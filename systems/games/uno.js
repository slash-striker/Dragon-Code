/*
 * UNO rules engine. Pure state transitions only: no Discord, no database.
 * Standard 108-card deck (wilds, +4s and +2s included), skip / reverse /
 * draw-2, wild colour choice, UNO call + catch penalty, round scoring.
 *
 * Rule modes: 'normal' (classic — a pending +2/+4 must be drawn, no
 * stacking), 'stack' (same draw stacks on same draw; a +4 may answer a +2),
 * 'spicy' (any +2/+4 stacks on any pending draw, +4s are always playable,
 * and the UNO-catch penalty is 4 cards).
 */

const COLORS = ['red', 'yellow', 'green', 'blue'];
const ACTION_VALUES = ['skip', 'reverse', 'draw2'];
const RULE_MODES = ['normal', 'stack', 'spicy'];
const TARGET_SCORE = 500;
const HAND_SIZE = 7;
const CATCH_PENALTY = 2;
const SPICY_CATCH_PENALTY = 4;

/* Short human-readable description of a rule mode for embeds and menus. */
function describeRules(mode) {
    switch (mode) {
        case 'normal':
            return 'Normal (no stacking — draw the penalty)';
        case 'spicy':
            return 'Spicy (any +2/+4 stacks, free +4s, 4-card UNO catch)';
        default:
            return 'Stack (+2s stack on +2s, +4s answer +2s)';
    }
}

function buildDeck() {
    let nextId = 0;
    const cards = [];
    const push = (color, value) => cards.push({ id: `c${nextId++}`, color, value });
    for (const color of COLORS) {
        push(color, '0');
        for (let n = 1; n <= 9; n++) {
            push(color, String(n));
            push(color, String(n));
        }
        for (const action of ACTION_VALUES) {
            push(color, action);
            push(color, action);
        }
    }
    for (let i = 0; i < 4; i++) {
        push('wild', 'wild');
        push('wild', 'wild4');
    }
    return cards;
}

function shuffle(list, rng = Math.random) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function isWild(card) {
    return card.color === 'wild';
}

/* Scoring value of a card left in a losing hand. */
function cardPoints(card) {
    if (/^\d$/.test(card.value)) return Number(card.value);
    if (ACTION_VALUES.includes(card.value)) return 20;
    return 50;
}

function topCard(state) {
    return state.discard[state.discard.length - 1];
}

function currentPlayer(state) {
    return state.players[state.turn];
}

function advance(state, steps = 1) {
    const n = state.players.length;
    state.turn = (((state.turn + state.direction * steps) % n) + n) % n;
}

function drawFromDeck(state) {
    if (!state.deck.length) {
        // Recycle every discarded card except the visible top card.
        const top = state.discard.pop();
        state.deck = shuffle(state.discard, state.rng);
        state.discard = top ? [top] : [];
    }
    return state.deck.pop() ?? null;
}

function assertPlaying(state) {
    if (state.status !== 'playing') throw new Error('This round is over.');
}

function canPlayCard(state, hand, card) {
    if (state.pendingDraw > 0) {
        // NORMAL: no stacking — the penalty must be drawn.
        if (state.rulesMode === 'normal') return false;
        // SPICY: any draw card stacks on any pending draw, no bluffing rule.
        if (state.rulesMode === 'spicy') return card.value === 'draw2' || card.value === 'wild4';
        // STACK: the same draw answers the same draw; a wild +4 may also
        // answer a +2 when the hand holds no card of the active colour.
        if (card.value === 'wild4') {
            if (state.pendingKind === 'wild4') return true;
            if (state.pendingKind === 'draw2') return !hand.some(c => c.color === state.color);
            return false;
        }
        return card.value === state.pendingKind;
    }
    if (card.value === 'wild') return true;
    // Wild +4 is only legal when the hand holds no card of the active colour
    // (no bluffing) — except in SPICY, where anything goes.
    if (card.value === 'wild4') {
        if (state.rulesMode === 'spicy') return true;
        return !hand.some(c => c.color === state.color);
    }
    return card.color === state.color || card.value === topCard(state).value;
}

function legalCards(state, playerId) {
    const player = state.players.find(p => p.id === playerId);
    if (!player || state.status !== 'playing') return [];
    return player.hand.filter(card => canPlayCard(state, player.hand, card));
}

function applyStarterEffect(state, card) {
    if (card.value === 'skip') advance(state, 1);
    else if (card.value === 'reverse') state.direction = -1;
    else if (card.value === 'draw2') {
        state.pendingDraw = 2;
        state.pendingKind = 'draw2';
    }
}

function startRound(state) {
    state.round += 1;
    state.deck = shuffle(buildDeck(), state.rng);
    state.discard = [];
    state.roundWinnerId = null;
    state.roundPoints = 0;
    state.unoOpen = null;
    state.pendingDraw = 0;
    state.pendingKind = null;
    state.direction = 1;
    state.status = 'playing';
    for (const player of state.players) {
        player.hand = [];
        player.calledUno = false;
    }
    for (let i = 0; i < HAND_SIZE; i++) {
        for (const player of state.players) player.hand.push(state.deck.pop());
    }

    // Flip a starter card. Wilds go back into the deck so the round never opens on one.
    let starter;
    do {
        starter = state.deck.pop();
        if (isWild(starter)) {
            state.deck.unshift(starter);
            state.deck = shuffle(state.deck, state.rng);
        }
    } while (isWild(starter));
    state.discard.push(starter);
    state.color = starter.color;
    state.turn = (state.round - 1) % state.players.length;
    applyStarterEffect(state, starter);
    state.log.push(`Round ${state.round} begins.`);
}

function createGame({ players, targetScore = TARGET_SCORE, rng = Math.random, rulesMode = 'stack' } = {}) {
    if (!Array.isArray(players) || players.length < 2 || players.length > 4) {
        throw new Error('UNO needs 2 to 4 players.');
    }
    if (!RULE_MODES.includes(rulesMode)) throw new Error('Unknown UNO rules mode.');
    const state = {
        players: players.map(player => ({
            id: player.id,
            name: player.name,
            isBot: Boolean(player.isBot),
            hand: [],
            score: 0,
            calledUno: false
        })),
        deck: [],
        discard: [],
        color: null,
        direction: 1,
        turn: 0,
        round: 0,
        pendingDraw: 0,
        pendingKind: null,
        targetScore,
        rulesMode,
        status: 'playing',
        winnerId: null,
        roundWinnerId: null,
        roundPoints: 0,
        unoOpen: null,
        rng,
        log: []
    };
    startRound(state);
    return state;
}

function finishRound(state, winner) {
    const points = state.players
        .filter(player => player !== winner)
        .reduce((sum, player) => sum + player.hand.reduce((total, card) => total + cardPoints(card), 0), 0);
    winner.score += points;
    state.roundWinnerId = winner.id;
    state.roundPoints = points;
    state.status = 'round-over';
    if (winner.score >= state.targetScore) {
        state.status = 'ended';
        state.winnerId = winner.id;
    }
    state.log.push(`${winner.name} went out and scored ${points} points.`);
    return { roundOver: true, winnerId: winner.id, points, gameOver: state.status === 'ended' };
}

/*
 * Play one card. `chosenColor` is required for wild cards. Returns the result
 * object; throws on any illegal move so callers can show the message.
 */
function playCard(state, playerId, cardId, chosenColor = null) {
    assertPlaying(state);
    const player = currentPlayer(state);
    if (player.id !== playerId) throw new Error("It's not your turn.");
    const card = player.hand.find(c => c.id === cardId);
    if (!card) throw new Error('That card is not in your hand.');
    if (!canPlayCard(state, player.hand, card)) throw new Error('That card cannot be played right now.');
    if (isWild(card) && !COLORS.includes(chosenColor)) throw new Error('Choose a colour for your wild card.');

    player.hand = player.hand.filter(c => c.id !== cardId);
    state.discard.push(card);
    state.color = isWild(card) ? chosenColor : card.color;
    state.unoOpen = null;
    if (player.hand.length !== 1) player.calledUno = false;

    if (player.hand.length === 0) return finishRound(state, player);
    // One card left without a UNO call: anyone may catch it until the next action.
    if (player.hand.length === 1 && !player.calledUno) state.unoOpen = player.id;

    const n = state.players.length;
    switch (card.value) {
        case 'skip':
            advance(state, 2);
            break;
        case 'reverse':
            state.direction *= -1;
            // With two players, reverse behaves like skip.
            advance(state, n === 2 ? 2 : 1);
            break;
        case 'draw2':
            state.pendingDraw += 2;
            state.pendingKind = 'draw2';
            advance(state, 1);
            break;
        case 'wild4':
            state.pendingDraw += 4;
            state.pendingKind = 'wild4';
            advance(state, 1);
            break;
        default:
            advance(state, 1);
    }
    return { roundOver: false, card, playerId };
}

/* Draw the pending penalty, or one card. The turn passes either way. */
function drawCard(state, playerId) {
    assertPlaying(state);
    const player = currentPlayer(state);
    if (player.id !== playerId) throw new Error("It's not your turn.");
    const amount = state.pendingDraw > 0 ? state.pendingDraw : 1;
    state.unoOpen = null;
    for (let i = 0; i < amount; i++) {
        const card = drawFromDeck(state);
        if (card) player.hand.push(card);
    }
    if (player.hand.length !== 1) player.calledUno = false;
    state.pendingDraw = 0;
    state.pendingKind = null;
    advance(state, 1);
    return { drew: amount };
}

function callUno(state, playerId) {
    const player = state.players.find(p => p.id === playerId);
    if (!player) throw new Error('You are not in this game.');
    if (player.hand.length !== 1) throw new Error('You can only call UNO with one card left.');
    player.calledUno = true;
    if (state.unoOpen === playerId) state.unoOpen = null;
    return { playerId };
}

/* Catch someone who forgot to call UNO: they draw the penalty cards. */
function catchUno(state, catcherId) {
    const target = state.players.find(p => p.id === state.unoOpen);
    if (!target || target.id === catcherId || target.calledUno || target.hand.length !== 1) {
        throw new Error('Nobody forgot to call UNO right now.');
    }
    const penalty = state.rulesMode === 'spicy' ? SPICY_CATCH_PENALTY : CATCH_PENALTY;
    for (let i = 0; i < penalty; i++) {
        const card = drawFromDeck(state);
        if (card) target.hand.push(card);
    }
    target.calledUno = false;
    state.unoOpen = null;
    return { targetId: target.id };
}

function startNextRound(state) {
    if (state.status !== 'round-over') throw new Error('The current round has not finished.');
    startRound(state);
}

function countColors(cards) {
    const counts = {};
    for (const card of cards) {
        if (!isWild(card)) counts[card.color] = (counts[card.color] ?? 0) + 1;
    }
    return counts;
}

function mostCommonColor(hand, rng = Math.random) {
    const counts = countColors(hand);
    const ranked = COLORS.slice().sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0));
    return (counts[ranked[0]] ?? 0) > 0 ? ranked[0] : COLORS[Math.floor(rng() * COLORS.length)];
}

/*
 * Bot policy: play the colour it holds most, save wilds, lean on action cards
 * when the next seat is close to going out, and draw only when nothing fits.
 */
function chooseBotMove(state) {
    const bot = currentPlayer(state);
    const legal = legalCards(state, bot.id);
    if (!legal.length) return { action: 'draw' };

    const n = state.players.length;
    const next = state.players[(((state.turn + state.direction) % n) + n) % n];
    const danger = next.hand.length <= 2;
    const counts = countColors(bot.hand);
    const score = card => {
        let value = isWild(card) ? -4 : (counts[card.color] ?? 0);
        if (ACTION_VALUES.includes(card.value) && danger) value += 6;
        if (card.value === 'draw2' || card.value === 'wild4') value += 2;
        return value;
    };
    const best = legal.reduce((a, b) => (score(b) > score(a) ? b : a));
    return {
        action: 'play',
        cardId: best.id,
        color: isWild(best) ? mostCommonColor(bot.hand) : null
    };
}

module.exports = {
    COLORS,
    RULE_MODES,
    SPICY_CATCH_PENALTY,
    TARGET_SCORE,
    HAND_SIZE,
    describeRules,
    buildDeck,
    shuffle,
    cardPoints,
    createGame,
    startNextRound,
    legalCards,
    canPlayCard,
    playCard,
    drawCard,
    callUno,
    catchUno,
    chooseBotMove,
    currentPlayer,
    topCard
};
