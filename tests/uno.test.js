const test = require('node:test');
const assert = require('node:assert/strict');
const uno = require('../systems/games/uno');

const PLAYERS = [
    { id: 'a', name: 'Ann' },
    { id: 'b', name: 'Ben' },
    { id: 'c', name: 'Cy' }
];

function totalCards(state) {
    return state.players.reduce((sum, p) => sum + p.hand.length, 0) + state.deck.length + state.discard.length;
}

function withTopCard(state, card) {
    state.discard = [card];
    state.color = card.color;
    state.pendingDraw = 0;
    state.pendingKind = null;
}

function cardIn(hand, predicate) {
    return hand.find(predicate);
}

test('uno deck: 108 cards with the standard colour and wild split', () => {
    const deck = uno.buildDeck();
    assert.equal(deck.length, 108);
    for (const color of uno.COLORS) {
        assert.equal(deck.filter(c => c.color === color).length, 25);
        assert.equal(deck.filter(c => c.color === color && c.value === '0').length, 1);
    }
    assert.equal(deck.filter(c => c.value === 'wild').length, 4);
    assert.equal(deck.filter(c => c.value === 'wild4').length, 4);
    assert.equal(new Set(deck.map(c => c.id)).size, 108, 'card ids are unique');
});

test('uno: createGame deals seven each and opens on a non-wild card', () => {
    for (let i = 0; i < 20; i++) {
        const state = uno.createGame({ players: PLAYERS });
        for (const player of state.players) assert.equal(player.hand.length, uno.HAND_SIZE);
        assert.notEqual(state.discard[0].color, 'wild');
        assert.equal(state.color, state.discard[0].color);
        assert.equal(totalCards(state), 108);
    }
});

test('uno: rejects out-of-turn plays and cards not in hand', () => {
    const state = uno.createGame({ players: PLAYERS });
    const notTurn = state.players.find(p => p.id !== uno.currentPlayer(state).id);
    assert.throws(() => uno.playCard(state, notTurn.id, notTurn.hand[0].id, 'red'), /not your turn/);
    const current = uno.currentPlayer(state);
    assert.throws(() => uno.playCard(state, current.id, 'nope', 'red'), /not in your hand/);
});

test('uno: a matching card is legal and a wild requires a colour', () => {
    const state = uno.createGame({ players: PLAYERS });
    const current = uno.currentPlayer(state);
    withTopCard(state, { id: 'top', color: 'red', value: '5' });
    current.hand = [{ id: 'w', color: 'wild', value: 'wild' }, { id: 'r', color: 'red', value: '9' }];
    assert.throws(() => uno.playCard(state, current.id, 'w', null), /colour/);
    uno.playCard(state, current.id, 'r', null);
    assert.equal(state.color, 'red');
    assert.equal(uno.topCard(state).id, 'r');
});

test('uno: a skip in three-player seating skips the next seat', () => {
    const state = uno.createGame({ players: PLAYERS });
    // A reverse starter would flip the direction before this test sets its own
    // top card, so pin clockwise play: the test is about skip, not the deal.
    state.direction = 1;
    const first = uno.currentPlayer(state);
    withTopCard(state, { id: 'top', color: 'blue', value: '3' });
    first.hand = [{ id: 's', color: 'blue', value: 'skip' }, { id: 'x', color: 'red', value: '1' }];
    const before = state.turn;
    uno.playCard(state, first.id, 's');
    assert.equal(state.turn, (before + 2) % 3);
});

test('uno: draw-two stacks onto a pending draw and the victim takes the total', () => {
    const state = uno.createGame({ players: PLAYERS });
    const first = uno.currentPlayer(state);
    withTopCard(state, { id: 'top', color: 'green', value: '2' });
    first.hand = [{ id: 'd1', color: 'green', value: 'draw2' }, { id: 'x', color: 'red', value: '1' }];
    uno.playCard(state, first.id, 'd1');
    assert.equal(state.pendingDraw, 2);

    const second = uno.currentPlayer(state);
    second.hand = [{ id: 'd2', color: 'red', value: 'draw2' }, { id: 'y', color: 'red', value: '4' }];
    uno.playCard(state, second.id, 'd2');
    assert.equal(state.pendingDraw, 4);

    const victim = uno.currentPlayer(state);
    const sizeBefore = victim.hand.length;
    uno.drawCard(state, victim.id);
    assert.equal(victim.hand.length, sizeBefore + 4);
    assert.equal(state.pendingDraw, 0);
});

test('uno: a pending draw can only be answered by the same draw card', () => {
    const state = uno.createGame({ players: PLAYERS });
    withTopCard(state, { id: 'top', color: 'red', value: 'draw2' });
    state.pendingDraw = 2;
    state.pendingKind = 'draw2';
    const current = uno.currentPlayer(state);
    current.hand = [{ id: 'n', color: 'red', value: '7' }, { id: 'w', color: 'wild', value: 'wild' }];
    assert.deepEqual(uno.legalCards(state, current.id), []);
});

test('uno: wild +4 is illegal while the hand holds the active colour', () => {
    const state = uno.createGame({ players: PLAYERS });
    withTopCard(state, { id: 'top', color: 'yellow', value: '1' });
    const current = uno.currentPlayer(state);
    current.hand = [{ id: 'w4', color: 'wild', value: 'wild4' }, { id: 'y', color: 'yellow', value: '8' }];
    assert.equal(uno.canPlayCard(state, current.hand, current.hand[0]), false);
    current.hand = [{ id: 'w4', color: 'wild', value: 'wild4' }, { id: 'r', color: 'red', value: '8' }];
    assert.equal(uno.canPlayCard(state, current.hand, current.hand[0]), true);
});

test('uno: forgetting UNO opens a catch, and catching draws two cards', () => {
    const state = uno.createGame({ players: PLAYERS });
    const first = uno.currentPlayer(state);
    withTopCard(state, { id: 'top', color: 'red', value: '5' });
    first.hand = [{ id: 'r', color: 'red', value: '2' }, { id: 'z', color: 'red', value: '3' }];
    uno.playCard(state, first.id, 'r');
    assert.equal(state.unoOpen, first.id);

    const catcher = uno.currentPlayer(state);
    assert.throws(() => uno.catchUno(state, first.id), /Nobody forgot/);
    const sizeBefore = first.hand.length;
    uno.catchUno(state, catcher.id);
    assert.equal(first.hand.length, sizeBefore + 2);
    assert.equal(state.unoOpen, null);
});

test('uno: calling UNO with one card protects the player from a catch', () => {
    const state = uno.createGame({ players: PLAYERS });
    const first = uno.currentPlayer(state);
    withTopCard(state, { id: 'top', color: 'red', value: '5' });
    first.hand = [{ id: 'r', color: 'red', value: '2' }, { id: 'z', color: 'red', value: '3' }];
    uno.playCard(state, first.id, 'r');
    uno.callUno(state, first.id);
    assert.throws(() => uno.catchUno(state, uno.currentPlayer(state).id), /Nobody forgot/);
});

test('uno: going out scores the other hands and ends at the target', () => {
    const state = uno.createGame({ players: PLAYERS, targetScore: 10 });
    const first = uno.currentPlayer(state);
    withTopCard(state, { id: 'top', color: 'red', value: '5' });
    first.hand = [{ id: 'r', color: 'red', value: '9' }];
    const others = state.players.filter(p => p !== first);
    others[0].hand = [{ id: 'o1', color: 'blue', value: 'skip' }];
    others[1].hand = [{ id: 'o2', color: 'blue', value: 'wild' }];
    const result = uno.playCard(state, first.id, 'r');
    assert.equal(result.roundOver, true);
    assert.equal(result.points, 70);
    assert.equal(first.score, 70);
    assert.equal(state.status, 'ended');
    assert.equal(state.winnerId, first.id);
});

test('uno: bot-vs-bot games keep all 108 cards and always finish', () => {
    for (let game = 0; game < 25; game++) {
        const state = uno.createGame({
            players: [
                { id: 'b1', name: 'Bot 1', isBot: true },
                { id: 'b2', name: 'Bot 2', isBot: true },
                { id: 'b3', name: 'Bot 3', isBot: true },
                { id: 'b4', name: 'Bot 4', isBot: true }
            ],
            targetScore: 200
        });
        let steps = 0;
        while (state.status !== 'ended' && steps < 20000) {
            steps++;
            if (state.status === 'round-over') {
                uno.startNextRound(state);
                continue;
            }
            assert.equal(totalCards(state), 108, 'no card is created or lost');
            const player = uno.currentPlayer(state);
            const move = uno.chooseBotMove(state);
            if (move.action === 'draw') uno.drawCard(state, player.id);
            else uno.playCard(state, player.id, move.cardId, move.color);
        }
        assert.equal(state.status, 'ended', 'the game reaches its target score');
        assert.ok(state.winnerId);
    }
});

test('uno: card points match the scoring table', () => {
    assert.equal(uno.cardPoints({ value: '7' }), 7);
    assert.equal(uno.cardPoints({ value: '0' }), 0);
    assert.equal(uno.cardPoints({ value: 'skip' }), 20);
    assert.equal(uno.cardPoints({ value: 'draw2' }), 20);
    assert.equal(uno.cardPoints({ value: 'wild' }), 50);
    assert.equal(uno.cardPoints({ value: 'wild4' }), 50);
    assert.ok(cardIn(uno.buildDeck(), c => c.value === 'wild4'));
});

test('uno table: renders a PNG for 2, 3 and 4 seats', () => {
    const { renderTable } = require('../systems/games/unoRender');
    for (const count of [2, 3, 4]) {
        const players = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}`, isBot: i > 0 }));
        const state = uno.createGame({ players });
        const png = renderTable(state, { turnPlayerId: 'p0' });
        assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
        assert.ok(png.length > 10_000);
    }
});

test('uno deck: wilds, +4s and +2s are all in the box', () => {
    const deck = uno.buildDeck();
    assert.equal(deck.filter(c => c.value === 'wild').length, 4);
    assert.equal(deck.filter(c => c.value === 'wild4').length, 4);
    assert.equal(deck.filter(c => c.value === 'draw2').length, 8);
    for (const color of uno.COLORS) {
        assert.equal(deck.filter(c => c.color === color && c.value === 'draw2').length, 2);
    }
});

test('uno rules: normal mode forces the draw (no stacking)', () => {
    const state = uno.createGame({ players: PLAYERS, rulesMode: 'normal' });
    withTopCard(state, { id: 'top', color: 'red', value: 'draw2' });
    state.pendingDraw = 2;
    state.pendingKind = 'draw2';
    const current = uno.currentPlayer(state);
    current.hand = [{ id: 'd', color: 'red', value: 'draw2' }, { id: 'w4', color: 'wild', value: 'wild4' }];
    assert.deepEqual(uno.legalCards(state, current.id), []);
});

test('uno rules: stack mode lets a +4 answer a +2, but a +2 cannot answer a +4', () => {
    const state = uno.createGame({ players: PLAYERS, rulesMode: 'stack' });
    withTopCard(state, { id: 'top', color: 'red', value: 'draw2' });
    state.pendingDraw = 2;
    state.pendingKind = 'draw2';
    const current = uno.currentPlayer(state);
    // No red card in hand, so the +4 bluffing rule is satisfied.
    current.hand = [{ id: 'w4', color: 'wild', value: 'wild4' }, { id: 'b', color: 'blue', value: '3' }];
    assert.deepEqual(uno.legalCards(state, current.id).map(c => c.id), ['w4']);

    state.pendingDraw = 4;
    state.pendingKind = 'wild4';
    current.hand = [{ id: 'd', color: 'blue', value: 'draw2' }, { id: 'b2', color: 'blue', value: '3' }];
    assert.deepEqual(uno.legalCards(state, current.id), []);
});

test('uno rules: spicy stacks anything, frees +4s, and catches for 4', () => {
    const state = uno.createGame({ players: PLAYERS, rulesMode: 'spicy' });
    withTopCard(state, { id: 'top', color: 'yellow', value: '1' });
    const current = uno.currentPlayer(state);
    // Bluffing allowed in spicy: +4 is legal even holding the active colour.
    current.hand = [{ id: 'w4', color: 'wild', value: 'wild4' }, { id: 'y', color: 'yellow', value: '8' }];
    assert.equal(uno.canPlayCard(state, current.hand, current.hand[0]), true);

    // A +2 answers a pending +4.
    state.pendingDraw = 4;
    state.pendingKind = 'wild4';
    current.hand = [{ id: 'd', color: 'blue', value: 'draw2' }, { id: 'b', color: 'blue', value: '3' }];
    assert.deepEqual(uno.legalCards(state, current.id).map(c => c.id), ['d']);

    // The catch penalty is 4 cards.
    state.pendingDraw = 0;
    state.pendingKind = null;
    withTopCard(state, { id: 'top2', color: 'red', value: '5' });
    current.hand = [{ id: 'r', color: 'red', value: '2' }, { id: 'z', color: 'red', value: '3' }];
    uno.playCard(state, current.id, 'r');
    const sizeBefore = current.hand.length;
    uno.catchUno(state, uno.currentPlayer(state).id);
    assert.equal(current.hand.length, sizeBefore + uno.SPICY_CATCH_PENALTY);
});

test('uno rules: the mode survives into the next round; unknown modes throw', () => {
    const state = uno.createGame({ players: PLAYERS, rulesMode: 'spicy' });
    state.status = 'round-over';
    uno.startNextRound(state);
    assert.equal(state.rulesMode, 'spicy');
    assert.throws(() => uno.createGame({ players: PLAYERS, rulesMode: 'chaos' }), /Unknown UNO rules mode/);
    assert.deepEqual(uno.RULE_MODES, ['normal', 'stack', 'spicy']);
});

test('uno-play: the slash command schema builds with its mode choices', () => {
    const command = require('../commands/uno-play');
    const json = command.data.toJSON();
    assert.equal(json.name, 'uno-play');
    const choices = json.options[0].choices.map(c => c.value);
    assert.deepEqual(choices, ['bot', '2', '3', '4']);
    const rules = json.options.find(o => o.name === 'rules');
    assert.ok(rules, 'a rules option exists');
    assert.deepEqual(rules.choices.map(c => c.value), ['normal', 'stack', 'spicy']);
});

test('uno-play: an empty hand sends text, never an empty select menu', () => {
    const command = require('../commands/uno-play');
    const engine = uno.createGame({ players: PLAYERS });
    const player = uno.currentPlayer(engine);
    // The live crash: a player with no cards opened "My Hand", producing a
    // select menu with zero options, which Discord rejects with 50035.
    player.hand = [];
    const empty = command.buildHandPayload({ id: 'g1', engine }, player);
    assert.equal(empty.components.length, 0);
    assert.match(empty.content, /empty/);

    player.hand = engine.deck.splice(0, 3);
    const full = command.buildHandPayload({ id: 'g1', engine }, player);
    // Assert on the serialized payload: that is exactly what Discord validates.
    const optionCount = full.components[0].components[0].toJSON().options.length;
    assert.ok(optionCount >= 1 && optionCount <= 25);
});

test('uno-play: the table posts content plus a full-size image, not an embed', async () => {
    const command = require('../commands/uno-play');
    const engine = uno.createGame({ players: PLAYERS });
    const payload = await command.gamePayload({ id: 'g1', engine, turnDeadline: Date.now() + 60_000 }, '');
    assert.equal(payload.embeds, undefined, 'no embed: embeds shrink the table image');
    assert.equal(payload.files.length, 1);
    assert.equal(payload.files[0].name, 'uno-table.png');
    assert.match(payload.content, /UNO · Round/);
    assert.match(payload.content, /Top card/);
    assert.ok(payload.content.length <= 2000, 'fits the message content limit');
    assert.ok(payload.components.length >= 1, 'table buttons still attached');
});

test('uno-play: turn clock is 60s with a 5s grace period', () => {
    const command = require('../commands/uno-play');
    assert.equal(command.TURN_MS, 60_000);
    assert.equal(command.GRACE_MS, 5_000);
});
