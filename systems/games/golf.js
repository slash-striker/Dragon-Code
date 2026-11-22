/*
 * Golf — the card game behind /play-cards.
 *
 * Pure state machine: no discord.js, no timers, no database. The command layer
 * owns the buttons and private panels; this file owns the rules.
 *
 * A hand is four face-down cards. At the start each player may look at two of
 * them, one at a time, and must put each back. On a turn a player takes the
 * discard top or draws from the deck; a kept card is swapped into one of the
 * four slots and the replaced card goes on the discard pile. A drawn card that
 * is not wanted is discarded. Knocking ends the drawer's turn and gives every
 * other player exactly one last turn. Lowest hand wins.
 *
 * Values: A = 1, 2-10 face value, J = 0, Q/K = 10, joker = -2.
 */

const HAND_SIZE = 4;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const VIEW_LIMIT = 2;

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function buildDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const rank of RANKS) deck.push({ rank, suit, joker: false });
    }
    deck.push({ rank: 'JOKER', suit: '🃏', joker: true });
    deck.push({ rank: 'JOKER', suit: '🃏', joker: true });
    return deck;
}

function shuffle(items, rng = Math.random) {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(rng() * (index + 1));
        const value = copy[index];
        copy[index] = copy[swap];
        copy[swap] = value;
    }
    return copy;
}

function cardLabel(card) {
    if (!card) return '—';
    return card.joker ? '🃏' : `${card.rank}${card.suit}`;
}

function cardValue(card) {
    if (!card) return 0;
    if (card.joker) return -2;
    if (card.rank === 'J') return 0;
    if (card.rank === 'Q' || card.rank === 'K') return 10;
    if (card.rank === 'A') return 1;
    return Number(card.rank);
}

function handValue(hand) {
    return (hand || []).reduce((total, card) => total + cardValue(card), 0);
}

function playerById(state, playerId) {
    return state.players.find(player => player.id === String(playerId)) ?? null;
}

function currentPlayer(state) {
    return state.players[state.turnIndex] ?? null;
}

function allReady(state) {
    return state.players.every(player => player.ready);
}

/*
 * Bots memorize two random slots at deal time; that is the only information
 * they are allowed to use for the rest of the hand.
 */
function autoMemorize(state, playerId, rng = Math.random) {
    const player = playerById(state, playerId);
    if (!player) throw new Error('That player is not at this table.');
    const slots = shuffle([0, 1, 2, 3], rng).slice(0, VIEW_LIMIT).sort((a, b) => a - b);
    player.memory = { viewed: slots, revealed: null, done: true };
    player.known = [...slots];
    player.ready = true;
    return player;
}

function createGame({ players, rng = Math.random } = {}) {
    if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
        throw new Error(`Golf needs ${MIN_PLAYERS} to ${MAX_PLAYERS} players.`);
    }

    const seen = new Set();
    const seats = players.map((player, index) => {
        const id = String(player?.id ?? '');
        if (!id) throw new Error('Every player needs an id.');
        if (seen.has(id)) throw new Error('A player can only take one seat.');
        seen.add(id);
        return {
            id,
            name: String(player?.name ?? '').trim() || `Player ${index + 1}`,
            isBot: Boolean(player?.isBot)
        };
    });

    const state = {
        players: seats.map(seat => ({
            ...seat,
            hand: [],
            ready: false,
            memory: { viewed: [], revealed: null, done: false },
            known: []
        })),
        deck: shuffle(buildDeck(), rng),
        discard: [],
        status: 'memorize',
        turnIndex: Math.floor(rng() * seats.length),
        turnCount: 0,
        knockerId: null,
        finalQueue: [],
        finalTotal: 0,
        pending: null,
        log: [],
        winners: [],
        results: []
    };

    for (const player of state.players) {
        player.hand = state.deck.splice(0, HAND_SIZE);
        if (player.isBot) autoMemorize(state, player.id, rng);
    }
    state.discard.push(state.deck.pop());
    return state;
}

function memorizingPlayer(state, playerId) {
    if (state.status !== 'memorize') throw new Error('Memorization is over.');
    const player = playerById(state, playerId);
    if (!player) throw new Error('You are not at this table.');
    if (player.memory.done) throw new Error('You already memorized your cards.');
    return player;
}

/* Reveal one slot. It counts as one of the two looks and stays face up until
 * putBack() is called. */
function revealCard(state, playerId, slot) {
    const player = memorizingPlayer(state, playerId);
    const index = Number(slot);
    if (!Number.isInteger(index) || index < 0 || index >= HAND_SIZE) {
        throw new Error('Pick a card from 1 to 4.');
    }
    if (player.memory.revealed !== null) {
        throw new Error('Put the first card back before looking at another.');
    }
    if (player.memory.viewed.includes(index)) {
        throw new Error('You already looked at that card.');
    }
    if (player.memory.viewed.length >= VIEW_LIMIT) {
        throw new Error(`You can only look at ${VIEW_LIMIT} cards.`);
    }

    player.memory.viewed.push(index);
    player.memory.revealed = index;
    return player.hand[index];
}

function putBack(state, playerId, slot) {
    const player = memorizingPlayer(state, playerId);
    if (player.memory.revealed !== Number(slot)) {
        throw new Error('That card is not face up.');
    }
    player.memory.revealed = null;
    return true;
}

function finishMemorizing(state, playerId) {
    const player = memorizingPlayer(state, playerId);
    if (player.memory.revealed !== null) throw new Error('Put the card back first.');
    if (player.memory.viewed.length < VIEW_LIMIT) {
        throw new Error(`Look at ${VIEW_LIMIT} cards first.`);
    }
    player.memory.done = true;
    player.ready = true;
    return { allReady: allReady(state) };
}

function beginPlay(state) {
    if (state.status !== 'memorize') throw new Error('The game has already started.');
    if (!allReady(state)) throw new Error('Everyone has to finish memorizing first.');
    state.status = 'playing';
    state.turnCount = 1;
    state.log.push(`🎬 ${currentPlayer(state).name} goes first.`);
    return state;
}

function assertTurn(state, playerId) {
    if (state.status !== 'playing') throw new Error('The game is not in play.');
    const player = currentPlayer(state);
    if (!player || player.id !== String(playerId)) {
        throw new Error(`It is ${player?.name ?? 'someone else'}'s turn.`);
    }
    return player;
}

function takeDiscard(state, playerId) {
    assertTurn(state, playerId);
    if (state.pending) throw new Error('Finish the card you already drew.');
    if (!state.discard.length) throw new Error('The discard pile is empty.');
    const card = state.discard.pop();
    state.pending = { card, source: 'discard' };
    return card;
}

function ensureDeck(state) {
    if (state.deck.length) return;
    if (!state.discard.length) return;
    const top = state.discard.pop();
    state.deck = shuffle(state.discard);
    state.discard = top ? [top] : [];
}

function drawFromDeck(state, playerId) {
    assertTurn(state, playerId);
    if (state.pending) throw new Error('Finish the card you already drew.');
    ensureDeck(state);
    if (!state.deck.length) throw new Error('The deck is empty.');
    const card = state.deck.pop();
    state.pending = { card, source: 'deck' };
    return card;
}

function swapPending(state, playerId, slot) {
    const player = assertTurn(state, playerId);
    if (!state.pending) throw new Error('Draw a card first.');
    const index = Number(slot);
    if (!Number.isInteger(index) || index < 0 || index >= HAND_SIZE) {
        throw new Error('Pick a slot from 1 to 4.');
    }

    const replaced = player.hand[index];
    player.hand[index] = state.pending.card;
    state.discard.push(replaced);
    if (player.isBot && !player.known.includes(index)) player.known.push(index);

    const drawn = state.pending.card;
    state.pending = null;
    /* The drawn card stays hidden; only the replaced card becomes public. */
    state.log.push(`🔄 ${player.name} made a swap; ${cardLabel(replaced)} hit the discard.`);
    advance(state);
    return { drawn, replaced };
}

function discardPending(state, playerId) {
    const player = assertTurn(state, playerId);
    if (!state.pending) throw new Error('Draw a card first.');
    const card = state.pending.card;
    state.discard.push(card);
    state.pending = null;
    state.log.push(`🗑️ ${player.name} discarded ${cardLabel(card)}.`);
    advance(state);
    return card;
}

function knock(state, playerId) {
    const player = assertTurn(state, playerId);
    if (state.knockerId) throw new Error('Someone already knocked.');
    if (state.pending) throw new Error('Finish the card you drew before knocking.');

    state.knockerId = player.id;
    const order = [];
    for (let offset = 1; offset < state.players.length; offset += 1) {
        order.push(state.players[(state.turnIndex + offset) % state.players.length].id);
    }
    state.finalQueue = order;
    state.finalTotal = order.length;
    state.pending = null;
    state.log.push(`✊ ${player.name} knocked — everyone else gets one last turn.`);

    if (!order.length) return finish(state);
    state.turnIndex = state.players.findIndex(candidate => candidate.id === order[0]);
    state.turnCount += 1;
    return state;
}

function advance(state) {
    if (state.status !== 'playing') return state;

    if (state.knockerId) {
        const finishedId = currentPlayer(state)?.id;
        state.finalQueue = state.finalQueue.filter(id => id !== finishedId);
        if (!state.finalQueue.length) return finish(state);
        state.turnIndex = state.players.findIndex(player => player.id === state.finalQueue[0]);
        state.turnCount += 1;
        state.pending = null;
        return state;
    }

    state.turnIndex = (state.turnIndex + 1) % state.players.length;
    state.turnCount += 1;
    state.pending = null;
    return state;
}

function abandonTurn(state) {
    if (state.status !== 'playing') return state;
    const player = currentPlayer(state);
    if (state.pending) {
        state.discard.push(state.pending.card);
        state.pending = null;
    }
    state.log.push(`⏰ ${player?.name ?? 'A player'} ran out of time.`);
    return advance(state);
}

function finish(state) {
    if (state.status === 'finished') return state;
    state.status = 'finished';
    state.pending = null;

    const results = state.players.map(player => ({
        id: player.id,
        name: player.name,
        isBot: player.isBot,
        hand: [...player.hand],
        total: handValue(player.hand)
    }));
    const best = Math.min(...results.map(result => result.total));
    state.results = results;
    state.winners = results.filter(result => result.total === best).map(result => result.id);
    const names = results.filter(result => state.winners.includes(result.id)).map(result => result.name);
    state.log.push(`🏁 ${names.join(' & ')} won with ${best}.`);
    return state;
}

function isFinalTurn(state, playerId) {
    return Boolean(state.knockerId) && state.finalQueue.includes(String(playerId));
}

function canKnock(state, playerId) {
    return state.status === 'playing'
        && !state.knockerId
        && !state.pending
        && currentPlayer(state)?.id === String(playerId);
}

/* The worst card the bot knows about is the one worth replacing. */
function worstKnownSlot(player) {
    let slot = null;
    let value = -Infinity;
    for (const index of player.known) {
        const candidate = cardValue(player.hand[index]);
        if (candidate > value) {
            value = candidate;
            slot = index;
        }
    }
    return slot;
}

function chooseBotMove(state, playerId) {
    const player = assertTurn(state, playerId);
    if (!player.isBot) throw new Error('Only bots choose automatically.');

    if (!state.knockerId) {
        const known = player.known.map(index => cardValue(player.hand[index]));
        const sum = known.reduce((total, value) => total + value, 0);
        if (state.turnCount >= 4 && known.length >= 2 && sum <= 1) return { action: 'knock' };
        if (state.turnCount >= 6 && Math.random() < 0.05) return { action: 'knock' };
    }

    const top = state.discard[state.discard.length - 1];
    const worst = worstKnownSlot(player);
    if (top && worst !== null && cardValue(top) < cardValue(player.hand[worst])) {
        return { action: 'take-discard' };
    }
    return { action: 'draw' };
}

function chooseBotPending(state, playerId) {
    const player = assertTurn(state, playerId);
    if (!player.isBot) throw new Error('Only bots choose automatically.');
    if (!state.pending) throw new Error('The bot has not drawn a card.');

    const value = cardValue(state.pending.card);
    const worst = worstKnownSlot(player);
    if (worst !== null && value < cardValue(player.hand[worst])) {
        return { action: 'swap', slot: worst };
    }
    if (worst === null && value <= 2) return { action: 'swap', slot: 0 };
    return { action: 'discard' };
}

module.exports = {
    HAND_SIZE,
    MIN_PLAYERS,
    MAX_PLAYERS,
    VIEW_LIMIT,
    buildDeck,
    shuffle,
    cardLabel,
    cardValue,
    handValue,
    playerById,
    currentPlayer,
    allReady,
    autoMemorize,
    createGame,
    revealCard,
    putBack,
    finishMemorizing,
    beginPlay,
    takeDiscard,
    drawFromDeck,
    swapPending,
    discardPending,
    knock,
    advance,
    abandonTurn,
    finish,
    isFinalTurn,
    canKnock,
    worstKnownSlot,
    chooseBotMove,
    chooseBotPending
};
