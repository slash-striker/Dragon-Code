const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');
const hs = require('../systems/highscores/highscoreManager');
const { NEON, neonEmbed } = require('../systems/games/neonUI');

const MODE_CHOICES = Object.entries(hs.MODES).map(([value, cfg]) => ({
    name: `${cfg.emoji} ${cfg.label}`,
    value
}));

/*
 * The canonical leaderboard body — shared by /display-hs and the auto-edit
 * that runs whenever an admin records a new highscore.
 *
 * IMPORTANT: rendered as a plain embed description, NOT an ```ansi``` panel —
 * Discord does not render user mentions (<@id>) or timestamps (<t:...>) inside
 * code blocks, which is why the leaderboard used to show raw IDs and <t:...>.
 */
function buildLeaderboardEmbed(mode = hs.DEFAULT_MODE) {
    const m = hs.normalizeMode(mode);
    const cfg = hs.MODES[m];
    const entries = hs.getTopHighscores(20, m);

    if (entries.length === 0) {
        return neonEmbed({
            title: `${cfg.emoji} NETQUEL // ${cfg.label} HIGHSCORES`,
            color: NEON.gold,
            description: '_no records logged — awaiting first submission_',
            footer: `Records are set by staff via /set or /hs-admin action:set (mode:${m})`
        });
    }

    /*
     * Ties share a medal/rank: every entry's position is 1 + the number of
     * strictly higher scores (competition ranking), so two players at #1 are
     * BOTH shown as #1 🥇 and the next player appears as #3.
     */
    const medals = ['🥇', '🥈', '🥉'];
    let lastScore = null;
    let lastPosition = 0;
    const lines = entries.map((entry, index) => {
        const position = entry.score === lastScore
            ? lastPosition
            : index + 1;
        lastScore = entry.score;
        lastPosition = position;
        const prefix = medals[position - 1] ?? `\`${String(position).padStart(2, '0')}\``;
        const date = `<t:${Math.floor(new Date(entry.setAt).getTime() / 1000)}:d>`;
        return `${prefix} <@${entry.userId}> » **${entry.score.toLocaleString()}** · ${date}`;
    });

    return neonEmbed({
        title: `${cfg.emoji} NETQUEL // ${cfg.label} HIGHSCORES`,
        color: NEON.gold,
        description: lines.join('\n'),
        footer: `Last synced <t:${Math.floor(Date.now() / 1000)}:R> • set by staff via /set or /hs-admin action:set`
    });
}

// Create the leaderboard message if needed, otherwise edit the existing one.
// Returns the message so /set hs can refresh it after each record.
async function syncLeaderboardMessage(client, mode = hs.DEFAULT_MODE) {
    const m = hs.normalizeMode(mode);
    const channel = await client.channels.fetch(hs.MODES[m].channel).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        throw new Error(`I cannot access <#${hs.MODES[m].channel}>.`);
    }

    const existingId = hs.getLeaderboardMessageId(m);
    if (existingId) {
        const existing = await channel.messages.fetch(existingId).catch(() => null);
        if (existing) {
            await existing.edit({ embeds: [buildLeaderboardEmbed(m)] });
            return existing;
        }
    }

    const message = await channel.send({ embeds: [buildLeaderboardEmbed(m)] });
    hs.setLeaderboardMessageId(message.id, m);
    return message;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('hs')
        .setDescription('View Netquel highscores')
        .addStringOption(option => option
            .setName('action')
            .setDescription('Show a player highscore or the leaderboard (default: show)')
            .addChoices(
                { name: 'Show a highscore (yours or a player\'s)', value: 'show' },
                { name: 'Show the global leaderboard here', value: 'top' }
            ))
        .addUserOption(option => option
            .setName('user')
            .setDescription('Player to inspect (for show)')
            .setRequired(false))
        .addStringOption(option => option
            .setName('mode')
            .setDescription('Leaderboard mode')
            .addChoices(...MODE_CHOICES)
            .setRequired(false)),
    /*
     * The admin subcommands (set / display) moved to /hs-admin — Discord
     * cannot hide individual subcommands, so they live in a command that is
     * hidden from non-admins entirely. /set hs (hidden) still delegates to
     * the same shared implementation.
     */

    async execute(interaction) {
        const subcommand = interaction.options.getString('action') ?? 'show';

        const mode = hs.normalizeMode(interaction.options.getString('mode') ?? hs.DEFAULT_MODE);
        const cfg = hs.MODES[mode];

        if (subcommand === 'top') {
            return interaction.reply({ embeds: [buildLeaderboardEmbed(mode)] });
        }

        // Default: /hs show [user] [mode]
        const target = interaction.options.getUser('user') ?? interaction.user;
        const entry = hs.getHighscore(target.id, mode);

        if (!entry) {
            return interaction.reply({
                embeds: [neonEmbed({
                    userId: target.id,
                    title: `${cfg.emoji} NETQUEL // ${cfg.label} HIGHSCORE DOSSIER`,
                    description: [
                        `**Player** » <@${target.id}>`,
                        `**Highscore** » _not recorded_`,
                        '',
                        '_staff can log records with /hs-admin set_'
                    ].join('\n')
                })]
            });
        }

        const rank = hs.getHighscoreRank(target.id, mode);
        return interaction.reply({
            embeds: [neonEmbed({
                userId: target.id,
                title: `${cfg.emoji} NETQUEL // ${cfg.label} HIGHSCORE DOSSIER`,
                color: NEON.gold,
                description: [
                    `**Player** » <@${target.id}>`,
                    `**Highscore** » **${entry.score.toLocaleString()}**`,
                    `**Global rank** » #${rank}`,
                    `**Recorded** » <t:${Math.floor(new Date(entry.setAt).getTime() / 1000)}:R> by <@${entry.setBy}>`,
                    entry.note ? `**Note** » ${entry.note}` : null
                ].filter(line => line !== null).join('\n')
            })]
        });
    },

    // Exposed for tests.
    buildLeaderboardEmbed,
    syncLeaderboardMessage
};
