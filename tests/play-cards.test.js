const test = require('node:test');
const assert = require('node:assert');

const golf = require('../systems/games/golf');
const playCards = require('../commands/play-cards');

function gameWith(players) {
    return {
        id: 'test-table',
        channelId: 'channel',
        hostId: players[0].id,
        state: golf.createGame({ players }),
        ended: false
    };
}

function description(payload) {
    return payload.embeds[0].data.description ?? '';
}

test('play-cards: the public table never shows a hand during memorization', () => {
    const game = gameWith([{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }]);
    const payload = playCards.publicPayload(game);

    assert.match(description(payload), /Memorize two/);
    for (const player of game.state.players) {
        for (const card of player.hand) {
            assert.ok(
                !description(payload).includes(golf.cardLabel(card)),
                `public table leaked ${golf.cardLabel(card)}`
            );
        }
    }

    // The private panel has four card buttons and a Done button.
    const memory = playCards.memoryPayload(game, game.state.players[0]);
    assert.strictEqual(memory.components.length, 2);
    assert.strictEqual(memory.components[0].components.length, 4);
    assert.strictEqual(memory.components[1].components.length, 1);
});

test('play-cards: a deck draw is shown only in the private turn panel', () => {
    const game = gameWith([{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }]);
    for (const player of game.state.players) {
        player.ready = true;
        player.memory.done = true;
    }
    golf.beginPlay(game.state);
    game.state.turnIndex = 0;

    const drawn = { rank: '7', suit: '♥' };
    game.state.deck = [drawn];
    golf.drawFromDeck(game.state, 'p1');

    const panel = playCards.turnPayload(game, game.state.players[0]);
    assert.match(panel.content, /7♥/);
    assert.strictEqual(panel.components[0].components.length, 4);

    // The shared table shows only card backs and the old discard.
    assert.ok(!description(playCards.publicPayload(game)).includes('7♥'));

    // A swap keeps the drawn card hidden too; only the replaced card is public.
    golf.swapPending(game.state, 'p1', 0);
    assert.ok(!description(playCards.publicPayload(game)).includes('7♥'));
});

test('play-cards: the results panel reveals every hand and the winner', () => {
    const game = gameWith([{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }]);
    game.state.players[0].hand = [
        { rank: 'A', suit: '♠' },
        { rank: '2', suit: '♠' },
        { rank: '3', suit: '♠' },
        { rank: '4', suit: '♠' }
    ];
    game.state.players[1].hand = [
        { rank: 'Q', suit: '♠' },
        { rank: 'K', suit: '♠' },
        { rank: '5', suit: '♠' },
        { rank: '6', suit: '♠' }
    ];
    golf.finish(game.state);

    const results = playCards.finishedPayload(game);
    assert.match(description(results), /One/);
    assert.match(description(results), /wins with \*\*10\*\* points/);
    assert.match(description(results), /A♠ \(1\)/);
    assert.strictEqual(results.components.length, 0);
});
