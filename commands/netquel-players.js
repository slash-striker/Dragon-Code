/*
 * /netquel-players — every player card the tracker has captured.
 *
 * The join date, high score, rank, streak and clan only exist on the in-game
 * card that opens when a board name is clicked, so this list grows as the
 * server sweep walks the boards. Players are grouped by their rank badge,
 * highest high score first inside each group, and tracked enemies are marked.
 *
 * Using the command refreshes the cards of the players it is about to list
 * instead of showing whatever the last sweep saw: the browser queue is shared
 * with the tracker, so a refresh waits for a running sweep rather than opening
 * a second client.
 */
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { hideFromMembers } = require('../systems/admin/adminVisibility');
const service = require('../systems/netquel/netquelService');
const store = require('../systems/netquel/netquelStore');
const {
    MODES,
    formatScore,
    nameMatches,
    normalizeClan,
    parseClan,
    relativeStamp,
    fitLines
} = require('../systems/netquel/netquelLogic');

/* The six ranks netquel awards, in the order its own ranks page lists them. */
const RANK_ORDER = ['Prospector', 'Sentinel', 'Harvester', 'Arbiter', 'Ascendant', 'Vanguard'];
const DESC_LIMIT = 3900;
/* Bounded so a refresh stays a command, not a sweep. */
const REFRESH_LIMIT = 8;

function rankOf(player) {
    const rank = String(player.rankName ?? '').trim();
    return rank || 'Unranked';
}

/* The HUD's italics and dimmed row, kept as of the card's last sighting. */
function badges(player) {
    return [
        player.verified ? '✅ verified' : '⬜ not verified',
        player.afk ? '💤 AFK' : '🏃 active'
    ];
}

function cardLine(player) {
    const name = `**${player.displayName}**`;
    const clan = player.clan ? ` **[${player.clan}]**` : '';
    if (player.isPrivate) {
        return [`${name}${clan}`, '🔒 profile is private', ...badges(player)].join(' · ');
    }

    return [
        `${name}${clan}`,
        `high score **${formatScore(player.highScore)}**`,
        player.joined ? `joined **${player.joined}**` : null,
        player.rankName ? `rank **${player.rankName}**` : null,
        player.streak ? `streak **${player.streak}**` : null,
        ...badges(player)
    ].filter(Boolean).join(' · ');
}

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder()
        .setName('netquel-players')
        .setDescription('Captured Netquel player cards — clan, high score, join date and rank')
        .addStringOption(option => option
            .setName('mode')
            .setDescription('Only players last seen in this mode')
            .addChoices({ name: 'FFA', value: 'FFA' }, { name: 'Forge', value: 'Forge' }))
        .addStringOption(option => option
            .setName('rank')
            .setDescription('Only this rank')
            .addChoices(...RANK_ORDER.map(rank => ({ name: rank, value: rank }))))
        .addStringOption(option => option
            .setName('clan')
            .setDescription('Only players in this clan, e.g. ENOS')
            .setMaxLength(24))
        .addBooleanOption(option => option
            .setName('tracked-only')
            .setDescription('Only the enemies on the watch list'))
        .addBooleanOption(option => option
            .setName('refresh')
            .setDescription('Open their cards live before listing (default: yes)'))),

    async execute(interaction) {
        if (!service.isNetquelStaff(interaction)) {
            return interaction.reply({ content: 'This command is restricted to server staff.', ephemeral: true });
        }

        const mode = MODES.includes(interaction.options.getString('mode'))
            ? interaction.options.getString('mode')
            : null;
        const rankFilter = interaction.options.getString('rank');
        const clanFilter = parseClan(interaction.options.getString('clan'));
        const trackedOnly = interaction.options.getBoolean('tracked-only') ?? false;
        const refresh = interaction.options.getBoolean('refresh') ?? true;

        const enemies = store.listEnemies();
        const isTracked = name => enemies.some(enemy => nameMatches(enemy.displayName, name));

        const filtered = () => {
            let players = store.listPlayers();
            if (mode) players = players.filter(player => player.mode === mode);
            if (rankFilter) players = players.filter(player => rankOf(player) === rankFilter);
            if (clanFilter) players = players.filter(player => normalizeClan(player.clan) === normalizeClan(clanFilter));
            if (trackedOnly) players = players.filter(player => isTracked(player.displayName));
            return players;
        };

        let players = filtered();
        let refreshNote = null;
        let deferred = false;

        if (refresh && players.length) {
            await interaction.deferReply({ ephemeral: true });
            deferred = true;

            const names = players.slice(0, REFRESH_LIMIT).map(player => player.displayName);
            const result = await service.refreshPlayerCards(names).catch(error => ({ errors: [error.message] }));
            const updated = result?.cards?.length ?? 0;
            const foundOn = [...new Set((result?.cards ?? []).map(card => `${card.mode} · ${card.server}`))].join(', ');
            const checked = [...new Set(result?.servers ?? [])].join(', ');
            refreshNote = updated
                ? `🔄 Refreshed ${updated} of ${names.length} card(s) live${foundOn ? ` (${foundOn})` : ''}.`
                : `🔄 Checked ${checked || 'the arena'} — none of those ${names.length} player(s) were on those boards; showing the stored cards.`;
            if (result?.errors?.length) refreshNote += ` (${result.errors[0]})`;
            players = filtered();
        }

        const reply = payload => (deferred ? interaction.editReply(payload) : interaction.reply({ ...payload, ephemeral: true }));

        if (!players.length) {
            return reply({
                embeds: [new EmbedBuilder()
                    .setColor(0xff7675)
                    .setTitle('🛰️ Netquel player cards')
                    .setDescription(
                        trackedOnly || rankFilter || clanFilter || mode
                            ? 'No captured player matches those filters yet.'
                            : 'No player cards captured yet — the tracker opens a card for every name on a live server board, '
                                + 'so the first 10-minute server sweep has to finish.'
                    )
                    .setFooter({ text: 'Netquel tracker' })]
            });
        }

        /* Group by rank badge, then by high score (already sorted descending). */
        const groups = new Map();
        for (const player of players) {
            const rank = rankOf(player);
            if (!groups.has(rank)) groups.set(rank, []);
            groups.get(rank).push(player);
        }
        const ranks = [...groups.keys()].sort((a, b) => {
            const left = RANK_ORDER.indexOf(a);
            const right = RANK_ORDER.indexOf(b);
            if (left === -1 && right === -1) return a.localeCompare(b);
            if (left === -1) return 1;
            if (right === -1) return -1;
            return left - right;
        });

        const lines = [];
        for (const rank of ranks) {
            if (lines.length) lines.push('');
            lines.push(`__**${rank}**__ · ${groups.get(rank).length} player${groups.get(rank).length === 1 ? '' : 's'}`);
            lines.push(...fitLines(groups.get(rank), DESC_LIMIT - lines.join('\n').length, cardLine));
        }

        const newest = players
            .map(player => Date.parse(player.lastSeen))
            .filter(Number.isFinite)
            .sort((a, b) => b - a)[0] ?? null;

        return reply({
            embeds: [new EmbedBuilder()
                .setColor(service.COLOR)
                .setTitle('🛰️ Netquel player cards')
                .setDescription([
                    `**Newest card ${relativeStamp(newest)}** · ${players.length} player(s)`,
                    refreshNote,
                    lines.join('\n')
                ].filter(Boolean).join('\n').slice(0, DESC_LIMIT))
                .setFooter({ text: 'Cards come from the live server boards · verified/AFK as of last sighting' })]
        });
    }
};
