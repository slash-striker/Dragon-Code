const db = require('../../database');
const { logTransaction } = require('./transactionLogger');

/*
 * PLAYER BOUNTIES — the revenge loop.
 *
 * Anyone can pool credits on another player with /bounty. The pool sits in
 * `bounties` (one row per target) with a per-contributor audit trail in
 * `bounty_contributions`. When a robber successfully robs the target, the
 * robbing code calls claimBounty(), which pays the WHOLE pool to the robber
 * and clears the target's bounty. No staff involvement, no timers.
 *
 * Money only ever moves through guarded UPDATE ... WHERE wallet >= ? debits
 * inside db.transaction(), so a race can never create credits.
 */

const MIN_BOUNTY = 500;
const MAX_BOUNTY = 100_000_000;

function normalizeAmount(amount) {
    const value = Number(amount);
    if (!Number.isFinite(value)) return 0;
    return Math.floor(value);
}

function getBounty(targetId) {
    if (!targetId) return { targetId: null, amount: 0 };
    return db.prepare('SELECT targetId, amount, updatedAt FROM bounties WHERE targetId = ?').get(targetId)
        || { targetId, amount: 0, updatedAt: null };
}

function getBountyAmount(targetId) {
    return Number(getBounty(targetId).amount) || 0;
}

function hasBounty(targetId) {
    return getBountyAmount(targetId) > 0;
}

/*
 * Place (or top up) a bounty. The debit and both writes happen in one
 * transaction so a partial failure can never mint or vanish credits.
 */
function placeBounty({ targetId, contributorId, amount }) {
    if (!targetId || !contributorId) {
        return { ok: false, message: 'A bounty needs both a target and a contributor.' };
    }
    if (targetId === contributorId) {
        return { ok: false, message: 'You cannot put a bounty on yourself — nice try.' };
    }

    const value = normalizeAmount(amount);
    if (value <= 0) {
        return { ok: false, message: 'The bounty amount must be a positive number.' };
    }
    if (value < MIN_BOUNTY) {
        return { ok: false, message: `The smallest bounty the grid accepts is 🪙${MIN_BOUNTY.toLocaleString()}.` };
    }
    if (value > MAX_BOUNTY) {
        return { ok: false, message: `A single bounty cannot exceed 🪙${MAX_BOUNTY.toLocaleString()}.` };
    }

    try {
        const result = db.transaction(() => {
            db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(contributorId);
            const debit = db.prepare(
                'UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?'
            ).run(value, contributorId, value);
            if (debit.changes !== 1) {
                throw new Error(`You need 🪙${value.toLocaleString()} in your wallet to fund this bounty.`);
            }

            const now = new Date().toISOString();
            db.prepare(`
                INSERT INTO bounties (targetId, amount, updatedAt)
                VALUES (?, ?, ?)
                ON CONFLICT(targetId) DO UPDATE SET
                    amount = amount + excluded.amount,
                    updatedAt = excluded.updatedAt
            `).run(targetId, value, now);

            db.prepare(`
                INSERT INTO bounty_contributions (targetId, contributorId, amount, updatedAt)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(targetId, contributorId) DO UPDATE SET
                    amount = amount + excluded.amount,
                    updatedAt = excluded.updatedAt
            `).run(targetId, contributorId, value, now);

            logTransaction(contributorId, 'bounty_placed', -value, `Bounty placed on ${targetId}`);
            return getBountyAmount(targetId);
        })();

        return {
            ok: true,
            total: result,
            message: `🎯 <@${targetId}> now carries a **🪙${result.toLocaleString()}** bounty.`
        };
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

function listContributors(targetId, limit = 5) {
    if (!targetId) return [];
    return db.prepare(`
        SELECT contributorId, amount FROM bounty_contributions
        WHERE targetId = ?
        ORDER BY amount DESC, updatedAt ASC
        LIMIT ?
    `).all(targetId, limit);
}

function topBounties(limit = 10) {
    return db.prepare(`
        SELECT targetId, amount FROM bounties
        WHERE amount > 0
        ORDER BY amount DESC
        LIMIT ?
    `).all(limit);
}

function totalBountyPool() {
    return Number(db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM bounties').get()?.total) || 0;
}

/*
 * Pay the pool to whoever brought the target down. Called from the robbery
 * payout path, so this must be safe to call on every successful robbery —
 * it simply reports { ok: false } when there is nothing to collect.
 */
function claimBounty(targetId, claimerId) {
    if (!targetId || !claimerId) return { ok: false, amount: 0, message: 'Nothing to claim.' };

    try {
        const amount = db.transaction(() => {
            const row = db.prepare('SELECT amount FROM bounties WHERE targetId = ?').get(targetId);
            const value = Number(row?.amount) || 0;
            if (value <= 0) return 0;

            db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(claimerId);
            db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(value, claimerId);
            db.prepare('DELETE FROM bounties WHERE targetId = ?').run(targetId);
            db.prepare('DELETE FROM bounty_contributions WHERE targetId = ?').run(targetId);
            logTransaction(claimerId, 'bounty_claimed', value, `Collected the bounty on ${targetId}`);
            return value;
        })();

        if (amount <= 0) return { ok: false, amount: 0, message: 'That bounty was already collected.' };

        return {
            ok: true,
            amount,
            message: `🎯 Bounty collected — **🪙${amount.toLocaleString()}** claimed for taking down <@${targetId}>.`
        };
    } catch (error) {
        console.error('Bounty claim failed:', error);
        return { ok: false, amount: 0, message: 'The bounty could not be released right now.' };
    }
}

module.exports = {
    MIN_BOUNTY,
    MAX_BOUNTY,
    placeBounty,
    getBounty,
    getBountyAmount,
    hasBounty,
    listContributors,
    topBounties,
    totalBountyPool,
    claimBounty
};
