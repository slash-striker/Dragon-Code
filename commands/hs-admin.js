const { SlashCommandBuilder } = require('discord.js');
const hs = require('../systems/highscores/highscoreManager');
const { NEON, neonEmbed } = require('../systems/games/neonUI');
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

/*
 * [ADMIN ONLY] Netquel highscore controls — /hs set + /hs display moved here.
 * Split from /hs because Discord cannot hide individual subcommands: the
 * visible /hs keeps the member-facing show/top views. /set hs (also hidden)
 * delegates to the same shared implementation via commands/hs.js.
 */
const MODE_CHOICES = Object.entries(hs.MODES).map(([value, cfg]) => ({
    name: `${cfg.emoji} ${cfg.label}`,
    value
}));

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('hs-admin')
        .setDescription('[ADMIN ONLY] Record and sync Netquel highscores')
        .addStringOption(option => option
            .setName('action')
            .setDescription('What to do')
            .setRequired(true)
            .addChoices(
                { name: 'Record a player highscore', value: 'set' },
                { name: 'Post/sync the leaderboards', value: 'display' }
            ))
        .addUserOption(option => option
            .setName('user')
            .setDescription('Player to record (for set)')
            .setRequired(false))
        .addIntegerOption(option => option
            .setName('score')
            .setDescription('Highscore value (for set)')
            .setMinValue(0)
            .setRequired(false))
        .addStringOption(option => option
            .setName('mode')
            .setDescription('Leaderboard mode (default: FFA — or all modes for display)')
            .addChoices(...MODE_CHOICES)
            .setRequired(false))
        .addStringOption(option => option
            .setName('note')
            .setDescription('Optional note, e.g. the game or event')
            .setRequired(false)),

    async execute(interaction) {
        // Runtime gate — non-admins cannot run it even via permission overrides.
        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ This command is restricted to administrators.' });
        }

        const subcommand = interaction.options.getString('action', true);

        if (subcommand === 'set') {
            const missing = [];
            if (!interaction.options.getUser('user')) missing.push('user');
            if (interaction.options.getInteger('score') === null) missing.push('score');
            if (missing.length) {
                return interaction.reply({ content: `❌ Recording a highscore needs \`${missing.join('` and \`')}\`.` });
            }
            await interaction.deferReply();
            const target = interaction.options.getUser('user', true);
            const score = interaction.options.getInteger('score', true);
            const mode = hs.normalizeMode(interaction.options.getString('mode') ?? hs.DEFAULT_MODE);
            const cfg = hs.MODES[mode];
            const note = interaction.options.getString('note');

            const previous = hs.getHighscore(target.id, mode);
            hs.setHighscore(target.id, score, interaction.user.id, note, mode);
            interaction.adminCommandDetails =
                `${cfg.label} Highscore: <@${target.id}> (${target.id})\n` +
                `Score: ${Number(previous?.score ?? 0).toLocaleString()} -> ${score.toLocaleString()}` +
                (previous ? ` (was ${previous.score.toLocaleString()})` : ' (no previous record — first entry)') +
                (note ? `\nNote: ${note}` : '');

            // Record it, then auto-edit the leaderboard in the mode's channel.
            let leaderboardStatus = '';
            try {
                await hsCommandModule().syncLeaderboardMessage(interaction.client, mode);
                leaderboardStatus = `\n🏆 ${cfg.label} leaderboard synced in <#${cfg.channel}>.`;
            } catch (error) {
                console.error('Highscore leaderboard sync failed:', error);
                leaderboardStatus = `\n⚠️ Could not update the ${cfg.label} leaderboard channel — run \`/hs-admin action:display mode:${mode}\` to repair it.`;
            }

            const isRecord = !previous || score > previous.score;
            return interaction.editReply({
                embeds: [neonEmbed({
                    userId: target.id,
                    title: `${cfg.emoji} ${cfg.label} HIGHSCORE // RECORD LOGGED`,
                    color: NEON.gold,
                    description: [
                        `**Player** » <@${target.id}>`,
                        `**Score** » **${score.toLocaleString()}**`,
                        `**Previous** » ${previous ? previous.score.toLocaleString() : '—'}`,
                        note ? `**Note** » ${note}` : null,
                        '',
                        isRecord
                            ? '≫ **NEW PERSONAL RECORD**'
                            : `_below the previous record of ${previous.score.toLocaleString()}_`,
                        leaderboardStatus.trim()
                    ].filter(line => line !== null).join('\n')
                })]
            });
        }

        // display
        await interaction.deferReply();
        const modeInput = interaction.options.getString('mode');
        const modes = modeInput ? [hs.normalizeMode(modeInput)] : Object.keys(hs.MODES);
        // Audit detail: what was (re)posted and where.
        interaction.adminCommandDetails = modes.length === Object.keys(hs.MODES).length
            ? 'Leaderboards: ALL modes (re)posted/synced in their channels'
            : `Leaderboard: ${hs.MODES[modes[0]].label} (re)posted/synced in <#${hs.MODES[modes[0]].channel}>`;
        const results = [];
        for (const m of modes) {
            try {
                const message = await hsCommandModule().syncLeaderboardMessage(interaction.client, m);
                results.push(`✅ **${hs.MODES[m].label}** → https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`);
            } catch (error) {
                results.push(`❌ **${hs.MODES[m].label}** → ${error.message}`);
            }
        }
        return interaction.editReply({ content: results.join('\n') });
    }
};

// Late require avoids a circular import at module-load time.
function hsCommandModule() {
    return require('./hs');
}
