const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('level-leaderboard')
        .setDescription('View the top XP users.'),
    async execute(interaction) {
        const rows = db.prepare(`
            SELECT userId, xp, level FROM users
            ORDER BY xp DESC, level DESC LIMIT 10
        `).all();
        const description = rows.length
            ? rows.map((row, index) =>
                `**#${index + 1}** <@${row.userId}> — Level ${row.level || 0}, ${Number(row.xp || 0).toLocaleString()} XP`
            ).join('\n')
            : 'No XP data is available yet.';
        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x00d4ff)
                    .setTitle('XP Leaderboard')
                    .setDescription(description)
            ]
        });
    }
};
