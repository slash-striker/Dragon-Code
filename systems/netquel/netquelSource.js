/*
 * Netquel leaderboard source.
 *
 * netquel.com is a WASM game client: the leaderboard tables are painted from
 * a WebSocket feed, and every non-static URL answers with the same HTML shell
 * (there is no JSON endpoint — /api/*, *.json and per-server paths were all
 * checked). The only way to read the standings is to let the real client
 * render, so this module drives a headless Chrome/Edge over the DevTools
 * protocol and reads the finished <table> cells.
 *
 * No extra npm dependency: Node's built-in fetch/WebSocket speak CDP, and the
 * browser is the one already installed on the host.
 *
 * The client refuses to boot without WebGL2, which headless Chrome does not
 * provide by default — the SwiftShader flags below give it a software GL
 * context. Without them the page renders "WebGL2 unsupported" and no tables
 * ever appear.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {
    MODES,
    PERIODS,
    toBoardRows,
    toServerRows,
    serverBoard,
    serverName,
    SERVER_NAMES
} = require('./netquelLogic');

const BASE_URL = 'https://www.netquel.com';
const RENDER_DEADLINE_MS = 30_000;
const LAUNCH_DEADLINE_MS = 20_000;
const ENTER_GAME_DEADLINE_MS = 45_000;
const SERVER_HOP_DEADLINE_MS = 95_000;
const MAX_SERVER_HOPS = 8;
const DEFAULT_SERVER_COUNT = 3;

const CHROME_FLAGS = [
    '--headless=new',
    '--disable-gpu',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    // Software WebGL2 — without this the game client draws its "unsupported"
    // notice instead of the leaderboard.
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist'
];

const CHROME_CANDIDATES = [
    process.env.NETQUEL_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

function locateChrome() {
    return CHROME_CANDIDATES.find(candidate => {
        if (!candidate) return false;
        try {
            return fs.existsSync(candidate);
        } catch {
            return false;
        }
    }) || null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/* Runs in the page: collect the visible Day/Week/All tables. */
const EXTRACT_LEADERBOARD = `(() => {
    const out = {};
    for (const table of document.querySelectorAll('table')) {
        let label = '';
        let node = table;
        for (let i = 0; i < 4 && node && !label; i += 1, node = node.parentElement) {
            const heading = node.querySelector('h1, h2, h3, h4');
            if (heading) label = heading.textContent.trim().toLowerCase();
        }
        if (!['day', 'week', 'all'].includes(label)) continue;
        const rect = table.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        out[label] = [...table.querySelectorAll('tr')].map(row => {
            const cells = [...row.querySelectorAll('td')];
            if (cells.length < 2) return null;
            return { name: cells[0].innerText.trim(), score: cells[1].innerText.trim() };
        }).filter(Boolean);
    }
    return JSON.stringify(out);
})()`;

/*
 * Runs in the page: the live in-game table of whatever arena we landed in.
 * The play page keeps its leaderboard overlay in the DOM from the start, so
 * the biggest table with real rows wins rather than the first visible one.
 */
const EXTRACT_LIVE = `(() => {
    const unsupported = document.body.innerText.includes('WebGL2 unsupported');
    let best = [];
    for (const table of document.querySelectorAll('table')) {
        const rows = [...table.querySelectorAll('tr')].map(row => {
            const cells = [...row.querySelectorAll('td')];
            if (cells.length < 2) return null;
            return { name: cells[0].innerText.trim(), score: cells[1].innerText.trim() };
        }).filter(Boolean);
        if (rows.length > best.length) best = rows;
    }
    return JSON.stringify({ unsupported, rows: best });
})()`;

/*
 * Runs in the page while a match is live. The in-game HUD board sits in the
 * top-right corner with "rank, name, score" cells (the site tables have two),
 * and sessionStorage.serverId names the server we are connected to — it
 * changes on the wall countdown -> hyperspace jump to the next server.
 */
/*
 * The shell's Play button exists before the client binds its click handler, so
 * a click that early is silently dropped. "Ready" means the client has painted
 * its canvas and rendered the landing board, which only happens once the
 * WebSocket is up.
 */
const EXTRACT_CLIENT_READY = `(() => {
    const canvas = document.querySelector('canvas');
    const painted = Boolean(canvas && canvas.width > 0 && canvas.height > 0);
    const boardRows = [...document.querySelectorAll('table')]
        .reduce((max, table) => Math.max(max, table.querySelectorAll('tr').length), 0);
    const play = [...document.querySelectorAll('button, [role="button"], a')]
        .some(element => /^play$/i.test((element.innerText || '').trim()));
    return JSON.stringify({ painted, boardRows, play });
})()`;

const EXTRACT_PLAY_STATE = `(() => {
    const NAMES = ['Zenith', 'Vortex', 'Spiral'];
    let best = [];
    let board = null;
    for (const table of document.querySelectorAll('table')) {
        const rect = table.getBoundingClientRect();
        if (rect.right < window.innerWidth * 0.55 || rect.top > window.innerHeight * 0.5) continue;
        const rows = [...table.querySelectorAll('tr')].map(row => {
            const cells = [...row.querySelectorAll('td')];
            if (cells.length < 3) return null;
            return {
                rank: cells[0].innerText.trim(),
                name: cells[1].innerText,
                score: cells[2].innerText
            };
        }).filter(Boolean);
        if (rows.length > best.length) {
            best = rows;
            board = table;
        }
    }
    /*
     * The HUD board is captioned with the server it belongs to. Only trust the
     * caption when it names exactly one known server, so a page-wide text scan
     * can never mislabel a board.
     */
    let hudName = null;
    if (board) {
        let node = board;
        for (let i = 0; i < 4 && node && !hudName; i += 1, node = node.parentElement) {
            const text = node.innerText || '';
            const found = NAMES.filter(name => new RegExp(name, 'i').test(text));
            if (found.length === 1) hudName = found[0];
        }
    }
    return JSON.stringify({
        serverId: sessionStorage.getItem('serverId') || null,
        hudName,
        rows: best
    });
})()`;

class ChromePage {
    constructor(child, socket, profileDir) {
        this.child = child;
        this.socket = socket;
        this.profileDir = profileDir;
        this.nextId = 0;
        this.pending = new Map();
        this.closed = false;
        this.pointer = null;
        this.boosting = false;
        this.markers = new Set();
        this.consoleTail = [];
        this.openedAt = 0;
    }

    static async launch() {
        const binary = locateChrome();
        if (!binary) {
            throw new Error(
                'No Chrome, Edge or Chromium install found for the Netquel scrape. ' +
                'Install one, or point NETQUEL_CHROME_PATH at the browser binary.'
            );
        }

        const port = await freePort();
        const profileDir = path.join(os.tmpdir(), `netquel-tracker-${port}`);
        const child = spawn(binary, [
            ...CHROME_FLAGS,
            `--user-data-dir=${profileDir}`,
            `--remote-debugging-port=${port}`,
            'about:blank'
        ], { stdio: 'ignore' });

        let target = null;
        const deadline = Date.now() + LAUNCH_DEADLINE_MS;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) {
                throw new Error(`Browser exited during startup (code ${child.exitCode}).`);
            }
            try {
                const response = await fetch(`http://127.0.0.1:${port}/json/list`);
                const targets = await response.json();
                target = targets.find(entry => entry.type === 'page');
                if (target?.webSocketDebuggerUrl) break;
            } catch {
                // Browser is still booting.
            }
            await sleep(250);
        }

        if (!target?.webSocketDebuggerUrl) {
            child.kill('SIGKILL');
            throw new Error('Browser started but never exposed a debugging target.');
        }

        const socket = new WebSocket(target.webSocketDebuggerUrl);
        const page = new ChromePage(child, socket, profileDir);
        await page.connect();
        return page;
    }

    async connect() {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timed out attaching to the browser target.')), 10_000);
            this.socket.addEventListener('open', () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
            this.socket.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error('Browser target refused the DevTools connection.'));
            }, { once: true });
        });

        this.socket.addEventListener('message', event => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                return;
            }

            /*
             * The client only binds its Play handler once it logs
             * "gameInteractive"; clicking before that is silently dropped.
             */
            if (message.method === 'Runtime.consoleAPICalled') {
                const text = (message.params.args || [])
                    .map(arg => arg.value ?? arg.description ?? '')
                    .join(' ');
                if (text) {
                    this.consoleTail.push(text);
                    if (this.consoleTail.length > 200) this.consoleTail.shift();
                    if (/gameInteractive|gameLoaded/i.test(text)) this.markers.add('interactive');
                }
                return;
            }

            const resolver = message.id && this.pending.get(message.id);
            if (!resolver) return;
            this.pending.delete(message.id);
            resolver(message);
        });

        await this.send('Page.enable');
        await this.send('Runtime.enable');
    }

    send(method, params = {}, timeoutMs = 20_000) {
        return new Promise((resolve, reject) => {
            if (this.closed) {
                reject(new Error('Browser session already closed.'));
                return;
            }
            const id = ++this.nextId;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`DevTools call ${method} timed out.`));
            }, timeoutMs);

            this.pending.set(id, message => {
                clearTimeout(timer);
                if (message.error) {
                    reject(new Error(message.error.message || `DevTools call ${method} failed.`));
                    return;
                }
                resolve(message.result);
            });

            try {
                this.socket.send(JSON.stringify({ id, method, params }));
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
        });
        if (result?.exceptionDetails) {
            throw new Error(result.exceptionDetails.text || 'Page evaluation failed.');
        }
        return result?.result?.value;
    }

    async open(url) {
        this.markers.clear();
        this.consoleTail.length = 0;
        this.openedAt = Date.now();
        await this.send('Page.navigate', { url });
    }

    /* Poll until the page has finished painting rows (or give up). */
    async waitForRows(readExpression, deadlineMs = RENDER_DEADLINE_MS) {
        const deadline = Date.now() + deadlineMs;
        let staleRender = false;
        let lastError = null;
        while (Date.now() < deadline) {
            const raw = await this.evaluate(readExpression).catch(error => {
                lastError = error;
                return null;
            });
            if (raw) {
                const parsed = JSON.parse(raw);
                const rows = parsed.rows || Object.values(parsed).flat();
                if (parsed.unsupported) staleRender = true;
                if (rows.length) return parsed;
            }
            await sleep(500);
        }
        if (staleRender) {
            throw new Error(
                'The Netquel client reported "WebGL2 unsupported" in this browser, so no '
                + 'leaderboard could be rendered.'
            );
        }
        if (lastError) {
            throw new Error(`Timed out waiting for the leaderboard to render (${lastError.message}).`);
        }
        throw new Error('Timed out waiting for the leaderboard to render.');
    }

    /* Returns { day: rows, week: rows, all: rows } for one game mode. */
    async readLeaderboard(mode) {
        await this.open(`${BASE_URL}/${mode}/leaderboard/`);
        const tables = await this.waitForRows(`(() => {
            const payload = ${EXTRACT_LEADERBOARD};
            const parsed = JSON.parse(payload);
            return JSON.stringify({
                rows: Object.values(parsed).flat(),
                tables: parsed,
                unsupported: document.body.innerText.includes('WebGL2 unsupported')
            });
        })()`);
        return tables.tables || {};
    }

    /* Returns the live in-game table from the play page (arena roster). */
    async readLive(mode) {
        await this.open(`${BASE_URL}/${mode}/`);
        // The client has to connect to an arena before the table fills in.
        const parsed = await this.waitForRows(EXTRACT_LIVE, 35_000);
        return parsed;
    }

    /* ---------------- per-server boards (in-game HUD) ---------------- */

    async readPlayState() {
        const raw = await this.evaluate(EXTRACT_PLAY_STATE).catch(() => null);
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    /* Wait until the client is live enough for a Play click to register. */
    async waitForClientReady(deadlineMs = 40_000) {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
            if (this.markers.has('interactive')) return true;

            /* Fallback for a client build that stops logging gameInteractive:
             * give the shell a moment to hydrate, then trust the paint check. */
            if (Date.now() - this.openedAt > 8000) {
                const raw = await this.evaluate(EXTRACT_CLIENT_READY).catch(() => null);
                if (raw) {
                    try {
                        const state = JSON.parse(raw);
                        if (state.painted && state.play && state.boardRows > 0) return true;
                    } catch {
                        // Page was mid-navigation; poll again.
                    }
                }
            }
            await sleep(500);
        }
        return false;
    }

    /* A trusted click at the button's centre, for when element.click() is ignored. */
    async clickPlayForReal() {
        const raw = await this.evaluate(`(() => {
            const button = [...document.querySelectorAll('button, [role="button"], a')]
                .find(element => /^play$/i.test((element.innerText || '').trim()));
            if (!button) return null;
            const rect = button.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;
            return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        })()`).catch(() => null);
        if (!raw) return false;

        const { x, y } = JSON.parse(raw);
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, 5000);
        await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, 5000);
        await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, 5000);
        return true;
    }

    async waitForPlayButton(deadlineMs = 25_000) {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
            const ready = await this.evaluate(`(() => [...document.querySelectorAll('button, [role="button"], a')]
                .some(element => /^play$/i.test((element.innerText || '').trim())))()`).catch(() => false);
            if (ready) return true;
            await sleep(500);
        }
        return false;
    }

    async startMatch() {
        return this.evaluate(`(() => {
            const button = [...document.querySelectorAll('button, [role="button"], a')]
                .find(element => /^play$/i.test((element.innerText || '').trim()));
            if (!button) return false;
            button.click();
            return true;
        })()`).catch(() => false);
    }

    /* The game is live once we have a server id and its HUD board has rows. */
    async waitForArena(deadlineMs = ENTER_GAME_DEADLINE_MS) {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
            const state = await this.readPlayState();
            if (state?.serverId && state.rows?.length) return state;
            await sleep(750);
        }
        return null;
    }

    /* Park the pointer on the right edge; holding the left button boosts. */
    async pointerToRightEdge(pressBoost = false) {
        const size = JSON.parse(await this.evaluate('JSON.stringify({ w: innerWidth, h: innerHeight })'));
        const x = Math.max(1, Math.round(Number(size?.w) || 800) - 6);
        const y = Math.round((Number(size?.h) || 600) / 2);
        this.pointer = { x, y };
        await this.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x, y, button: 'none', buttons: this.boosting ? 1 : 0
        }, 5000);
        if (!pressBoost || this.boosting) return;
        await this.send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1
        }, 5000);
        this.boosting = true;
    }

    async releaseBoost() {
        if (!this.boosting) return;
        const { x, y } = this.pointer || { x: 10, y: 10 };
        this.boosting = false;
        await this.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1
        }, 5000).catch(() => {});
    }

    /* Fly right into the wall and wait out the countdown to the next server. */
    async waitForServerHop(fromServerId, deadlineMs = SERVER_HOP_DEADLINE_MS) {
        const deadline = Date.now() + deadlineMs;
        await this.pointerToRightEdge(true).catch(() => {});
        try {
            while (Date.now() < deadline) {
                await sleep(1000);
                // Re-pin the pointer: the camera scrolls, so the ship needs the
                // target kept at the right edge to keep thrusting into the wall.
                await this.pointerToRightEdge(false).catch(() => {});
                const state = await this.readPlayState();
                if (!state) continue;
                if (state.serverId && state.serverId !== fromServerId && state.rows?.length) {
                    // Let the new arena's HUD board replace the old one.
                    await sleep(2500);
                    const settled = await this.readPlayState();
                    return settled?.rows?.length ? settled : state;
                }
            }
            return null;
        } finally {
            await this.releaseBoost();
        }
    }

    /*
     * Start a match and read the top-right board on each server: fly right
     * into the wall, wait for the jump, read again, and stop once the client
     * lands back on a server we already read.
     */
    async collectServerBoards(mode, targetCount = DEFAULT_SERVER_COUNT) {
        await this.open(`${BASE_URL}/${mode}/`);
        if (!(await this.waitForClientReady())) {
            throw new Error('The Netquel play page never finished loading its client.');
        }

        /* A Play click can still be dropped if an ad overlay is settling, so
         * click, wait for the arena, and try again rather than give up. */
        let state = null;
        for (let attempt = 0; attempt < 3 && !state; attempt += 1) {
            if (attempt > 0) await sleep(2000);
            if (attempt === 1) {
                await this.clickPlayForReal();
            } else {
                await this.startMatch();
            }
            state = await this.waitForArena(25_000);
        }
        if (!state) throw new Error('The Netquel client never entered an arena.');

        const boards = new Map();
        const wanted = Math.min(Math.max(1, targetCount), MAX_SERVER_HOPS);
        for (let hop = 0; hop <= MAX_SERVER_HOPS; hop += 1) {
            if (state.serverId && state.rows?.length) {
                if (boards.has(state.serverId)) break; // full loop, nothing new
                const name = serverName(state.serverId, state.hudName);
                const mapped = SERVER_NAMES[state.serverId];
                if (mapped && name !== mapped) {
                    console.warn(
                        `Netquel ${mode}: board on ${state.serverId} calls itself ${name} (expected ${mapped}).`
                    );
                }
                boards.set(state.serverId, { server: name, rows: state.rows });
            }
            if (boards.size >= wanted) break;
            const next = await this.waitForServerHop(state.serverId);
            if (!next) break;
            state = next;
        }

        return [...boards].map(([serverId, entry]) => ({
            serverId,
            server: entry.server,
            rows: entry.rows
        }));
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        try {
            this.socket.close();
        } catch {
            // Ignore: the socket may already be gone.
        }
        try {
            this.child.kill('SIGKILL');
        } catch {
            // Ignore.
        }
        /*
         * Best-effort temp profile cleanup: the browser may still be flushing
         * files the instant it is killed, and a failed cleanup must never hide
         * a successful scrape.
         */
        try {
            fs.rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
        } catch {
            // Ignore — the OS reaps the temp directory.
        }
    }
}

/* How many servers the client is currently offering (Cloud/2, Cloud/3, …). */
async function knownServerCount() {
    try {
        const response = await fetch(`${BASE_URL}/system.json`, { signal: AbortSignal.timeout(8000) });
        const data = await response.json();
        const servers = Array.isArray(data?.available_servers) ? data.available_servers : [];
        return servers.length ? Math.min(servers.length, MAX_SERVER_HOPS) : DEFAULT_SERVER_COUNT;
    } catch {
        return DEFAULT_SERVER_COUNT;
    }
}

/*
 * The site publishes three tables per mode (day/week/all). The per-server
 * boards live only inside a live match: press Play, read the top-right board,
 * then fly right into the wall to be teleported to the next server.
 */
async function scrapeMode(mode, serverTarget) {
    const page = await ChromePage.launch();
    const boards = [];
    try {
        const tables = await page.readLeaderboard(mode);
        const siteFetchedAt = Date.now();
        for (const period of PERIODS) {
            boards.push({ mode, period, rows: toBoardRows(tables[period]), fetchedAt: siteFetchedAt });
        }

        /* A failed hop must not throw away the site boards we just read. */
        try {
            const servers = await page.collectServerBoards(mode, serverTarget);
            const serverFetchedAt = Date.now();
            for (const entry of servers) {
                boards.push({
                    ...serverBoard(mode, entry.server, toServerRows(entry.rows), entry.serverId),
                    fetchedAt: serverFetchedAt
                });
            }
        } catch (error) {
            console.warn(`Netquel ${mode} server boards unavailable:`, error.message);
        }
    } finally {
        await page.close();
    }
    return boards;
}

/*
 * Fast path: only the site's day/week/all tables for each mode. No match, no
 * wall, no hops — one browser, one page, a few seconds per mode.
 */
async function scrapeSiteBoards(modes = MODES) {
    const startedAt = Date.now();
    const page = await ChromePage.launch();
    const boards = [];
    const errors = [];
    try {
        for (const mode of modes) {
            try {
                const tables = await page.readLeaderboard(mode);
                const fetchedAt = Date.now();
                for (const period of PERIODS) {
                    boards.push({ mode, period, rows: toBoardRows(tables[period]), fetchedAt });
                }
            } catch (error) {
                errors.push(`${mode}: ${error.message}`);
                console.warn(`Netquel ${mode} site boards failed:`, error.message);
            }
        }
    } finally {
        await page.close();
    }

    if (!boards.length && errors.length) throw new Error(errors.join(' | '));
    return { fetchedAt: Date.now(), boards, durationMs: Date.now() - startedAt, errors };
}

/*
 * Slow path: the in-game per-server boards. Each mode costs a match join plus
 * two wall hops, so this keeps its own timer and never runs beside other
 * browser work (two software-rendered clients starve each other).
 */
async function scrapeServerBoards(modes = MODES) {
    const startedAt = Date.now();
    const serverTarget = await knownServerCount();
    const page = await ChromePage.launch();
    const boards = [];
    const errors = [];
    try {
        for (const mode of modes) {
            try {
                const servers = await page.collectServerBoards(mode, serverTarget);
                const fetchedAt = Date.now();
                for (const entry of servers) {
                    boards.push({
                        ...serverBoard(mode, entry.server, toServerRows(entry.rows), entry.serverId),
                        fetchedAt
                    });
                }
            } catch (error) {
                errors.push(`${mode}: ${error.message}`);
                console.warn(`Netquel ${mode} server boards failed:`, error.message);
            }
        }
    } finally {
        await page.close();
    }

    if (!boards.length && errors.length) throw new Error(errors.join(' | '));
    return { fetchedAt: Date.now(), boards, durationMs: Date.now() - startedAt, errors };
}

/*
 * One mode at a time, on purpose. Running FFA and Forge side by side was
 * measured at ~130s instead of ~180s, but the two software-rendered game
 * clients starve each other: the ship's wall approach lagged and Forge came
 * back with one server board instead of three. Every board matters more than
 * the minute it saves, so the modes stay sequential.
 *
 * The remaining cost is inherent to the game: the per-server boards only
 * exist inside a live match, and reaching the next server means flying into
 * the wall and waiting out the client's own teleport countdown (25-40s a hop,
 * two hops per mode).
 */
async function scrapeBoards() {
    const startedAt = Date.now();
    const serverTarget = await knownServerCount();
    const boards = [];
    const errors = [];

    for (const mode of MODES) {
        try {
            boards.push(...await scrapeMode(mode, serverTarget));
        } catch (error) {
            errors.push(`${mode}: ${error.message}`);
            console.warn(`Netquel ${mode} scrape failed:`, error.message);
        }
    }

    if (!boards.length && errors.length) {
        throw new Error(errors.join(' | '));
    }
    return { fetchedAt: Date.now(), boards, durationMs: Date.now() - startedAt, errors };
}

/* Live arena roster for one mode, used by /target. */
async function scrapeLive(mode) {
    const page = await ChromePage.launch();
    try {
        const parsed = await page.readLive(mode);
        return { mode, rows: toBoardRows(parsed.rows) };
    } finally {
        await page.close();
    }
}

module.exports = {
    BASE_URL,
    MODES,
    locateChrome,
    scrapeBoards,
    scrapeSiteBoards,
    scrapeServerBoards,
    scrapeLive
};
