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
    findHighScoreRows,
    formatScore,
    periodLabel,
    relativeStamp,
    fitLines,
    newestFetchedAt,
    mergeBoardGroup,
    mergeBoard,
    parseJoinedDate,
    parseBrief,
    isOneDayStreak,
    verifyEnemy,
    filterTierRosters,
    tierLabel,
    rosterTierLookup,
    rosterTierFor,
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
        'commands/play-cards.js',
        'commands/add-enemy.js',
        'commands/netquel-players.js'
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

test('netquel: join dates are normalised to the profile card format', () => {
    assert.strictEqual(parseJoinedDate('11/16/2026'), '11/16/2026');
    assert.strictEqual(parseJoinedDate('2026-11-16'), '11/16/2026');
    assert.strictEqual(parseJoinedDate(' 11-16-2026 '), '11/16/2026');
    assert.strictEqual(parseJoinedDate('2/3/2026'), '2/3/2026');

    // Real calendar days only — the card never shows 2/30.
    assert.strictEqual(parseJoinedDate('2026-02-30'), null);
    assert.strictEqual(parseJoinedDate('13/45/2026'), null);
    assert.strictEqual(parseJoinedDate('yesterday'), null);
    assert.strictEqual(parseJoinedDate(''), null);
    assert.strictEqual(parseJoinedDate(null), null);
});

test('netquel: a profile card keeps join date, high score, rank and streak', () => {
    const card = parseBrief({
        Joined: '11/16/2026',
        'High score': '2,972',
        Rank: '\n Prospector',
        Streak: '1 day streak'
    });
    assert.deepStrictEqual(card, {
        joined: '11/16/2026',
        highScore: 2972,
        rank: 'Prospector',
        streak: '1 day streak',
        clan: null,
        private: false
    });

    // Unranked players render no Rank row at all.
    const unranked = parseBrief({ Joined: '11/19/2026', 'High score': '393', Streak: '1 day streak' });
    assert.strictEqual(unranked.rank, null);
    assert.strictEqual(unranked.highScore, 393);

    assert.strictEqual(parseBrief(null), null);
    assert.strictEqual(parseBrief({}), null);
});

test('netquel: the card carries clan, a cleaned rank and private notices', () => {
    const card = parseBrief({
        Clan: '[ENOS]',
        Joined: '1/29/2026',
        'High score': '210,162',
        Rank: ' |  Vanguard',
        Streak: '9 day streak'
    });
    assert.strictEqual(card.clan, 'ENOS');
    assert.strictEqual(card.rank, 'Vanguard');
    assert.strictEqual(card.highScore, 210162);
    assert.strictEqual(card.joined, '1/29/2026');
    assert.strictEqual(card.private, false);

    const priv = parseBrief({}, 'This profile is private.');
    assert.strictEqual(priv.private, true);
    assert.strictEqual(priv.clan, null);
    assert.strictEqual(parseBrief({}, 'Profile not found'), null);
    /* An unranked card has a blank Rank row, not the word "Unranked". */
    assert.strictEqual(parseBrief({ Joined: '11/19/2026', Rank: '' }).rank, null);
});

test('netquel: private cards and clans take part in verification', () => {
    assert.strictEqual(verifyEnemy({ joined: '1/29/2026', highScore: 5 }, { private: true }).status, 'unverified');
    assert.strictEqual(verifyEnemy({ clan: 'ENOS' }, { clan: 'OTHR' }).status, 'mismatch');
    assert.strictEqual(verifyEnemy({ clan: 'enos' }, { clan: '[ENOS]' }).status, 'ok');
});

test('netquel: the card panel has no clan row, so a missing clan never fails a match', () => {
    const pinned = { clan: 'ENOS', joined: '1/29/2026', highScore: 210162 };
    const card = { joined: '1/29/2026', highScore: 210162, clan: null };
    assert.strictEqual(verifyEnemy(pinned, card).status, 'ok');

    /* A clan the card does show still has to agree. */
    const wrong = verifyEnemy(pinned, { ...card, clan: 'OTHR' });
    assert.strictEqual(wrong.status, 'mismatch');
    assert.match(wrong.reason, /clan/);

    /* With nothing else pinned there is nothing to check. */
    assert.strictEqual(verifyEnemy({ clan: 'ENOS' }, { joined: '1/29/2026' }).status, 'unverified');
});

test('netquel: a fresh guest card is only a join date and a one-day streak', () => {
    const card = parseBrief({ Joined: '11/19/2026', Streak: '1 day streak' });
    assert.deepStrictEqual(card, {
        joined: '11/19/2026',
        highScore: null,
        rank: null,
        streak: '1 day streak',
        clan: null,
        private: false
    });
    assert.ok(isOneDayStreak(card));

    /* Such a card can never confirm a pinned profile. */
    const verdict = verifyEnemy({ joined: '1/29/2026', highScore: 210162 }, card);
    assert.strictEqual(verdict.status, 'unverified');
});

test('netquel: a one-day streak marks a brand-new guest card', () => {
    assert.ok(isOneDayStreak({ streak: '1 day streak' }));
    assert.ok(isOneDayStreak({ streak: ' 1 Day Streak ' }));
    assert.ok(isOneDayStreak({ streak: '1-day streak' }));
    assert.strictEqual(isOneDayStreak({ streak: '2 day streak' }), false);
    assert.strictEqual(isOneDayStreak({ streak: null }), false);
    assert.strictEqual(isOneDayStreak(null), false);
});

test('netquel: server rows carry the captured profile card', () => {
    const rows = toServerRows([{
        rank: '1.',
        name: 'Apex',
        score: '5580',
        brief: { Joined: '11/16/2026', 'High score': '10903', Rank: 'Prospector' }
    }]);
    assert.strictEqual(rows[0].profile.joined, '11/16/2026');
    assert.strictEqual(rows[0].profile.highScore, 10903);

    const bare = toServerRows([{ rank: '2.', name: 'Nobody', score: '1' }]);
    assert.strictEqual(bare[0].profile, undefined);
});

test('netquel: server rows keep the verified and AFK markers', () => {
    // The HUD italicises a verified name and dims an AFK row with title="AFK".
    const rows = toServerRows([
        { rank: '1.', name: 'SlashStr1ker', score: '10', verified: true, afk: false },
        { rank: '2.', name: 'EDG', score: '5', verified: false, afk: true }
    ]);
    assert.deepStrictEqual(rows.map(row => [row.name, row.verified, row.afk]), [
        ['SlashStr1ker', true, false],
        ['EDG', false, true]
    ]);

    // And an alert hit carries them, so the sighting can say which is which.
    const board = serverBoard('FFA', 'Zenith', rows, 'Cloud/3');
    const [hit] = findEnemyHits([{ name: 'edg', displayName: 'EDG' }], [board]);
    assert.strictEqual(hit.verified, false);
    assert.strictEqual(hit.afk, true);
});

test('netquel: a live 50,000+ score is a high-score alert', () => {
    const live = serverBoard('FFA', 'Spiral', toServerRows([
        { rank: '1.', name: 'Rich', score: '50,000' },
        { rank: '2.', name: 'Almost', score: '49,999' }
    ]), 'Cloud/2');
    // Site tables are history and are full of high scores; they never alert.
    const site = { mode: 'FFA', period: 'all', rows: toBoardRows([{ name: 'SiteRich', score: '900,000' }]) };

    const rows = findHighScoreRows([live, site], 50_000);
    assert.deepStrictEqual(
        rows.map(row => [row.name, row.score, row.label, row.rank]),
        [['Rich', 50_000, 'FFA · Spiral', 1]]
    );
    assert.deepStrictEqual(findHighScoreRows([site], 50_000), []);
});

test('netquel: a pinned enemy only pings when the card still matches', () => {
    const pinned = { name: 'apex', displayName: 'Apex', joined: '11/16/2026', highScore: 2972 };
    const card = { joined: '11/16/2026', highScore: 2972 };

    assert.strictEqual(verifyEnemy(pinned, card).status, 'ok');
    assert.strictEqual(verifyEnemy(pinned, null).status, 'unverified');

    const otherScore = verifyEnemy(pinned, { joined: '11/16/2026', highScore: 10903 });
    assert.strictEqual(otherScore.status, 'mismatch');
    assert.match(otherScore.reason, /high score/);

    const otherJoin = verifyEnemy(pinned, { joined: '10/01/2026', highScore: 2972 });
    assert.strictEqual(otherJoin.status, 'mismatch');
    assert.match(otherJoin.reason, /joined/);

    // A name-only watch has nothing to verify, so it still pings.
    assert.strictEqual(verifyEnemy({ name: 'apex' }, null).status, 'ok');
    assert.strictEqual(verifyEnemy({ name: 'apex', joined: null, highScore: null }, null).status, 'ok');

    // Either half of the criteria is enough to pin an enemy.
    assert.strictEqual(verifyEnemy({ joined: null, highScore: 2972 }, card).status, 'ok');
    assert.strictEqual(verifyEnemy({ joined: '11/16/2026', highScore: null }, card).status, 'ok');

    // A brand-new account has a blank high score: unverifiable, not a mismatch.
    const blank = verifyEnemy(pinned, { joined: '11/16/2026', highScore: null });
    assert.strictEqual(blank.status, 'unverified');
    assert.match(blank.reason, /high score/);
});

test('netquel: a fresh server board only replaces its own server', () => {
    const spiral = {
        ...serverBoard('FFA', 'Spiral', toServerRows([{ rank: '1.', name: 'Apex', score: '10' }]), 'Cloud/2'),
        fetchedAt: 1
    };
    const zenith = {
        ...serverBoard('FFA', 'Zenith', toServerRows([{ rank: '1.', name: 'Zed', score: '9' }]), 'Cloud/3'),
        fetchedAt: 1
    };

    const both = mergeBoard([spiral], zenith);
    assert.strictEqual(both.length, 2);

    const fresh = {
        ...serverBoard('FFA', 'Spiral', toServerRows([{ rank: '1.', name: 'New', score: '11' }]), 'Cloud/2'),
        fetchedAt: 2
    };
    const merged = mergeBoard(both, fresh);
    assert.strictEqual(merged.length, 2);
    assert.strictEqual(merged.filter(board => board.serverId === 'Cloud/2').length, 1);
    assert.strictEqual(merged.find(board => board.serverId === 'Cloud/2').rows[0].name, 'New');
    assert.strictEqual(merged.find(board => board.serverId === 'Cloud/3').rows[0].name, 'Zed');
});

test('netquel: Cloud ids map to their own server hosts', () => {
    const { serverBaseUrl } = require('../systems/netquel/netquelSource');
    assert.strictEqual(serverBaseUrl('Cloud/4'), 'https://4.netquel.com');
    assert.strictEqual(serverBaseUrl('Cloud/2'), 'https://2.netquel.com');
    assert.strictEqual(serverBaseUrl('Local/1'), 'https://www.netquel.com');
    assert.strictEqual(serverBaseUrl(null), 'https://www.netquel.com');
});

test('netquel: a board-only sighting keeps the card and updates the HUD markers', () => {
    const Module = require('node:module');
    const Database = require('better-sqlite3');
    const originalLoad = Module._load;
    Module._load = function (request) {
        if (request === '../../database') return new Database(':memory:');
        return originalLoad.apply(this, arguments);
    };
    try {
        delete require.cache[require.resolve('../systems/netquel/netquelStore')];
        const store = require('../systems/netquel/netquelStore');
        store.recordPlayers([{
            name: 'Apex',
            joined: '11/16/2026',
            highScore: 2972,
            rank: 'Prospector',
            private: true,
            verified: 1,
            afk: 0,
            mode: 'FFA',
            server: 'Spiral'
        }]);
        store.recordPlayers([{
            name: 'Apex',
            hasCard: false,
            verified: 0,
            afk: 1,
            mode: 'FFA',
            server: 'Zenith'
        }]);

        /* A board-only name with no stored card is a possible one-day guest,
         * so it waits for the card pass before it is stored. */
        store.recordPlayers([{
            name: 'BrandNewGuest',
            hasCard: false,
            verified: 0,
            afk: 0,
            mode: 'FFA',
            server: 'Zenith'
        }]);
        assert.strictEqual(store.getPlayer('BrandNewGuest'), null);

        const player = store.getPlayer('Apex');
        assert.strictEqual(player.joined, '11/16/2026');
        assert.strictEqual(player.highScore, 2972);
        assert.strictEqual(player.isPrivate, 1);
        assert.strictEqual(player.verified, 1);
        assert.strictEqual(player.afk, 1);
        assert.strictEqual(player.server, 'Zenith');
        assert.strictEqual(player.seenCount, 2);

        /* A ping is suppressed for the cooldown, then allowed again. */
        assert.strictEqual(store.canPing('Apex', 10 * 60 * 1000), true);
        store.recordPing('Apex');
        assert.strictEqual(store.canPing('Apex', 10 * 60 * 1000), false);
        assert.strictEqual(store.canPing('Apex', 0), true);

        /* One high-score alert per visit; it survives a fresh prune and goes
         * away once the grace period has passed. */
        assert.strictEqual(store.hasScoreAlert('Apex'), false);
        store.recordScoreAlert({ name: 'Apex', displayName: 'Apex', server: 'Spiral', score: 60_000 });
        assert.strictEqual(store.hasScoreAlert('apex'), true);
        store.pruneScoreAlerts(new Set(), 10 * 60 * 1000);
        assert.strictEqual(store.hasScoreAlert('Apex'), true);
        store.pruneScoreAlerts(new Set(), 0);
        assert.strictEqual(store.hasScoreAlert('Apex'), false);
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../systems/netquel/netquelStore')];
    }
});

test('netquel: tier rosters drop names shared by more than one tier', () => {
    const entries = filterTierRosters([
        { serverId: 'Cloud/2', server: 'Spiral', tier: '0', names: ['Guest', 'Shared', 'GuestHouse'], online: 1 },
        { serverId: 'Cloud/2', server: 'Spiral', tier: 'A', names: ['Shared'], online: 0 },
        { serverId: 'Cloud/2', server: 'Spiral', tier: 'B', names: ['Shared', '(ー_ー゛)'], online: 1 }
    ]);
    assert.deepStrictEqual(entries.find(entry => entry.tier === '0').names, ['Guest', 'GuestHouse']);
    assert.deepStrictEqual(entries.find(entry => entry.tier === 'A').names, []);
    assert.deepStrictEqual(entries.find(entry => entry.tier === 'B').names, ['(ー_ー゛)']);
});

test('netquel: tier labels name the FFA quadrants', () => {
    assert.strictEqual(tierLabel('0'), 'Entry');
    assert.strictEqual(tierLabel('A'), 'A');
    assert.strictEqual(tierLabel('b'), 'B');
    assert.strictEqual(tierLabel(null), null);
});

test('netquel: board rows pick up the tier from the matching server roster', () => {
    const lookup = rosterTierLookup([
        { serverId: 'Cloud/2', server: 'Spiral', tier: '0', names: ['EntryOne', 'Shared'] },
        { serverId: 'Cloud/2', server: 'Spiral', tier: 'A', names: ['Ace', 'CATALYST'] },
        { serverId: 'Cloud/4', server: 'Vortex', tier: 'B', names: ['CATALYST'] }
    ]);

    assert.strictEqual(rosterTierFor(lookup, 'Cloud/2', 'entryone'), 'Entry');
    assert.strictEqual(rosterTierFor(lookup, 'Spiral', 'Ace'), 'A');
    /* The HUD truncates long aliases, so a board row can be a prefix. */
    assert.strictEqual(rosterTierFor(lookup, 'Cloud/2', 'CAT...'), 'A');
    assert.strictEqual(rosterTierFor(lookup, 'Cloud/4', 'Catalyst'), 'B');
    /* The same alias on another server is a different roster. */
    assert.strictEqual(rosterTierFor(lookup, 'Cloud/4', 'Ace'), null);
    assert.strictEqual(rosterTierFor(lookup, 'Cloud/2', 'Nobody'), null);
});

test('netquel: a name seen in two tiers is never tagged', () => {
    const lookup = rosterTierLookup([
        { serverId: 'Cloud/3', server: 'Zenith', tier: '0', names: ['tiger'] },
        { serverId: 'Cloud/3', server: 'Zenith', tier: 'B', names: ['tiger'] }
    ]);
    assert.strictEqual(rosterTierFor(lookup, 'Cloud/3', 'tiger'), null);
});
