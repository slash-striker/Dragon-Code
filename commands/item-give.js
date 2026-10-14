const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { SHOP_ITEMS, getItemByName, getItemQuantity } = require('../systems/economy/shopItems');
const { addItem, removeItem } = require('../systems/economy/inventoryh');
const db = require('../database');

/* Stored fish stack in fishing_inventory (one row per catch, soldAt IS NULL),
   so quantities can be large — the fish cap is higher than the shop cap. */
const FISH_MAX_QUANTITY = 100;
const FISH_PICKER_MS = 60_000;

function getStoredFishGroups(userId) {
    return db.prepare(`
        SELECT fishId,
               MAX(name)   AS name,
               MAX(emoji)  AS emoji,
               MAX(rarity) AS rarity,
               COUNT(*)    AS quantity,
               MAX(value)  AS bestValue
        FROM fishing_inventory
        WHERE userId = ? AND soldAt IS NULL
        GROUP BY fishId
        ORDER BY quantity DESC, name ASC
    `).all(userId);
}

/*
 * Fish transfer — moves `amount` catches of `fishId` from the sender's live
 * tank into the target's. One db.transaction: remove + insert succeed or
 * fail together. Cheapest catches move first (consistent with selling),
 * name/emoji/rarity/location are preserved so the dex and inventory keep
 * rendering the transferred fish identically.
 */
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

module.exports = {
    // Fish-transfer internals (exported for reuse + tests).
    transferFish,
    getStoredFishGroups,

    data: new SlashCommandBuilder()
        .setName('item-give')
        .setDescription('Give one of your items or stored fish to another user')
        .addUserOption(opt =>
            opt.setName('target')
                .setDescription('User to give to')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('kind')
                .setDescription('What you are giving (default: shop item)')
                .addChoices(
                    { name: '📦 Shop item (default)', value: 'item' },
                    { name: '🐟 Stored fish (from your live tank)', value: 'fish' }
                )
        )
        .addStringOption(opt =>
            opt.setName('item')
                .setDescription('Item to give (shop item name, or a fish — pick a fish after sending)')
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addIntegerOption(opt =>
            opt.setName('amount')
                .setDescription('How many to give (default: 1)')
                .setMinValue(1)
                .setMaxValue(100)
        ),

    async autocomplete(interaction) {
        const kind = interaction.options.getString('kind') || 'item';
        const focused = (interaction.options.getFocused() || '').toLowerCase();

        // Fish autocomplete: the user's own stored tank, grouped by species.
        const fishChoices = getStoredFishGroups(interaction.user.id)
            .filter(fish => fish.name.toLowerCase().includes(focused))
            .slice(0, 25)
            .map(fish => ({
                name: `${fish.emoji || '🐟'} ${fish.name} ×${fish.quantity} stored`.slice(0, 100),
                value: `fish:${fish.fishId}`
            }));

        // Item autocomplete: shop catalogue, names only.
        const itemChoices = Object.values(SHOP_ITEMS)
            .filter(item => item.name.toLowerCase().includes(focused))
            .slice(0, 25)
            .map(item => ({ name: item.name.slice(0, 100), value: item.name }));

        return interaction.respond(kind === 'fish' ? fishChoices : itemChoices);
    },

    async execute(interaction) {
        const target = interaction.options.getUser('target');
        const kind = interaction.options.getString('kind') || 'item';
        const itemInput = interaction.options.getString('item') ?? '';
        const quantity = interaction.options.getInteger('amount') || 1;

        if (target.id === interaction.user.id) {
            return interaction.reply({ content: '❌ You cannot give to yourself.', ephemeral: true });
        }
        if (target.bot) {
            return interaction.reply({ content: '❌ Bots have no pockets — pick a human.', ephemeral: true });
        }

        // ---------- Fish flow ----------
        // The `fish:` prefix can come straight from the autocomplete value, or
        // the user can pick "🎣 Pick a stored fish…" to open a select menu.
        if (kind === 'fish' || itemInput.startsWith('fish:')) {
            const fishId = itemInput.startsWith('fish:') ? itemInput.slice(5) : null;

            if (!fishId) {
                const groups = getStoredFishGroups(interaction.user.id);
                if (!groups.length) {
                    return interaction.reply({ content: '🎣 Your live tank is empty — catch something with `/fish` first.', ephemeral: true });
                }
                const menu = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`item-give-component:fish:${interaction.user.id}:${target.id}`)
                        .setPlaceholder(`Pick a fish to give ${quantity > 1 ? `${quantity}× ` : ''}to ${target.username}`)
                        .addOptions(groups.slice(0, 25).map(fish => ({
                            label: `${fish.emoji || '🐟'} ${fish.name}`.slice(0, 100),
                            description: `You have ×${fish.quantity} stored`.slice(0, 100),
                            value: fish.fishId
                        })))
                );
                return interaction.reply({
                    content: `🐟 **Give fish to ${target}** — pick the species (amount: **${quantity}**).`,
                    components: [menu],
                    ephemeral: true
                });
            }

            if (quantity > FISH_MAX_QUANTITY) {
                return interaction.reply({ content: `❌ Fish transfers are capped at ${FISH_MAX_QUANTITY} per command.`, ephemeral: true });
            }

            const result = transferFish(interaction.user.id, target.id, fishId, quantity);
            if (!result.ok) {
                return interaction.reply({
                    content: `❌ You only have ${result.available}× that fish stored; you cannot give ${quantity}.`,
                    ephemeral: true
                });
            }

            const fish = result.fish;
            const embed = new EmbedBuilder()
                .setColor(0x00d4ff)
                .setTitle('🐟 FISH TRANSFERRED')
                .setDescription(`Gave ${quantity}× ${fish.emoji} **${fish.name}** to ${target.tag}`)
                .addFields(
                    { name: 'Target', value: `<@${target.id}>`, inline: true },
                    { name: 'Species', value: `${fish.name} (${fish.rarity})`, inline: true },
                    { name: 'Quantity', value: quantity.toString(), inline: true }
                )
                .setFooter({ text: 'The fish now live in their live tank — /fish action:inventory to see them' })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        // ---------- Shop item flow (unchanged behaviour) ----------
        if (!itemInput) {
            return interaction.reply({ content: '❌ Name the item to give — try typing `item:` for suggestions.', ephemeral: true });
        }
        const item = getItemByName(itemInput);

        if (!item) {
            return interaction.reply({
                content: `❌ Item "${itemInput}" not found.`, ephemeral: true });
        }

        // Check limit
        const currentQty = getItemQuantity(target.id, item.id, db);
        if (currentQty + quantity > item.limit) {
            const canGive = item.limit - currentQty;
            if (canGive <= 0) {
                return interaction.reply({
                    content: `❌ ${target.tag} has reached the limit for ${item.name} (${item.limit}).`, ephemeral: true });
            }
            return interaction.reply({
                content: `❌ Can only give ${canGive} more ${item.name} to ${target.tag} (limit: ${item.limit}).`, ephemeral: true });
        }

        const senderQty = getItemQuantity(interaction.user.id, item.id, db);
        if (senderQty < quantity) {
            return interaction.reply({
                content: `❌ You only have ${senderQty}x ${item.name}; you cannot give ${quantity}.`, ephemeral: true });
        }

        removeItem(interaction.user.id, item.id, quantity, db);
        addItem(target.id, item.id, quantity);

        const embed = new EmbedBuilder()
            .setColor(0x00ff00)
            .setTitle('🎁 ITEM GIVEN')
            .setDescription(`Gave ${quantity}x ${item.name} to ${target.tag}`)
            .addFields(
                { name: 'Target', value: `<@${target.id}>`, inline: true },
                { name: 'Item', value: item.name, inline: true },
                { name: 'Quantity', value: quantity.toString(), inline: true }
            );

        return interaction.reply({ embeds: [embed] });
    },

    /*
     * Component handler for the fish select menu, wired from index.js
     * (customId: item-give-component:fish:<senderId>:<targetId>).
     */
    async handleComponent(interaction) {
        const [, flow, senderId, targetId, fishId] = interaction.customId.split(':');
        if (flow !== 'fish' || !senderId || !targetId || !fishId) {
            return interaction.update({ content: '❌ This fish picker expired or is invalid.', components: [] }).catch(() => {});
        }
        if (interaction.user.id !== senderId) {
            return interaction.reply({ content: 'This fish picker is not yours.', ephemeral: true }).catch(() => {});
        }

        // Quantity was fixed when the picker was opened (echoed in the prompt).
        const quantity = Number(interaction.message?.content?.match(/amount: \*\*(\d+)\*\*/)?.[1]) || 1;

        const transfer = transferFish(senderId, targetId, fishId, quantity);

        if (!transfer.ok) {
            return interaction.update({
                content: '❌ Transfer failed — you no longer have enough of that fish stored.',
                components: []
            }).catch(() => {});
        }

        const fish = transfer.fish;
        await interaction.update({
            content: `✅ Gave **${quantity}× ${fish.emoji} ${fish.name}** to <@${targetId}>. The fish now live in their tank.`,
            components: []
        }).catch(() => {});
    }
};
