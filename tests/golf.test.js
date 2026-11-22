const test = require('node:test');
const assert = require('node:assert');

const golf = require('../systems/games/golf');

const PLAYERS = [
    { id: 'p1', name: 'One' },
    { id: 'p2', name: 'Two' },
    { id: 'p3', name: 'Three' }
];

/* A game past memorization, with p1 on turn. */
function readyGame(players = PLAYERS) {
    const state = golf.createGame({ players });
    for (const player of state.players) {
        player.memory = { viewed: [0, 1], revealed: null, done: true };
        player.ready = true;
    }
    golf.beginPlay(state);
    state.turnIndex = 0;
    return state;
}

test('golf: card values follow the house rules', () => {
    assert.strictEqual(golf.cardValue({ rank: 'A', suit: '♠' }), 1);
    assert.strictEqual(golf.cardValue({ rank: 'J', suit: '♠' }), 0);
    assert.strictEqual(golf.cardValue({ rank: 'Q', suit: '♠' }), 10);
    assert.strictEqual(golf.cardValue({ rank: 'K', suit: '♠' }), 10);
    assert.strictEqual(golf.cardValue({ rank: '7', suit: '♠' }), 7);
    assert.strictEqual(golf.cardValue({ joker: true }), -2);
    assert.strictEqual(
        golf.handValue([
            { rank: 'A', suit: '♠' },
            { rank: 'J', suit: '♠' },
            { joker: true },
            { rank: 'K', suit: '♠' }
        ]),
        9
    );
    assert.strictEqual(golf.cardLabel({ joker: true }), '🃏');
    assert.strictEqual(golf.cardLabel({ rank: '10', suit: '♥' }), '10♥');
});

test('golf: a deal gives everyone four cards and leaves one on the discard', () => {
    const state = golf.createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });

    assert.strictEqual(state.status, 'memorize');
    assert.strictEqual(state.deck.length, 54 - 8 - 1);
    assert.strictEqual(state.discard.length, 1);
    assert.ok(state.players.every(player => player.hand.length === 4));
});

test('golf: each player may look at exactly two cards, one at a time', () => {
    const state = golf.createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });

    golf.revealCard(state, 'a', 0);
    // The first card has to go back before the second can be seen.
    assert.throws(() => golf.revealCard(state, 'a', 1), /Put the first card back/);
    assert.throws(() => golf.finishMemorizing(state, 'a'), /Put the card back first/);
    golf.putBack(state, 'a', 0);
    assert.throws(() => golf.finishMemorizing(state, 'a'), /Look at 2 cards first/);
    golf.revealCard(state, 'a', 1);
    golf.putBack(state, 'a', 1);
    assert.throws(() => golf.revealCard(state, 'a', 2), /only look at 2 cards/);

    // Done works once two cards have been seen and both are face down again.
    assert.deepStrictEqual(golf.finishMemorizing(state, 'a'), { allReady: false });
    assert.throws(() => golf.revealCard(state, 'a', 2), /already memorized/);

    golf.revealCard(state, 'b', 2);
    golf.putBack(state, 'b', 2);
    golf.revealCard(state, 'b', 3);
    golf.putBack(state, 'b', 3);
    assert.deepStrictEqual(golf.finishMemorizing(state, 'b'), { allReady: true });

    golf.beginPlay(state);
    assert.strictEqual(state.status, 'playing');
});

test('golf: taking the discard and swapping sends the replaced card to the pile', () => {
    const state = readyGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
    state.discard = [{ rank: 'A', suit: '♠' }];
    const replaced = state.players[0].hand[0];

    assert.deepStrictEqual(golf.takeDiscard(state, 'a'), { rank: 'A', suit: '♠' });
    const result = golf.swapPending(state, 'a', 0);

    assert.deepStrictEqual(state.players[0].hand[0], { rank: 'A', suit: '♠' });
    assert.deepStrictEqual(result.replaced, replaced);
    assert.deepStrictEqual(state.discard[state.discard.length - 1], replaced);
    assert.strictEqual(state.turnIndex, 1);
});

test('golf: an unwanted draw is discarded and the turn passes', () => {
    const state = readyGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
    const drawn = { rank: '7', suit: '♥' };
    state.deck = [drawn];

    assert.deepStrictEqual(golf.drawFromDeck(state, 'a'), drawn);
    assert.deepStrictEqual(golf.discardPending(state, 'a'), drawn);
    assert.deepStrictEqual(state.discard[state.discard.length - 1], drawn);
    assert.strictEqual(state.turnIndex, 1);
    assert.strictEqual(state.pending, null);
});

test('golf: a knock gives everyone else one last turn and the lowest hand wins', () => {
    const state = readyGame(PLAYERS);
    state.players[0].hand = [
        { rank: 'A', suit: '♠' },
        { rank: '2', suit: '♠' },
        { rank: '3', suit: '♠' },
        { rank: '4', suit: '♠' }
    ];
    state.players[1].hand = [
        { rank: '5', suit: '♠' },
        { rank: '6', suit: '♠' },
        { rank: '7', suit: '♠' },
        { rank: '8', suit: '♠' }
    ];
    state.players[2].hand = [
        { rank: 'J', suit: '♠' },
        { rank: 'J', suit: '♥' },
        { rank: 'J', suit: '♦' },
        { rank: 'J', suit: '♣' }
    ];

    golf.knock(state, 'p1');
    assert.strictEqual(state.knockerId, 'p1');
    assert.deepStrictEqual(state.finalQueue, ['p2', 'p3']);
    assert.strictEqual(state.turnIndex, 1);
    assert.strictEqual(golf.canKnock(state, 'p2'), false);

    state.deck = [{ rank: 'K', suit: '♥' }];
    golf.drawFromDeck(state, 'p2');
    golf.discardPending(state, 'p2');
    assert.strictEqual(state.turnIndex, 2);
    assert.strictEqual(state.status, 'playing');

    state.deck = [{ rank: 'Q', suit: '♥' }];
    golf.drawFromDeck(state, 'p3');
    golf.discardPending(state, 'p3');

    assert.strictEqual(state.status, 'finished');
    assert.deepStrictEqual(state.winners, ['p3']);
    assert.strictEqual(state.results.find(result => result.id === 'p3').total, 0);
    // The knocker's hand was not changed by the final turns.
    assert.strictEqual(state.results.find(result => result.id === 'p1').total, 10);
});

test('golf: bots memorize automatically and know two slots', () => {
    const state = golf.createGame({
        players: [
            { id: 'a', name: 'A' },
            { id: 'bot', name: 'Bot', isBot: true }
        ]
    });
    const bot = state.players[1];

    assert.strictEqual(bot.ready, true);
    assert.strictEqual(bot.memory.done, true);
    assert.strictEqual(bot.known.length, 2);

    // The human still has to do the memorization step.
    golf.autoMemorize(state, 'a');
    assert.strictEqual(golf.allReady(state), true);
    golf.beginPlay(state);
    assert.strictEqual(state.status, 'playing');
});
