const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, StringSelectMenuBuilder } = require('discord.js');
const { SHOP_ITEMS, getItemByName, getItemQuantity, purchaseItem } = require('../systems/economy/shopItems');
const flashDeals = require('../systems/economy/flashDeals');
const { getUser } = require('../systems/economy/userManager');
const db = require('../database');
const { getColor, formatTitle, formatDescription, formatButtonLabel, formatFieldName, isHighTech } = require('../systems/economy/uiStyleHelper');
const { grantBoostFromPurchase, BOOST_ROLES } = require('../systems/economy/timedRoles');
const { buildSlashApproval, hasServiceSupport, SLASH_USER_ID } = require('../systems/economy/slashServices');

/*
 * The premium-purchase notification used to ping process.env.OWNER_ID with a
 * hardcoded fallback ID that is not a member of this guild — Discord rendered
 * it as “@unknown-user” right before the embed pinged SLASH. The real host
 * account is SLASH_USER_ID (1466461677783351447).
 */
const OWNER_ID = process.env.OWNER_ID || SLASH_USER_ID;
const PREMIUM_NOTIFICATION_CHANNEL = process.env.PREMIUM_CHANNEL || '1504562791967756448';

// Same economy-terminal lock every other shop/economy command uses.
const ALLOWED_CHANNEL = '1504562791967756448';

// Group items by category
const CATEGORIES = {
    all: { label: '🛒 All Items', value: 'all' },
    work: { label: '⚒️ Work Items', value: 'work' },
    protection: { label: '🛡️ Protection', value: 'protection' },
    luck: { label: '🍀 Luck Items', value: 'luck' },
    box: { label: '🎁 Mystery Boxes', value: 'box' },
    fishing: { label: '🎣 Fishing', value: 'fishing' },
    dragon: { label: '🐉 Dragon Hatchery', value: 'dragon' },
    premium: { label: '💎 Premium', value: 'premium' },
    services: { label: '🛠️ SLASH Services', value: 'services' },
    xp: { label: '⬆️ XP Boosts', value: 'xp' }
};

/*
 * /shop — unified shop command (formerly /shop-view + /shop-buy).
 *
 *   /shop                        → browse panel (categories + pagination)
 *   /shop action:buy item:<name> → purchase with autocomplete suggestions
 *
 * A choice option keeps "/shop" as a single slash entry. The item field uses
 * autocomplete instead of a static choice list — the shop outgrew Discord's
 * 25-choice limit.
 */

module.exports = {
    data: new SlashCommandBuilder()
        .setName('shop')
        .setDescription('The Neural Shop: browse items or buy')
        .addStringOption(opt => opt
            .setName('action')
            .setDescription('Browse the shop or buy an item')
            .addChoices(
                { name: 'View — browse all items', value: 'view' },
                { name: 'Buy — purchase an item', value: 'buy' }
            ))
        .addStringOption(opt =>
            opt.setName('item')
                .setDescription('Item to buy (start typing for suggestions)')
                .setAutocomplete(true))
        .addIntegerOption(opt =>
            opt.setName('quantity')
            .setDescription('Quantity to buy (default: 1)')
            .setMinValue(1)
            .setMaxValue(10)),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused().toLowerCase();
        const choices = Object.values(SHOP_ITEMS)
            .filter(item => !item.hidden)
            .filter(item =>
                item.id.includes(focused) ||
                item.name.toLowerCase().includes(focused))
            .slice(0, 25)
            .map(item => ({
                name: `${item.name} — 🪙${item.price.toLocaleString()}`.slice(0, 100),
                value: item.id
            }));
        return interaction.respond(choices);
    },

    async execute(interaction) {
        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ You can only use this in <#${ALLOWED_CHANNEL}>.` });
        }

        const action = interaction.options.getString('action') ?? 'view';
        if (action === 'buy') return runShopBuy(interaction);
        return runShopView(interaction);
    }
};

/* =========================
   /shop view — browse panel
========================= */

function shopGetItemQuantity(userId, itemId) {
    const row = db.prepare('SELECT quantity FROM inventory WHERE userId = ? AND itemId = ?').get(userId, itemId);
    return row ? row.quantity : 0;
}

async function runShopView(interaction) {
    const userId = interaction.user.id;
    let currentCategory = 'all';
    let page = 0;

    const visibleItems = category => Object.values(SHOP_ITEMS).filter(item =>
        (category === 'all' ? true : item.category === category) && !item.hidden);

    const buildEmbed = (category, pageNum) => {
        const items = visibleItems(category);

        const pageSize = 5;
        const totalPages = Math.ceil(items.length / pageSize);
        const pageItems = items.slice(pageNum * pageSize, (pageNum + 1) * pageSize);

        /*
         * Daily flash deals get first billing in the panel — they are the
         * reason to open /shop every day, and the discounted price shown here
         * is the exact price purchaseItem charges (see shopItems.purchaseItem).
         */
        const dealLines = flashDeals.describeDeals();
        const dealBlock = dealLines.length
            ? [`🔥 **LIMITED-TIME FLASH DEALS — ${dealLines.length} LIVE TODAY**`, ...dealLines].join('\n')
            : null;

        const embed = new EmbedBuilder()
            .setColor(getColor(userId))
            .setTitle(formatTitle(userId, '🛒 NEURAL SHOP TERMINAL', 'Shop'))
            .setDescription(formatDescription(userId,
                [dealBlock, `Browse available items for purchase\n**Category:** ${CATEGORIES[category]?.label || category}`]
                    .filter(Boolean).join('\n\n')
            ));

        if (pageItems.length === 0) {
            embed.addFields({ name: formatFieldName(userId, 'No items', 'No items'), value: 'No items in this category.' });
        } else {
            const { getServicePurchase } = require('../systems/economy/slashServices');
            pageItems.forEach(item => {
                const currentQty = shopGetItemQuantity(userId, item.id);
                const limitText = item.limit === 999 ? '∞' : item.limit;
                const ownedText = currentQty > 0 ? ` (Owned: ${currentQty}/${limitText})` : '';

                /*
                 * SLASH services have per-item status sources: pings and
                 * auto-deposit keep their own tables; everything else is
                 * one-per-player in service_purchases.
                 */
                if (item.category === 'services') {
                    let status;
                    if (item.id === 'auto_deposit') {
                        const subRow = db.prepare('SELECT expiresAt, stacks FROM auto_deposit_subscriptions WHERE userId = ?').get(userId);
                        status = subRow && subRow.expiresAt > Date.now()
                            ? `🟢 Active — ${subRow.stacks} month(s) stacked, expires <t:${Math.floor(subRow.expiresAt / 1000)}:R>`
                            : '⬜ Not active';
                    } else if (item.id === 'work_ping' || item.id === 'fish_ping' || item.id === 'mine_ping') {
                        const cmd = item.id.replace(/_ping$/, '');
                        const row = db.prepare('SELECT enabled FROM ping_subscriptions WHERE userId = ? AND command = ?').get(userId, cmd);
                        status = row
                            ? (row.enabled ? '🟢 ON — manage with /toggle-ping' : '🔴 OFF — manage with /toggle-ping')
                            : '⬜ Not owned';
                    } else {
                        const owned = getServicePurchase(userId, item.id);
                        status = owned ? '✅ REQUESTED — SLASH will build it' : '⬜ Not requested';
                    }
                    embed.addFields({
                        name: `${item.emoji || '📦'} ${item.name} - 🪙 ${item.price.toLocaleString()}`,
                        value: formatDescription(userId, item.description, item.description) + `\n**Status:** ${status}`,
                        inline: false
                    });
                    return;
                }

                const deal = flashDeals.getDeal(item.id);
                const shownPrice = deal ? flashDeals.discountedPrice(item, deal) : item.price;
                const priceLabel = deal
                    ? `~~🪙 ${item.price.toLocaleString()}~~ 🪙 ${shownPrice.toLocaleString()} (−${deal.discount}%)`
                    : `🪙 ${item.price.toLocaleString()}`;
                const dealLine = deal
                    ? `\n🔥 **FLASH DEAL — ${deal.discount}% off**, ends <t:${Math.floor(Number(deal.endsAt) / 1000)}:R>`
                    : '';

                embed.addFields({
                    name: `${item.emoji || '📦'} ${item.name} - ${priceLabel}${ownedText}`.slice(0, 256),
                    value: formatDescription(userId, item.description, item.description) + `\n**${formatFieldName(userId, 'Limit', 'Limit')}:** ${limitText}${dealLine}`,
                    inline: false
                });
            });
        }

        embed.setFooter({ text: `Page ${pageNum + 1}/${totalPages || 1} • Buy with /shop action:buy item:<name>` });

        return embed;
    };

    const buildComponents = (category, pageNum) => {
        const items = visibleItems(category);

        const totalPages = Math.ceil(items.length / 5);
        const useHighTech = isHighTech(userId);

        // Category select menu
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('shop:category')
            .setPlaceholder(useHighTech ? '🔍 Select a category...' : 'Select a category...')
            .addOptions(
                Object.values(CATEGORIES).map(cat => ({
                    label: cat.label,
                    value: cat.value,
                    default: cat.value === category
                }))
            );

        const selectRow = new ActionRowBuilder().addComponents(selectMenu);

        // Navigation buttons
        const navRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('shop:prev')
                    .setLabel(formatButtonLabel(userId, '◀ Previous', 'Previous'))
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(pageNum === 0),
                new ButtonBuilder()
                    .setCustomId('shop:next')
                    .setLabel(formatButtonLabel(userId, 'Next ▶', 'Next'))
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(pageNum >= totalPages - 1 || totalPages === 0)
            );

        return [selectRow, navRow];
    };

    const message = await interaction.reply({
        embeds: [buildEmbed(currentCategory, page)],
        components: buildComponents(currentCategory, page),
        fetchReply: true
    });

    const collector = message.createMessageComponentCollector({
        time: 120000
    });

    collector.on('collect', async (btn) => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your shop panel.' });
        }

        if (btn.isStringSelectMenu()) {
            if (btn.customId === 'shop:category') {
                currentCategory = btn.values[0];
                page = 0;
                await btn.update({
                    embeds: [buildEmbed(currentCategory, page)],
                    components: buildComponents(currentCategory, page)
                });
            }
        } else if (btn.isButton()) {
            if (btn.customId === 'shop:prev') {
                if (page > 0) {
                    page--;
                    await btn.update({
                        embeds: [buildEmbed(currentCategory, page)],
                        components: buildComponents(currentCategory, page)
                    });
                }
            } else if (btn.customId === 'shop:next') {
                const totalPages = Math.ceil(visibleItems(currentCategory).length / 5);
                if (page < totalPages - 1) {
                    page++;
                    await btn.update({
                        embeds: [buildEmbed(currentCategory, page)],
                        components: buildComponents(currentCategory, page)
                    });
                }
            }
        }
    });

    collector.on('end', async () => {
        try {
            await message.edit({ components: [] });
        } catch {}
    });
}

/* =========================
   /shop action:buy — purchase flow
========================= */

async function runShopBuy(interaction) {
    const itemInput = interaction.options.getString('item');
    const quantity = interaction.options.getInteger('quantity') || 1;

    const item = getItemByName(itemInput);

    if (!item) {
        return interaction.reply({
            content: `❌ Item "${itemInput}" not found. Use /shop view to see available items.` });
    }

    if (item.hidden) {
        return interaction.reply({
            content: `❌ This item cannot be purchased directly.` });
    }

    await getUser(interaction.user.id);
    const autoOpen = db.prepare("SELECT autoOpenBoxes FROM users WHERE userId = ?").get(interaction.user.id)?.autoOpenBoxes === 1;
    const opensImmediately = autoOpen && (item.id === 'mystery_box' || item.id === 'lucky_mystery');
    const result = purchaseItem(interaction.user.id, item.id, quantity, { autoOpen: opensImmediately });
    if (!result.ok) {
        return interaction.reply({ content: `❌ ${result.message}` });
    }
    const totalCost = result.totalCost;

    /*
     * XP / Mega XP Boost purchases activate the timed boost ROLE instead of
     * stacking inventory charges — 3 days for XP Boost, 7 days for Mega.
     */
    let boostNote = null;
    let boostExpiry = null;
    if (item.id === 'xp_boost' || item.id === 'mega_xp_boost') {
        boostExpiry = grantBoostFromPurchase(interaction.user.id, item.id, quantity);
        const roleId = BOOST_ROLES[item.id]?.roleId;
        if (boostExpiry && roleId && interaction.guild) {
            try {
                const member = await interaction.guild.members.fetch(interaction.user.id);
                if (!member.roles.cache.has(roleId)) {
                    await member.roles.add(roleId, 'XP boost activated');
                }
            } catch (error) {
                console.error('Unable to add boost role:', error.message);
            }
        }
        boostNote = `⚡ Boost active until <t:${Math.floor(boostExpiry / 1000)}:F> (<t:${Math.floor(boostExpiry / 1000)}:R>)`;
    }

    // Send premium notification
    if (item.category === 'premium' || item.category === 'services') {
        try {
            const client = interaction.client;
            const channel = await client.channels.fetch(PREMIUM_NOTIFICATION_CHANNEL);
            if (channel) {
                const premiumEmbed = new EmbedBuilder()
                    .setColor(0xffd700)
                    .setTitle('💎 PREMIUM PURCHASE NOTIFICATION')
                    .setDescription(
                        `I, SLASH, promise to give you **${quantity}x ${item.name}** and make it for you as soon as I can. Thanks for your purchase!`
                    )
                    .addFields(
                        { name: '👤 Purchaser', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                        { name: '📦 Item', value: `${item.emoji || '💎'} ${item.name}`, inline: true },
                        { name: '🔢 Quantity', value: quantity.toString(), inline: true },
                        { name: '💰 Cost', value: `🪙 ${totalCost.toLocaleString()}`, inline: true }
                    )
                    .setTimestamp();

                await channel.send({
                    content: `<@${OWNER_ID}>`,
                    embeds: [premiumEmbed]
                });
            }
        } catch (error) {
            console.error('Failed to send premium notification:', error);
        }
    }

    const userId = interaction.user.id;
    const useHighTech = isHighTech(userId);

    if ((item.id === 'mystery_box' || item.id === 'lucky_mystery') && autoOpen) {
        const { openMysteryBox } = require('./open-box');
        const results = [];
        for (let i = 0; i < quantity; i += 1) results.push(...openMysteryBox(interaction.user.id, item.id === 'lucky_mystery'));
        const summary = results.map(reward => reward.type === 'money'
            ? `${reward.positive ? '💰' : '💸'} ${reward.positive ? '+' : '-'}🪙${reward.value.toLocaleString()}`
            : reward.type === 'xp' ? `⬆️ +${reward.value.toLocaleString()} XP`
                : reward.type === 'item' ? `🎁 ${reward.value}` : '◼️ No reward').join('\n');
        const embed = new EmbedBuilder()
            .setColor(getColor(userId))
            .setTitle(formatTitle(userId, '🛒 PURCHASE SUCCESSFUL', 'Purchase Successful'))
            .setDescription(formatDescription(userId, `You bought ${quantity}x ${item.name} for 🪙 ${totalCost.toLocaleString()} and opened them immediately.`, `You bought ${quantity}x ${item.name} for 🪙 ${totalCost.toLocaleString()} and opened them immediately.`))
            .addFields(
                { name: formatFieldName(userId, 'Item', 'Item'), value: item.name, inline: true },
                { name: formatFieldName(userId, 'Quantity', 'Quantity'), value: quantity.toString(), inline: true },
                { name: formatFieldName(userId, 'Cost', 'Cost'), value: `🪙 ${totalCost.toLocaleString()}`, inline: true },
                { name: formatFieldName(userId, 'Auto-Open Results', 'Auto-Open Results'), value: summary.slice(0, 1024), inline: false }
            );

        appendPurchaseExtras(embed, userId, item, result);
        return interaction.reply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
        .setColor(getColor(userId))
        .setTitle(formatTitle(userId, '🛒 PURCHASE SUCCESSFUL', 'Purchase Successful'))
        .setDescription(formatDescription(userId, `You bought ${quantity}x ${item.name} for 🪙 ${totalCost.toLocaleString()}`, `You bought ${quantity}x ${item.name} for 🪙 ${totalCost.toLocaleString()}`))
        .addFields(
            { name: formatFieldName(userId, 'Item', 'Item'), value: item.name, inline: true },
            { name: formatFieldName(userId, 'Quantity', 'Quantity'), value: quantity.toString(), inline: true },
            { name: formatFieldName(userId, 'Cost', 'Cost'), value: `🪙 ${totalCost.toLocaleString()}`, inline: true }
        );

    if (item.id === 'mystery_box' || item.id === 'lucky_mystery') {
        embed.addFields({ name: formatFieldName(userId, 'Note', 'Note'), value: 'Use /open-box to open your mystery boxes.', inline: false });
    }

    if (boostNote) {
        embed.addFields({ name: formatFieldName(userId, '⚡ Boost Active', 'Boost Active'), value: boostNote, inline: false });
    }

    /*
     * SLASH services (custom spaces/roles/emojis) do nothing automatic —
     * SLASH fulfils them personally. Confirm the request and append the
     * approval line to the receipt. The mention goes in the message
     * CONTENT, because mentions inside embeds never ping in Discord.
     *
     * Ping subscriptions (work/fish/mine ping) and auto-deposit ARE automatic
     * — they activate instantly in shopItems.purchaseItem, so SLASH must NOT
     * be summoned for them (he used to get a request he could not fulfil).
     * hasServiceSupport in slashServices is the single source of truth.
     */
    const needsSlash = result.isService && hasServiceSupport(item.id);
    if (needsSlash) {
        embed.setDescription(
            formatDescription(userId,
                `You bought **${item.name}** for 🪙 ${totalCost.toLocaleString()} — SLASH will build this for you personally.`,
                `You bought ${item.name} for 🪙 ${totalCost.toLocaleString()} — SLASH will build this for you personally.`
            )
        );
        embed.addFields({
            name: formatFieldName(userId, '✅ Approval', 'Approval'),
            value: buildSlashApproval(item, quantity, totalCost),
            inline: false
        });
        return interaction.reply({
            content: `<@${SLASH_USER_ID}> — new request from <@${interaction.user.id}>: **${item.name}** (🪙 ${totalCost.toLocaleString()})`,
            embeds: [embed]
        });
    }

    if (result.isService) {
        // Automatic service (ping subscription / auto-deposit): activation is
        // already done — show a receipt that says so, with no SLASH summon.
        embed.setDescription(
            formatDescription(userId,
                `You bought **${item.name}** for 🪙 ${totalCost.toLocaleString()} — it is active immediately.`,
                `You bought ${item.name} for 🪙 ${totalCost.toLocaleString()} — it is active immediately.`
            )
        );
        const activationNote = item.id === 'auto_deposit'
            ? 'Your auto-deposit subscription is live — your wallet is swept into the bank every night.'
            : 'Your ping subscription is live — manage it any time with **/toggle-ping**.';
        embed.addFields({
            name: formatFieldName(userId, '✅ Activation', 'Activation'),
            value: activationNote,
            inline: false
        });
    }

    /*
     * Streak Protection / Streak Shield. The shield is different from the
     * banked day packs: it activates ON PURCHASE (shopItems adds the cover days
     * inside the purchase transaction), so the receipt says so explicitly.
     */
    if (item.id === 'streak_protection_day' || item.id === 'streak_protection_week' || item.id === 'streak_shield') {
        const sp = require('../systems/economy/streakProtection');
        const activated = Number(result.shieldDays) > 0
            ? `✅ **Activated on purchase** — ${result.shieldDays} shield day(s) banked.\n`
            : '';
        embed.addFields({
            name: formatFieldName(userId, '🛡️ Streak Protection', 'Streak Protection'),
            value: activated + sp.describeBalance(interaction.user.id),
            inline: false
        });
    }

    appendPurchaseExtras(embed, userId, item, result);
    return interaction.reply({ embeds: [embed] });
}

/*
 * Receipt extras shared by every successful purchase path: the flash discount
 * that was actually applied, and the contents of an instantly-opened Dragon
 * Egg Crate. Kept out of the main flow so each early return stays readable.
 */
function appendPurchaseExtras(embed, userId, item, result) {
    if (result.discount) {
        embed.addFields({
            name: formatFieldName(userId, '🔥 Flash deal applied', '🔥 Flash deal applied'),
            value: `**${result.discount}% off** — you paid 🪙${Number(result.unitPrice).toLocaleString()} each instead of 🪙${Number(item.price).toLocaleString()}.`,
            inline: false
        });
    }

    if (Array.isArray(result.eggs) && result.eggs.length) {
        const { EGG_TYPES } = require('../systems/dragons/dragonCatalog');
        const lines = result.eggs.map(egg => {
            const type = EGG_TYPES[egg.eggType] || null;
            const side = type?.side || egg.side;
            return `${type?.emoji || '🥚'} **${type?.name || egg.eggType}** — ${type?.rarity || egg.rarity} · ${side === 'evil' ? '🩸 Onslaught' : '🌌 Dragonflight'}`;
        });
        embed.addFields({
            name: formatFieldName(userId, '🥚 Crate contents', '🥚 Crate contents'),
            value: [lines.join('\n'), '', '_Incubate them from /profile, **Eggs** panel — they hatch into dragons or beasts in 24–48h._'].join('\n').slice(0, 1024),
            inline: false
        });
    }

    return embed;
}
