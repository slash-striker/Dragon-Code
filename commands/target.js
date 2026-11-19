/*
 * /target <name> — one-off "is this player online right now?" check.
 *
 * netquel.com has no player-search endpoint, so the check loads the FFA and
 * Forge play pages in the headless browser and looks for the alias in the live
 * arena table each one renders (name + score). That table only covers the
 * arena the browser landed in, not every server — the reply says so instead of
 * implying a server-wide answer.
 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { hideFromMembers } = require('../systems/admin/adminVisibility');
const service = require('../systems/netquel/netquelService');
const source = require('../systems/netquel/netquelSource');
const { nameMatches, formatScore, MODES, boardLabel } = require('../systems/netquel/netquelLogic');

const CHECK_TIMEOUT_MS = 90_000;

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))
    ]);
}

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder()
        .setName('target')
        .setDescription('Check whether a Netquel player is online right now')
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
        await interaction.deferReply({ ephemeral: true });

        const lines = [];
        let found = false;

        for (const mode of MODES) {
            try {
                const live = await withTimeout(source.scrapeLive(mode), CHECK_TIMEOUT_MS, `${mode} live check`);
                const row = live.rows.find(candidate => nameMatches(username, candidate.name));
                if (row) {
                    found = true;
                    lines.push(`🟢 **Online in ${mode}** — score ${formatScore(row.score)} (rank #${row.rank} in that arena)`);
                } else {
                    lines.push(`⚪ Not seen in the ${mode} arena this check landed in (${live.rows.length} player${live.rows.length === 1 ? '' : 's'} listed)`);
                }
            } catch (error) {
                lines.push(`⚠️ ${mode} check failed — ${error.message}`);
            }
        }

        /* Cached boards add rank context even when the live arena missed them. */
        for (const board of service.getSnapshot()?.boards ?? []) {
            const row = board.rows.find(candidate => nameMatches(username, candidate.name));
            if (!row) continue;
            const where = board.server ? `${boardLabel(board)} (in-game board)` : `${boardLabel(board)} board`;
            lines.push(`📊 ${where} — rank #${row.rank} with ${formatScore(row.score)}`);
        }

        const embed = new EmbedBuilder()
            .setColor(found ? 0x2ee59d : 0x95a5a6)
            .setTitle(`${found ? '🟢 Online' : '⚪ Not found'} — ${username}`)
            .setDescription([
                lines.join('\n').slice(0, 3800) || 'No data.',
                `Cached boards updated ${service.snapshotStamp()}.`
            ].join('\n\n'))
            .setFooter({ text: 'One-off live check' });

        return interaction.editReply({ embeds: [embed] });
    }
};
