const { SlashCommandBuilder } = require('discord.js');
const { COUNTING_CHANNEL_ID, getState, setStartingCount } = require('../systems/counting/countingManager');

// Admin role config lives in systems/admin/adminVisibility.js (DB-backed).
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('set-count')
        .setDescription('[ADMIN ONLY] Set the next number in the counting channel')
        .addIntegerOption(option => option
            .setName('number')
            .setDescription('The next number users must send')
            .setMinValue(1)
            .setRequired(true)),

    async execute(interaction) {
        if (interaction.channelId !== COUNTING_CHANNEL_ID) {
            return interaction.reply({ content: `Use this command in <#${COUNTING_CHANNEL_ID}>.` });
        }
        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ This command is restricted to administrators.' });
        }
        const nextNumber = interaction.options.getInteger('number');
        const previousNumber = getState().currentCount;
        const state = setStartingCount(nextNumber);
        // Picked up by the admin-log block in index.js (adminCommandDetails).
        interaction.adminCommandDetails = `Counting reset: **${previousNumber}** → **${nextNumber}** (next required count: ${nextNumber})`;
        return interaction.reply({ content: `✅ Counting grid synchronized. The next number is **${nextNumber}** (previous count was **${previousNumber}**).` });
    }
};
