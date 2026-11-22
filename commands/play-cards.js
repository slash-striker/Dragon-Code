/*
 * /play-cards — Golf, the hidden-hand card game.
 *
 * The public table message only ever shows the discard top, the deck size and
 * who is on turn. A player's four cards and any card drawn from the deck are
 * shown in an ephemeral panel that only they can see.
 *
 * Flow:
 *   1. Everyone memorizes two of their four cards (tap to flip, tap to put
 *      back, then Done once). Bots memorize automatically.
 *   2. A random player starts. On a turn they take the discard top or draw
 *      from the deck, then swap the card into one of their slots or discard it.
 *   3. Anyone can knock instead of drawing. Everyone else gets exactly one
 *      last turn, then every hand is revealed and the lowest score wins.
 */
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    SlashCommandBuilder
} = require('discord.js');
const golf = require('../systems/games/golf');

const TURN_MS = 90_000;
const BOT_DELAY_MS = 1_200;
const MEMORIZE_MS = 3 * 60_000;

const COLOR = 0x2ee59d;
const COLOR_TURN = 0x3a86ff;
const COLOR_KNOCK = 0xffb020;
const COLOR_END = 0x95a5a6;

const games = new Map();
const channelGames = new Map();

function displayName(interaction) {
    return interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username;
}

function button(customId, label, style, disabled = false) {
    return new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(style)
        .setDisabled(disabled);
}

function mention(player) {
    return player.isBot ? `🤖 **${player.name}**` : `<@${player.id}>`;
}

function newBot(seats) {
    const count = seats.filter(player => player.isBot).length + 1;
    return {
        id: `bot-${count}`,
        name: count === 1 ? 'Golf Bot' : `Golf Bot ${count}`,
        isBot: true
    };
}

function publicComponents(game) {
    if (game.state.status === 'finished') return [];
    const row = new ActionRowBuilder().addComponents(
        button(
            `cards:${game.state.status === 'memorize' ? 'memorize' : 'turn'}:${game.id}`,
            game.state.status === 'memorize' ? '🧠 Memorize my cards' : '▶️ Play turn',
            ButtonStyle.Primary
        ),
        button(`cards:end:${game.id}`, '🛑 End game', ButtonStyle.Secondary)
    );
    return [row];
}

function publicPayload(game, note = '') {
    const state = game.state;
    const current = golf.currentPlayer(state);
    const top = state.discard[state.discard.length - 1] ?? null;
    const lines = [];

    if (state.status === 'memorize') {
        lines.push('**Memorize two of your four cards, then press Done.**');
        lines.push(`**Discard:** ${golf.cardLabel(top)}  ·  **Deck:** ${state.deck.length}`);
    } else if (state.status === 'playing') {
        lines.push(`**Discard:** ${golf.cardLabel(top)}  ·  **Deck:** ${state.deck.length}`);
        lines.push(`**Turn:** ${mention(current)}${golf.isFinalTurn(state, current.id) ? ' · 🔔 final turn' : ''}`);
        if (state.knockerId) {
            const knocker = state.players.find(player => player.id === state.knockerId);
            lines.push(
                `✊ **${knocker?.name ?? 'Someone'}** knocked — `
                + `**${state.finalQueue.length}** final turn${state.finalQueue.length === 1 ? '' : 's'} left.`
            );
        }
    } else {
        lines.push('🏁 **Game over**');
    }

    lines.push('**Seats**');
    for (const player of state.players) {
        const marker = state.status === 'playing' && player.id === current?.id ? '▶' : '▫️';
        const status = state.status === 'memorize'
            ? (player.ready ? '✅ memorized' : '🧠 memorizing…')
            : `${player.hand.length} card${player.hand.length === 1 ? '' : 's'}`;
        const knocked = player.id === state.knockerId ? ' · ✊ knocked' : '';
        lines.push(`${marker} ${mention(player)} — ${status}${knocked}`);
    }

    if (state.log.length) {
        lines.push(`**Recent:** ${state.log.slice(-2).join(' ')}`);
    }
    if (note) lines.push(note);

    return {
        embeds: [new EmbedBuilder()
            .setColor(state.status === 'finished' ? COLOR_END : state.knockerId ? COLOR_KNOCK : state.status === 'playing' ? COLOR_TURN : COLOR)
            .setTitle(state.status === 'memorize'
                ? '🃏 GOLF · memorize'
                : state.status === 'playing' ? `🃏 GOLF · turn ${state.turnCount}` : '🃏 GOLF')
            .setDescription(lines.join('\n').slice(0, 4000))
            .setFooter({ text: 'Golf · lowest hand wins · Q/K 10 · J 0 · A 1 · jokers −2' })],
        components: publicComponents(game)
    };
}

function memoryPayload(game, player) {
    const state = game.state;
    if (state.status !== 'memorize') {
        return { content: 'The game has already started.', components: [] };
    }
    if (player.memory.done) {
        return { content: '✅ You memorized your cards. Waiting for the others…', components: [] };
    }

    const memory = player.memory;
    const cards = player.hand.map((card, index) => {
        const viewed = memory.viewed.includes(index);
        const revealed = memory.revealed === index;
        let label;
        let style = ButtonStyle.Secondary;
        let disabled = false;

        if (revealed) {
            label = `${golf.cardLabel(card)} · ${index + 1}`;
            style = ButtonStyle.Primary;
        } else if (viewed) {
            label = `${index + 1} ✅`;
            style = ButtonStyle.Success;
            disabled = true;
        } else if (memory.viewed.length >= golf.VIEW_LIMIT) {
            label = `${index + 1} 🂠`;
            disabled = true;
        } else {
            label = `${index + 1} 🂠`;
        }

        return button(`cards:flip:${game.id}:${index}`, label, style, disabled);
    });

    const canFinish = memory.viewed.length >= golf.VIEW_LIMIT && memory.revealed === null;
    const rows = [
        new ActionRowBuilder().addComponents(...cards),
        new ActionRowBuilder().addComponents(
            button(`cards:done:${game.id}`, '✅ Done memorizing', ButtonStyle.Success, !canFinish)
        )
    ];

    return {
        content: [
            '🧠 **Your cards** — tap a face-down card to look at it, then tap it again to put it back.',
            `You may look at **${golf.VIEW_LIMIT}** cards, once.`,
            memory.revealed === null
                ? `Viewed ${memory.viewed.length}/${golf.VIEW_LIMIT}.`
                : `Viewed ${memory.viewed.length}/${golf.VIEW_LIMIT} — put this card back before looking at another.`
        ].join('\n'),
        components: rows
    };
}

function turnPayload(game, player) {
    const state = game.state;
    if (state.status !== 'playing') {
        return {
            content: state.status === 'finished' ? '🏁 The game is over.' : 'Memorization is still going.',
            components: []
        };
    }

    const current = golf.currentPlayer(state);
    if (current.id !== player.id) {
        return { content: `⏳ It is ${mention(current)}'s turn.`, components: [] };
    }

    const top = state.discard[state.discard.length - 1] ?? null;

    if (state.pending) {
        const source = state.pending.source === 'discard' ? 'the discard pile' : 'the deck';
        const rows = [
            new ActionRowBuilder().addComponents(
                ...[0, 1, 2, 3].map(index => button(
                    `cards:swap:${game.id}:${index}`,
                    `${index + 1} 🂠`,
                    ButtonStyle.Secondary
                ))
            ),
            new ActionRowBuilder().addComponents(
                button(
                    `cards:discard:${game.id}`,
                    state.pending.source === 'discard' ? '↩️ Put it back' : '🗑️ Discard it',
                    state.pending.source === 'discard' ? ButtonStyle.Secondary : ButtonStyle.Danger
                )
            )
        ];
        return {
            content: [
                `🎴 You took **${golf.cardLabel(state.pending.card)}** from ${source}.`,
                'Swap it into one of your four slots, or put it on the discard pile.',
                'Only you can see this card.'
            ].join('\n'),
            components: rows
        };
    }

    const handLine = player.hand.map((_, index) => `\`${index + 1} 🂠\``).join(' ');
    return {
        content: [
            `🎴 **Your turn** — discard **${golf.cardLabel(top)}** · deck **${state.deck.length}**`,
            `Your hand: ${handLine}`,
            golf.isFinalTurn(state, player.id)
                ? '🔔 This is your final turn — someone knocked.'
                : 'Take the discard, draw from the deck, or knock.'
        ].join('\n'),
        components: [new ActionRowBuilder().addComponents(
            button(
                `cards:take:${game.id}`,
                `♻️ Take ${top ? golf.cardLabel(top) : 'discard'}`,
                ButtonStyle.Primary,
                !top
            ),
            button(
                `cards:draw:${game.id}`,
                '🎴 Draw from the deck',
                ButtonStyle.Secondary,
                state.deck.length === 0 && state.discard.length <= 1
            ),
            button(
                `cards:knock:${game.id}`,
                '✊ Knock',
                ButtonStyle.Danger,
                !golf.canKnock(state, player.id)
            )
        )]
    };
}

function finishedPayload(game, note = '') {
    const state = game.state;
    const lines = [];

    if (state.status === 'finished') {
        const winners = state.players.filter(player => state.winners.includes(player.id));
        const best = state.results.length
            ? Math.min(...state.results.map(result => result.total))
            : 0;
        lines.push(winners.length === 1
            ? `🏆 **${winners[0].name}** wins with **${best}** points!`
            : `🏆 **${winners.map(player => player.name).join(' & ')}** tie with **${best}** points!`);

        for (const result of state.results) {
            const cards = result.hand
                .map(card => `${golf.cardLabel(card)} (${golf.cardValue(card)})`)
                .join(' · ');
            const winner = state.winners.includes(result.id) ? ' 🏆' : '';
            lines.push(`${result.isBot ? '🤖' : '🧑'} **${result.name}**${winner} — **${result.total}** pts\n${cards}`);
        }

        if (state.knockerId) {
            const knocker = state.players.find(player => player.id === state.knockerId);
            lines.push(`✊ **${knocker?.name ?? 'Someone'}** knocked.`);
        }
    } else {
        lines.push('🛑 **Table closed** — the host ended the game before it finished.');
    }

    if (note) lines.push(note);

    return {
        embeds: [new EmbedBuilder()
            .setColor(state.status === 'finished' ? COLOR : COLOR_END)
            .setTitle(state.status === 'finished' ? '🃏 GOLF · results' : '🃏 GOLF · closed')
            .setDescription(lines.join('\n\n').slice(0, 4000))
            .setFooter({ text: 'Golf · lowest hand wins' })],
        components: []
    };
}

async function updatePublic(game, note = '') {
    if (!game.message || game.ended) return;
    const payload = game.state.status === 'finished'
        ? finishedPayload(game)
        : publicPayload(game, note);
    await game.message.edit(payload).catch(error => console.error('Golf update failed:', error.message));
}

function clearTimer(game) {
    if (game.timer) clearTimeout(game.timer);
    game.timer = null;
}

async function finishGame(game, note = '') {
    if (game.ended) return;
    game.ended = true;
    clearTimer(game);
    if (game.readyTimer) clearTimeout(game.readyTimer);
    game.readyTimer = null;

    const payload = finishedPayload(game, note);
    games.delete(game.id);
    channelGames.delete(game.channelId);
    await game.message?.edit(payload).catch(error => console.error('Golf finish failed:', error.message));
}

function scheduleTurn(game) {
    clearTimer(game);
    const state = game.state;
    if (game.ended || state.status !== 'playing') return;

    const player = golf.currentPlayer(state);
    const token = ++game.turnToken;
    if (player.isBot) {
        game.timer = setTimeout(() => runBot(game, token), BOT_DELAY_MS);
    } else {
        game.timer = setTimeout(() => turnTimedOut(game, token), TURN_MS);
    }
}

function afterAction(game, note = '') {
    if (game.ended) return;
    if (game.state.status === 'finished') {
        finishGame(game, note);
        return;
    }
    updatePublic(game, note);
    scheduleTurn(game);
}

function runBot(game, token) {
    if (game.ended || token !== game.turnToken) return;
    const state = game.state;
    if (state.status !== 'playing') return;

    const bot = golf.currentPlayer(state);
    if (!bot?.isBot) {
        scheduleTurn(game);
        return;
    }

    try {
        const move = golf.chooseBotMove(state, bot.id);
        if (move.action === 'knock') {
            golf.knock(state, bot.id);
            afterAction(game, `✊ **${bot.name}** knocked!`);
            return;
        }

        const source = move.action === 'take-discard' ? 'the discard' : 'the deck';
        const card = move.action === 'take-discard'
            ? golf.takeDiscard(state, bot.id)
            : golf.drawFromDeck(state, bot.id);

        const choice = golf.chooseBotPending(state, bot.id);
        if (choice.action === 'swap') {
            const result = golf.swapPending(state, bot.id, choice.slot);
            /* Never name the drawn card: it stays hidden in the bot's hand. */
            afterAction(
                game,
                `🤖 **${bot.name}** took from ${source} and swapped out **${golf.cardLabel(result.replaced)}**.`
            );
            return;
        }

        golf.discardPending(state, bot.id);
        afterAction(
            game,
            `🤖 **${bot.name}** took **${golf.cardLabel(card)}** from ${source} and discarded it.`
        );
    } catch (error) {
        console.error(`Golf bot move failed (${bot.name}):`, error.message);
        try {
            golf.abandonTurn(state);
        } catch {
            /* the game may already be over */
        }
        afterAction(game, `⚠️ ${bot.name} skipped their turn.`);
    }
}

function turnTimedOut(game, token) {
    if (game.ended || token !== game.turnToken) return;
    const state = game.state;
    if (state.status !== 'playing') return;

    const player = golf.currentPlayer(state);
    if (player.isBot) return;

    try {
        golf.abandonTurn(state);
    } catch (error) {
        console.error('Golf timeout advance failed:', error.message);
    }
    afterAction(game, `⏰ **${player.name}** ran out of time.`);
}

async function startGame(game) {
    golf.beginPlay(game.state);
    if (game.readyTimer) clearTimeout(game.readyTimer);
    game.readyTimer = null;
    await updatePublic(game, '🎬 Cards memorized — play begins.');
    scheduleTurn(game);
}

function armMemorizeTimer(game) {
    game.readyTimer = setTimeout(() => {
        if (game.ended || game.state.status !== 'memorize') return;
        for (const player of game.state.players) {
            if (!player.ready) golf.autoMemorize(game.state, player.id);
        }
        startGame(game).catch(error => console.error('Golf auto-start failed:', error.message));
    }, MEMORIZE_MS);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('play-cards')
        .setDescription('Play Golf — a 2-4 player card game with hidden hands and a knock')
        .addUserOption(option => option
            .setName('player2')
            .setDescription('First opponent'))
        .addUserOption(option => option
            .setName('player3')
            .setDescription('Second opponent'))
        .addUserOption(option => option
            .setName('player4')
            .setDescription('Third opponent'))
        .addIntegerOption(option => option
            .setName('bots')
            .setDescription('Add 0-3 bots')
            .setMinValue(0)
            .setMaxValue(3)),

    async execute(interaction) {
        if (channelGames.has(interaction.channelId)) {
            return interaction.reply({
                content: '🃏 A Golf table is already running in this channel.',
                ephemeral: true
            });
        }

        const host = {
            id: interaction.user.id,
            name: displayName(interaction),
            isBot: false
        };
        const seats = [host];
        const seen = new Set([host.id]);

        for (const option of ['player2', 'player3', 'player4']) {
            const user = interaction.options.getUser(option);
            if (!user || seen.has(user.id)) continue;
            seen.add(user.id);
            const member = interaction.options.getMember(option);
            seats.push({
                id: user.id,
                name: member?.displayName ?? user.globalName ?? user.username,
                isBot: Boolean(user.bot)
            });
        }

        const requestedBots = interaction.options.getInteger('bots') ?? 0;
        while (seats.length < golf.MIN_PLAYERS) seats.push(newBot(seats));
        for (let added = 0; added < requestedBots && seats.length < golf.MAX_PLAYERS; added += 1) {
            seats.push(newBot(seats));
        }
        seats.length = Math.min(seats.length, golf.MAX_PLAYERS);

        let state;
        try {
            state = golf.createGame({ players: seats });
        } catch (error) {
            return interaction.reply({ content: `❌ ${error.message}`, ephemeral: true });
        }

        const game = {
            id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            channelId: interaction.channelId,
            hostId: host.id,
            state,
            message: null,
            ended: false,
            timer: null,
            readyTimer: null,
            turnToken: 0
        };
        games.set(game.id, game);
        channelGames.set(game.channelId, game.id);

        const mentions = seats
            .filter(player => !player.isBot)
            .map(player => `<@${player.id}>`)
            .join(' ');

        const opening = publicPayload(game);
        await interaction.reply(mentions ? { content: mentions, ...opening } : opening);
        game.message = await interaction.fetchReply();
        armMemorizeTimer(game);
    },

    async handleComponent(interaction) {
        const [, verb, gameId, arg] = interaction.customId.split(':');
        const game = games.get(gameId);
        if (!game || game.ended) {
            return interaction.reply({ content: 'That Golf table has closed.', ephemeral: true }).catch(() => {});
        }

        const player = game.state.players.find(candidate => candidate.id === interaction.user.id);
        if (!player) {
            return interaction.reply({ content: 'You are not seated at this table.', ephemeral: true }).catch(() => {});
        }

        const deny = content => interaction.reply({ content, ephemeral: true }).catch(() => {});

        if (verb === 'memorize') {
            if (game.state.status !== 'memorize') return deny('Memorization is over.');
            return interaction.reply({ ...memoryPayload(game, player), ephemeral: true }).catch(() => {});
        }

        if (verb === 'flip') {
            try {
                const slot = Number(arg);
                if (player.memory.revealed === slot) {
                    golf.putBack(game.state, player.id, slot);
                } else {
                    golf.revealCard(game.state, player.id, slot);
                }
                return interaction.update(memoryPayload(game, player)).catch(() => {});
            } catch (error) {
                return deny(`❌ ${error.message}`);
            }
        }

        if (verb === 'done') {
            try {
                const { allReady } = golf.finishMemorizing(game.state, player.id);
                await interaction.update({
                    content: '✅ Memorized. Waiting for the others…',
                    components: []
                }).catch(() => {});
                if (allReady) {
                    await startGame(game);
                } else {
                    await updatePublic(game, `🧠 **${player.name}** is ready.`);
                }
                return undefined;
            } catch (error) {
                return deny(`❌ ${error.message}`);
            }
        }

        if (verb === 'turn') {
            if (game.state.status !== 'playing') return deny('The game has not started yet.');
            const current = golf.currentPlayer(game.state);
            if (current.id !== player.id) return deny(`⏳ It is ${current.name}'s turn.`);
            return interaction.reply({ ...turnPayload(game, player), ephemeral: true }).catch(() => {});
        }

        if (verb === 'take' || verb === 'draw') {
            try {
                if (verb === 'take') golf.takeDiscard(game.state, player.id);
                else golf.drawFromDeck(game.state, player.id);
                return interaction.update(turnPayload(game, player)).catch(() => {});
            } catch (error) {
                return deny(`❌ ${error.message}`);
            }
        }

        if (verb === 'swap') {
            try {
                const result = golf.swapPending(game.state, player.id, Number(arg));
                await interaction.update({
                    content: [
                        `🔄 Swapped in **${golf.cardLabel(result.drawn)}**.`,
                        `**${golf.cardLabel(result.replaced)}** is now on the discard pile.`
                    ].join('\n'),
                    components: []
                }).catch(() => {});
                afterAction(game, `🔄 **${player.name}** made a swap.`);
                return undefined;
            } catch (error) {
                return deny(`❌ ${error.message}`);
            }
        }

        if (verb === 'discard') {
            try {
                const card = golf.discardPending(game.state, player.id);
                await interaction.update({
                    content: `🗑️ Discarded **${golf.cardLabel(card)}**.`,
                    components: []
                }).catch(() => {});
                afterAction(game, `🗑️ **${player.name}** discarded **${golf.cardLabel(card)}**.`);
                return undefined;
            } catch (error) {
                return deny(`❌ ${error.message}`);
            }
        }

        if (verb === 'knock') {
            try {
                golf.knock(game.state, player.id);
                await interaction.update({
                    content: '✊ You knocked! Everyone else gets one final turn.',
                    components: []
                }).catch(() => {});
                afterAction(game, `✊ **${player.name}** knocked!`);
                return undefined;
            } catch (error) {
                return deny(`❌ ${error.message}`);
            }
        }

        if (verb === 'end') {
            if (interaction.user.id !== game.hostId) return deny('Only the host can end the table.');
            await deny('🛑 Table closed.');
            return finishGame(game, 'Ended by the host.');
        }

        return deny('That action is not available.');
    }
};

/* Exported for tests: these builders never touch the Discord API. */
module.exports.publicPayload = publicPayload;
module.exports.memoryPayload = memoryPayload;
module.exports.turnPayload = turnPayload;
module.exports.finishedPayload = finishedPayload;
