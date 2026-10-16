const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { isAdminUser } = require('../systems/admin/adminVisibility');
const { getSwearLeaderboard } = require('../systems/economy/swearJar');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('swear-leaderboard')
        .setDescription('[ADMIN ONLY] Who has the most swear-jar entries')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ This command is restricted to administrators.', ephemeral: true });
        }

        const rows = getSwearLeaderboard(10);
        const lines = rows.length
            ? rows.map((row, index) => `**${index + 1}.** <@${row.userId}> — ${Number(row.count).toLocaleString()} swears`)
            : ['No swears recorded yet.'];

        const embed = new EmbedBuilder()
            .setColor(0xffd166)
            .setTitle('🫙 SWEAR JAR LEADERBOARD')
            .setDescription(lines.join('\n'))
            .setTimestamp();
        return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
};
