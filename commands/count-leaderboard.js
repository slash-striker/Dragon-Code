const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { COUNTING_CHANNEL_ID, getLeaderboard, getState } = require('../systems/counting/countingManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('count-leaderboard')
        .setDescription('View the counting channel leaderboard'),

    async execute(interaction) {
        if (interaction.channelId !== COUNTING_CHANNEL_ID) {
            return interaction.reply({ content: `Use this command in <#${COUNTING_CHANNEL_ID}>.` });
        }
        const rows = getLeaderboard();
        const state = getState();
        const description = rows.length
            ? rows.map((row, index) =>
                `**${index + 1}.** <@${row.userId}> — ${row.validCounts.toLocaleString()} valid counts • best streak ${row.bestStreak.toLocaleString()}`
            ).join('\n')
            : 'No valid counts recorded yet.';
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor(0x00ff88)
                .setTitle('🟢 COUNTING GRID // LEADERBOARD')
                .setDescription(description)
                .addFields({ name: 'Current Count', value: `**${state.currentCount.toLocaleString()}**`, inline: true })
                .setFooter({ text: 'Channel-only counting statistics' })] });
    }
};
