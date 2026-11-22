/*
 * /add-enemy — track a Netquel player.
 *
 * Two ways to say who an enemy is:
 *   - the alias alone (a name watch: any board hit can ping),
 *   - the join date and/or high score from their in-game profile card (a person
 *     watch: a hit only pings when the captured card still agrees).
 *
 * A card is read off every player on every live server board during the sweep,
 * so the join-date + high-score route can find somebody whose alias you do not
 * know — and a reused alias shows up as a warning instead of a false ping.
 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { hideFromMembers } = require('../systems/admin/adminVisibility');
const service = require('../systems/netquel/netquelService');
const store = require('../systems/netquel/netquelStore');
const {
    nameMatches,
    parseClan,
    parseJoinedDate,
    verifyEnemy,
    formatScore,
    boardLabel
} = require('../systems/netquel/netquelLogic');

function cardLine(profile) {
    if (!profile) return 'No profile card captured for them yet.';
    if (profile.private || profile.isPrivate) return '🔒 Their profile is private, so the card shows nothing.';
    return [
        profile.clan ? `clan **[${profile.clan}]**` : null,
        `Joined **${profile.joined ?? 'unknown'}**`,
        `high score **${formatScore(profile.highScore)}**`,
        profile.rankName || profile.rank ? `rank **${profile.rankName ?? profile.rank}**` : null,
        profile.streak ? `streak **${profile.streak}**` : null
    ].filter(Boolean).join(' · ');
}

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder()
        .setName('add-enemy')
        .setDescription('Add or remove a tracked Netquel player — by alias, or by join date + high score')
        .addStringOption(option => option
            .setName('username')
            .setDescription('In-game alias (leave empty to find them by join date + high score)')
            .setMaxLength(32))
        .addStringOption(option => option
            .setName('joined')
            .setDescription('Join date from their profile card, e.g. 11/16/2026')
            .setMaxLength(20))
        .addIntegerOption(option => option
            .setName('high-score')
            .setDescription('High score from their profile card, e.g. 2972')
            .setMinValue(0))
        .addStringOption(option => option
            .setName('clan')
            .setDescription('Clan tag from their profile card, e.g. ENOS')
            .setMaxLength(24))
        .addBooleanOption(option => option
            .setName('refresh')
            .setDescription('Open their card live before adding (default: only when no card is stored)')
            .setRequired(false))
        .addBooleanOption(option => option
            .setName('remove')
            .setDescription('Remove this enemy from the watch list instead of adding them'))),

    async execute(interaction) {
        if (!service.isNetquelStaff(interaction)) {
            return interaction.reply({ content: 'This command is restricted to server staff.', ephemeral: true });
        }

        const usernameOption = interaction.options.getString('username')?.trim() || null;
        const joinedOption = interaction.options.getString('joined')?.trim() || null;
        const highScoreOption = interaction.options.getInteger('high-score');
        const clanOption = parseClan(interaction.options.getString('clan')) || null;

        const joined = joinedOption ? parseJoinedDate(joinedOption) : null;
        if (joinedOption && !joined) {
            return interaction.reply({
                content: `Could not read **${joinedOption}** as a date. Use the card's format, e.g. \`11/16/2026\` or \`2026-11-16\`.`,
                ephemeral: true
            });
        }

        if (!usernameOption && (!joined || highScoreOption === null)) {
            return interaction.reply({
                content: 'Give a **username**, or **both** a join date and a high score so I can find the player.',
                ephemeral: true
            });
        }

        let targetName = usernameOption;
        let profile = usernameOption ? store.getPlayer(usernameOption) : null;
        let resolvedBy = 'name';

        /*
         * No alias? Resolve the person from the join date + high score captured
         * on the server boards. Two players can share a high score, so an
         * ambiguous match is reported instead of guessing.
         */
        if (!usernameOption) {
            const matches = store.findPlayersByProfile({ joined, highScore: highScoreOption, clan: clanOption });
            if (!matches.length) {
                return interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setColor(0xff7675)
                        .setTitle('🔍 No player matches that card')
                        .setDescription([
                            `Nothing captured so far has joined **${joined}** with a high score of **${formatScore(highScoreOption)}**.`,
                            'Cards are collected from every player on the live server boards during the 10-minute sweep, '
                            + 'so a player who has not been seen yet is not in the list. Try again after a sweep, or add the alias instead.'
                        ].join('\n\n'))
                        .setFooter({ text: 'Netquel tracker' })],
                    ephemeral: true
                });
            }
            if (matches.length > 1) {
                return interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setColor(0xffb020)
                        .setTitle('🔍 That card fits more than one player')
                        .setDescription([
                            `Joined **${joined}**, high score **${formatScore(highScoreOption)}** matches: `
                            + `${matches.map(entry => `**${entry.displayName}**`).join(', ')}.`,
                            'Add the username as well to pick one.'
                        ].join('\n\n'))
                        .setFooter({ text: 'Netquel tracker' })],
                    ephemeral: true
                });
            }
            profile = matches[0];
            targetName = profile.displayName;
            resolvedBy = 'profile';
        }

        /*
         * Removing lives on the same command: the lookup is the same either
         * way (alias, or join date + high score), only the last step differs.
         */
        if (interaction.options.getBoolean('remove')) {
            const existing = store.getEnemy(targetName);
            if (!existing) {
                return interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setColor(0xff7675)
                        .setTitle('🗑️ Not on the watch list')
                        .setDescription(`**${targetName}** is not a tracked enemy, so there is nothing to remove.`)
                        .setFooter({ text: 'Netquel tracker' })],
                    ephemeral: true
                });
            }

            store.removeEnemy(existing.name);
            const wasPinned = [];
            if (existing.joined) wasPinned.push(`joined **${existing.joined}**`);
            if (existing.highScore !== null && existing.highScore !== undefined) {
                wasPinned.push(`high score **${formatScore(existing.highScore)}**`);
            }
            if (existing.clan) wasPinned.push(`clan **[${existing.clan}]**`);

            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0x95a5a6)
                    .setTitle('🗑️ Enemy removed')
                    .setDescription([
                        `**${existing.displayName}** is no longer watched on any board.`,
                        wasPinned.length ? `They were pinned to ${wasPinned.join(' · ')}.` : 'They were a name-only watch.',
                        'Their alert history is cleared, so re-adding them starts fresh.'
                    ].join('\n\n'))
                    .setFooter({ text: 'Netquel tracker' })],
                ephemeral: true
            });
        }

        /*
         * Rank, streak and clan only exist on the card, so a name with no
         * stored card is looked up live before it is added. The option forces
         * that lookup even when an older card is on file.
         */
        const refreshOption = interaction.options.getBoolean('refresh');
        const shouldRefresh = refreshOption === null ? !profile : refreshOption;
        const respond = payload => (shouldRefresh ? interaction.editReply(payload) : interaction.reply(payload));
        if (shouldRefresh) {
            await interaction.deferReply({ ephemeral: true });
            const refreshed = await service.refreshPlayerCards([targetName]).catch(error => ({ errors: [error.message] }));
            if (refreshed?.cards?.length) profile = store.getPlayer(targetName) ?? profile;
        }

        let enemy;
        try {
            enemy = store.addEnemy({
                name: targetName,
                addedBy: interaction.user.id,
                channelId: interaction.channelId,
                joined: joined ?? null,
                highScore: highScoreOption,
                clan: clanOption
            });
        } catch (error) {
            return respond({ content: `Could not track **${targetName}**: ${error.message}`, ephemeral: true });
        }

        /* Report any sighting already in the current snapshot. */
        const seen = [];
        for (const board of service.getSnapshot()?.boards ?? []) {
            const row = board.rows.find(candidate => nameMatches(enemy.displayName, candidate.name));
            if (row) seen.push(`${boardLabel(board)} — rank #${row.rank} (${formatScore(row.score)})`);
        }

        const verdict = verifyEnemy(enemy, profile);
        const criteria = [];
        if (enemy.joined) criteria.push(`joined **${enemy.joined}**`);
        if (enemy.highScore !== null && enemy.highScore !== undefined) criteria.push(`high score **${formatScore(enemy.highScore)}**`);
        if (enemy.clan) criteria.push(`clan **[${enemy.clan}]**`);

        let alertLine;
        if (!criteria.length) {
            alertLine = `Watching the name. A live hit pings <@&${service.STAFF_ROLE_ID}> — at most once per 10 minutes; AFK hits post without a ping.`;
        } else if (verdict.status === 'ok') {
            alertLine = `Pinned to ${criteria.join(' · ')}. A hit only pings when the card still matches (at most once per 10 minutes; AFK never pings).`;
        } else if (verdict.status === 'mismatch') {
            alertLine = `⚠️ Pinned to ${criteria.join(' · ')}, but the card on record shows ${verdict.reason}. `
                + 'Hits will post a warning instead of pinging.';
        } else {
            alertLine = `Pinned to ${criteria.join(' · ')}. No card captured for them yet — hits will warn until a sweep opens their profile.`;
        }

        const embed = new EmbedBuilder()
            .setColor(verdict.status === 'mismatch' ? 0xffb020 : service.COLOR)
            .setTitle(resolvedBy === 'profile' ? '🎯 Enemy tracked by profile card' : '🎯 Enemy tracked')
            .setDescription([
                `**${enemy.displayName}** is now watched on every Netquel refresh.`,
                profile ? cardLine(profile) : null,
                seen.length
                    ? `Already on a board right now:\n${seen.join('\n')}`
                    : 'Not on any board in the current snapshot.',
                alertLine,
                'Day/week/all-time sightings always post quietly, without a ping.',
                `Board snapshot ${service.snapshotStamp()}.`
            ].filter(Boolean).join('\n\n'))
            .setFooter({ text: 'Netquel tracker' });

        return respond({ embeds: [embed], ephemeral: true });
    }
};
