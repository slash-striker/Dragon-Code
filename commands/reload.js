/*
 * /reload — force a Netquel board refresh now (staff only).
 *
 * The site's day/week/all tables live on the tracker's resident browser and
 * reload in a couple of seconds, so that is the default scope. The per-server
 * boards only exist inside a live match — join, fly into the wall, wait out the
 * game's own teleport, per server — so `servers` and `all` take minutes: those
 * answer immediately with when the last good snapshot was taken, then edit the
 * same reply when the scrape lands. If a scheduled refresh is already running,
 * this joins it instead of opening a second browser.
 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { hideFromMembers } = require('../systems/admin/adminVisibility');
const service = require('../systems/netquel/netquelService');
const { boardLabel } = require('../systems/netquel/netquelLogic');

const SCOPES = [
    { name: 'site', value: 'site' },
    { name: 'servers', value: 'servers' },
    { name: 'all', value: 'all' }
];

const RUNNING = {
    site: 'Reloading the site tables (day / week / all-time) now — a few seconds on the warm browser.',
    servers: 'Hopping every in-game server now — a full sweep takes a few minutes.',
    all: 'Scraping the site tables and hopping every in-game server now — a full pass takes a few minutes.'
};

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder()
        .setName('reload')
        .setDescription('Refresh the Netquel leaderboards now (site tables are the fast default)')
        .addStringOption(option => option
            .setName('scope')
            .setDescription('site = fast day/week/all tables (seconds) · servers = in-game sweep · all = both')
            .addChoices(...SCOPES))),

    async execute(interaction) {
        if (!service.isNetquelStaff(interaction)) {
            return interaction.reply({ content: 'This command is restricted to server staff.', ephemeral: true });
        }

        const scope = interaction.options.getString('scope') ?? 'site';
        await interaction.deferReply({ ephemeral: true });

        const alreadyRunning = service.isRefreshing();
        const last = service.snapshotStamp();
        const lastClock = service.snapshotClock();

        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(service.COLOR)
                .setTitle('🛰️ Netquel refresh started')
                .setDescription([
                    alreadyRunning
                        ? 'A refresh was already running, so this one rides along with it.'
                        : RUNNING[scope] ?? RUNNING.site,
                    `Last successful scrape: ${last} (${lastClock}).`
                ].join('\n\n'))
                .setFooter({ text: 'This message updates itself when the scrape finishes.' })]
        });

        const result = scope === 'servers'
            ? await service.refreshServers()
            : scope === 'all'
                ? await service.refresh()
                : await service.refreshSite();

        /* The pass just ran, so the pending timer tick would fetch it again. */
        if (scope === 'site' && result.ok) service.rescheduleSite();

        if (!result.ok) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(0xff7675)
                    .setTitle('🛰️ Netquel refresh failed')
                    .setDescription([
                        `\`\`\`${String(result.error?.message ?? result.error).slice(0, 1500)}\`\`\``,
                        `Last good scrape: ${last}.`
                    ].join('\n\n'))
                    .setFooter({
                        text: service.trackerDisabledReason()
                            ? 'Tracker is disabled — see NETQUEL-HOSTING.md'
                            : 'Retrying automatically in 2 minutes'
                    })]
            }).catch(() => null);
        }

        /* Show what this scope actually refreshed, not the whole snapshot. */
        const boards = result.snapshot.boards
            .filter(board => scope === 'all' || (scope === 'servers' ? board.server : !board.server))
            .map(board => `**${boardLabel(board)}** — ${board.rows.length} row${board.rows.length === 1 ? '' : 's'}`)
            .join('\n');
        const seconds = ((result.snapshot.durationMs ?? 0) / 1000).toFixed(1);

        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(service.COLOR)
                .setTitle('🛰️ Netquel boards refreshed')
                .setDescription([
                    boards || '_No boards in the snapshot yet._',
                    `Refreshed ${service.snapshotStamp()} · took ${seconds}s.`
                ].join('\n\n'))
                .setFooter({
                    text: `${result.alerts} enemy alert(s) • ${result.published ?? 0} channel(s) updated`
                })]
        }).catch(() => null);
    }
};
