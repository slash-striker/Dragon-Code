const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { SHOP_ITEMS } = require('../systems/economy/shopItems');

/*
 * /inventory — the SHOP ITEMS inventory.
 *
 * Each storage system has its own dedicated command now:
 *   • /inventory         → this (shop items only)
 *   • /mining-inventory  → ores, refined, artifacts, drones, crew
 *   • /fish-inventory    → stored fish + fishing loadout
 *   • /fish-collection   → the species dex (collection log)
 */

module.exports = {
    data: new SlashCommandBuilder()
        .setName('inventory')
        .setDescription('View your shop item inventory')
        .addUserOption(option => option
            .setName('user')
            .setDescription('View another player\'s items')
            .setRequired(false)),

    async execute(interaction) {
        // Defer immediately — keeps the 3s reply window safe.
        await interaction.deferReply();
        const target = interaction.options.getUser('user') ?? interaction.user;
        const items = db.prepare('SELECT itemId, quantity FROM inventory WHERE userId = ? AND quantity > 0').all(target.id);

        const lines = items.length
            ? items.map(item => `${SHOP_ITEMS[item.itemId]?.emoji ?? '📦'} ${SHOP_ITEMS[item.itemId]?.name ?? item.itemId} ×${item.quantity}`)
            : ['_No items — browse the `/shop`._'];

        return interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x00d4ff)
                    .setTitle(`🎒 ${target.username}'s Items`)
                    .setDescription(lines.join('\n'))
                    .setFooter({ text: 'Mining storage: /mining-inventory · Fish storage: /fish-inventory' })
            ]
        });
    }
};
