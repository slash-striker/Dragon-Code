/*
 * /netquel-leaderboard — the FFA/Forge standings the tracker scraped.
 *
 * Without options it returns the same message the board channels get: daily,
 * weekly, all-time and the per-server boards. Pass `server` (Cloud/3, …) to
 * look at one server's live board.
 *
 * Staff-only: hidden from members via DefaultMemberPermissions and gated
 * again at runtime to the Owner role.
 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { hideFromMembers } = require('../systems/admin/adminVisibility');
const service = require('../systems/netquel/netquelService');
const { MODES, PERIODS } = require('../systems/netquel/netquelLogic');

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder()
        .setName('netquel-leaderboard')
        .setDescription('Netquel leaderboards — FFA or Forge, daily / weekly / all-time / per-server')
        .addStringOption(option => option
            .setName('mode')
            .setDescription('Game mode')
            .addChoices({ name: 'FFA', value: 'FFA' }, { name: 'Forge', value: 'Forge' }))
        .addStringOption(option => option
            .setName('period')
            .setDescription('Board period')
            .addChoices(
                { name: 'Daily', value: 'day' },
                { name: 'Weekly', value: 'week' },
                { name: 'All-time', value: 'all' }
            ))
        .addStringOption(option => option
            .setName('server')
            .setDescription('Show one server’s live board instead of the period boards (Zenith, Vortex or Spiral)')
            .setMaxLength(24))),

    async execute(interaction) {
        if (!service.isNetquelStaff(interaction)) {
            return interaction.reply({ content: 'This command is restricted to server staff.', ephemeral: true });
        }

        const mode = MODES.includes(interaction.options.getString('mode'))
            ? interaction.options.getString('mode')
            : 'FFA';
        const period = PERIODS.includes(interaction.options.getString('period'))
            ? interaction.options.getString('period')
            : 'day';
        const server = interaction.options.getString('server')?.trim() || null;

        if (server) {
            const embed = service.serverBoardEmbedFor(mode, server);
            if (embed) return interaction.reply({ embeds: [embed] });

            const known = service.serverBoardsFor(mode).map(board => board.server);
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0xff7675)
                    .setTitle(`🛰️ ${mode} · ${server}`)
                    .setDescription(
                        known.length
                            ? `No board for **${server}**. Servers in the last refresh: ${known.join(', ')}.`
                            : 'No server boards yet — the tracker has not finished its in-game hops. Try `/reload`.'
                    )
                    .setFooter({ text: 'Netquel tracker' })],
                ephemeral: true
            });
        }

        return interaction.reply({ embeds: [service.boardEmbed(mode, period), service.serverBoardEmbed(mode)] });
    }
};
