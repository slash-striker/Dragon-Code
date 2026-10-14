const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const db = require('../database');
const { createLevelCard, getLevelFromXP, getLevelProgress, MAX_LEVEL } = require('../systems/leveling/levelingSystem');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rank')
        .setDescription('View your level and XP.')
        .addUserOption(option => option
            .setName('user')
            .setDescription('User to view')
            .setRequired(false)),
    async execute(interaction) {
        // Acknowledge immediately — the canvas render below can blow the 3s window.
        await interaction.deferReply();
        const user = interaction.options.getUser('user') || interaction.user;
        const row = db.prepare('SELECT xp, prestigeLevel FROM users WHERE userId = ?').get(user.id);
        const xp = Number(row?.xp || 0);
        const level = getLevelFromXP(xp);
        const progress = getLevelProgress(xp, level);
        const isMax = level >= MAX_LEVEL;

        const rankLines = isMax
            ? `> 👑 **APEX PROTOCOL — LEVEL ${MAX_LEVEL}**\n` +
              `> Total XP banked: **${xp.toLocaleString()}**\n` +
              `> No further tiers remain. Maximum synchronization achieved.`
            : `> ⬆️ **Level ${level} → ${level + 1}**\n` +
              `> XP: **${xp.toLocaleString()} / ${progress.required.toLocaleString()}**\n` +
              `> Sync progress: **${Math.round(progress.percent * 100)}%**\n` +
              `> Remaining: **${Math.max(0, progress.required - xp).toLocaleString()} XP**`;

        const card = await createLevelCard({
            user: {
                username: user.username,
                displayAvatarURL: options => user.displayAvatarURL(options)
            }
        }, level, xp, Number(row?.prestigeLevel || 0));
        if (!card) {
            return interaction.editReply({
                content: `${user.username}: ${rankLines.replace(/\*\*/g, '')}`
            });
        }
        const embed = new EmbedBuilder()
            .setColor(isMax ? 0xffcc00 : 0x00ffff)
            .setTitle(`📊 Rank — ${user.username}`)
            .setDescription(rankLines)
            .setImage('attachment://rank.png')
            .setFooter(isMax
                ? { text: 'APEX PROTOCOL — maximum level achieved' }
                : { text: `Next milestone: Level ${level + 1}` });

        return interaction.editReply({
            embeds: [embed],
            files: [new AttachmentBuilder(card, { name: 'rank.png' })]
        });
    }
};
