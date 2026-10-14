const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');

const ALLOWED_CHANNEL = '1504562791967756448';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('daily-leaderboard')
        .setDescription('View the top daily streak leaders'),

    async execute(interaction) {

        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ SYSTEM LOCKED → Use this in <#${ALLOWED_CHANNEL}>.` });
        }

        // Acknowledge first — resolving member names below can hit the Discord
        // API once per entry, which otherwise blows the 3-second reply window.
        await interaction.deferReply();

        // ------------------------------
        // FETCH DATA
        // ------------------------------
        const rows = db.prepare(`
            SELECT userId, dailyStreak
            FROM users
            WHERE length(userId) BETWEEN 17 AND 20
              AND userId NOT GLOB '*[^0-9]*'
            ORDER BY dailyStreak DESC, userId ASC
            LIMIT 10
        `).all();

        const guild = interaction.guild;

        // ------------------------------
        // FORMAT LEADERBOARD
        // ------------------------------
        const lines = await Promise.all(
            rows.map(async (u, i) => {
                let name = `<@${u.userId}>`;

                try {
                    // Cache-first: only hit the API when the member is unknown.
                    const member = guild.members.cache.get(u.userId)
                        ?? await guild.members.fetch(u.userId).catch(() => null);
                    name =
                        member?.nickname ||
                        member?.user?.globalName ||
                        member?.user?.username ||
                        name;
                } catch {}

                const medal =
                    i === 0 ? '🥇' :
                    i === 1 ? '🥈' :
                    i === 2 ? '🥉' : '🔹';

                return `\`${medal} #${i + 1}\` **${name}** ┃ 🔥 \`${u.dailyStreak} days\``;
            })
        );

        // ------------------------------
        // EMBED (TECH UI)
        // ------------------------------
        const embed = new EmbedBuilder()
            .setColor(0x00d4ff)
            .setTitle('📡 DAILY STREAK NETWORK INDEX')
            .setDescription(
                [
                    '```diff',
                    '+ NEURAL SCAN COMPLETE',
                    '+ DATA STREAM: ACTIVE',
                    '+ RANKING STATUS: LIVE',
                    '```',
                    '',
                    '🧠 **Top Active Users (Streak Matrix)**',
                    '',
                    lines.join('\n') || '⚠️ No data detected in system',
                    '',
                    '```yaml',
                    'SYSTEM STATUS: ONLINE',
                    'SYNC: REAL-TIME',
                    'MODE: COMPETITIVE TRACKING',
                    '```'
                ].join('\n')
            )
            .setFooter({ text: 'Neural Leaderboard System v3.1' })
            .setTimestamp();

        return interaction.editReply({
            embeds: [embed]
        });
    }
};