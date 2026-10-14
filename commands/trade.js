/*
 * /trade — two players swap items and/or credits.
 *
 * All validation, ownership checks and the atomic swap live in
 * systems/economy/tradeManager.js. This file is the interface: build an offer,
 * let BOTH sides confirm, then render the result. Nothing here reimplements a
 * balance check.
 *
 * A trade row persists across restarts, so the panel is rebuilt from the row
 * every time a button is pressed instead of living in a collector.
 *
 * Note on "want": the engine has exactly two offer slots (the initiator's give
 * side and the partner's give side) and no wishlist column. The initiator's
 * WANTED items are therefore stored separately in bot_meta under
 * trade:request:<tradeId> so the panel can keep showing them, and they are
 * explicitly labelled as a request — never as something the engine will move.
 * They are cleared when the trade completes or is cancelled.
 */
const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const db = require('../database');
const { SHOP_ITEMS, getItemByName, getItemQuantity } = require('../systems/economy/shopItems');
const trades = require('../systems/economy/tradeManager');

const ALLOWED_CHANNEL = '1504562791967756448';
const PREFIX = 'trade:';
const REQUEST_KEY = 'trade:request:';
const COLOR = 0x00d4ff;

// ==================================================
// ITEM PARSING
// ==================================================
/*
 * Tolerant parser for offer text. Accepts:
 *   "coffee x2, lucky_dice"      → 2 coffee, 1 lucky dice
 *   "coffee 2; magic fishing hook"
 *   "mystery box *3"
 * Unknown, hidden or service items are rejected by name so the typo is obvious.
 */
function parseItemList(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { ok: true, items: [], unknown: [] };

    const chunks = text.split(/[,\n;]+/).map(chunk => chunk.trim()).filter(Boolean);
    const merged = new Map();
    const unknown = [];

    for (const chunk of chunks) {
        let name = chunk;
        let quantity = 1;
        const suffixed = chunk.match(/^(.*?)\s*[x*×]\s*(\d+)$/i) || chunk.match(/^(.*?)\s+(\d+)$/);
        if (suffixed) {
            name = suffixed[1].trim();
            quantity = Number(suffixed[2]);
        }

        const item = getItemByName(name);
        // Hidden items are secret on purpose, and services are fulfilled by
        // SLASH personally rather than sitting in the inventory.
        if (!item || item.hidden || item.category === 'services') {
            unknown.push(chunk);
            continue;
        }
        if (!Number.isInteger(quantity) || quantity <= 0) {
            unknown.push(chunk);
            continue;
        }
        merged.set(item.id, (merged.get(item.id) || 0) + quantity);
    }

    return {
        ok: unknown.length === 0,
        items: [...merged].map(([itemId, quantity]) => ({ itemId, quantity })),
        unknown
    };
}

/** Tradable = a real stackable inventory item (not hidden, not a SLASH service). */
function tradableItems(userId) {
    return Object.values(SHOP_ITEMS)
        .filter(item => !item.hidden && item.category !== 'services')
        .map(item => ({ item, owned: getItemQuantity(userId, item.id) }));
}

function describeItems(items) {
    return (items || []).map(row =>
        `${SHOP_ITEMS[row.itemId]?.name || row.itemId} ×${row.quantity}`
    );
}

/** Prefill text for the offer modal, e.g. "☕ Coffee x2". */
function offerText(items) {
    return describeItems(items).join(', ');
}

// ==================================================
// REQUEST STORAGE (the initiator's wishlist)
// ==================================================
function saveRequest(tradeId, request) {
    try {
        db.prepare(`
            INSERT INTO bot_meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(REQUEST_KEY + tradeId, JSON.stringify(request));
    } catch (error) {
        /* the wishlist is cosmetic — never fail a trade over it */
    }
}

function loadRequest(tradeId) {
    try {
        const row = db.prepare('SELECT value FROM bot_meta WHERE key = ?').get(REQUEST_KEY + tradeId);
        if (!row) return null;
        return JSON.parse(row.value);
    } catch (error) {
        return null;
    }
}

function clearRequest(tradeId) {
    try {
        db.prepare('DELETE FROM bot_meta WHERE key = ?').run(REQUEST_KEY + tradeId);
    } catch (error) {
        /* nothing to clean */
    }
}

/** Drop wishlists whose trade is gone or already closed. */
function pruneRequests() {
    try {
        const rows = db.prepare("SELECT key FROM bot_meta WHERE key LIKE ?").all(REQUEST_KEY + '%');
        const remove = db.prepare('DELETE FROM bot_meta WHERE key = ?');
        for (const row of rows) {
            const tradeId = row.key.slice(REQUEST_KEY.length);
            const trade = trades.getTrade(tradeId);
            if (!trade || trade.status !== 'open') remove.run(row.key);
        }
    } catch (error) {
        /* pruning is best-effort */
    }
}

// ==================================================
// RENDER
// ==================================================
function expiryStamp(trade) {
    const created = new Date(trade.createdAt).getTime();
    const expires = created + trades.TRADE_TTL_MS;
    return `<t:${Math.floor(expires / 1000)}:R>`;
}

function statusLine(trade) {
    if (trade.status === 'done') return '✅ **Settled**';
    if (trade.status === 'cancelled') return '🛑 **Cancelled**';
    if (trade.status === 'expired') return '⌛ **Expired**';
    const initiator = trade.initiatorConfirmed ? '✅ confirmed' : '⬜ waiting';
    const partner = trade.partnerConfirmed ? '✅ confirmed' : '⬜ waiting';
    return `<@${trade.initiatorId}> ${initiator} · <@${trade.partnerId}> ${partner}`;
}

function sideLines(lines, fallback) {
    return lines && lines.length ? lines.map(line => `• ${line}`).join('\n') : `• _${fallback}_`;
}

/*
 * `pickerUserId` is the person looking at the panel. The quick-add item menu
 * can only offer items THEY own and only edit THEIR side, so the list is built
 * per viewer rather than baked into the message.
 */
function panel(trade, extraNote = null, pickerUserId = null) {
    const offer = trades.renderOffer(trade);
    const request = loadRequest(trade.tradeId);

    const requestLines = request && ((request.items || []).length || Number(request.credits) > 0)
        ? [
            ...(request.items || []).map(entry => `• ${entry}`),
            Number(request.credits) > 0 ? `• 🪙 ${Number(request.credits).toLocaleString()} from ${request.account || 'wallet'}` : null
        ].filter(Boolean).join('\n')
        : null;

    const embed = new EmbedBuilder()
        .setColor(trade.status === 'done' ? 0x57f287 : trade.status === 'open' ? COLOR : 0xff5577)
        .setTitle(`🤝 TRADE ${trade.tradeId}`)
        .setDescription([
            `<@${trade.initiatorId}> ⇄ <@${trade.partnerId}>`,
            `Expires ${expiryStamp(trade)}`,
            '',
            `**<@${trade.initiatorId}> GIVES**`,
            sideLines(offer.initiator, 'nothing offered yet'),
            '',
            requestLines
                ? `**<@${trade.initiatorId}> REQUESTS FROM <@${trade.partnerId}>** _(a wish — the partner decides what to offer)_\n${requestLines}`
                : null,
            requestLines ? '' : null,
            `**<@${trade.partnerId}> GIVES**`,
            sideLines(offer.partner, 'nothing offered yet'),
            '',
            '**CONFIRMATIONS**',
            statusLine(trade),
            extraNote ? `\n${extraNote}` : null
        ].filter(entry => entry !== null && entry !== undefined).join('\n'))
        .setFooter({ text: 'Both sides must confirm. Changing your offer cancels your own confirmation.' });

    const open = trade.status === 'open';
    const components = [];

    if (open && pickerUserId && (pickerUserId === trade.initiatorId || pickerUserId === trade.partnerId)) {
        const options = tradableItems(pickerUserId)
            .filter(entry => entry.owned > 0)
            .sort((a, b) => b.owned - a.owned)
            .slice(0, 25)
            .map(entry => ({
                label: `${entry.item.name} (owned: ${entry.owned})`.slice(0, 100),
                description: `Add 1 to your side — 🪙${Number(entry.item.price).toLocaleString()} each`.slice(0, 100),
                value: entry.item.id
            }));
        if (options.length) {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`${PREFIX}pick:${trade.tradeId}`)
                    .setPlaceholder('Quick-add one of your items')
                    .addOptions(options)
            ));
        }
    }

    components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}confirm:${trade.tradeId}`).setLabel('Confirm my side').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!open),
        new ButtonBuilder().setCustomId(`${PREFIX}offer:${trade.tradeId}`).setLabel('Edit my offer').setEmoji('✏️').setStyle(ButtonStyle.Primary).setDisabled(!open),
        new ButtonBuilder().setCustomId(`${PREFIX}clear:${trade.tradeId}`).setLabel('Clear my offer').setEmoji('🧹').setStyle(ButtonStyle.Secondary).setDisabled(!open),
        new ButtonBuilder().setCustomId(`${PREFIX}cancel:${trade.tradeId}`).setLabel('Cancel trade').setEmoji('🛑').setStyle(ButtonStyle.Danger).setDisabled(!open)
    ));

    return { embeds: [embed], components };
}

/** Compact panel listing the caller's open trades. */
function openTradesPanel(userId) {
    const open = trades.listOpenTradesFor(userId);
    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('🤝 YOUR OPEN TRADES')
        .setDescription(open.length
            ? open.map(trade => [
                `**${trade.tradeId}** — <@${trade.initiatorId}> ⇄ <@${trade.partnerId}>`,
                `> ${trade.initiatorConfirmed ? '✅' : '⬜'} initiator · ${trade.partnerConfirmed ? '✅' : '⬜'} partner · expires ${expiryStamp(trade)}`
            ].join('\n')).join('\n\n')
            : [
                'You have no open trades.',
                '',
                'Start one with **/trade user:@someone give-items:"coffee x2" want-items:"lucky_dice"**.',
                '',
                'Then use the **✏️ Edit my offer** button (or the item picker) to build your side, and hit **✅ Confirm** once you are happy. Nothing moves until both players have confirmed.'
            ].join('\n'))
        .setFooter({ text: 'One open trade per player · trades expire after 30 minutes' });

    const components = [];
    if (open.length) {
        const row = new ActionRowBuilder();
        for (const trade of open.slice(0, 5)) {
            row.addComponents(new ButtonBuilder()
                .setCustomId(`${PREFIX}view:${trade.tradeId}`)
                .setLabel(`View ${trade.tradeId}`)
                .setEmoji('🔍')
                .setStyle(ButtonStyle.Primary));
        }
        components.push(row);
    }
    return { embeds: [embed], components };
}

/** Final result once both sides confirmed and the swap executed. */
function completedPanel(trade) {
    const offer = trades.renderOffer(trade);
    const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ TRADE COMPLETE')
        .setDescription([
            `**${trade.tradeId}** settled between <@${trade.initiatorId}> and <@${trade.partnerId}>.`,
            '',
            `**<@${trade.initiatorId}> received from <@${trade.partnerId}>**`,
            sideLines(offer.partner, 'nothing'),
            '',
            `**<@${trade.partnerId}> received from <@${trade.initiatorId}>**`,
            sideLines(offer.initiator, 'nothing'),
            '',
            '_Both inventories and balances have been updated. Start another trade any time._'
        ].join('\n'))
        .setTimestamp();
    return { embeds: [embed], components: [] };
}

// ==================================================
// COMMAND
// ==================================================
function buildOfferModal(trade, userId) {
    const isInitiator = trade.initiatorId === userId;
    const items = isInitiator ? trade.giveItems : trade.receiveItems;
    const credits = isInitiator ? trade.giveCredits : trade.receiveCredits;
    const account = isInitiator ? trade.giveAccount : trade.partnerGiveAccount;

    let parsedItems = [];
    try {
        const parsed = JSON.parse(items || '[]');
        parsedItems = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        parsedItems = [];
    }

    return new ModalBuilder()
        .setCustomId(`${PREFIX}modal:${trade.tradeId}:${isInitiator ? 'give' : 'receive'}`)
        .setTitle(`Your offer — ${trade.tradeId}`.slice(0, 45))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('items')
                    .setLabel('Items you give (e.g. coffee x2, lucky_dice)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(300)
                    .setValue(offerText(Array.isArray(parsedItems) ? parsedItems : []).slice(0, 300))
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('credits')
                    .setLabel('Credits you give (number, blank for none)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(15)
                    .setValue(Number(credits) > 0 ? String(Number(credits)) : '')
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('account')
                    .setLabel('Pay credits from: wallet or bank')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(6)
                    .setValue(account === 'bank' ? 'bank' : 'wallet')
            )
        );
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('trade')
        .setDescription('Trade items and credits with another player — both sides must confirm')
        .addUserOption(option => option
            .setName('user')
            .setDescription('Who to trade with (leave blank to view your open trades)'))
        .addStringOption(option => option
            .setName('give-items')
            .setDescription('What you give, e.g. coffee x2, lucky_dice'))
        .addIntegerOption(option => option
            .setName('give-credits')
            .setDescription('Credits you give')
            .setMinValue(0))
        .addStringOption(option => option
            .setName('give-account')
            .setDescription('Where your credits come from')
            .addChoices(
                { name: 'Wallet', value: 'wallet' },
                { name: 'Bank', value: 'bank' }
            ))
        .addStringOption(option => option
            .setName('want-items')
            .setDescription('What you would like back (shown to the other player as a request)'))
        .addIntegerOption(option => option
            .setName('want-credits')
            .setDescription('Credits you would like back (a request)')
            .setMinValue(0)),

    async execute(interaction) {
        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({ content: `❌ You can only trade in <#${ALLOWED_CHANNEL}>.` });
        }

        await interaction.deferReply();
        pruneRequests();

        const callerId = interaction.user.id;
        const partner = interaction.options.getUser('user');

        if (!partner) {
            return interaction.editReply(openTradesPanel(callerId));
        }

        const created = trades.createTrade({
            initiatorId: callerId,
            partnerId: partner.id,
            channelId: interaction.channelId
        });
        if (!created.ok) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(0xff5577)
                    .setTitle('⚠️ TRADE NOT OPENED')
                    .setDescription(`${created.message}\n\nUse **/trade** with no user to see your open trades.`)]
            });
        }

        const tradeId = created.trade.tradeId;
        const notes = [];

        // ---- the initiator's give side ----
        const giveRaw = interaction.options.getString('give-items');
        const giveCredits = interaction.options.getInteger('give-credits') || 0;
        const giveAccount = interaction.options.getString('give-account') || 'wallet';

        let parsedGive = { ok: true, items: [], unknown: [] };
        if (giveRaw || giveCredits > 0) {
            parsedGive = parseItemList(giveRaw);
            if (!parsedGive.ok) {
                return interaction.editReply(finishWith(tradeId, `Those items are not tradable: ${parsedGive.unknown.join(', ')}. Check the names with /inventory, then open a new trade.`));
            }
            const offer = trades.setOffer(tradeId, callerId, {
                items: parsedGive.items,
                credits: giveCredits,
                account: giveAccount
            });
            if (!offer.ok) return interaction.editReply(finishWith(tradeId, offer.message, true));
            if (giveCredits > 0) notes.push(`Your 🪙${giveCredits.toLocaleString()} will come from your ${giveAccount}.`);
        }

        // ---- the initiator's wish list (request only, never moved by the engine) ----
        const wantRaw = interaction.options.getString('want-items');
        const wantCredits = interaction.options.getInteger('want-credits') || 0;
        let parsedWant = { ok: true, items: [], unknown: [] };
        if (wantRaw || wantCredits > 0) {
            parsedWant = parseItemList(wantRaw);
            if (!parsedWant.ok) {
                notes.push(`I ignored these requested items because I could not match them: ${parsedWant.unknown.join(', ')}.`);
            }
            saveRequest(tradeId, {
                items: describeItems(parsedWant.items),
                credits: wantCredits,
                account: giveAccount
            });
        }

        if (parsedGive.items.length === 0 && giveCredits === 0) {
            notes.push('You have not offered anything yet — use **✏️ Edit my offer** to build your side.');
        }
        notes.push(`<@${partner.id}> — you are the other side of this trade. Build your offer with **✏️ Edit my offer**, then **✅ Confirm** once you are happy.`);

        const body = panel(trades.getTrade(tradeId), notes.join('\n'), callerId);
        return interaction.editReply(body);
    },

    // ---------------------------------------------------------------
    // Component router — index.js routes every `trade:` id here.
    // ---------------------------------------------------------------
    async handleComponent(interaction) {
        const pieces = String(interaction.customId).split(':');
        const action = pieces[1];
        const tradeId = pieces[2];

        const trade = trades.getTrade(tradeId);
        if (!trade) {
            return interaction.reply({ content: '❌ That trade no longer exists.', flags: 64 });
        }

        const userId = interaction.user.id;
        if (userId !== trade.initiatorId && userId !== trade.partnerId) {
            return interaction.reply({ content: '❌ This is not your trade.', flags: 64 });
        }

        if (action === 'view') {
            return interaction.reply({ ...panel(trade, null, userId), flags: 64 });
        }

        if (action === 'cancel') {
            const result = trades.cancel(tradeId, userId);
            clearRequest(tradeId);
            const updated = trades.getTrade(tradeId);
            const body = panel(updated, result.message, userId);
            if (interaction.deferred || interaction.replied) return interaction.editReply(body);
            return interaction.update(body);
        }

        if (action === 'clear') {
            const isInitiator = trade.initiatorId === userId;
            const currentItems = isInitiator ? trade.giveItems : trade.receiveItems;
            let items = [];
            try {
                items = JSON.parse(currentItems || '[]');
            } catch (error) {
                items = [];
            }
            if (!items.length && Number(isInitiator ? trade.giveCredits : trade.receiveCredits) === 0) {
                return interaction.reply({ content: '❌ You have not offered anything yet.', flags: 64 });
            }
            const result = trades.setOffer(tradeId, userId, { items: [], credits: 0, account: 'wallet' });
            const body = panel(trades.getTrade(tradeId), result.ok
                ? '🧹 Your offer was cleared — both sides will need to confirm again.'
                : result.message, userId);
            if (interaction.deferred || interaction.replied) return interaction.editReply(body);
            return interaction.update(body);
        }

        if (action === 'confirm') {
            const result = trades.confirm(tradeId, userId);
            const updated = trades.getTrade(tradeId);

            if (result.executed && updated && updated.status === 'done') {
                clearRequest(tradeId);
                return interaction.update(completedPanel(updated));
            }
            const body = panel(updated || trade, result.message, userId);
            if (interaction.deferred || interaction.replied) return interaction.editReply(body);
            return interaction.update(body);
        }

        if (action === 'offer') {
            if (trade.status !== 'open') {
                return interaction.reply({ content: '❌ That trade is no longer open.', flags: 64 });
            }
            return interaction.showModal(buildOfferModal(trade, userId));
        }

        if (action === 'pick') {
            // The select menu lives on the panel; its value is an itemId.
            if (!interaction.isStringSelectMenu()) return;
            const itemId = interaction.values[0];
            const item = SHOP_ITEMS[itemId];
            if (!item) return interaction.reply({ content: '❌ Unknown item.', flags: 64 });

            const isInitiator = trade.initiatorId === userId;
            const currentRaw = isInitiator ? trade.giveItems : trade.receiveItems;
            let items = [];
            try {
                const parsed = JSON.parse(currentRaw || '[]');
                items = Array.isArray(parsed) ? parsed : [];
            } catch (error) {
                items = [];
            }
            const merged = items.map(row => ({ itemId: row.itemId, quantity: row.quantity }));
            const existing = merged.find(row => row.itemId === itemId);
            if (existing) existing.quantity += 1;
            else merged.push({ itemId, quantity: 1 });

            const result = trades.setOffer(tradeId, userId, {
                items: merged,
                credits: isInitiator ? trade.giveCredits : trade.receiveCredits,
                account: isInitiator ? trade.giveAccount : trade.partnerGiveAccount
            });
            const body = panel(trades.getTrade(tradeId), result.ok
                ? `➕ Added 1× ${item.name}. Your confirmation was reset — press ✅ Confirm again.`
                : result.message, userId);
            return interaction.update(body);
        }

        return interaction.reply({ content: '❌ Unknown trade action.', flags: 64 });
    },

    // ---------------------------------------------------------------
    // Offer modal
    // ---------------------------------------------------------------
    async handleModal(interaction) {
        const pieces = String(interaction.customId).split(':');
        const tradeId = pieces[2];
        const trade = trades.getTrade(tradeId);
        if (!trade) return interaction.reply({ content: '❌ That trade no longer exists.', flags: 64 });

        const userId = interaction.user.id;
        if (userId !== trade.initiatorId && userId !== trade.partnerId) {
            return interaction.reply({ content: '❌ This is not your trade.', flags: 64 });
        }

        const rawItems = interaction.fields.getTextInputValue('items') || '';
        const rawCredits = interaction.fields.getTextInputValue('credits') || '';
        const rawAccount = (interaction.fields.getTextInputValue('account') || 'wallet').trim().toLowerCase();

        const parsed = parseItemList(rawItems);
        if (!parsed.ok) {
            return interaction.update(panel(trade, `❌ I could not find: ${parsed.unknown.join(', ')}. Use the item names from /inventory (and the picker on the panel).`, userId));
        }

        let credits = 0;
        if (rawCredits.trim()) {
            credits = Number(rawCredits.replace(/[^0-9]/g, ''));
            if (!Number.isFinite(credits) || credits < 0) {
                return interaction.update(panel(trade, '❌ Credits must be a whole non-negative number.', userId));
            }
        }

        const result = trades.setOffer(tradeId, userId, {
            items: parsed.items,
            credits,
            account: rawAccount === 'bank' ? 'bank' : 'wallet'
        });

        const body = panel(trades.getTrade(tradeId), result.ok
            ? '✏️ Offer saved. Your confirmation was reset — press ✅ Confirm when it looks right.'
            : `❌ ${result.message}`, userId);
        return interaction.update(body);
    }
};

// ==================================================
// HELPERS
// ==================================================
/** Render the trade after a setup failure so the panel still exists. */
function finishWith(tradeId, note, fatal = false) {
    const trade = trades.getTrade(tradeId);
    if (!trade) {
        return {
            embeds: [new EmbedBuilder()
                .setColor(0xff5577)
                .setTitle('⚠️ TRADE CLOSED')
                .setDescription(note)],
            components: []
        };
    }
    const body = panel(trade, note, trade.initiatorId);
    if (fatal) body.components = [];
    return body;
}


