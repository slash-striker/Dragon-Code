/*
 * /reload — force a Netquel board scrape now (staff only).
 *
 * A full scrape cannot be fast: the per-server boards only exist inside a live
 * match, so the tracker has to join, fly into the wall and wait out the game's
 * own teleport countdown twice per mode. So this answers immediately with when
 * the last good snapshot was taken, then edits the same reply when the scrape
 * lands. If a scheduled refresh is already running, this joins it instead of
 * opening a second browser.
 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { hideFromMembers } = require('../systems/admin/adminVisibility');
const service = require('../systems/netquel/netquelService');
const { boardLabel } = require('../systems/netquel/netquelLogic');

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder()
        .setName('reload')
        .setDescription('Force a Netquel leaderboard refresh right now')),

    async execute(interaction) {
        if (!service.isNetquelStaff(interaction)) {
            return interaction.reply({ content: 'This command is restricted to server staff.', ephemeral: true });
        }

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
                        : 'Scraping the site boards and hopping every in-game server now.',
                    `Last successful scrape: ${last} (${lastClock}).`
                ].join('\n\n'))
                .setFooter({ text: 'This message updates itself when the scrape finishes.' })]
        });

        const result = await service.refresh();

        if (!result.ok) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(0xff7675)
                    .setTitle('🛰️ Netquel refresh failed')
                    .setDescription([
                        `\`\`\`${String(result.error?.message ?? result.error).slice(0, 1500)}\`\`\``,
                        `Last good scrape: ${last}.`
                    ].join('\n\n'))
                    .setFooter({ text: 'Retrying automatically in 2 minutes' })]
            }).catch(() => null);
        }

        const boards = result.snapshot.boards
            .map(board => `**${boardLabel(board)}** — ${board.rows.length} row${board.rows.length === 1 ? '' : 's'}`)
            .join('\n');
        const seconds = Math.round((result.snapshot.durationMs ?? 0) / 1000);

        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(service.COLOR)
                .setTitle('🛰️ Netquel boards refreshed')
                .setDescription([
                    boards,
                    `Refreshed ${service.snapshotStamp()} · took ${seconds}s.`
                ].join('\n\n'))
                .setFooter({
                    text: `${result.alerts} enemy alert(s) • ${result.published ?? 0} channel(s) updated`
                })]
        }).catch(() => null);
    }
};
