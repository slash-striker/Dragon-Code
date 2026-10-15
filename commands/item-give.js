const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { SHOP_ITEMS, getItemByName, getItemQuantity } = require('../systems/economy/shopItems');
const { addItem, removeItem } = require('../systems/economy/inventoryh');
const db = require('../database');

const FISH_MAX_QUANTITY = 100;
const PICKER_PREFIX = 'item-give-component:';

function getStoredFishGroups(userId) {
    return db.prepare(`
        SELECT fishId, MAX(name) AS name, MAX(emoji) AS emoji, MAX(rarity) AS rarity,
               COUNT(*) AS quantity, MAX(value) AS bestValue
        FROM fishing_inventory
        WHERE userId = ? AND soldAt IS NULL
        GROUP BY fishId
        ORDER BY quantity DESC, name ASC
    `).all(userId);
}

function transferFish(fromUserId, toUserId, fishId, amount) {
    return db.transaction(() => {
        const rows = db.prepare(`
            SELECT * FROM fishing_inventory
            WHERE userId = ? AND fishId = ? AND soldAt IS NULL
            ORDER BY value ASC, caughtAt ASC
            LIMIT ?
        `).all(fromUserId, fishId, amount);
        if (rows.length !== amount) return { ok: false, available: rows.length };
        const insert = db.prepare(`
            INSERT INTO fishing_inventory
                (userId, fishId, name, rarity, emoji, weight, value, caughtAt, soldAt, location)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        `);
        for (const row of rows) {
            insert.run(toUserId, row.fishId, row.name, row.rarity, row.emoji,
                row.weight, row.value, row.caughtAt, row.location ?? null);
            db.prepare('DELETE FROM fishing_inventory WHERE catchId = ?').run(row.catchId);
        }
        return { ok: true, fish: rows[0] };
    })();
}

function pickerEmbed(target, kind, amount) {
    return new EmbedBuilder()
        .setColor(0x00d4ff)
        .setTitle('🎁 GIVE ITEM // TRANSFER TERMINAL')
        .setDescription([
            `**Recipient:** <@${target}>`,
            `**Type:** ${kind === 'fish' ? '🐟 Stored fish' : '📦 Shop item'}`,
            `**Quantity:** ${amount}`,
            '',
            'Choose the item below. A successful selection immediately moves it from your inventory to the recipient.'
        ].join('\n'))
        .setFooter({ text: 'This private picker only works for the person who opened it.' });
}

function buildPickerRows(ownerId, targetId, kind = 'item', amount = 1, page = 0) {
    amount = Math.min(FISH_MAX_QUANTITY, Math.max(1, Number(amount) || 1));
    const kindMenu = new StringSelectMenuBuilder()
        .setCustomId(`${PICKER_PREFIX}kind:${ownerId}:${targetId}`)
        .setPlaceholder(kind === 'fish' ? '🐟 Stored fish' : '📦 Shop items')
        .addOptions([
            { label: '📦 Shop items', value: 'item', default: kind === 'item' },
            { label: '🐟 Stored fish', value: 'fish', default: kind === 'fish' }
        ]);
    const quantityMenu = new StringSelectMenuBuilder()
        .setCustomId(`${PICKER_PREFIX}quantity:${ownerId}:${targetId}:${kind}`)
        .setPlaceholder(`Quantity: ${amount}`)
        .addOptions([1, 5, 10, 25, 50, 100].map(value => ({
            label: `${value} item${value === 1 ? '' : 's'}`,
            value: String(value),
            default: value === amount
        })));

    const allItems = kind === 'fish'
        ? getStoredFishGroups(ownerId).map(fish => ({
            label: `${fish.emoji || '🐟'} ${fish.name}`.slice(0, 100),
            description: `Owned: ${fish.quantity} · ${fish.rarity || 'Fish'}`.slice(0, 100),
            value: `fish:${fish.fishId}`
        }))
        : Object.values(SHOP_ITEMS)
            .filter(item => getItemQuantity(ownerId, item.id, db) > 0)
            .map(item => ({
                label: item.name.slice(0, 100),
                description: `Owned: ${getItemQuantity(ownerId, item.id, db)} · limit ${item.limit}`.slice(0, 100),
                value: `item:${item.id}`
            }));
    const pages = Math.max(1, Math.ceil(allItems.length / 25));
    page = Math.max(0, Math.min(Number(page) || 0, pages - 1));
    const items = allItems.slice(page * 25, (page + 1) * 25);
    const itemMenu = new StringSelectMenuBuilder()
        .setCustomId(`${PICKER_PREFIX}select:${ownerId}:${targetId}:${kind}:${amount}:${page}`)
        .setPlaceholder(items.length ? `Choose an item (${page + 1}/${pages})…` : 'Nothing available in this category')
        .setDisabled(!items.length)
        .addOptions(items.length ? items : [{ label: 'No items available', value: 'none' }]);
    const rows = [
        new ActionRowBuilder().addComponents(kindMenu),
        new ActionRowBuilder().addComponents(quantityMenu),
        new ActionRowBuilder().addComponents(itemMenu)
    ];
    if (pages > 1) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${PICKER_PREFIX}page:${ownerId}:${targetId}:${kind}:${amount}:${page - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId(`${PICKER_PREFIX}page:${ownerId}:${targetId}:${kind}:${amount}:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1)
        ));
    }
    return rows;
}

module.exports = {
    transferFish,
    getStoredFishGroups,
    data: new SlashCommandBuilder()
        .setName('item-give')
        .setDescription('Open a guided picker to give an item or stored fish to another user')
        .addUserOption(opt => opt.setName('target').setDescription('User to give to').setRequired(true)),

    async execute(interaction) {
        const target = interaction.options.getUser('target', true);
        if (target.id === interaction.user.id) return interaction.reply({ content: '❌ You cannot give items to yourself.', ephemeral: true });
        if (target.bot) return interaction.reply({ content: '❌ Bots have no pockets — pick a human.', ephemeral: true });
        return interaction.reply({
            embeds: [pickerEmbed(target.id, 'item', 1)],
            components: buildPickerRows(interaction.user.id, target.id),
            ephemeral: true
        });
    },

    async handleComponent(interaction) {
        const [, verb, ownerId, targetId, kind, amountText, pageText] = interaction.customId.split(':');
        if (!['kind', 'quantity', 'page', 'select'].includes(verb)) {
            return interaction.reply({ content: 'This picker action is not supported.', ephemeral: true }).catch(() => {});
        }
        if (!ownerId || !targetId) return interaction.reply({ content: 'This picker expired or is invalid.', ephemeral: true }).catch(() => {});
        if (interaction.user.id !== ownerId) return interaction.reply({ content: 'This private item picker is not yours.', ephemeral: true }).catch(() => {});
        const target = await interaction.client.users.fetch(targetId).catch(() => null);
        if (!target || target.bot || target.id === ownerId) return interaction.update({ content: '❌ Recipient is no longer valid.', embeds: [], components: [] }).catch(() => {});
        if (verb !== 'kind' && !['item', 'fish'].includes(kind)) {
            return interaction.reply({ content: '❌ Invalid picker category.', ephemeral: true }).catch(() => {});
        }
        if (verb === 'page' && (!['item', 'fish'].includes(kind) || !Number.isInteger(Number(amountText)) || !Number.isInteger(Number(pageText)))) {
            return interaction.reply({ content: '❌ Invalid page control.', ephemeral: true }).catch(() => {});
        }

        if (verb === 'kind' || verb === 'quantity' || verb === 'page') {
            const nextKind = verb === 'kind' ? interaction.values?.[0] : kind;
            const nextAmount = verb === 'quantity' ? Number(interaction.values?.[0]) : Number(amountText || 1);
            const nextPage = verb === 'page' ? Number(pageText) : Number(pageText || 0);
            if (!['item', 'fish'].includes(nextKind) || !Number.isInteger(nextAmount) || nextAmount < 1 || nextAmount > FISH_MAX_QUANTITY || !Number.isInteger(nextPage)) {
                return interaction.reply({ content: '❌ Invalid picker choice.', ephemeral: true }).catch(() => {});
            }
            return interaction.update({
                embeds: [pickerEmbed(targetId, nextKind, nextAmount)],
                components: buildPickerRows(ownerId, targetId, nextKind, nextAmount, nextPage)
            });
        }

        if (verb !== 'select') return interaction.reply({ content: 'This picker action is not supported.', ephemeral: true }).catch(() => {});
        const chosen = interaction.values?.[0];
        const amount = Number(amountText) || 1;
        if (!chosen || chosen === 'none' || !['item', 'fish'].includes(kind) || !Number.isInteger(amount) || amount < 1 || amount > FISH_MAX_QUANTITY) {
            return interaction.reply({ content: '❌ Choose a valid item and quantity.', ephemeral: true }).catch(() => {});
        }

        if (kind === 'fish') {
            const fishId = chosen.startsWith('fish:') ? chosen.slice(5) : '';
            const result = transferFish(ownerId, targetId, fishId, amount);
            if (!result.ok) {
                return interaction.update({ embeds: [new EmbedBuilder().setColor(0xff5577).setTitle('Transfer failed').setDescription(`You have only **${result.available}** of that fish; the transfer was not made.`)], components: [] });
            }
            return interaction.update({ embeds: [new EmbedBuilder().setColor(0x00d4ff).setTitle('🐟 FISH TRANSFERRED').setDescription(`Gave **${amount}× ${result.fish.emoji || '🐟'} ${result.fish.name}** to <@${targetId}>.`).setTimestamp()], components: [] });
        }

        const itemId = chosen.startsWith('item:') ? chosen.slice(5) : '';
        const item = Object.values(SHOP_ITEMS).find(entry => entry.id === itemId) || getItemByName(itemId);
        if (!item) return interaction.update({ content: '❌ That item is no longer available.', embeds: [], components: [] });
        const transfer = db.transaction(() => {
            const senderQty = getItemQuantity(ownerId, item.id, db);
            const targetQty = getItemQuantity(targetId, item.id, db);
            if (senderQty < amount) throw new Error(`You only own ${senderQty} ${item.name}.`);
            if (targetQty + amount > item.limit) throw new Error(`Recipient can hold only ${Math.max(0, item.limit - targetQty)} more ${item.name}.`);
            removeItem(ownerId, item.id, amount, db);
            addItem(targetId, item.id, amount);
        });
        try { transfer(); } catch (error) {
            return interaction.update({ embeds: [new EmbedBuilder().setColor(0xff5577).setTitle('Transfer failed').setDescription(error.message)], components: [] });
        }
        return interaction.update({ embeds: [new EmbedBuilder().setColor(0x00d4ff).setTitle('🎁 ITEM GIVEN').setDescription(`Gave **${amount}× ${item.name}** to <@${targetId}>.`).setTimestamp()], components: [] });
    }
};
