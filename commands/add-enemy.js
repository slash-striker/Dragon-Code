/*
 * /add-enemy <name> — track a Netquel alias.
 *
 * The enemy is watched on every board refresh from now on; the role ping goes
 * to the channel the enemy was added in, so different staff channels can track
 * their own rivals.
 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { hideFromMembers } = require('../systems/admin/adminVisibility');
const service = require('../systems/netquel/netquelService');
const store = require('../systems/netquel/netquelStore');
const { nameMatches, formatScore, boardLabel } = require('../systems/netquel/netquelLogic');

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder()
        .setName('add-enemy')
        .setDescription('Track a Netquel player — pings the Owner role when they are live in a server')
        .addStringOption(option => option
            .setName('username')
            .setDescription('Exact in-game alias')
            .setRequired(true)
            .setMaxLength(32))),

    async execute(interaction) {
        if (!service.isNetquelStaff(interaction)) {
            return interaction.reply({ content: 'This command is restricted to server staff.', ephemeral: true });
        }

        const username = interaction.options.getString('username', true).trim();

        let enemy;
        try {
            enemy = store.addEnemy({
                name: username,
                addedBy: interaction.user.id,
                channelId: interaction.channelId
            });
        } catch (error) {
            return interaction.reply({ content: `Could not track **${username}**: ${error.message}`, ephemeral: true });
        }

        /* Report any sighting already in the current snapshot. */
        const seen = [];
        for (const board of service.getSnapshot()?.boards ?? []) {
            const row = board.rows.find(candidate => nameMatches(username, candidate.name));
            if (row) seen.push(`${boardLabel(board)} — rank #${row.rank} (${formatScore(row.score)})`);
        }

        const embed = new EmbedBuilder()
            .setColor(service.COLOR)
            .setTitle('🎯 Enemy tracked')
            .setDescription([
                `**${enemy.displayName}** is now watched on every Netquel board refresh.`,
                seen.length
                    ? `Already on a board right now:\n${seen.join('\n')}`
                    : 'Not on any board in the current snapshot.',
                `Alerts ping <@&${service.STAFF_ROLE_ID}> in <#${interaction.channelId}> when they show up on a live server board. `
                + 'Day/week/all-time sightings post quietly, without a ping.',
                `Board snapshot ${service.snapshotStamp()}.`
            ].join('\n\n'))
            .setFooter({ text: 'Netquel tracker' });

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
};
