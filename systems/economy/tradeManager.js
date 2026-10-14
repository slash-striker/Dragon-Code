const db = require('../../database');
const { SHOP_ITEMS, getItemQuantity } = require('./shopItems');
const { logTransaction } = require('./transactionLogger');

/*
 * PLAYER TRADES — the two-click confirm.
 *
 * A trade is a persisted row, not an in-memory session, so it survives a bot
 * restart. The initiator offers items/credits and states what they want back;
 * BOTH parties must explicitly confirm before a single credit or item moves.
 * Re-offering resets that side's confirmation, so nobody can be sniped by a
 * changed offer they already agreed to.
 *
 * Items are always stackable rows from `inventory`; credits come from either
 * the wallet or the bank and each side records which account it pays from.
 * Every mutation runs inside db.transaction() with guarded
 * UPDATE ... WHERE <account> >= ? debits, and is re-validated from live data
 * at execution time — confirming an offer you no longer own just fails.
 */

const TRADE_TTL_MS = 30 * 60 * 1000;
const MAX_TRADE_ITEMS = 10;

/*
 * The trades table predates per-side payment accounts, so the partner's
 * credit source lives in its own column. Re-asserting it here is idempotent
 * and matches the self-healing pattern used by the other economy modules.
 */
function ensureSchema() {
    try {
        db.exec("ALTER TABLE trades ADD COLUMN partnerGiveAccount TEXT NOT NULL DEFAULT 'wallet'");
    } catch (error) {
        // Column already exists -- nothing to heal.
    }
}
ensureSchema();

function normalizeAccount(account) {
    return account === 'bank' ? 'bank' : 'wallet';
}

function accountLabel(account) {
    return normalizeAccount(account) === 'bank' ? 'bank' : 'wallet';
}

function parseItems(raw) {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

function isParty(trade, userId) {
    return trade && (trade.initiatorId === userId || trade.partnerId === userId);
}

function isInitiator(trade, userId) {
    return trade && trade.initiatorId === userId;
}

/*
 * Validate one side's proposed offer and return the parsed item list.
 * Rejects unknown item ids, bad quantities and items the user does not hold.
 */
function validateItems(userId, items) {
    const list = Array.isArray(items) ? items.slice(0, MAX_TRADE_ITEMS) : [];
    const merged = new Map();
    for (const entry of list) {
        const itemId = entry?.itemId;
        const quantity = Math.floor(Number(entry?.quantity));
        if (!itemId || !SHOP_ITEMS[itemId]) {
            return { ok: false, message: `\`${itemId || 'unknown item'}\` is not a tradable item.` };
        }
        if (!Number.isInteger(quantity) || quantity <= 0) {
            return { ok: false, message: `Quantity for ${SHOP_ITEMS[itemId].name} must be a positive whole number.` };
        }
        merged.set(itemId, (merged.get(itemId) || 0) + quantity);
    }

    // Validate the MERGED total, so offering the same item twice cannot slip
    // past a per-entry ownership check.
    const cleaned = [];
    for (const [itemId, quantity] of merged) {
        const owned = getItemQuantity(userId, itemId);
        if (owned < quantity) {
            return { ok: false, message: `You only have ${owned}x ${SHOP_ITEMS[itemId].name}.` };
        }
        cleaned.push({ itemId, quantity });
    }
    return { ok: true, items: cleaned };
}

function getTrade(tradeId) {
    if (!tradeId) return null;
    return db.prepare('SELECT * FROM trades WHERE tradeId = ?').get(tradeId) || null;
}

function hasOpenTrade(userId) {
    return Boolean(db.prepare(
        "SELECT 1 FROM trades WHERE status = 'open' AND (initiatorId = ? OR partnerId = ?) LIMIT 1"
    ).get(userId, userId));
}

function createTrade({ initiatorId, partnerId, channelId, messageId = null }) {
    if (!initiatorId || !partnerId) {
        return { ok: false, message: 'A trade needs two players.' };
    }
    if (initiatorId === partnerId) {
        return { ok: false, message: 'You cannot trade with yourself.' };
    }
    if (hasOpenTrade(initiatorId)) {
        return { ok: false, message: 'You already have an open trade — finish or cancel it first.' };
    }
    if (hasOpenTrade(partnerId)) {
        return { ok: false, message: 'That player already has an open trade in progress.' };
    }

    const tradeId = `TR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const now = new Date().toISOString();
    try {
        db.prepare(`
            INSERT INTO trades (
                tradeId, initiatorId, partnerId, channelId, messageId,
                giveItems, giveCredits, giveAccount,
                receiveItems, receiveCredits, partnerGiveAccount,
                status, initiatorConfirmed, partnerConfirmed, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, '[]', 0, 'wallet', '[]', 0, 'wallet', 'open', 0, 0, ?, ?)
        `).run(tradeId, initiatorId, partnerId, String(channelId), messageId, now, now);
        return { ok: true, trade: getTrade(tradeId) };
    } catch (error) {
        console.error('Trade creation failed:', error);
        return { ok: false, message: 'The trade could not be opened.' };
    }
}

/*
 * Set one side's offer. Only the owning party may do it, only while open, and
 * re-offering clears that side's confirmation.
 */
function setOffer(tradeId, userId, { items = [], credits = 0, account = 'wallet' } = {}) {
    const trade = getTrade(tradeId);
    if (!trade) return { ok: false, message: 'That trade no longer exists.' };
    if (!isParty(trade, userId)) return { ok: false, message: 'This is not your trade.' };
    if (trade.status !== 'open') return { ok: false, message: 'That trade is already closed.' };

    const mine = isInitiator(trade, userId);
    if (mine && trade.initiatorConfirmed) {
        return { ok: false, message: 'You already confirmed this trade. Cancel it and open a new one to change your offer.' };
    }
    if (!mine && trade.partnerConfirmed) {
        return { ok: false, message: 'You already confirmed this trade.' };
    }

    const validated = validateItems(userId, items);
    if (!validated.ok) return validated;

    const value = Math.floor(Number(credits) || 0);
    if (value < 0) return { ok: false, message: 'Credits offered cannot be negative.' };
    const source = normalizeAccount(account);
    if (value > 0) {
        const row = db.prepare('SELECT wallet, bank FROM users WHERE userId = ?').get(userId);
        const available = Number(row ? row[source] : 0) || 0;
        if (available < value) {
            return { ok: false, message: `You only have 🪙${available.toLocaleString()} in your ${accountLabel(source)}.` };
        }
    }

    try {
        db.prepare(`
            UPDATE trades SET
                giveItems = ?, giveCredits = ?, giveAccount = ?,
                receiveItems = ?, receiveCredits = ?, partnerGiveAccount = ?,
                initiatorConfirmed = ?, partnerConfirmed = ?, updatedAt = ?
            WHERE tradeId = ?
        `).run(
            mine ? JSON.stringify(validated.items) : trade.giveItems,
            mine ? value : trade.giveCredits,
            mine ? source : trade.giveAccount,
            mine ? trade.receiveItems : JSON.stringify(validated.items),
            mine ? trade.receiveCredits : value,
            mine ? trade.partnerGiveAccount : source,
            mine ? 0 : trade.initiatorConfirmed,
            mine ? trade.partnerConfirmed : 0,
            new Date().toISOString(),
            tradeId
        );
        return { ok: true, trade: getTrade(tradeId), message: 'Offer updated.' };
    } catch (error) {
        console.error('Trade offer update failed:', error);
        return { ok: false, message: 'That offer could not be saved.' };
    }
}

function offerIsEmpty(itemsRaw, credits) {
    return parseItems(itemsRaw).length === 0 && (Number(credits) || 0) === 0;
}

/*
 * Confirm one side. When both sides are confirmed the trade executes
 * immediately and atomically.
 */
function confirm(tradeId, userId) {
    const trade = getTrade(tradeId);
    if (!trade) return { ok: false, message: 'That trade no longer exists.' };
    if (!isParty(trade, userId)) return { ok: false, message: 'This is not your trade.' };
    if (trade.status === 'done') return { ok: false, message: 'That trade is already complete.' };
    if (trade.status !== 'open') return { ok: false, message: 'That trade is no longer open.' };

    const mine = isInitiator(trade, userId);
    const myItems = mine ? trade.giveItems : trade.receiveItems;
    const myCredits = mine ? trade.giveCredits : trade.receiveCredits;
    if (offerIsEmpty(myItems, myCredits)) {
        return { ok: false, message: 'Set what you are offering before confirming — an empty offer cannot be traded.' };
    }

    try {
        db.prepare(`UPDATE trades SET ${mine ? 'initiatorConfirmed' : 'partnerConfirmed'} = 1, updatedAt = ? WHERE tradeId = ?`)
            .run(new Date().toISOString(), tradeId);
    } catch (error) {
        console.error('Trade confirm failed:', error);
        return { ok: false, message: 'That confirmation could not be recorded.' };
    }

    const updated = getTrade(tradeId);
    if (updated.initiatorConfirmed && updated.partnerConfirmed) {
        const executed = executeTrade(tradeId);
        return {
            ok: executed.ok,
            executed: executed.ok,
            trade: getTrade(tradeId),
            message: executed.message
        };
    }

    return {
        ok: true,
        executed: false,
        trade: updated,
        message: `✅ <@${userId}> confirmed — waiting on the other side.`
    };
}

/*
 * Move everything. Validated from live data first, then mutated in one
 * transaction: items both ways, credits both ways.
 */
function executeTrade(tradeId) {
    const trade = getTrade(tradeId);
    if (!trade) return { ok: false, message: 'That trade no longer exists.' };
    if (trade.status === 'done') return { ok: false, message: 'That trade already completed.' };
    if (trade.status !== 'open') return { ok: false, message: 'That trade is no longer open.' };
    if (!trade.initiatorConfirmed || !trade.partnerConfirmed) {
        return { ok: false, message: 'Both players must confirm before the trade executes.' };
    }

    const giveItems = parseItems(trade.giveItems);
    const receiveItems = parseItems(trade.receiveItems);
    const giveCredits = Math.max(0, Math.floor(Number(trade.giveCredits) || 0));
    const receiveCredits = Math.max(0, Math.floor(Number(trade.receiveCredits) || 0));
    const giveAccount = normalizeAccount(trade.giveAccount);
    const receiveAccount = normalizeAccount(trade.partnerGiveAccount);

    if (giveItems.length === 0 && receiveItems.length === 0 && giveCredits === 0 && receiveCredits === 0) {
        return { ok: false, message: 'Nothing was offered — the trade was cancelled without moving anything.' };
    }

    // Re-validate ownership from live data before anything moves.
    for (const row of giveItems) {
        if (getItemQuantity(trade.initiatorId, row.itemId) < row.quantity) {
            return { ok: false, message: `<@${trade.initiatorId}> no longer owns the ${SHOP_ITEMS[row.itemId]?.name || row.itemId} they offered.` };
        }
    }
    for (const row of receiveItems) {
        if (getItemQuantity(trade.partnerId, row.itemId) < row.quantity) {
            return { ok: false, message: `<@${trade.partnerId}> no longer owns the ${SHOP_ITEMS[row.itemId]?.name || row.itemId} they offered.` };
        }
    }
    for (const [userId, account, amount] of [
        [trade.initiatorId, giveAccount, giveCredits],
        [trade.partnerId, receiveAccount, receiveCredits]
    ]) {
        if (amount <= 0) continue;
        const row = db.prepare(`SELECT ${account} AS balance FROM users WHERE userId = ?`).get(userId);
        if (!row || Number(row.balance) < amount) {
            return { ok: false, message: `<@${userId}> no longer has 🪙${amount.toLocaleString()} in their ${accountLabel(account)}.` };
        }
    }

    try {
        db.transaction(() => {
            db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(trade.initiatorId);
            db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(trade.partnerId);

            // Items: remove from the giver, upsert onto the receiver.
            const moveItem = (fromId, toId, itemId, quantity) => {
                const owned = getItemQuantity(fromId, itemId);
                if (owned < quantity) throw new Error(`<@${fromId}> no longer owns enough ${SHOP_ITEMS[itemId]?.name || itemId}.`);
                db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE userId = ? AND itemId = ?')
                    .run(quantity, fromId, itemId);
                db.prepare('DELETE FROM inventory WHERE userId = ? AND itemId = ? AND quantity <= 0')
                    .run(fromId, itemId);
                db.prepare(`
                    INSERT INTO inventory (userId, itemId, quantity, createdAt)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(userId, itemId) DO UPDATE SET quantity = quantity + excluded.quantity
                `).run(toId, itemId, quantity, new Date().toISOString());
            };
            for (const row of giveItems) moveItem(trade.initiatorId, trade.partnerId, row.itemId, row.quantity);
            for (const row of receiveItems) moveItem(trade.partnerId, trade.initiatorId, row.itemId, row.quantity);

            // Credits: guarded debit on the payer, plain credit on the receiver.
            const moveCredits = (fromId, toId, account, amount) => {
                if (amount <= 0) return;
                const debit = db.prepare(
                    `UPDATE users SET ${account} = ${account} - ? WHERE userId = ? AND ${account} >= ?`
                ).run(amount, fromId, amount);
                if (debit.changes !== 1) throw new Error(`<@${fromId}> could not cover the 🪙${amount.toLocaleString()} they offered.`);
                db.prepare(`UPDATE users SET ${account} = ${account} + ? WHERE userId = ?`).run(amount, toId);
            };
            moveCredits(trade.initiatorId, trade.partnerId, giveAccount, giveCredits);
            moveCredits(trade.partnerId, trade.initiatorId, receiveAccount, receiveCredits);

            logTransaction(trade.initiatorId, 'trade_out', -giveCredits, `Trade ${trade.tradeId} with ${trade.partnerId}`);
            logTransaction(trade.partnerId, 'trade_in', giveCredits, `Trade ${trade.tradeId} from ${trade.initiatorId}`);
            logTransaction(trade.partnerId, 'trade_out', -receiveCredits, `Trade ${trade.tradeId} with ${trade.initiatorId}`);
            logTransaction(trade.initiatorId, 'trade_in', receiveCredits, `Trade ${trade.tradeId} from ${trade.partnerId}`);

            db.prepare("UPDATE trades SET status = 'done', updatedAt = ? WHERE tradeId = ?")
                .run(new Date().toISOString(), trade.tradeId);
        })();

        /* 📋 Quest board hook — completed trades count for both parties. */
        try {
            const questManager = require('./questManager');
            questManager.recordQuestEvent(trade.initiatorId, 'trade', 1, { partnerId: trade.partnerId });
            questManager.recordQuestEvent(trade.partnerId, 'trade', 1, { partnerId: trade.initiatorId });
            questManager.awardBadge(trade.initiatorId, 'trader');
            questManager.awardBadge(trade.partnerId, 'trader');
        } catch (error) {
            /* quests must never block a completed trade */
        }

        return { ok: true, message: '✅ Trade complete — both sides have been settled.' };
    } catch (error) {
        console.error('Trade execution failed:', error);
        return { ok: false, message: error.message || 'The trade could not be completed.' };
    }
}

function cancel(tradeId, userId) {
    const trade = getTrade(tradeId);
    if (!trade) return { ok: false, message: 'That trade no longer exists.' };
    if (!isParty(trade, userId)) return { ok: false, message: 'This is not your trade.' };
    if (trade.status !== 'open') return { ok: false, message: 'That trade is already closed.' };
    db.prepare("UPDATE trades SET status = 'cancelled', updatedAt = ? WHERE tradeId = ?")
        .run(new Date().toISOString(), tradeId);
    return { ok: true, message: '🛑 Trade cancelled — nothing moved.' };
}

function expireStale(now = Date.now()) {
    const cutoff = new Date(now - TRADE_TTL_MS).toISOString();
    const info = db.prepare(`
        UPDATE trades SET status = 'expired', updatedAt = ?
        WHERE status = 'open' AND createdAt < ?
    `).run(new Date(now).toISOString(), cutoff);
    return info.changes || 0;
}

function listOpenTradesFor(userId) {
    return db.prepare(`
        SELECT * FROM trades
        WHERE status = 'open' AND (initiatorId = ? OR partnerId = ?)
        ORDER BY createdAt DESC
    `).all(userId, userId);
}

/*
 * Ready-to-render offer lines. Each array holds the item lines the side is
 * giving, with the credit line appended when that side offers credits, so a
 * caller can render the arrays directly and still has the raw numbers when it
 * wants to show them separately.
 */
function renderOffer(trade) {
    if (!trade) return { initiator: [], partner: [], giveCredits: 0, receiveCredits: 0, giveAccount: 'wallet', receiveAccount: 'wallet' };

    const itemLines = rows => rows.map(row =>
        `${SHOP_ITEMS[row.itemId]?.name || row.itemId} ×${row.quantity}`
    );

    const giveCredits = Math.max(0, Math.floor(Number(trade.giveCredits) || 0));
    const receiveCredits = Math.max(0, Math.floor(Number(trade.receiveCredits) || 0));
    const giveAccount = normalizeAccount(trade.giveAccount);
    const receiveAccount = normalizeAccount(trade.partnerGiveAccount);

    const initiator = itemLines(parseItems(trade.giveItems));
    const partner = itemLines(parseItems(trade.receiveItems));
    if (giveCredits > 0) initiator.push(`🪙 ${giveCredits.toLocaleString()} from ${accountLabel(giveAccount)}`);
    if (receiveCredits > 0) partner.push(`🪙 ${receiveCredits.toLocaleString()} from ${accountLabel(receiveAccount)}`);

    return { initiator, partner, giveCredits, receiveCredits, giveAccount, receiveAccount };
}

module.exports = {
    TRADE_TTL_MS,
    MAX_TRADE_ITEMS,
    createTrade,
    getTrade,
    hasOpenTrade,
    setOffer,
    confirm,
    executeTrade,
    cancel,
    expireStale,
    listOpenTradesFor,
    renderOffer
};
