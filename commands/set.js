const { SlashCommandBuilder } = require('discord.js');
const hs = require('../systems/highscores/highscoreManager');
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

/*
 * /set — one flat command for bot-managed records (was /set hs). Recording a
 * highscore delegates to the shared implementation in /hs so both entry points
 * behave identically (record + leaderboard auto-edit).
 *
 * Admin role config lives in systems/admin/adminVisibility.js (DB-backed).
 */
module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('set')
        .setDescription('[ADMIN ONLY] Set bot-managed records')
        .addUserOption(option => option
            .setName('user')
            .setDescription('Player to record')
            .setRequired(true))
        .addIntegerOption(option => option
            .setName('score')
            .setDescription('Highscore value')
            .setMinValue(0)
            .setRequired(true))
        .addStringOption(option => option
            .setName('mode')
            .setDescription('Leaderboard mode (default: FFA)')
            .addChoices(...Object.entries(hs.MODES).map(([value, cfg]) => ({ name: `${cfg.emoji} ${cfg.label}`, value })))
            .setRequired(false))
        .addStringOption(option => option
            .setName('note')
            .setDescription('Optional note, e.g. the game or event')
            .setRequired(false)),

    async execute(interaction) {
        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ This command is restricted to administrators.' });
        }

        // Delegate to the shared implementation in /hs so both entry
        // points behave identically (record + leaderboard auto-edit).
        await interaction.deferReply();
        const hsCommand = require('./hs');
        const target = interaction.options.getUser('user', true);
        const score = interaction.options.getInteger('score', true);
        const note = interaction.options.getString('note');
        const mode = hs.normalizeMode(interaction.options.getString('mode') ?? hs.DEFAULT_MODE);
        const cfg = hs.MODES[mode];

        const previous = hs.getHighscore(target.id, mode);
        hs.setHighscore(target.id, score, interaction.user.id, note, mode);
        interaction.adminCommandDetails =
            `${cfg.label} Highscore: <@${target.id}> (${target.id})\n` +
            `Score: ${Number(previous?.score ?? 0).toLocaleString()} -> ${score.toLocaleString()}` +
            (note ? `\nNote: ${note}` : '');

        let leaderboardStatus = '';
        try {
            await hsCommand.syncLeaderboardMessage(interaction.client, mode);
            leaderboardStatus = `\n🏆 ${cfg.label} leaderboard synced in <#${cfg.channel}>.`;
        } catch (error) {
            console.error('Highscore leaderboard sync failed:', error);
            leaderboardStatus = `\n⚠️ Could not update the ${cfg.label} leaderboard channel — run \`/hs-admin action:display mode:${mode}\` to repair it.`;
        }

        const isRecord = !previous || score > previous.score;
        // The interaction was already deferReply()'d above — replying again
        // throws InteractionAlreadyReplied.
        return interaction.editReply({
            content: `🏆 ${cfg.label} highscore recorded for <@${target.id}>: **${score.toLocaleString()}**` +
                (isRecord ? ' — new personal record!' : '') +
                leaderboardStatus });
    }
};
