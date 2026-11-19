const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    normalizeName,
    nameMatches,
    parseScore,
    toBoardRows,
    toServerRows,
    serverBoard,
    boardLabel,
    serverName,
    matchesServer,
    findEnemyHits,
    formatScore,
    periodLabel,
    relativeStamp,
    fitLines,
    newestFetchedAt,
    mergeBoardGroup
} = require('../systems/netquel/netquelLogic');

test('netquel: aliases are compared case- and spacing-insensitively', () => {
    assert.strictEqual(normalizeName('  Apex  '), 'apex');
    assert.ok(nameMatches('apex', 'Apex'));
    assert.ok(nameMatches('Beta', 'BETA '));
    assert.strictEqual(nameMatches('apex', 'apex2'), false);
});

test('netquel: a truncated board name matches by prefix only', () => {
    // The site shortens long aliases ("CAT...").
    assert.ok(nameMatches('Catastrophe', 'CAT...'));
    assert.strictEqual(nameMatches('Ca', 'CAT...'), false);
    assert.strictEqual(nameMatches('Other', 'CAT...'), false);
});

test('netquel: scores strip separators and empty cells', () => {
    assert.strictEqual(parseScore('96,951'), 96951);
    assert.strictEqual(parseScore(' 1 234 '), 1234);
    assert.strictEqual(parseScore('-'), null);
    assert.strictEqual(formatScore(96951), '96,951');
});

test('netquel: rows get ranks in page order and skip placeholders', () => {
    const rows = toBoardRows([
        { name: ' Axiom ', score: '407214' },
        { name: '-', score: '-' },
        { name: 'VN', score: '1234' }
    ]);
    assert.deepStrictEqual(rows.map(row => [row.rank, row.name, row.score]), [
        [1, 'Axiom', 407214],
        [2, 'VN', 1234]
    ]);
});

test('netquel: enemy hits report every board the name is on', () => {
    const boards = [
        { mode: 'FFA', period: 'day', rows: toBoardRows([{ name: 'Apex', score: '100' }]) },
        { mode: 'FFA', period: 'all', rows: toBoardRows([{ name: 'Apex', score: '900' }, { name: 'Zed', score: '5' }]) },
        { mode: 'Forge', period: 'day', rows: toBoardRows([{ name: 'Zed', score: '7' }]) }
    ];
    const hits = findEnemyHits([{ name: 'apex', displayName: 'Apex' }], boards);

    assert.strictEqual(hits.length, 2);
    assert.deepStrictEqual(hits.map(hit => `${hit.board}:#${hit.rank}`), ['ffa:day:#1', 'ffa:all:#1']);
    assert.deepStrictEqual(findEnemyHits([{ name: 'nobody', displayName: 'Nobody' }], boards), []);
});

test('netquel: period labels are human readable', () => {
    assert.strictEqual(periodLabel('day'), 'Daily');
    assert.strictEqual(periodLabel('week'), 'Weekly');
    assert.strictEqual(periodLabel('all'), 'All-time');
});

test('netquel: in-game server rows keep the HUD rank', () => {
    // The top-right in-game table is "rank, name, score" per row.
    const rows = toServerRows([
        { rank: '1.', name: 'yaboikeith', score: '3,635' },
        { rank: '2.', name: 'Guest Choice ', score: '1547' },
        { rank: '', name: '-', score: '-' },
        { rank: '9.', name: 'δ', score: '87' }
    ]);

    assert.deepStrictEqual(rows.map(row => [row.rank, row.name, row.score]), [
        [1, 'yaboikeith', 3635],
        [2, 'Guest Choice', 1547],
        [9, 'δ', 87]
    ]);
});

test('netquel: servers are named the way the game names them', () => {
    // Plain names: the mode already lives in the board title and the Cloud/N
    // id is only the stable key.
    assert.strictEqual(serverName('Cloud/2'), 'Spiral');
    assert.strictEqual(serverName('Cloud/3'), 'Zenith');
    assert.strictEqual(serverName('Cloud/4'), 'Vortex');
    // An unknown server keeps its id rather than being mislabelled.
    assert.strictEqual(serverName('Cloud/9'), 'Cloud/9');
    // The in-game board's own caption wins over the id map.
    assert.strictEqual(serverName('Cloud/9', 'vortex'), 'Vortex');
    assert.strictEqual(serverName('Cloud/3', 'not a server'), 'Zenith');
});

test('netquel: a server board answers to its name or its Cloud id', () => {
    const board = serverBoard('FFA', 'Zenith', toServerRows([]), 'Cloud/3');
    assert.ok(matchesServer(board, 'Zenith'));
    assert.ok(matchesServer(board, 'zenith'));
    assert.ok(matchesServer(board, 'Cloud/3'));
    assert.ok(matchesServer(board, '3-Zenith'));
    assert.strictEqual(matchesServer(board, 'Spiral'), false);
});

test('netquel: server boards get their own board key and label', () => {
    const board = serverBoard('FFA', 'Zenith', toServerRows([{ rank: '1.', name: 'Apex', score: '12' }]), 'Cloud/3');

    assert.strictEqual(board.key, 'ffa:server:cloud/3');
    assert.strictEqual(boardLabel(board), 'FFA · Zenith');
    assert.strictEqual(boardLabel({ mode: 'Forge', period: 'week' }), 'Forge · Weekly');

    const hits = findEnemyHits([{ name: 'apex', displayName: 'Apex' }], [board]);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].board, 'ffa:server:cloud/3');
    assert.strictEqual(hits[0].label, 'FFA · Zenith');

    // The name the client shows is used for display, the Cloud id for keys.
    const named = serverBoard('Forge', 'Vortex', board.rows, 'Cloud/4');
    assert.strictEqual(named.server, 'Vortex');
    assert.strictEqual(named.key, 'forge:server:cloud/4');
    assert.strictEqual(boardLabel(named), 'Forge · Vortex');
});

test('netquel: timestamps use Discord markup, not a code block', () => {
    const stamp = relativeStamp(Date.UTC(2026, 0, 1, 12, 0, 0));
    assert.strictEqual(stamp, '<t:1767268800:R>');
    assert.ok(!stamp.includes('`'));
    assert.strictEqual(relativeStamp(null), 'never');
    assert.strictEqual(relativeStamp(0), 'never');
});

test('netquel: the freshest board in a group wins', () => {
    assert.strictEqual(newestFetchedAt([{ fetchedAt: 100 }, { fetchedAt: 900 }, {}]), 900);
    assert.strictEqual(newestFetchedAt([{ server: 'Zenith' }]), null);
    assert.strictEqual(newestFetchedAt([]), null);
});

test('netquel: timestamps are never placed in an embed footer', () => {
    /*
     * Discord prints <t:…> literally in a footer (it only renders in message
     * content and embed bodies), so every timestamp must live in a description.
     */
    const files = [
        'systems/netquel/netquelService.js',
        'commands/reload.js',
        'commands/target.js',
        'commands/add-enemy.js'
    ];

    for (const file of files) {
        const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        const footers = [...source.matchAll(/\.setFooter\(\{([\s\S]*?)\}\s*\)/g)].map(match => match[1]);
        assert.ok(footers.length, `${file} should have at least one footer`);
        for (const footer of footers) {
            assert.ok(
                !/<t:|relativeStamp|snapshotStamp/.test(footer),
                `${file} puts a timestamp in a footer: ${footer.trim()}`
            );
        }
    }
});

test('netquel: board lines fill the embed budget without splitting one', () => {
    const format = row => `${row.rank}. ${row.name}`;

    assert.deepStrictEqual(
        fitLines([{ rank: 1, name: 'A' }, { rank: 2, name: 'B' }], 100, format),
        ['1. A', '2. B']
    );

    // Too tight for the second line: stop rather than cut it in half.
    assert.deepStrictEqual(
        fitLines([{ rank: 1, name: 'A' }, { rank: 2, name: 'BBBB' }], 8, format),
        ['1. A']
    );

    // A full 20-row site table fits a 4000-character description.
    const rows = Array.from({ length: 20 }, (_, index) => ({ rank: index + 1, name: `Player ${index + 1}`, score: 123456 }));
    const lines = fitLines(rows, 4000, row => `**${row.rank}.** ${row.name} — 123,456`);
    assert.strictEqual(lines.length, 20);

    assert.deepStrictEqual(fitLines([], 100, format), []);
});

test('netquel: a site refresh keeps every other board group', () => {
    const site = (mode, period, fetchedAt) => ({ mode, period, fetchedAt, rows: toBoardRows([{ name: 'Apex', score: '1' }]) });
    const server = (mode, name) => serverBoard(mode, name, toServerRows([{ rank: '1.', name: 'Apex', score: '2' }]), `Cloud/${name}`);

    const current = [
        site('FFA', 'day', 1),
        site('FFA', 'week', 1),
        site('Forge', 'day', 1),
        server('FFA', 'Zenith'),
        server('Forge', 'Vortex')
    ];

    // Fast pass lands fresh FFA site rows: its server board and all of Forge
    // must survive untouched.
    const next = mergeBoardGroup(current, [site('FFA', 'day', 500), site('FFA', 'week', 500)], { mode: 'FFA', server: false });

    assert.deepStrictEqual(
        next.map(board => `${board.mode}:${board.server ? 'server' : board.period}`).sort(),
        ['FFA:day', 'FFA:server', 'FFA:week', 'Forge:day', 'Forge:server']
    );
    assert.strictEqual(next.filter(board => board.mode === 'FFA' && !board.server).length, 2);
    assert.deepStrictEqual(next.filter(board => board.mode === 'FFA' && !board.server).map(b => b.fetchedAt), [500, 500]);

    // And a server sweep replaces only server boards.
    const swept = mergeBoardGroup(next, [server('FFA', 'Spiral')], { mode: 'FFA', server: true });
    assert.deepStrictEqual(
        swept.filter(board => board.mode === 'FFA' && board.server).map(board => board.server),
        ['Spiral']
    );
    assert.strictEqual(swept.filter(board => board.mode === 'FFA' && !board.server).length, 2);
});
