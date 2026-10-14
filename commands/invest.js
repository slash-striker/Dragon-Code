/*
 * /invest — the contrarian stock market.
 *
 * The market engine has always published ore prices that swing with random
 * events, but until now nobody could act on a hunch. A round picks ONE ore,
 * runs for 5 minutes, and everyone bets `long` (price rises) or `short`
 * (price falls).
 *
 * The payout is parimutuel with a contrarian bonus: winners get their stake
 * back plus a slice of the losing pool, so the money is in taking the side
 * nobody else wanted — a lone winning side takes 90% of the losing pool.
 *
 * The panel is stateless: every component id carries the opener's user id, so
 * a restart cannot leave a half-dead panel owned by nobody.
 */
const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder
} = require('discord.js');

const db = require('../database');
const { ensureUser } = require('../systems/utils/ensureUser');
const marketPvp = require('../systems/economy/marketPvp');
const { getMarketInfo, BASE_ORE_VALUES } = require('../systems/mining/marketEngine');

const ALLOWED_CHANNEL = '1504562791967756448';
const COLOR_LONG = 0x2ecc71;
const COLOR_SHORT = 0xe74c3c;
const COLOR = 0x00d4ff;

// The select menu only remembers a choice; the actual bet is always placed by
// the long/short buttons. Picks expire so a stale selection can never be
// silently reused an hour later.
const PICK_TTL_MS = 5 * 60 * 1000;
const picks = new Map();

const STAKE_PRESETS = [5_000, 25_000, 100_000, 1_000_000];

function oreLabel(oreId) {
    return String(oreId || 'unknown')
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function money(value) {
    return Number(value || 0).toLocaleString();
}

function setPick(userId, patch) {
    const current = picks.get(userId) || {};
    picks.set(userId, { ...current, ...patch, at: Date.now() });
}

function getPick(userId) {
    const entry = picks.get(userId);
    if (!entry) return { oreId: null, stake: marketPvp.MIN_BET };
    if (Date.now() - (entry.at || 0) > PICK_TTL_MS) {
        picks.delete(userId);
        return { oreId: null, stake: marketPvp.MIN_BET };
    }
    return entry;
}

function oreIds() {
    return Object.keys(BASE_ORE_VALUES || {});
}

// How much a stake is likely to return if this side wins. The engine pays
// stake x2 plus a share of the losing pool; a side nobody else joined pays
// 90% of that pool instead of a pro-rata slice.
function estimatePayout(round, direction, stake) {
    const split = marketPvp.getRoundBets(round.roundId);
    const sameSide = direction === 'long' ? split.long : split.short;
    const otherSide = direction === 'long' ? split.short : split.long;
    if (sameSide.count === 0) return stake * 2 + Math.floor(otherSide.staked * 0.9);
    const winnersIncludingMe = sameSide.count + 1;
    return stake * 2 + Math.floor(otherSide.staked / winnersIncludingMe);
}

function splitLine(label, bucket, total) {
    const share = total > 0 ? Math.round((bucket.staked / total) * 100) : 0;
    const barSize = 12;
    const filled = Math.max(0, Math.min(barSize, Math.round((share / 100) * barSize)));
    const bar = '▰'.repeat(filled) + '▱'.repeat(barSize - filled);
    return `**${label}** — ${bucket.count} player(s) · 🪙${money(bucket.staked)} (${share}%)\n${bar}`;
}

function buildPanel(userId, selectedOre) {
    const round = marketPvp.getOpenRound() || marketPvp.openRound();
    const market = getMarketInfo();
    const split = marketPvp.getRoundBets(round.roundId);
    const myBets = db.prepare('SELECT * FROM market_bets WHERE roundId = ? AND userId = ?')
        .get(round.roundId, userId);

    const pick = getPick(userId);
    const oreId = selectedOre || pick.oreId || round.oreId;
    const stake = Math.max(marketPvp.MIN_BET, Number(pick.stake) || marketPvp.MIN_BET);
    const isRoundOre = oreId === round.oreId;
    const stats = marketPvp.getStats(userId);
    const secondsLeft = Math.max(0, Math.round((round.endsAt - Date.now()) / 1000));

    const embed = new EmbedBuilder()
        .setColor(round.startPrice ? (isRoundOre ? COLOR : 0xf1c40f) : COLOR)
        .setTitle(`📈 CONTRARIAN MARKET — ROUND #${round.roundId}`)
        .setDescription([
            'Take a side on where the price moves. **Long** = price rises, **short** = price falls.',
            '',
            '> Winners get their stake back plus **2x** in total, plus an equal cut of the losing pool.',
            '> **Contrarian bonus:** if you are the ONLY player on the winning side you take **90% of the losing pool** on top.',
            '',
            isRoundOre
                ? `This round is trading **${oreLabel(round.oreId)}**.`
                : `⚠️ This round is trading **${oreLabel(round.oreId)}**, not ${oreLabel(oreId)} — betting on ${oreLabel(oreId)} will be refused.`
        ].join('\n'))
        .addFields(
            {
                name: '📊 LIVE SPLIT',
                value: split.total > 0
                    ? [
                        splitLine('🟢 LONG', split.long, split.total),
                        splitLine('🔴 SHORT', split.short, split.total),
                        `Pool: 🪙${money(split.total)}`
                    ].join('\n')
                    : '_Nobody has taken a position yet — a lone call here pays the full contrarian bonus._',
                inline: false
            },
            {
                name: '💹 PRICE',
                value: [
                    `${oreLabel(round.oreId)} — started at 🪙${Number(round.startPrice).toFixed(2)}`,
                    `Live market price: 🪙${Number(market.prices[round.oreId] || 0).toLocaleString()}${market.event ? ` · event **${market.event}** (x${market.multiplier})` : ' · no active event'}`,
                    `Closes <t:${Math.floor(round.endsAt / 1000)}:R> (${secondsLeft}s)`
                ].join('\n'),
                inline: false
            },
            {
                name: '🎯 YOUR POSITION',
                value: myBets
                    ? `You are **${String(myBets.direction).toUpperCase()}** for 🪙${money(myBets.amount)}. Settles when the round closes.`
                    : `No position yet. Stake: 🪙${money(stake)}\nIf you win: ~🪙${money(estimatePayout(round, 'long', stake))} on a long, ~🪙${money(estimatePayout(round, 'short', stake))} on a short.`,
                inline: true
            },
            {
                name: '📈 YOUR RECORD',
                value: [
                    `${stats.wins}W / ${stats.losses}L across ${stats.rounds} round(s)`,
                    `Net: ${stats.netCredits >= 0 ? '+' : ''}🪙${money(stats.netCredits)}`,
                    `Contrarian wins: **${stats.contrarianWins}**`
                ].join('\n'),
                inline: true
            }
        )
        .setFooter({ text: 'NEURAL EXCHANGE • one position per round • settle yourself by reading /market' })
        .setTimestamp();

    const components = [];

    // The live round's ore is always offered first so it can never fall off
    // the 25-option select menu limit.
    const allOres = oreIds();
    const orderedOres = round.oreId && allOres.includes(round.oreId)
        ? [round.oreId, ...allOres.filter(id => id !== round.oreId)]
        : allOres;

    const options = orderedOres.slice(0, 25).map(id => {
        const price = Number(market.prices[id] || BASE_ORE_VALUES[id] || 0);
        const isRound = id === round.oreId;
        const vote = isRound ? ` · LONG ${split.long.count} / SHORT ${split.short.count}` : '';
        return {
            label: `${oreLabel(id)} — 🪙${price.toFixed(2)}${isRound ? ' (live)' : ''}`.slice(0, 100),
            description: `select to inspect this ore${vote}`.slice(0, 100),
            value: id,
            default: id === oreId
        };
    });
    if (options.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`invest:${userId}:ore`)
                .setPlaceholder('Inspect an ore')
                .addOptions(options)
        ));
    }

    components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`invest:${userId}:long`)
            .setLabel(`LONG — 🪙${money(stake)}`)
            .setEmoji('🟢')
            .setStyle(ButtonStyle.Success)
            .setDisabled(Boolean(myBets)),
        new ButtonBuilder()
            .setCustomId(`invest:${userId}:short`)
            .setLabel(`SHORT — 🪙${money(stake)}`)
            .setEmoji('🔴')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(Boolean(myBets)),
        new ButtonBuilder()
            .setCustomId(`invest:${userId}:stake`)
            .setLabel('Stake size')
            .setEmoji('💰')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`invest:${userId}:refresh`)
            .setLabel('Refresh')
            .setEmoji('🔄')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`invest:${userId}:close`)
            .setLabel('Close')
            .setEmoji('✖')
            .setStyle(ButtonStyle.Secondary)
    ));

    components.push(new ActionRowBuilder().addComponents(
        STAKE_PRESETS.map(preset => new ButtonBuilder()
            .setCustomId(`invest:${userId}:stake:${preset}`)
            .setLabel(`🪙${money(preset)}`)
            .setStyle(preset === stake ? ButtonStyle.Primary : ButtonStyle.Secondary))
    ));

    return { embed, components, round, oreId, stake, myBets, isRoundOre };
}

function receiptEmbed(result, direction, oreId) {
    const color = direction === 'long' ? COLOR_LONG : COLOR_SHORT;
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(`${direction === 'long' ? '🟢 LONG' : '🔴 SHORT'} POSITION TAKEN`)
        .setDescription([
            `You staked **🪙${money(result.stake)}** on **${oreLabel(oreId)}** going ${direction === 'long' ? 'up' : 'down'}.`,
            '',
            `Payout if you are right: **≈🪙${money(result.payoutIfWin)}**`,
            `Rivals on your side: **${result.split[direction].count}** · against you: **${result.split[direction === 'long' ? 'short' : 'long'].count}**`,
            `Settles <t:${Math.floor(result.round.endsAt / 1000)}:R>`,
            '',
            result.split[direction].count === 1
                ? '👑 You are currently a **lone contrarian** — a win here takes 90% of the losing pool.'
                : 'Someone shares your side — a lone call would have paid more.'
        ].join('\n'))
        .setFooter({ text: 'NEURAL EXCHANGE • settle with /market' })
        .setTimestamp();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('invest')
        .setDescription('Bet credits on where an ore price moves — contrarian payouts for the only player on the winning side')
        .addStringOption(option => option
            .setName('ore')
            .setDescription('Ore to take a position on (defaults to the live round)')
            .setAutocomplete(true))
        .addStringOption(option => option
            .setName('direction')
            .setDescription('Which way the price moves — omit to open the panel')
            .addChoices(
                { name: 'Long — the price rises', value: 'long' },
                { name: 'Short — the price falls', value: 'short' }
            ))
        .addIntegerOption(option => option
            .setName('amount')
            .setDescription('Credits to stake (default 1,000)')
            .setMinValue(1000)
            .setMaxValue(5_000_000)),

    async autocomplete(interaction) {
        const focused = String(interaction.options.getFocused() || '').toLowerCase();
        const choices = oreIds()
            .filter(id => id.includes(focused) || oreLabel(id).toLowerCase().includes(focused))
            .slice(0, 25)
            .map(id => ({
                name: oreLabel(id).slice(0, 100),
                value: id
            }));
        return interaction.respond(choices);
    },

    async execute(interaction) {
        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ Market access is restricted to <#${ALLOWED_CHANNEL}>.`
            });
        }

        await interaction.deferReply();
        ensureUser(interaction.user.id);

        const oreId = interaction.options.getString('ore');
        const direction = interaction.options.getString('direction');
        const amount = interaction.options.getInteger('amount');

        const round = marketPvp.getOpenRound() || marketPvp.openRound({ oreId: oreId && BASE_ORE_VALUES[oreId] ? oreId : undefined });

        if (!direction) {
            const built = buildPanel(interaction.user.id, oreId);
            return interaction.editReply({ embeds: [built.embed], components: built.components });
        }

        const targetOre = oreId && BASE_ORE_VALUES[oreId] ? oreId : round.oreId;
        const stake = amount || getPick(interaction.user.id).stake || marketPvp.MIN_BET;
        const result = marketPvp.placeBet(interaction.user.id, {
            oreId: targetOre,
            direction,
            amount: stake
        });

        if (!result.ok) {
            const built = buildPanel(interaction.user.id);
            return interaction.editReply({
                content: `❌ ${result.message}`,
                embeds: [built.embed],
                components: built.components
            });
        }

        setPick(interaction.user.id, { oreId: result.round.oreId, stake: result.stake });
        const built = buildPanel(interaction.user.id, result.round.oreId);
        return interaction.editReply({
            embeds: [receiptEmbed(result, direction, result.round.oreId), built.embed],
            components: built.components
        });
    },

    /*
     * Component router — index.js routes every id starting with 'invest:' here.
     * All ids are scoped to the opener: invest:<userId>:<action>[:arg].
     */
    async handleComponent(interaction) {
        const pieces = String(interaction.customId).split(':');
        const ownerId = pieces[1];
        const action = pieces[2];
        const arg = pieces[3];

        if (!ownerId || !action) return;
        if (interaction.user.id !== ownerId) {
            return interaction.reply({
                content: '❌ This exchange panel belongs to someone else — run /invest to open your own.',
                flags: 64
            });
        }

        ensureUser(ownerId);

        if (interaction.isStringSelectMenu()) {
            if (action !== 'ore') return;
            const oreId = interaction.values[0];
            setPick(ownerId, { oreId });
            const built = buildPanel(ownerId, oreId);
            return interaction.update({ embeds: [built.embed], components: built.components });
        }

        if (action === 'refresh') {
            const built = buildPanel(ownerId);
            return interaction.update({ embeds: [built.embed], components: built.components });
        }

        if (action === 'close') {
            return interaction.update({ content: '📉 Exchange panel closed.', embeds: [], components: [] });
        }

        if (action === 'stake') {
            if (arg) {
                const preset = Math.max(marketPvp.MIN_BET, Math.min(marketPvp.MAX_BET, Math.floor(Number(arg) || marketPvp.MIN_BET)));
                setPick(ownerId, { stake: preset });
                const built = buildPanel(ownerId);
                return interaction.update({ embeds: [built.embed], components: built.components });
            }
            const built = buildPanel(ownerId);
            built.embed.addFields({
                name: '💰 STAKE SIZE',
                value: `Pick a stake from the bottom row. Current stake: **🪙${money(built.stake)}**. Minimum 🪙${money(marketPvp.MIN_BET)}, maximum 🪙${money(marketPvp.MAX_BET)}.`,
                inline: false
            });
            return interaction.update({ embeds: [built.embed], components: built.components });
        }

        if (action === 'long' || action === 'short') {
            const pick = getPick(ownerId);
            const built = buildPanel(ownerId, pick.oreId);
            const result = marketPvp.placeBet(ownerId, {
                oreId: built.round.oreId,
                direction: action,
                amount: pick.stake || marketPvp.MIN_BET
            });

            if (!result.ok) {
                const fallback = buildPanel(ownerId);
                return interaction.update({
                    content: `❌ ${result.message}`,
                    embeds: [fallback.embed],
                    components: fallback.components
                });
            }

            setPick(ownerId, { oreId: result.round.oreId, stake: result.stake });
            const after = buildPanel(ownerId, result.round.oreId);
            return interaction.update({
                content: null,
                embeds: [receiptEmbed(result, action, result.round.oreId), after.embed],
                components: after.components
            });
        }
    }
};
