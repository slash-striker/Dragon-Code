const test = require('node:test');
const assert = require('node:assert');

const { boardSignature, createCoalescer } = require('../systems/netquel/netquelLogic');
const { ChromePage, ResidentBoards } = require('../systems/netquel/netquelSource');

function fakeBrowser(stateRef) {
    const browser = {
        alive: true,
        tabs: [],
        async send() {},
        async createTab(url, options = {}) {
            const calls = [];
            const tab = {
                alive: true,
                calls,
                onBinding: options.onBinding,
                async send(method, params = {}) {
                    calls.push({ method, params });
                },
                async evaluate(expression) {
                    if (expression.includes('MutationObserver')) return 'installed';
                    return true;
                },
                async joinServer() {
                    return stateRef.state;
                },
                async readPlayState() {
                    return stateRef.state;
                },
                async respawn() {
                    return stateRef.respawnState ?? stateRef.state;
                },
                async ping() {
                    return true;
                },
                async close() {
                    this.alive = false;
                }
            };
            browser.tabs.push(tab);
            return tab;
        },
        async close() {
            browser.alive = false;
        }
    };
    return browser;
}

test('netquel: a board signature changes only when the board does', () => {
    const rows = [
        { rank: '1.', name: ' Apex ', score: '10', verified: true, afk: false },
        { rank: '2.', name: 'Zed', score: '5', verified: false, afk: true }
    ];

    assert.strictEqual(boardSignature(rows, 'Cloud/2'), boardSignature([...rows], 'Cloud/2'));
    /* Spacing is normalized, so a repaint that only changes padding is not news. */
    assert.strictEqual(
        boardSignature([{ ...rows[0], name: 'Apex' }, rows[1]], 'Cloud/2'),
        boardSignature(rows, 'Cloud/2')
    );

    assert.notStrictEqual(
        boardSignature([{ ...rows[0], score: '11' }, rows[1]], 'Cloud/2'),
        boardSignature(rows, 'Cloud/2')
    );
    assert.notStrictEqual(
        boardSignature([{ ...rows[0], afk: true }, rows[1]], 'Cloud/2'),
        boardSignature(rows, 'Cloud/2')
    );
    assert.notStrictEqual(
        boardSignature([{ ...rows[0], verified: false }, rows[1]], 'Cloud/2'),
        boardSignature(rows, 'Cloud/2')
    );
    assert.notStrictEqual(boardSignature(rows, 'Cloud/2'), boardSignature(rows, 'Cloud/3'));
});

test('netquel: board publishes are capped to the refresh interval', async () => {
    const calls = [];
    const coalescer = createCoalescer({
        delayMs: 5,
        minIntervalMs: 50,
        run: keys => calls.push({ keys: [...keys], at: Date.now() })
    });

    coalescer.push('Forge');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(calls.length, 1);

    /* A second burst inside the window waits for the window to close. */
    coalescer.push('Forge');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(calls.length, 1);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.strictEqual(calls.length, 2);
    assert.ok(calls[1].at - calls[0].at >= 45);
});

test('netquel: board publishes coalesce a burst into one call', async () => {
    const calls = [];
    const coalescer = createCoalescer({
        delayMs: 5,
        run: keys => {
            calls.push([...keys].sort());
        }
    });

    coalescer.push('FFA');
    coalescer.push('Forge');
    coalescer.push('FFA');
    assert.strictEqual(coalescer.size(), 2);

    await coalescer.flush();
    assert.deepStrictEqual(calls, [['FFA', 'Forge']]);
    assert.strictEqual(coalescer.size(), 0);

    /* An empty flush is a no-op. */
    await coalescer.flush();
    assert.strictEqual(calls.length, 1);
});

test('netquel: resident boards emit on change, ignore repeats and reject a wrong server', async () => {
    const stateRef = {
        state: {
            serverId: 'Cloud/2',
            hudName: null,
            rows: [
                { rank: '1.', name: 'Apex', score: '10' },
                { rank: '2.', name: 'Zed', score: '5' }
            ]
        }
    };
    const boards = [];
    const pool = new ResidentBoards({
        modes: ['FFA'],
        serverIds: ['Cloud/2'],
        limit: 1,
        pollMs: 60_000,
        fps: 0,
        healthMs: 60_000,
        launchBrowser: async () => fakeBrowser(stateRef),
        onBoard: board => boards.push(board),
        onError: () => {}
    });

    try {
        await pool.start();
        assert.strictEqual(pool.running, true);
        assert.strictEqual(pool.summary().liveTabs, 1);
        assert.strictEqual(boards.length, 1);
        assert.strictEqual(boards[0].server, 'Spiral');
        assert.strictEqual(boards[0].serverId, 'Cloud/2');
        assert.strictEqual(boards[0].rows.length, 2);

        const slot = pool.tabs.get('FFA|Cloud/2');
        assert.ok(slot?.ready);
        assert.strictEqual(typeof slot.page.onBinding, 'function');

        /* The same HUD pushed again is not a new board. */
        slot.page.onBinding({
            name: 'netquelBoardPush',
            payload: JSON.stringify(stateRef.state)
        });
        assert.strictEqual(boards.length, 1);

        /* A score change is. */
        stateRef.state = {
            ...stateRef.state,
            rows: [
                { rank: '1.', name: 'Apex', score: '11' },
                { rank: '2.', name: 'Zed', score: '5' }
            ]
        };
        slot.page.onBinding({
            name: 'netquelBoardPush',
            payload: JSON.stringify(stateRef.state)
        });
        assert.strictEqual(boards.length, 2);
        assert.strictEqual(boards[1].rows[0].score, 11);

        /* A client that hopped servers must never be filed under Cloud/2. */
        slot.page.onBinding({
            name: 'netquelBoardPush',
            payload: JSON.stringify({ ...stateRef.state, serverId: 'Cloud/9' })
        });
        assert.strictEqual(boards.length, 2);
    } finally {
        await pool.stop();
    }
});

test('netquel: a destroyed tab respawns instead of publishing its stats panel', async () => {
    const stateRef = {
        state: {
            serverId: 'Cloud/2',
            hudName: null,
            dead: false,
            rows: [{ rank: '1.', name: 'Apex', score: '10' }]
        }
    };
    const boards = [];
    const pool = new ResidentBoards({
        modes: ['FFA'],
        serverIds: ['Cloud/2'],
        limit: 1,
        pollMs: 60_000,
        fps: 0,
        healthMs: 60_000,
        launchBrowser: async () => fakeBrowser(stateRef),
        onBoard: board => boards.push(board),
        onError: () => {}
    });

    try {
        await pool.start();
        assert.strictEqual(boards.length, 1);
        const slot = pool.tabs.get('FFA|Cloud/2');

        /* The death screen's stats panel must never become a one-row board. */
        stateRef.state = { serverId: 'Cloud/2', hudName: null, dead: true, rows: [] };
        pool.emit(slot, stateRef.state);
        assert.strictEqual(boards.length, 1);

        /* Play Again returns a live arena and republishes the board. */
        stateRef.respawnState = {
            serverId: 'Cloud/2',
            hudName: null,
            dead: false,
            rows: [{ rank: '1.', name: 'Apex', score: '11' }]
        };
        await pool.respawn(slot);
        assert.strictEqual(boards.length, 2);
        assert.strictEqual(boards[1].rows[0].score, 11);
        assert.strictEqual(pool.stats.rejoins, 1);
    } finally {
        await pool.stop();
    }
});

test('netquel: a quiet board still reports on the publish heartbeat', async () => {
    const stateRef = {
        state: {
            serverId: 'Cloud/2',
            hudName: null,
            dead: false,
            rows: [{ rank: '1.', name: 'Apex', score: '10' }]
        }
    };
    const boards = [];
    const pool = new ResidentBoards({
        modes: ['FFA'],
        serverIds: ['Cloud/2'],
        limit: 1,
        pollMs: 60_000,
        fps: 0,
        publishMs: 10,
        healthMs: 60_000,
        launchBrowser: async () => fakeBrowser(stateRef),
        onBoard: board => boards.push(board),
        onError: () => {}
    });

    try {
        await pool.start();
        assert.strictEqual(boards.length, 1);
        const slot = pool.tabs.get('FFA|Cloud/2');

        await new Promise(resolve => setTimeout(resolve, 20));
        slot.page.onBinding({
            name: 'netquelBoardPush',
            payload: JSON.stringify(stateRef.state)
        });

        /* The rows are identical, but the heartbeat refreshes fetchedAt. */
        assert.strictEqual(boards.length, 2);
        assert.ok(boards[1].fetchedAt >= boards[0].fetchedAt);
    } finally {
        await pool.stop();
    }
});

test('netquel: resident tabs get a timer-driven frame loop and a visible state', async () => {
    const stateRef = {
        state: {
            serverId: 'Cloud/2',
            hudName: null,
            rows: [{ rank: '1.', name: 'Apex', score: '10' }]
        }
    };
    const pool = new ResidentBoards({
        modes: ['FFA'],
        serverIds: ['Cloud/2'],
        limit: 1,
        pollMs: 60_000,
        fps: 0,
        healthMs: 60_000,
        launchBrowser: async () => fakeBrowser(stateRef),
        onBoard: () => {},
        onError: () => {}
    });

    try {
        await pool.start();
        const slot = pool.tabs.get('FFA|Cloud/2');
        const install = slot.page.calls.find(call => call.method === 'Page.addScriptToEvaluateOnNewDocument');
        assert.ok(install);
        /* Native rAF stops in hidden tabs; the callback must come from a timer. */
        assert.match(install.params.source, /requestAnimationFrame = callback => setTimeout/);
        assert.match(install.params.source, /visibilityState/);
        assert.match(install.params.source, /get: \(\) => false/);
        /* fps=0 is uncapped, not uninstalled. */
        assert.match(install.params.source, /1000 \/ 60/);
    } finally {
        await pool.stop();
    }
});

test('netquel: a timed-out trusted click falls back instead of failing the join', async () => {
    const page = Object.create(ChromePage.prototype);
    page.evaluate = async () => JSON.stringify({ x: 120, y: 80 });
    /* A busy renderer never answers the input events; that must not reject. */
    const events = [];
    page.send = async (method, params) => {
        events.push({ method, params });
        throw new Error(`DevTools call ${method} timed out.`);
    };

    assert.strictEqual(await page.clickButtonForReal(/^play$/i), false);
    assert.deepStrictEqual(
        events.map(event => event.params.type),
        ['mouseMoved', 'mousePressed', 'mouseReleased']
    );
});

test('netquel: a scheduled rejoin reopens the tab instead of re-reading it', async () => {
    const stateRef = {
        state: {
            serverId: 'Cloud/2',
            hudName: null,
            rows: [{ rank: '1.', name: 'Apex', score: '10' }]
        }
    };
    const pool = new ResidentBoards({
        modes: ['FFA'],
        serverIds: ['Cloud/2'],
        limit: 1,
        pollMs: 60_000,
        fps: 0,
        healthMs: 60_000,
        launchBrowser: async () => fakeBrowser(stateRef),
        onBoard: () => {},
        onError: () => {}
    });

    try {
        await pool.start();
        const slot = pool.tabs.get('FFA|Cloud/2');
        const deafPage = slot.page;

        /* The process is up but the page stopped answering; a rejoin must
         * replace the tab rather than re-read the same deaf page. */
        await pool.ensureTab({ mode: 'FFA', serverId: 'Cloud/2' }, { force: true });
        assert.notStrictEqual(slot.page, deafPage);
        assert.strictEqual(deafPage.alive, false);
        assert.strictEqual(slot.ready, true);

        /* Normal ticks still reuse a healthy tab. */
        const healthyPage = slot.page;
        await pool.ensureTab({ mode: 'FFA', serverId: 'Cloud/2' });
        assert.strictEqual(slot.page, healthyPage);
    } finally {
        await pool.stop();
    }
});
