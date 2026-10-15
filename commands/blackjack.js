
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const casino = require('../systems/casino/casinoManager');
const { makeDeck, shuffle, blackjackValue, isBlackjack } = require('../systems/casino/cards');
const { casinoTable } = require('../systems/casino/tableRenderer');
const { getColor, formatButtonLabel, isHighTech } = require('../systems/economy/uiStyleHelper');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ruleText = 'Also: 99% of players quit before they hit big……………..';

function formatCards(cards) {
    return cards.map(c => {
        if (c.hidden) return '🂠';
        const suits = { '♠': '♠', '♥': '♥', '♦': '♦', '♣': '♣' };
        return `${c.rank}${suits[c.suit]}`;
    }).join(' ');
}

function controls(game, allowSplit, userId) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('bj:hit')
                .setLabel(formatButtonLabel(userId, 'Hit', 'Hit'))
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('bj:stand')
                .setLabel(formatButtonLabel(userId, 'Stand', 'Stand'))
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('bj:double')
                .setLabel(formatButtonLabel(userId, 'Double', 'Double'))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('bj:split')
                .setLabel(formatButtonLabel(userId, 'Split', 'Split'))
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!allowSplit),
            new ButtonBuilder()
                .setCustomId('bj:quit')
                .setLabel(formatButtonLabel(userId, 'Quit', 'Quit'))
                .setStyle(ButtonStyle.Danger)
        )
    ];
}

function view(game, status, userId) {
    const dealer = game.reveal
        ? game.dealer
        : [{ card: game.dealer[0] }, { card: game.dealer[1], hidden: true }];
    const cards = game.hands.flatMap(hand => hand.cards);
    const useHighTech = isHighTech(userId);
    const dealerValue = blackjackValue(dealer.filter(card => !card.hidden).map(card => card.card || card));
    const playerValue = blackjackValue(cards);
    
    const tableTitle = useHighTech ? 'BLACKJACK // NEURAL TABLE' : 'Blackjack Table';
    
    if (useHighTech) {
        const embedTitle = '♠ NEON BLACKJACK // VIRTUAL TABLE';
        return {
            files: [casinoTable({ title: tableTitle, playerCards: cards, dealerCards: dealer, dealerValue, playerValue, status: `${status}\n${ruleText}`, filename: 'blackjack.png', userId })],
            components: controls(game, game.hands.length === 1 && game.hands[0].cards.length === 2 && blackjackValue(game.hands[0].cards) === blackjackValue([game.hands[0].cards[0], game.hands[0].cards[1]]) && game.hands[0].cards[0].rank === game.hands[0].cards[1].rank, userId)
        };
    } else {
        return {
            files: [casinoTable({ title: tableTitle, playerCards: cards, dealerCards: dealer, dealerValue, playerValue, status: `${status}\n${ruleText}`, filename: 'blackjack.png', userId })],
            components: controls(game, game.hands.length === 1 && game.hands[0].cards.length === 2 && blackjackValue(game.hands[0].cards) === blackjackValue([game.hands[0].cards[0], game.hands[0].cards[1]]) && game.hands[0].cards[0].rank === game.hands[0].cards[1].rank, userId)
        };
    }
}
async function agreement(interaction) {
    if (casino.hasAcknowledged(interaction.user.id)) return 'acknowledged';
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('casino:agree').setLabel('I Understand & Play').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('casino:exit').setLabel('Exit').setStyle(ButtonStyle.Secondary)
    );
    const message = await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xffcc66).setTitle('Virtual-play agreement').setDescription(ruleText)], components: [row], fetchReply: true });
    try { const button = await message.awaitMessageComponent({ componentType: ComponentType.Button, time: 60000, filter: i => i.user.id === interaction.user.id }); if (button.customId === 'casino:agree') { casino.acknowledge(interaction.user.id); await button.update({ content: '🎰 Agreement recorded — dealing you in…', embeds: [], components: [] }); return 'agreed'; } await button.update({ content: 'Casino session closed.', embeds: [], components: [] }); } catch { await interaction.editReply({ content: 'Agreement timed out.', embeds: [], components: [] }); }
    return false;
}
module.exports = { data: new SlashCommandBuilder().setName('blackjack').setDescription('Virtual Blackjack').addSubcommand(s => s.setName('play').setDescription('Open a virtual Blackjack table').addIntegerOption(o => o.setName('bet').setDescription('Wallet-credit wager').setRequired(true))), async execute(interaction) {
    /*
     * /blackjack max-bet was merged into /casino maxbet (admin only).
     * Any subcommand other than 'play' gets pointed at the new home.
     */
    if (interaction.options.getSubcommand() !== 'play') {
        return interaction.reply({
            content: '⚠️ Setting the Blackjack table limit moved — use `/casino maxbet` and pick **Blackjack**.' });
    }
    
    if (interaction.channelId !== casino.GAME_CHANNELS.blackjack) return interaction.reply({ content: `Blackjack is available only in <#${casino.GAME_CHANNELS.blackjack}>.` });
    const globalPausedUntil = casino.blackjackPauseStatus();
    if (globalPausedUntil) return interaction.reply({ content: `Blackjack is currently paused for everyone until <t:${Math.floor(new Date(globalPausedUntil).getTime() / 1000)}:F>.` });
    const pausedUntil = casino.pauseStatus(interaction.user.id);
    if (pausedUntil) return interaction.reply({ content: `Your casino access is paused until <t:${Math.floor(new Date(pausedUntil).getTime() / 1000)}:F>.` });
    if (casino.getActiveSession(interaction.user.id, 'blackjack')) return interaction.reply({ content: 'You already have an active Blackjack table. Finish it, quit it, or wait for the inactivity timeout.' });
    const agreementResult = await agreement(interaction);
    if (!agreementResult) return;
    // First-timers who just agreed already have a reply — edit it into the
    // table instead of making them run the command a second time.
    if (agreementResult === 'acknowledged') await interaction.deferReply();
    const bet = interaction.options.getInteger('bet'); const max = casino.getMaxBet('blackjack');
    if (!Number.isSafeInteger(bet) || bet < 1 || bet > max) return interaction.editReply({ content: `Bet must be between 🪙 1 and 🪙 ${max.toLocaleString()} credits.` });
    try { casino.debitWallet(interaction.user.id, 'blackjack', bet, 'Opening wallet wager'); } catch (error) { return interaction.editReply({ content: error.message }); }
    const deck = shuffle(makeDeck()); const game = { deck, dealer: [deck.pop(), deck.pop()], hands: [{ cards: [deck.pop(), deck.pop()], bet, done: false }], current: 0, totalWager: bet, reveal: false };
    const sessionId = casino.createSession({ userId: interaction.user.id, game: 'blackjack', channelId: interaction.channelId, payload: game });
    const message = await interaction.editReply({ ...view(game, 'Cards dealt. Choose your move.', interaction.user.id), fetchReply: true });

    // An opening natural is immediate only when the player has Blackjack.
    // A dealer natural with a non-natural player hand remains visible as one
    // exposed card until the player's turn is resolved; do not pre-empt play.
    const playerNatural = isBlackjack(game.hands[0].cards);
    const dealerNatural = isBlackjack(game.dealer);
    if (playerNatural) {
        game.reveal = true;
        const bothNatural = dealerNatural;
        const payout = bothNatural ? bet : bet * 2.5;
        const result = bothNatural ? 'PUSH' : 'NATURAL BLACKJACK';
        casino.creditWallet(
            interaction.user.id,
            'blackjack',
            payout,
            bothNatural ? 'push' : 'payout',
            result
        );
        casino.closeSession(sessionId, game);
        const resultEmbed = new EmbedBuilder()
            .setColor(bothNatural ? 0xffcc66 : 0x00e5a8)
            .setTitle(bothNatural ? '♠ BLACKJACK PUSH' : '♠ NATURAL BLACKJACK')
            .setDescription(bothNatural
                ? 'Both you and the dealer opened with 21. Your wallet wager was returned.'
                : 'You opened with an Ace and a ten-value card. The round ends immediately and your blackjack payout is awarded.')
            .addFields(
                { name: 'Dealer', value: `${blackjackValue(game.dealer)}\n${formatCards(game.dealer)}`, inline: true },
                { name: 'Player', value: `${blackjackValue(game.hands[0].cards)}\n${formatCards(game.hands[0].cards)}`, inline: true },
                { name: 'Wallet Returned', value: `🪙 ${payout.toLocaleString()}`, inline: true }
            )
            .setFooter({ text: ruleText })
            .setTimestamp();
        return message.edit({ content: null, embeds: [resultEmbed], files: [], components: [] });
    }

    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 10 * 60 * 1000 });
    if (dealerNatural) {
        game.dealerNatural = true;
        game.dealer = [game.dealer[0], { ...game.dealer[1], hidden: true }];
    }
    async function resolveHand(hand) {
    while (blackjackValue(game.dealer) < 17) {
        game.dealer.push(game.deck.pop());
        await message.edit(view(game, 'Dealer draws another card...', interaction.user.id)).catch(() => {});
        await sleep(850);
    }
    const player = blackjackValue(hand.cards);
    const dealer = blackjackValue(game.dealer);
    let payout = 0;
    let result;
    if (player > 21) result = 'BUST';
    else if (dealer > 21 || player > dealer) {
        payout = hand.bet * (isBlackjack(hand.cards) ? 2.5 : 2);
        result = 'WIN';
    } else if (player === dealer) {
        payout = hand.bet;
        result = 'PUSH';
    } else result = 'LOSS';
    return { payout, result };
    }
    async function endBust(i, hand) {
        game.reveal = true;
        casino.closeSession(sessionId, game);
        collector.stop('bust');
        await i.update({
            embeds: [new EmbedBuilder()
                .setColor(0xff5577)
                .setTitle('♠ BLACKJACK BUST')
                .setDescription('You went over 21. The round ended immediately and your wager was lost.')
                .addFields(
                    { name: 'Your hand', value: `${blackjackValue(hand.cards)}\n${formatCards(hand.cards)}`, inline: true },
                    { name: 'Dealer', value: `${blackjackValue(game.dealer)}\n${formatCards(game.dealer)}`, inline: true },
                    { name: 'Lost wager', value: `🪙${hand.bet.toLocaleString()}`, inline: true }
                )
                .setFooter({ text: ruleText })
                .setTimestamp()],
            components: [],
            files: []
        });
    }
    async function endTwentyOne(i, hand) {
        const blackjack = isBlackjack(hand.cards);
        const dealerHasNatural = Boolean(game.dealerNatural);
        const payout = dealerHasNatural ? 0 : hand.bet * (blackjack ? 2.5 : 2);
        game.reveal = true;
        game.dealer = game.dealer.map(card => { const { hidden, ...visible } = card; return visible; });
        if (payout > 0) {
            casino.creditWallet(
                interaction.user.id,
                'blackjack',
                payout,
                'payout',
                blackjack ? 'Immediate blackjack' : 'Immediate 21'
            );
        }
        casino.closeSession(sessionId, game);
        collector.stop('twenty-one');
        await i.update({
            embeds: [new EmbedBuilder()
                .setColor(0x00e5a8)
                .setTitle(blackjack ? '♠ BLACKJACK' : '♠ 21!')
                .setDescription(dealerHasNatural
                    ? 'You reached 21, so the round ended. The dealer revealed a natural Blackjack and wins this hand.'
                    : blackjack
                        ? 'You reached Blackjack. The round ended immediately and your blackjack reward was awarded.'
                        : 'You reached 21. The round ended immediately and your normal win payout was awarded.')
                .addFields(
                    { name: 'Your hand', value: `${blackjackValue(hand.cards)}\n${formatCards(hand.cards)}`, inline: true },
                    { name: 'Payout', value: `🪙${payout.toLocaleString()}`, inline: true }
                )
                .setFooter({ text: ruleText })
                .setTimestamp()],
            components: [],
            files: []
        });
    }
    collector.on('collect', async i => { if (i.user.id !== interaction.user.id) return i.reply({ content: 'This is not your table.' }); let hand = game.hands[game.current];
        if (i.customId === 'bj:quit') { const refund = Math.floor(game.totalWager / 2); casino.creditWallet(interaction.user.id, 'blackjack', refund, 'refund', 'Player quit Blackjack (half wager forfeited)'); casino.closeSession(sessionId, game); collector.stop('quit'); return i.update({ embeds: [ new EmbedBuilder() .setColor(0xff5555) .setTitle('♠ BLACKJACK — LEFT THE TABLE') .setDescription(`You quit the table. Half of your wager is forfeited.\n\n**Forfeited:** 🪙 ${(game.totalWager - refund).toLocaleString()}\n**Refunded:** 🪙 ${refund.toLocaleString()}`) ], components: [], files: [] }); }
        if (i.customId === 'bj:hit') {
            hand.cards.push(game.deck.pop());
            if (blackjackValue(hand.cards) > 21) return endBust(i, hand);
            if (blackjackValue(hand.cards) === 21) return endTwentyOne(i, hand);
        }
        if (i.customId === 'bj:double') { if (hand.cards.length !== 2) return i.reply({ content: 'Double is only available on your first two cards.' }); const additionalWager = hand.bet; try { casino.debitWallet(interaction.user.id, 'blackjack', additionalWager, 'Double down'); } catch (e) { return i.reply({ content: e.message }); } hand.bet += additionalWager; game.totalWager += additionalWager; hand.cards.push(game.deck.pop()); if (blackjackValue(hand.cards) > 21) return endBust(i, hand); if (blackjackValue(hand.cards) === 21) return endTwentyOne(i, hand); hand.done = true; }
        if (i.customId === 'bj:split') { if (game.hands.length !== 1 || hand.cards.length !== 2 || hand.cards[0].rank !== hand.cards[1].rank) return i.reply({ content: 'Split requires an opening pair of equal ranks.' }); try { casino.debitWallet(interaction.user.id, 'blackjack', hand.bet, 'Split wager'); } catch (e) { return i.reply({ content: e.message }); } game.totalWager += hand.bet; game.hands = [{ cards: [hand.cards[0], game.deck.pop()], bet: hand.bet }, { cards: [hand.cards[1], game.deck.pop()], bet: hand.bet }]; game.current = 0; hand = game.hands.find(currentHand => blackjackValue(currentHand.cards) === 21) || game.hands[0]; if (blackjackValue(hand.cards) === 21) return endTwentyOne(i, hand); }
        if (i.customId === 'bj:stand') hand.done = true;
        if (hand.done && game.current < game.hands.length - 1) { game.current++; return i.update(view(game, `Hand ${game.current + 1}: choose your move.`, interaction.user.id)); }
        if (!game.hands.every(h => h.done)) return i.update(view(game, `Hand ${game.current + 1}: ${blackjackValue(hand.cards)}.`, interaction.user.id));
        await i.deferUpdate();
        game.reveal = true;
        let payout = 0;
        const outcomes = [];
        for (const currentHand of game.hands) {
            const result = await resolveHand(currentHand);
            payout += result.payout;
            outcomes.push(`${result.result} — ${currentHand.cards.map(c => `${c.rank}${c.suit}`).join(' ')}`);
        }
        if (payout) {
            casino.creditWallet(interaction.user.id, 'blackjack', Math.floor(payout), 'payout', outcomes.join(', '));
        }
        casino.closeSession(sessionId, game);
        collector.stop('complete');

        const hasWin = outcomes.some(outcome => outcome.startsWith('WIN'));
        const hasPush = outcomes.some(outcome => outcome.startsWith('PUSH'));
        const resultEmbed = new EmbedBuilder()
            .setColor(hasWin ? 0x00e5a8 : hasPush ? 0xffcc66 : 0xff5577)
            .setTitle(hasWin ? '♠ BLACKJACK WIN' : hasPush ? '♠ BLACKJACK PUSH' : '♠ BLACKJACK ROUND COMPLETE')
            .setDescription('The table is closed. Your final result is recorded below.')
            .addFields(
                { name: 'Dealer', value: `${blackjackValue(game.dealer)}\n${game.dealer.map(card => `${card.rank}${card.suit}`).join(' ')}`, inline: true },
                { name: 'Total Wagered', value: `🪙 ${game.totalWager.toLocaleString()}`, inline: true },
                { name: 'Wallet Returned', value: `🪙 ${Math.floor(payout).toLocaleString()}`, inline: true },
                { name: 'Hand Results', value: outcomes.join('\n'), inline: false }
            )
            .setFooter({ text: ruleText })
            .setTimestamp();

        await message.edit({ content: null, embeds: [resultEmbed], files: [], components: [] });
    });
    collector.on('end', async (_, reason) => { 
        if (reason !== 'complete' && reason !== 'quit' && reason !== 'bust' && reason !== 'twenty-one') {

            // Inactivity timeout: half the wager is forfeited, half refunded.
            const refund = Math.floor(game.totalWager / 2);
            casino.creditWallet(
                interaction.user.id,
                'blackjack',
                refund,
                'refund',
                'Blackjack inactivity timeout (half wager forfeited)'
            );

            casino.closeSession(sessionId, game);

            await message.edit({

                content:
                    `⏱️ You were inactive too long and automatically left the table. Half of your wager was forfeited.\n\n**Forfeited:** 🪙 ${Math.ceil(game.totalWager / 2).toLocaleString()} • **Refunded:** 🪙 ${refund.toLocaleString()}`,

                embeds: [],
                files: [],
                components: []

            }).catch(() => {});

        }


    });
} };
