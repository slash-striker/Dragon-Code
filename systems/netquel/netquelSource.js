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
    boardSignature,
    nameMatches,
    normalizeName,
    parseBrief,
    toBoardRows,
    toServerRows,
    serverBoard,
    serverName,
    SERVER_NAMES
} = require('./netquelLogic');

const BASE_URL = 'https://www.netquel.com';
/*
 * Cloud servers answer on their own numbered hosts and pin that server, so a
 * board is one page load away: https://4.netquel.com already is Cloud/4. That
 * removes the wall hop (and its 25-40s teleport countdown) from every read.
 */
const DIRECT_SERVERS = String(process.env.NETQUEL_DIRECT_SERVERS ?? '1').toLowerCase() !== '0';
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const RENDER_DEADLINE_MS = 30_000;

/*
 * Resident live boards: one tab per (mode, server) that joins once and then
 * only reads the HUD. A refresh becomes a DOM read instead of a page load,
 * a WASM boot, a Play click and an arena wait.
 */
const RESIDENT_PROFILE_DIR = path.join(PROJECT_ROOT, '.netquel-resident-profile');
const RESIDENT_POLL_MS = (() => {
    const seconds = Number(process.env.NETQUEL_RESIDENT_POLL_SECONDS);
    return Math.max(500, (Number.isFinite(seconds) && seconds > 0 ? seconds : 2) * 1000);
})();
const RESIDENT_FPS = (() => {
    const fps = Number(process.env.NETQUEL_RESIDENT_FPS);
    return Number.isFinite(fps) && fps >= 0 ? Math.min(60, Math.round(fps)) : 5;
})();
const RESIDENT_HEALTH_MS = 15_000;
const LAUNCH_DEADLINE_MS = 30_000;
const ENTER_GAME_DEADLINE_MS = 45_000;
const SERVER_HOP_DEADLINE_MS = 95_000;
const MAX_SERVER_HOPS = 8;
const DEFAULT_SERVER_COUNT = 3;

/*
 * One long-lived browser for the site's day/week/all tables. The WASM client is
 * ~7s with a cold profile and ~1.5s warm, so the profile is kept between ticks
 * instead of being thrown away with the browser every time.
 */
const SITE_PROFILE_DIR = path.join(PROJECT_ROOT, '.netquel-site-profile');
const SITE_NAVIGATE_TIMEOUT_MS = 20_000;
/*
 * Generous on purpose: while the in-game server sweep is running, the two
 * software-rendered clients share the CPU and a warm reload measured ~9s per
 * mode on a loaded host. A deadline that tight would restart the browser
 * mid-sweep for no reason; only a really stuck render should hit this.
 */
const SITE_RENDER_DEADLINE_MS = 40_000;
const SITE_POLL_MS = 100;
/* A failed launch is not fixed by the next 30s tick, so attempts back off. */
const SITE_LAUNCH_BACKOFF_MS = 30_000;
const SITE_LAUNCH_BACKOFF_MAX_MS = 5 * 60_000;
/*
 * The in-game client gets its own resident browser. A sweep needs a live match,
 * and keeping the process (and its cached WASM) between sweeps removes the
 * launch and temporary-profile cost. It is parked on about:blank between
 * passes so it is not sitting in a match.
 */
const SWEEP_PROFILE_DIR = path.join(PROJECT_ROOT, '.netquel-sweep-profile');
const SWEEP_LAUNCH_BACKOFF_MS = 30_000;
const SWEEP_LAUNCH_BACKOFF_MAX_MS = 5 * 60_000;
/*
 * A join blocks the client's main thread while it renders, and on a loaded
 * host a single 3s probe timed out on a page that was merely busy. Killing a
 * warm browser over one missed probe cost a cold launch and a fresh join, so
 * a page is only declared deaf when two generous probes both miss.
 */
const BROWSER_PING_TIMEOUT_MS = 8_000;
const BROWSER_PING_ATTEMPTS = 2;
const BROWSER_PING_RETRY_MS = 1_500;

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
    // A profile kept between ticks can hold a crash flag from a killed run; the
    // restore bubble is a modal that can sit over the tables.
    '--hide-crash-restore-bubble',
    // Software WebGL2 — without this the game client draws its "unsupported"
    // notice instead of the leaderboard.
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    // Containers give /dev/shm 64 MB; without this the renderer crashes
    // mid-page and the leaderboard never paints.
    '--disable-dev-shm-usage',
    // Resident boards live in background tabs; Chrome must not freeze or
    // throttle them out of the game while another tab is being read.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
];

/*
 * The page boots faster without ad/tracker round-trips, and a resident tab
 * should not spend CPU on anything but the client. Blocking is conservative
 * and can be turned off with NETQUEL_BLOCK_ADS=0.
 */
const BLOCK_ADS = !/^(0|false|no)$/i.test(String(process.env.NETQUEL_BLOCK_ADS ?? '1').trim());
const AD_URLS = [
    '*://*.doubleclick.net/*',
    '*://*.googlesyndication.com/*',
    '*://*.google-analytics.com/*',
    '*://*.googletagmanager.com/*',
    '*://*.adservice.google.com/*',
    '*://*.amazon-adsystem.com/*'
];

/*
 * Most game-hosting containers run without user namespaces, so Chrome's
 * sandbox cannot start. Opting out is a real trade-off (the browser is no
 * longer sandboxed), so it is never automatic — set
 * NETQUEL_CHROME_NO_SANDBOX=1 on the host when the browser refuses to boot.
 */
if (/^(1|true|yes)$/i.test(String(process.env.NETQUEL_CHROME_NO_SANDBOX ?? '').trim())) {
    CHROME_FLAGS.push('--no-sandbox', '--disable-setuid-sandbox');
}

/*
 * Set once Chrome has proved it cannot start with its sandbox (the normal case
 * on game panels), so later launches go straight to the flags that work
 * instead of paying the failed attempt every refresh.
 */
let sandboxUnavailable = false;
let sandboxNoticeShown = false;

const CHROME_CANDIDATES = [
    // Downloaded by scripts/install-netquel-chrome.js (npm postinstall) when the
    // host has no browser of its own.
    path.join(__dirname, '..', '..', '.netquel-chrome', 'chrome-linux64', 'chrome'),
    path.join(__dirname, '..', '..', '.netquel-chrome', 'chrome-linux-arm64', 'chrome'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/lib/chromium/chromium',
    '/usr/lib/chromium-browser/chromium-browser',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

/*
 * A host usually has no system browser, but `npx puppeteer browsers install
 * chrome` (or a Playwright install) drops one in the user cache. Those are
 * real Chrome binaries, so they work with the same CDP flags.
 */
function cachedBrowserCandidates() {
    const home = os.homedir();
    const found = [];
    const cacheRoots = [
        path.join(home, '.cache', 'puppeteer', 'chrome'),
        path.join(home, '.cache', 'ms-playwright')
    ];

    for (const root of cacheRoots) {
        let entries = [];
        try {
            entries = fs.readdirSync(root);
        } catch {
            continue;
        }
        for (const entry of entries) {
            for (const guess of [
                path.join(root, entry, 'chrome-linux64', 'chrome'),
                path.join(root, entry, 'chrome-linux', 'chrome'),
                path.join(root, entry, 'chrome-linux', 'headless_shell')
            ]) {
                try {
                    if (fs.existsSync(guess)) found.push(guess);
                } catch {
                    // Ignore unreadable cache entries.
                }
            }
        }
    }
    return found;
}

/*
 * A Chrome folder dropped into the bot by hand (the panel's file manager is the
 * usual way): `chrome/chrome`, a whole `chrome-linux64/` folder next to
 * index.js, or the same folder at the container root. Downloaded and unpacked
 * by an upload, not by a package manager, so the executable bit is fixed up in
 * ensureExecutable() before launch.
 */
function uploadedBrowserCandidates() {
    const roots = [PROJECT_ROOT, process.cwd(), '/chrome'];
    const found = [];
    for (const root of roots) {
        for (const relative of [
            ['chrome', 'chrome'],
            ['chrome', 'chrome-linux64', 'chrome'],
            ['chrome', 'chrome-linux-arm64', 'chrome'],
            ['chrome-linux64', 'chrome'],
            ['chrome']
        ]) {
            found.push(path.join(root, ...relative));
        }
    }
    return found;
}

function locateChrome() {
    const candidates = [
        process.env.NETQUEL_CHROME_PATH,
        ...uploadedBrowserCandidates(),
        ...cachedBrowserCandidates(),
        ...CHROME_CANDIDATES
    ];
    return candidates.find(candidate => {
        if (!candidate) return false;
        try {
            return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
        } catch {
            return false;
        }
    }) || null;
}

/*
 * Chrome uploaded through a web file manager usually loses its executable bit,
 * which fails with a bare EACCES and no explanation. Restore it when we can.
 */
function ensureExecutable(binary) {
    try {
        fs.accessSync(binary, fs.constants.X_OK);
        return binary;
    } catch {
        // Fall through: try to fix the mode.
    }
    try {
        fs.chmodSync(binary, 0o755);
        return binary;
    } catch (error) {
        throw new Error(
            `The browser at ${binary} is not executable and could not be chmod'd (${error.message}). `
            + 'Run `chmod +x` on it, or re-upload it with the executable bit set.'
        );
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/*
 * Chrome's crash handler prints a register dump and a hundred stack frames.
 * Keep the sentence that actually explains the failure and drop the rest, so a
 * log file stays readable and /reload does not paste a megabyte into Discord.
 */
function condenseStderr(text) {
    const noise = /^(#\d+|\s*[a-z0-9]{2}:|trp:|msk:|efl:|cgf:|erf:|cr2:|ip:|dx:|cx:|ax:|bx:|sp:|bp:|si:|di:|r\d+:|\[end of stack trace\])/i;
    const kept = String(text || '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !noise.test(line));
    const joined = kept.slice(0, 6).join('\n');
    return joined.length > 900 ? `${joined.slice(0, 900)}…` : joined;
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
 * The site tables plus the id of the document that painted them. A reload is
 * only accepted once the document has changed, so the previous mode's DOM can
 * never be read as this mode's standings — and readiness is the three real
 * tables (day/week/all), because the landing board is a ten-row table that
 * would otherwise look like a finished leaderboard.
 */
const EXTRACT_SITE_TABLES = `(() => {
    const parsed = JSON.parse(${EXTRACT_LEADERBOARD});
    const body = document.body;
    return JSON.stringify({
        docId: (typeof window.__netquelDocId === 'string' && window.__netquelDocId) || null,
        tables: parsed,
        unsupported: Boolean(body && body.innerText.includes('WebGL2 unsupported'))
    });
})()`;

/* Stamped into every new document, so a stale DOM is never mistaken for fresh. */
const DOC_ID_SCRIPT = `window.__netquelDocId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);`;

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

/*
 * `.brief` is the profile card the client draws when a board name is clicked.
 * It only exists after a click, it carries no player name, and it is anchored
 * to the row that opened it — its top edge sits a few pixels under the click.
 * That anchor is the only proof of whose card it is.
 */
const EXTRACT_BRIEF = `(() => {
    const brief = document.querySelector('.brief');
    if (!brief) return null;
    const out = {};
    let title = null;
    for (const row of brief.querySelectorAll('tr')) {
        const cells = row.querySelectorAll('td');
        /* A one-cell row is the player's name, on cards that show a clan. */
        if (!title && cells.length === 1) {
            const value = cells[0].innerText.trim();
            if (value && !/profile (is private|not found)/i.test(value)) title = value;
        }
        const label = row.querySelector('td.label')?.innerText.trim();
        if (!label || cells.length < 2) continue;
        out[label] = cells[1].innerText.trim();
    }
    return JSON.stringify({
        top: brief.getBoundingClientRect().y,
        title,
        text: (brief.innerText || '').trim(),
        fields: out
    });
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
            /*
             * A verified account draws its name in italics (the span carries
             * font-style: italic), and an AFK row is dimmed with title="AFK".
             * Neither is in the text, so both are read from the live DOM.
             */
            const nameCell = cells[1];
            const spans = [...nameCell.querySelectorAll('span')];
            const nameText = nameCell.innerText.trim();
            const label = spans.find(span => span.innerText.trim() === nameText)
                || spans[spans.length - 1]
                || nameCell;
            const inline = (label.style && label.style.fontStyle) || '';
            const computed = window.getComputedStyle(label).fontStyle || '';
            return {
                rank: cells[0].innerText.trim(),
                name: cells[1].innerText,
                score: cells[2].innerText,
                verified: /italic|oblique/i.test(inline + ' ' + computed),
                afk: /afk/i.test(row.getAttribute('title') || '')
            };
        }).filter(row => row && row.rank && row.name.trim());
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
    /*
     * A destroyed player sits on the "Play Again" screen with the scoreboard
     * hidden; the profile-stats table is then the only one on screen and would
     * otherwise be read as a one-row board (and never refresh again). A plain
     * Play menu with no board means the client dropped out of the match, which
     * is the same recovery.
     */
    const buttons = [...document.querySelectorAll('button, [role="button"], a')];
    const label = element => (element.innerText || '').trim();
    const hasPlayAgain = buttons.some(element => /play again/i.test(label(element)));
    const hasPlay = buttons.some(element => /^play$/i.test(label(element)));
    const dead = hasPlayAgain || (hasPlay && !best.length);
    return JSON.stringify({
        serverId: sessionStorage.getItem('serverId') || null,
        hudName,
        dead,
        rows: dead ? [] : best
    });
})()`;

/*
 * Runs inside a resident tab: every HUD mutation is pushed to Node over the
 * Runtime binding. The 250 ms debounce absorbs a sort animation without
 * dropping the final frame, and the poll in ResidentBoards covers a client
 * that repaints without touching the DOM.
 */
const HUD_OBSERVER_SCRIPT = `(() => {
    if (window.__netquelHudObserver) return 'already';
    const read = ${EXTRACT_PLAY_STATE};
    let timer = null;
    const emit = () => {
        timer = null;
        try {
            const raw = read();
            if (raw && typeof netquelBoardPush === 'function') netquelBoardPush(raw);
        } catch (error) {
            /* Mid-navigation: the next mutation retries. */
        }
    };
    const schedule = () => {
        if (timer) return;
        timer = setTimeout(emit, 250);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['title', 'style', 'class']
    });
    window.__netquelHudObserver = observer;
    emit();
    return 'installed';
})()`;

/*
 * The game client renders in software at 60 fps, which is the real cost of
 * keeping several boards resident. The bot does not need smooth frames; it
 * needs the WebSocket and the HUD table, so the loop is capped.
 *
 * The cap is a timer, not native requestAnimationFrame: Chrome stops
 * compositor frames for every hidden tab, so a native-rAF wrapper freezes the
 * client's loop (and its HUD scores) as soon as another tab is brought
 * forward. The timer keeps ticking in the background, and the same script
 * reports the page as visible so the client does not pause on visibilitychange.
 * NETQUEL_RESIDENT_FPS=0 means uncapped (60 fps), still timer-driven.
 */
function residentFrameScript(fps) {
    const rate = Number(fps) > 0
        ? Math.max(1, Math.min(60, Math.round(Number(fps))))
        : 60;
    return `(() => {
        if (window.__netquelResidentFrame) return 'already';
        window.__netquelResidentFrame = true;

        const interval = 1000 / ${rate};
        let last = 0;
        window.requestAnimationFrame = callback => setTimeout(() => {
            last = performance.now();
            callback(last);
        }, Math.max(0, interval - (performance.now() - last)));
        window.cancelAnimationFrame = id => clearTimeout(id);

        /*
         * A hidden tab still receives visibilitychange events. Report visible
         * so the client's handler resumes instead of parking the match.
         */
        try {
            Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                get: () => 'visible'
            });
            Object.defineProperty(document, 'hidden', {
                configurable: true,
                get: () => false
            });
            document.hasFocus = () => true;
        } catch (error) {
            /* The timer loop still keeps the client updating. */
        }
        try { document.dispatchEvent(new Event('visibilitychange')); } catch (error) {}
        try { window.dispatchEvent(new Event('focus')); } catch (error) {}
        return 'installed';
    })()`;
}

class ChromePage {
    constructor(child, socket, profileDir, options = {}) {
        this.child = child;
        this.socket = socket;
        this.profileDir = profileDir;
        /*
         * A shared/persistent page keeps its profile: the cached client is the
         * whole point, and deleting it would force a cold ~7s render next time.
         */
        this.keepProfile = Boolean(options.keepProfile);
        /* Set on the browser's first page, and inherited by its other tabs. */
        this.port = options.port ?? null;
        this.targetId = options.targetId ?? null;
        this.owner = options.owner ?? null;
        this.onBinding = typeof options.onBinding === 'function' ? options.onBinding : null;
        this.nextId = 0;
        this.pending = new Map();
        this.closed = false;
        this.pointer = null;
        this.boosting = false;
        this.markers = new Set();
        this.consoleTail = [];
        this.openedAt = 0;
    }

    /* True while the browser behind this page is still running. */
    get alive() {
        if (this.closed) return false;
        if (this.child) return this.child.exitCode === null && !this.child.signalCode;
        return Boolean(this.owner?.alive);
    }

    /* The process can be alive while its DevTools socket is wedged. */
    async ping(timeoutMs = 3_000) {
        if (!this.alive) return false;
        try {
            await this.send('Runtime.evaluate', { expression: '1', returnByValue: true }, timeoutMs);
            return true;
        } catch {
            return false;
        }
    }

    /*
     * Game-panel containers (Pterodactyl and friends) have no user namespaces,
     * so Chrome's sandbox cannot start: the process stays up but never exposes
     * a page target. That is indistinguishable from a missing library without
     * the browser's stderr, so it is captured and quoted in every failure, and
     * a failed start is retried once without the sandbox.
     */
    static async launch(options = {}) {
        const found = locateChrome();
        if (!found) {
            throw new Error(
                'No Chrome, Edge or Chromium install found for the Netquel scrape. ' +
                'Install one, or point NETQUEL_CHROME_PATH at the browser binary — ' +
                'see NETQUEL-HOSTING.md.'
            );
        }
        const binary = ensureExecutable(found);

        const unsandboxed = [...CHROME_FLAGS, '--no-sandbox', '--disable-setuid-sandbox'];
        const canDropSandbox = !CHROME_FLAGS.includes('--no-sandbox');
        const variants = !canDropSandbox
            ? [CHROME_FLAGS]
            : (sandboxUnavailable ? [unsandboxed, CHROME_FLAGS] : [CHROME_FLAGS, unsandboxed]);

        let lastError = null;
        for (let index = 0; index < variants.length; index += 1) {
            const flags = variants[index];
            try {
                const page = await ChromePage.launchWith(binary, flags, options);
                if (canDropSandbox && flags.includes('--no-sandbox')) {
                    sandboxUnavailable = true;
                    if (!sandboxNoticeShown) {
                        sandboxNoticeShown = true;
                        console.warn(
                            'Netquel: this host cannot start the Chrome sandbox, so the browser runs with '
                            + '--no-sandbox from now on (see NETQUEL-HOSTING.md).'
                        );
                    }
                }
                return page;
            } catch (error) {
                lastError = error;
                if (index + 1 < variants.length) {
                    console.warn(
                        `Netquel browser failed to start (${error.message}); retrying `
                        + `${flags.includes('--no-sandbox') ? 'with the sandbox restored' : 'without the Chrome sandbox'}.`
                    );
                }
            }
        }
        throw lastError;
    }

    static async launchWith(binary, flags, options = {}) {
        const port = await freePort();
        const profileDir = options.profileDir
            ? path.resolve(options.profileDir)
            : path.join(os.tmpdir(), `netquel-tracker-${port}`);
        const keepProfile = Boolean(options.keepProfile);
        const child = spawn(binary, [
            ...flags,
            `--user-data-dir=${profileDir}`,
            `--remote-debugging-port=${port}`,
            'about:blank'
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        /* Chrome's own words are the only useful diagnosis on a bare host. */
        let stderr = '';
        let spawnError = null;
        const note = chunk => { stderr = (stderr + chunk).slice(-2000); };
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', note);
        child.on('error', error => {
            spawnError = error;
            note(`spawn error: ${error.message}\n`);
        });

        const detail = () => {
            const summary = condenseStderr(stderr);
            return summary ? ` Browser said: ${summary}` : '';
        };
        const cleanup = () => {
            try {
                child.kill('SIGKILL');
            } catch {
                // Already gone.
            }
            /* A persistent profile is a cache its owner keeps across launches. */
            if (keepProfile) return;
            try {
                fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
            } catch {
                // The OS reaps the temp directory.
            }
        };

        let target = null;
        const deadline = Date.now() + LAUNCH_DEADLINE_MS;
        while (Date.now() < deadline) {
            if (spawnError) {
                cleanup();
                throw new Error(`The browser could not be started (${spawnError.message}).`);
            }
            if (child.exitCode !== null || child.signalCode) {
                cleanup();
                throw new Error(
                    `Browser exited during startup (${child.exitCode ?? child.signalCode}).${detail()}`
                );
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
            cleanup();
            throw new Error(`Browser started but never exposed a debugging target.${detail()}`);
        }

        const socket = new WebSocket(target.webSocketDebuggerUrl);
        const page = new ChromePage(child, socket, profileDir, {
            keepProfile,
            port,
            targetId: target.id
        });
        await page.connect();
        return page;
    }

    /*
     * Attach to another tab in the same Chrome. Resident boards share one
     * browser (and its process) instead of paying a launch per server.
     */
    static async attach(webSocketDebuggerUrl, options = {}) {
        const socket = new WebSocket(webSocketDebuggerUrl);
        const page = new ChromePage(null, socket, options.profileDir ?? null, {
            keepProfile: true,
            port: options.port ?? null,
            targetId: options.targetId ?? null,
            owner: options.owner ?? null,
            onBinding: options.onBinding
        });
        await page.connect();
        return page;
    }

    /* Open a tab through the DevTools HTTP endpoint and attach to it. */
    async createTab(url = 'about:blank', options = {}) {
        if (!this.port) {
            throw new Error('This browser page has no DevTools port to open tabs on.');
        }
        const endpoint = `http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`;
        let response = await fetch(endpoint, { method: 'PUT' }).catch(() => null);
        if (!response?.ok) response = await fetch(endpoint).catch(() => null);
        if (!response?.ok) {
            throw new Error(`The browser would not open a new tab (HTTP ${response?.status ?? 'no response'}).`);
        }
        const target = await response.json().catch(() => null);
        if (!target?.webSocketDebuggerUrl) {
            throw new Error('The browser opened a tab without a DevTools target.');
        }
        return ChromePage.attach(target.webSocketDebuggerUrl, {
            profileDir: this.profileDir,
            port: this.port,
            targetId: target.id,
            owner: this,
            onBinding: options.onBinding
        });
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
            if (message.method === 'Runtime.bindingCalled') {
                if (this.onBinding) {
                    try {
                        this.onBinding(message.params);
                    } catch {
                        // A handler error must not wedge the DevTools socket.
                    }
                }
                return;
            }

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
        if (BLOCK_ADS) {
            await this.send('Network.enable').catch(() => {});
            await this.send('Network.setBlockedURLs', { urls: AD_URLS }).catch(() => {});
        }
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
        // A render can take 30s; without these two lines the log goes silent
        // and a slow scrape is indistinguishable from a hung one.
        console.log(`Netquel ${mode}: loading the site tables…`);
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
        const rendered = Object.values(tables.tables || {})
            .reduce((total, rows) => total + (rows?.length ?? 0), 0);
        console.log(`Netquel ${mode}: site tables rendered (${rendered} row(s)).`);
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

    /*
     * A trusted click at the button's centre, for when element.click() is ignored.
     *
     * It is an optimisation, not the join itself. A busy or backgrounded
     * renderer can stop answering Input.dispatchMouseEvent, and one timeout
     * used to reject the whole join, close the tab and park the server behind
     * a rejoin backoff ("unavailable: DevTools call ... timed out"). Dispatch
     * best-effort and report whether every event was acknowledged, so the
     * caller can fall back to an element click instead.
     */
    async clickButtonForReal(pattern) {
        const raw = await this.evaluate(`(() => {
            const pattern = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
            const button = [...document.querySelectorAll('button, [role="button"], a')]
                .find(element => pattern.test((element.innerText || '').trim()));
            if (!button) return null;
            const rect = button.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;
            return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        })()`).catch(() => null);
        if (!raw) return false;

        const { x, y } = JSON.parse(raw);
        const events = [
            { type: 'mouseMoved', x, y, button: 'none' },
            { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 },
            { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }
        ];
        let acknowledged = true;
        for (const params of events) {
            const sent = await this.send('Input.dispatchMouseEvent', params, 5000)
                .then(() => true)
                .catch(() => false);
            if (!sent) acknowledged = false;
        }
        return acknowledged;
    }

    async clickPlayForReal() {
        return this.clickButtonForReal(/^play$/i);
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
            if (state?.serverId && state.rows?.length && !state.dead) return state;
            await sleep(750);
        }
        return null;
    }

    /*
     * A resident tab plays a real match, so it dies. The death screen hides the
     * scoreboard behind "Play Again"; click it and wait for the next arena.
     * The trusted click matches the Play button path; the element click is the
     * fallback for builds where the overlay swallows synthesized input.
     */
    async respawn(deadlineMs = 15_000) {
        /*
         * Chrome drops input to a background tab (the join path learned the
         * same lesson), so a hidden tab cannot click its own Play Again.
         */
        await this.send('Page.bringToFront', {}, 5_000).catch(() => {});

        const inArena = async () => {
            const state = await this.readPlayState().catch(() => null);
            return state && !state.dead && state.rows?.length ? state : null;
        };
        const clickElement = label => this.evaluate(`(() => {
            const button = [...document.querySelectorAll('button, [role=\"button\"], a')]
                .find(element => new RegExp(${JSON.stringify('^' + label + '$')}, 'i')
                    .test((element.innerText || '').trim()));
            if (!button) return false;
            button.click();
            return true;
        })()`).catch(() => false);

        /* Play Again is the death screen; a plain Play is the dropped-out menu. */
        for (const pattern of [/play again/i, /^play$/i]) {
            if (await this.clickButtonForReal(pattern)) {
                await sleep(1_500);
                const state = await inArena();
                if (state) return state;
            }
            if (await clickElement(pattern.source.replace(/^\^|\$$/g, ''))) {
                await sleep(1_500);
                const state = await inArena();
                if (state) return state;
            }
        }
        return this.waitForArena(deadlineMs);
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
    async waitForServerHop(fromServerId, deadlineMs = SERVER_HOP_DEADLINE_MS, signal = null) {
        const deadline = Date.now() + deadlineMs;
        await this.pointerToRightEdge(true).catch(() => {});
        try {
            while (Date.now() < deadline) {
                if (signal?.aborted) throw new Error('Live check cancelled.');
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
    /*
     * Click every name on the live board and read the card that opens: join
     * date, high score, rank, streak and clan (when the player has one).
     * Best-effort per row — a card that will not open must never cost the
     * server board we are standing on.
     *
     * The click is dispatched on the name cell itself, not at screen
     * coordinates: the board re-sorts every time a score changes, so a
     * coordinate click can land on whoever just took that row — which is how a
     * guest with a blank high score and a one-day streak got filed under a
     * rank-1 player. Clicking the exact cell keeps the card tied to that name.
     */
    async readBoardBriefs(names, { budgetMs = 60_000, limit = Infinity } = {}) {
        const panelView = async () => {
            const raw = await this.evaluate(EXTRACT_BRIEF).catch(() => null);
            if (!raw) return null;
            try {
                return JSON.parse(raw);
            } catch {
                return null;
            }
        };

        /* The row's name cell is the click target; a missing row is skipped. */
        const openRow = name => this.evaluate(`(() => {
            let board = null;
            let best = 0;
            for (const table of document.querySelectorAll('table')) {
                if (table.closest('.brief')) continue;
                const rect = table.getBoundingClientRect();
                if (rect.right < window.innerWidth * 0.55 || rect.top > window.innerHeight * 0.5) continue;
                const count = table.querySelectorAll('tr').length;
                if (count > best) { best = count; board = table; }
            }
            if (!board) return 'no-board';
            const wanted = ${JSON.stringify(String(name))};
            const row = [...board.querySelectorAll('tr')].find(candidate => {
                const cells = [...candidate.querySelectorAll('td')];
                return cells.length >= 3 && cells[1].innerText.trim() === wanted;
            });
            if (!row) return 'no-row';
            const cell = row.querySelectorAll('td')[1];
            const target = cell.firstElementChild || cell;
            const down = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };
            const up = { ...down, buttons: 0 };
            target.dispatchEvent(new PointerEvent('pointerdown', down));
            target.dispatchEvent(new MouseEvent('mousedown', down));
            target.dispatchEvent(new PointerEvent('pointerup', up));
            target.dispatchEvent(new MouseEvent('mouseup', up));
            target.dispatchEvent(new MouseEvent('click', up));
            return 'clicked';
        })()`).catch(() => 'error');

        /*
         * The client asks the server for the profile when a name is clicked, so
         * the card can take a couple of seconds to arrive on a busy board. A
         * short poll reads "no card" and the player is skipped, which is how a
         * real sighting ends up judged against a stale stored card.
         */
        const CARD_WAIT_MS = 6000;
        const startedAt = Date.now();

        const briefs = new Map();
        let previousText = (await panelView())?.text ?? null;
        let read = 0;
        for (const name of names || []) {
            if (!name) continue;
            if (read >= limit) break;
            if (Date.now() - startedAt > budgetMs) break; // keep the sweep on schedule
            try {
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    if (await openRow(name) !== 'clicked') break;

                    let view = null;
                    const deadline = Date.now() + CARD_WAIT_MS;
                    while (Date.now() < deadline) {
                        const current = await panelView();
                        /* An unchanged panel means this click opened nothing. */
                        if (current?.text && current.text !== previousText) {
                            view = current;
                            break;
                        }
                        await sleep(180);
                    }
                    if (!view) continue;
                    previousText = view.text;

                    /* A clan card names its owner; that name has to be this row's. */
                    if (view.title && !nameMatches(name, view.title)) continue;

                    const card = parseBrief(view.fields, view.text);
                    if (card) {
                        briefs.set(normalizeName(name), card);
                        read += 1;
                        break;
                    }
                }
            } catch {
                // Skip this row; the rest of the board is still worth reading.
            }
        }
        return briefs;
    }

    /*
     * Open a mode's play page and get into a live arena. The full server sweep
     * and the on-demand card refresh both enter the game through here.
     */
    async joinArena(mode, { baseUrl = BASE_URL } = {}) {
        await this.open(`${baseUrl}/${mode}/`);
        if (!(await this.waitForClientReady())) {
            throw new Error('The Netquel play page never finished loading its client.');
        }

        /*
         * A Play click can still be dropped if an ad overlay is settling, so
         * click, wait for the arena, and try again rather than give up.
         *
         * The first attempt is the trusted input click and only waits 10s: if
         * it registered, the arena is up in a second or two; if it was dropped,
         * there is no point sitting out the full 25s before trying again. That
         * timeout was the 30s every resident join used to cost.
         */
        let state = null;
        for (let attempt = 0; attempt < 3 && !state; attempt += 1) {
            if (attempt > 0) await sleep(1000);
            if (attempt === 0) {
                if (!(await this.clickPlayForReal())) await this.startMatch();
            } else if (attempt === 1) {
                await this.clickPlayForReal();
            } else {
                await this.startMatch();
            }
            state = await this.waitForArena(attempt === 0 ? 10_000 : 25_000);
        }
        if (!state) throw new Error('The Netquel client never entered an arena.');
        return state;
    }

    /* Open a numbered server host and make sure the client landed there. */
    async joinServer(mode, serverId) {
        const state = await this.joinArena(mode, { baseUrl: serverBaseUrl(serverId) });
        if (state.serverId && String(state.serverId) !== String(serverId)) {
            throw new Error(`asked for ${serverId}, client joined ${state.serverId}`);
        }
        return state;
    }

    /* ---------------- FFA tier selection + Lobby roster ---------------- */

    /* A real click on a label; the game ignores element.click() for some overlays. */
    async clickLabel(text) {
        return this.evaluate(`(() => {
            const wanted = ${JSON.stringify(String(text))};
            const item = [...document.querySelectorAll('button, [role="button"], a, div, span')]
                .find(element => (element.innerText || '').trim() === wanted);
            if (!item) return false;
            item.click();
            return true;
        })()`).catch(() => false);
    }

    /* Open the in-game pause menu (bottom-right corner) and its Settings tab. */
    async openSettingsMenu() {
        await this.send('Page.bringToFront', {}, 5_000).catch(() => {});
        const size = JSON.parse(await this.evaluate('JSON.stringify({ w: innerWidth, h: innerHeight })'));
        const x = Math.max(1, Number(size?.w) - 16);
        const y = Math.max(1, Number(size?.h) - 21);
        for (const params of [
            { type: 'mouseMoved', x, y, button: 'none' },
            { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 },
            { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }
        ]) {
            await this.send('Input.dispatchMouseEvent', params, 5_000).catch(() => {});
        }
        await sleep(800);
        const opened = await this.clickLabel('Settings');
        await sleep(800);
        return opened;
    }

    async closeSettingsMenu() {
        const size = JSON.parse(await this.evaluate('JSON.stringify({ w: innerWidth, h: innerHeight })'));
        const x = Math.max(1, Number(size?.w) - 14);
        const y = 17;
        for (const params of [
            { type: 'mouseMoved', x, y, button: 'none' },
            { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 },
            { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }
        ]) {
            await this.send('Input.dispatchMouseEvent', params, 5_000).catch(() => {});
        }
        await sleep(600);
        await this.clickLabel('Resume');
        await sleep(600);
    }

    /* The settings select is a public list of every server/tier and its live count. */
    async readTierOptions() {
        const read = () => this.evaluate(`(() => {
            const options = [];
            for (const select of document.querySelectorAll('select')) {
                for (const option of select.options) {
                    const match = /^Cloud\\/(\\d+)\\/public\\/([^/]+)\\/(0|A|B)$/.exec(option.value);
                    if (!match) continue;
                    const online = /\\((\\d+)\\s+online\\)/i.exec(option.textContent || '');
                    options.push({
                        serverId: 'Cloud/' + match[1],
                        mode: match[2],
                        tier: match[3],
                        value: option.value,
                        online: online ? Number(online[1]) : null
                    });
                }
            }
            return JSON.stringify(options);
        })()`).catch(() => null);
        const parse = raw => {
            try {
                return JSON.parse(raw) || [];
            } catch {
                return [];
            }
        };

        let options = parse(await read());
        if (!options.length && await this.openSettingsMenu()) {
            options = parse(await read());
            await this.closeSettingsMenu().catch(() => {});
        }
        return options;
    }

    async switchTier(serverId, tier) {
        const value = `${serverId}/public/FFA/${tier}`;
        const selected = await this.evaluate(`(() => {
            const value = ${JSON.stringify(value)};
            for (const select of document.querySelectorAll('select')) {
                const option = [...select.options].find(candidate => candidate.value === value);
                if (!option) continue;
                select.value = value;
                select.dispatchEvent(new Event('input', { bubbles: true }));
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return JSON.stringify({ value: select.value, text: option.textContent });
            }
            return null;
        })()`).catch(() => null);
        return selected ? JSON.parse(selected) : null;
    }

    async readArenaQuery() {
        return this.evaluate(`sessionStorage.getItem('arenaQuery')`).catch(() => null);
    }

    async readLocalAlias() {
        return this.evaluate(`sessionStorage.getItem('randomGuestAlias')`).catch(() => null);
    }

    /*
     * Switch this client to one FFA tier and wait until it is really there.
     * Entry needs no switch after joinServer(); A/B go through the settings
     * select, then the death screen, so the query is checked before reading.
     */
    async enterTier(serverId, tier) {
        const wantedTier = String(tier);
        if (wantedTier !== '0') {
            if (!(await this.openSettingsMenu())) {
                throw new Error('The in-game settings did not open.');
            }
            const selected = await this.switchTier(serverId, wantedTier);
            if (!selected) {
                await this.closeSettingsMenu().catch(() => {});
                throw new Error(`${serverId}/FFA/${wantedTier} is not in the server list.`);
            }
            await this.closeSettingsMenu();
            await sleep(1_000);
        }

        let state = await this.readPlayState();
        if (!state || state.dead || wantedTier !== '0') {
            await this.respawn(30_000);
            await sleep(1_000);
            state = await this.readPlayState();
        }

        const expected = new RegExp(`/s${wantedTier}\\.`, 'i');
        let query = await this.readArenaQuery();
        for (let attempt = 0; attempt < 20 && !(query && expected.test(query)); attempt += 1) {
            await sleep(500);
            query = await this.readArenaQuery();
        }
        if (!query || !expected.test(query)) {
            throw new Error(`The client did not land in ${serverId}/FFA/${wantedTier} (arena ${query || 'unknown'}).`);
        }
        return { state, arenaQuery: query };
    }

    /*
     * The Lobby Players list is the per-scene roster. The server-wide HUD is
     * not a substitute: it merges every tier. This tab also includes a few
     * chat/global names; filterTierRosters() drops names seen in two tiers.
     */
    async readLobbyNames() {
        if (!(await this.openSettingsMenu())) {
            throw new Error('The in-game settings did not open.');
        }
        const opened = await this.clickLabel('Lobby');
        await sleep(800);
        const raw = opened ? await this.evaluate(`(() => {
            const dialog = document.getElementById('dialog_content');
            if (!dialog) return null;
            const heading = [...dialog.querySelectorAll('h2')]
                .find(element => (element.innerText || '').trim().startsWith('Players'));
            if (!heading) return null;
            const block = heading.parentElement;
            return JSON.stringify([...block.querySelectorAll('span.name')].map(span => {
                const inner = span.querySelector(':scope > span:last-child');
                return (inner ? inner.innerText : span.innerText).trim();
            }));
        })()`).catch(() => null) : null;
        await this.closeSettingsMenu().catch(() => {});
        try {
            return JSON.parse(raw) || [];
        } catch {
            return [];
        }
    }

    /*
     * Read one live board. Cards are optional on purpose: the board itself is
     * what refreshes every cycle, and clicking ten profiles can cost a minute.
     * `cards: 'tracked'` clicks only tracked enemies, `'all'` clicks the board.
     */
    async boardRows(state, mode, {
        cards = 'none',
        cardLimit = Infinity,
        cardBudgetMs = 60_000,
        tracked = [],
        cardOffset = 0
    } = {}) {
        const name = serverName(state.serverId, state.hudName);
        let cardNames = null;
        if (cards === 'tracked') {
            cardNames = state.rows
                .filter(row => tracked.some(trackedName => nameMatches(trackedName, row.name)))
                .map(row => row.name);
        } else if (cards === 'all') {
            cardNames = state.rows.map(row => row.name);
            /* The card pass rolls down the board instead of re-clicking the
             * same top rows every ten minutes. */
            const start = cardNames.length
                ? Math.max(0, Math.floor(Number(cardOffset) || 0)) % cardNames.length
                : 0;
            if (start) cardNames = [...cardNames.slice(start), ...cardNames.slice(0, start)];
        }
        if (!cardNames?.length) return state.rows;

        const briefs = await this.readBoardBriefs(cardNames, { budgetMs: cardBudgetMs, limit: cardLimit })
            .catch(error => {
                console.warn(`Netquel ${mode}: profile cards unavailable on ${name} — ${error.message}`);
                return new Map();
            });
        return state.rows.map(row => {
            const brief = briefs.get(normalizeName(row.name));
            return brief ? { ...row, brief } : row;
        });
    }

    /*
     * One server board on demand. The card pass uses this so it can hand the
     * browser queue back to a due board pass between servers instead of
     * holding it for a whole six-board sweep.
     */
    async readServerBoard(mode, serverId, options = {}) {
        const reloader = getSweepReloader();
        const page = await reloader.ensurePage();
        try {
            const state = await page.joinServer(mode, serverId);
            return {
                ...serverBoard(
                    mode,
                    serverName(state.serverId, state.hudName),
                    toServerRows(await page.boardRows(state, mode, options)),
                    state.serverId
                ),
                fetchedAt: Date.now()
            };
        } finally {
            await reloader.park();
        }
    }

    /*
     * Direct path: one page load per server, no match flight. The numbered
     * host pins its server, and joinServer throws if the client lands elsewhere,
     * so a partial failure falls back to the wall-hop path instead of filing a
     * board under the wrong server.
     */
    async collectServerBoards(mode, servers = DEFAULT_SERVER_COUNT, options = {}) {
        const wanted = Array.isArray(servers) ? servers.filter(Boolean) : [];
        if (wanted.length && DIRECT_SERVERS) {
            const boards = [];
            const errors = [];
            for (const serverId of wanted) {
                let state = null;
                try {
                    state = await this.joinServer(mode, serverId);
                } catch (error) {
                    errors.push(`${serverId}: ${error.message}`);
                    continue;
                }
                const board = {
                    serverId: state.serverId,
                    server: serverName(state.serverId, state.hudName),
                    rows: await this.boardRows(state, mode, options)
                };
                boards.push(board);
                options.onBoard?.(board);
            }
            if (boards.length) {
                if (errors.length) {
                    console.warn(`Netquel ${mode}: direct server join missed — ${errors.join(' | ')}`);
                }
                return boards;
            }
            console.warn(
                `Netquel ${mode}: direct server joins failed, falling back to wall hops — ${errors.join(' | ')}`
            );
        }

        return this.collectServerBoardsByHop(
            mode,
            Array.isArray(servers) ? (servers.length || DEFAULT_SERVER_COUNT) : (Number(servers) || DEFAULT_SERVER_COUNT),
            options
        );
    }

    async collectServerBoardsByHop(mode, targetCount = DEFAULT_SERVER_COUNT, options = {}) {
        let state = await this.joinArena(mode);

        const boards = new Map();
        const wanted = Math.min(Math.max(1, targetCount), MAX_SERVER_HOPS);
        console.log(`Netquel ${mode}: in a live arena, reading ${wanted} server board(s)…`);
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
                await sleep(600); // let the board finish animating in
                const board = {
                    serverId: state.serverId,
                    server: name,
                    rows: await this.boardRows(state, mode, options)
                };
                boards.set(state.serverId, board);
                options.onBoard?.(board);
            }
            if (boards.size >= wanted) break;
            const next = await this.waitForServerHop(state.serverId);
            if (!next) break;
            state = next;
        }

        console.log(
            `Netquel ${mode}: server boards read — `
            + ([...boards.values()].map(entry => `${entry.server} (${entry.rows.length})`).join(', ') || 'none')
            + '.'
        );

        return [...boards.values()];
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        /* A tab attached to a shared browser closes only itself. */
        if (!this.child && this.targetId && this.owner?.port) {
            try {
                await fetch(`http://127.0.0.1:${this.owner.port}/json/close/${this.targetId}`, { method: 'PUT' });
            } catch {
                // The browser may already be gone.
            }
        }
        try {
            this.socket.close();
        } catch {
            // Ignore: the socket may already be gone.
        }
        if (this.child) {
            try {
                this.child.kill('SIGKILL');
            } catch {
                // Ignore.
            }
        }
        /* A shared page's profile outlives it; its owner removes it on shutdown. */
        if (this.keepProfile) return;
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

/*
 * The site's day/week/all tables live in one warm browser.
 *
 * The old path launched a browser, downloaded the WASM client into a fresh
 * temp profile, rendered, and killed all of it — every mode, every tick. That
 * measured 3.5s of launch plus 7.3s of cold render; the same page reloads in
 * 0.9-1.5s once the profile is warm. So one visible tab stays up, the modes
 * take turns on it, and a hung navigation is recovered instead of being fatal.
 *
 * One tab only, on purpose: Chrome freezes a background tab, and a frozen tab
 * never paints the tables (a second tab measured as never rendering at all).
 */
/*
 * Resident live boards.
 *
 * A sweep pays a page load, a WASM boot, a Play click and an arena wait for
 * every board on every pass. A resident tab joins once and then only reads the
 * HUD, so a refresh is a DOM read. One Chrome hosts every tab. Chrome stops
 * native rAF for hidden tabs, so each page gets a timer-driven frame loop and
 * a forced-visible document before the client boots; otherwise only the
 * foreground tab's HUD advances. The HUD is pushed through a page binding as
 * it mutates, with a slow poll as a fallback.
 */
class ResidentBoards {
    constructor({
        modes = MODES,
        serverIds = [],
        limit = 6,
        pollMs = RESIDENT_POLL_MS,
        fps = RESIDENT_FPS,
        publishMs = 30_000,
        healthMs = RESIDENT_HEALTH_MS,
        onBoard = null,
        launchBrowser = null,
        onError = null
    } = {}) {
        this.modes = [...modes].filter(Boolean);
        this.serverIds = [...serverIds].filter(Boolean);
        this.limit = Math.max(1, Math.floor(Number(limit) || 6));
        this.pollMs = Math.max(500, Math.round(Number(pollMs) || RESIDENT_POLL_MS));
        const frameRate = Number(fps);
        this.fps = Number.isFinite(frameRate) ? Math.max(0, Math.min(60, Math.round(frameRate))) : RESIDENT_FPS;
        const heartbeatMs = Number(publishMs);
        this.publishMs = Number.isFinite(heartbeatMs) && heartbeatMs >= 0 ? Math.round(heartbeatMs) : 30_000;
        this.healthMs = Math.max(5_000, Math.round(Number(healthMs) || RESIDENT_HEALTH_MS));
        this.onBoard = onBoard;
        this.onError = typeof onError === 'function' ? onError : null;
        this.launchBrowser = launchBrowser;
        this.browser = null;
        this.launching = null;
        this.tabs = new Map();
        this.healthTimer = null;
        this.healthInFlight = null;
        this.respawnQueue = Promise.resolve();
        this.startTimer = null;
        this.starting = false;
        this.startPromise = null;
        this.stopped = false;
        this.failures = 0;
        this.nextLaunchAt = 0;
        this.stats = { startedAt: Date.now(), boards: 0, reads: 0, errors: 0, rejoins: 0 };
    }

    get running() {
        return Boolean(this.browser?.alive);
    }

    report(message, level = 'warn') {
        if (this.onError) {
            this.onError(message, level);
            return;
        }
        console[level](message);
    }

    entries() {
        const list = [];
        for (const mode of this.modes) {
            for (const serverId of this.serverIds) list.push({ mode, serverId });
        }
        return list.slice(0, this.limit);
    }

    summary() {
        const seconds = Math.max(1, Math.round((Date.now() - this.stats.startedAt) / 1000));
        return {
            ...this.stats,
            seconds,
            readsPerSecond: Number((this.stats.reads / seconds).toFixed(2)),
            liveTabs: [...this.tabs.values()].filter(slot => slot.ready && slot.page?.alive).length
        };
    }

    scheduleStart(delayMs) {
        if (this.stopped || this.startTimer) return;
        this.startTimer = setTimeout(() => {
            this.startTimer = null;
            this.start().catch(error => {
                this.report(`Netquel resident boards retry failed: ${error.message}`);
            });
        }, Math.max(1_000, delayMs));
        if (typeof this.startTimer.unref === 'function') this.startTimer.unref();
    }

    async start() {
        if (this.stopped) return this.summary();
        if (this.starting) return this.startPromise;
        this.starting = true;
        this.startPromise = (async () => {
            try {
                if (!this.serverIds.length) this.serverIds = await knownServers();
                if (!this.serverIds.length) {
                    throw new Error('Netquel did not advertise any Cloud servers.');
                }
                await this.ensureBrowser();
                for (const entry of this.entries()) {
                    if (this.stopped) break;
                    try {
                        await this.ensureTab(entry);
                    } catch (error) {
                        this.stats.errors += 1;
                        this.report(`Netquel resident ${entry.mode} ${entry.serverId} unavailable: ${error.message}`);
                    }
                }
                this.armHealth();
                return this.summary();
            } catch (error) {
                this.failures += 1;
                this.scheduleStart(Math.min(30_000 * this.failures, 5 * 60_000));
                throw error;
            } finally {
                this.starting = false;
            }
        })();
        return this.startPromise;
    }

    async ensureBrowser() {
        if (this.browser?.alive) return this.browser;
        if (this.launching) return this.launching;
        const wait = this.nextLaunchAt - Date.now();
        if (wait > 0) {
            throw new Error(`The resident browser is backing off (${Math.ceil(wait / 1000)}s).`);
        }

        this.launching = (async () => {
            try {
                const page = this.launchBrowser
                    ? await this.launchBrowser({ profileDir: RESIDENT_PROFILE_DIR, keepProfile: true })
                    : await ChromePage.launch({ profileDir: RESIDENT_PROFILE_DIR, keepProfile: true });
                await page.send('Emulation.setDeviceMetricsOverride', {
                    width: 900,
                    height: 600,
                    deviceScaleFactor: 1,
                    mobile: false
                }, 5_000).catch(() => {});
                this.browser = page;
                this.failures = 0;
                this.nextLaunchAt = 0;
                return page;
            } catch (error) {
                this.failures += 1;
                this.nextLaunchAt = Date.now() + Math.min(30_000 * this.failures, 5 * 60_000);
                throw error;
            } finally {
                this.launching = null;
            }
        })();
        return this.launching;
    }

    async ensureTab({ mode, serverId }, { force = false } = {}) {
        if (this.stopped || !mode || !serverId) return null;
        const key = `${mode}|${serverId}`;
        let slot = this.tabs.get(key);

        /*
         * One join per tab. A health tick, a rejoin timer and a manual repair
         * used to race here and close each other's tabs, which looked like the
         * client refusing every arena.
         */
        if (slot?.joining) return slot.joining;

        /*
         * A scheduled rejoin must actually reopen the tab. The old path took
         * the "ready" branch here, re-read the same deaf page and reported
         * success, so a tab whose process stayed up but stopped answering was
         * flagged every health tick and never repaired.
         */
        if (!force && slot?.ready && slot.page?.alive) {
            this.emit(slot, await slot.page.readPlayState().catch(() => null));
            return slot;
        }
        if (slot && Date.now() < (slot.nextTry ?? 0)) return null;

        if (!slot) {
            slot = {
                key,
                mode,
                serverId,
                page: null,
                timer: null,
                ready: false,
                joining: null,
                failures: 0,
                nextTry: 0,
                rejoinAt: 0,
                signature: null,
                seenRows: false,
                emptyReads: 0,
                polling: false,
                respawnAt: 0,
                respawning: false,
                lastOnBoardAt: 0,
                server: null,
                lastRowsAt: 0
            };
            this.tabs.set(key, slot);
        }

        slot.joining = this.openTab(slot).finally(() => { slot.joining = null; });
        return slot.joining;
    }

    async openTab(slot) {
        const { mode, serverId } = slot;
        if (this.stopped) return null;
        if (slot.page) await slot.page.close().catch(() => {});
        slot.page = null;
        slot.ready = false;
        slot.emptyReads = 0;
        if (slot.timer) {
            clearInterval(slot.timer);
            slot.timer = null;
        }

        const browser = await this.ensureBrowser();
        const page = await browser.createTab('about:blank', {
            onBinding: params => this.handlePush(slot, params)
        });
        slot.page = page;
        if (this.stopped) {
            await page.close().catch(() => {});
            slot.page = null;
            return null;
        }
        try {
            /*
             * Chrome throttles a background tab's input and paint. Every join
             * is therefore driven in the foreground; once it is in an arena
             * the tab can go back to the background and keep streaming.
             */
            await page.send('Page.bringToFront', {}, 5_000).catch(() => {});
            /*
             * The client captures requestAnimationFrame when it boots, so the
             * shim has to be installed before the navigation. Applying it after
             * the join only wraps a function the game no longer calls. It also
             * makes a hidden tab look visible; Chrome otherwise stops its rAF
             * and the HUD scores freeze while another tab is in front.
             */
            await page.send('Page.addScriptToEvaluateOnNewDocument', {
                source: residentFrameScript(this.fps)
            }, 5_000).catch(() => {});
            await page.send('Runtime.addBinding', { name: 'netquelBoardPush' }, 8_000).catch(() => {});
            const state = await page.joinServer(mode, serverId);
            if (!state?.serverId || !state.rows?.length) {
                throw new Error('the client joined without a live board');
            }
            /* Fallback for a page that was already loaded before the shim. */
            await page.evaluate(residentFrameScript(this.fps)).catch(() => {});
            /* The join navigates the tab; make sure the binding survived it. */
            await page.send('Runtime.addBinding', { name: 'netquelBoardPush' }, 8_000).catch(() => {});
            const installed = await page.evaluate(HUD_OBSERVER_SCRIPT).catch(error => {
                this.report(`Netquel resident ${mode} ${serverId}: HUD observer unavailable (${error.message}); polling only.`);
                return null;
            });
            slot.ready = true;
            slot.joinedAt = Date.now();
            slot.lastRowsAt = slot.joinedAt;
            slot.failures = 0;
            slot.server = serverName(state.serverId, state.hudName);
            /* A fresh join is a fresh read; publish it even if it matches
             * the board the previous tab left behind. */
            slot.lastOnBoardAt = 0;
            this.emit(slot, state);

            slot.timer = setInterval(() => {
                this.poll(slot).catch(() => {});
            }, this.pollMs);
            if (typeof slot.timer.unref === 'function') slot.timer.unref();

            this.stats.boards += 1;
            this.report(
                `Netquel resident ${mode} ${slot.server}: ${state.rows.length} row(s)`
                + `${installed === 'installed' || installed === 'already' ? ' · push on' : ' · polling'}`,
                'log'
            );
            return slot;
        } catch (error) {
            slot.failures += 1;
            slot.nextTry = Date.now() + Math.min(10_000 * slot.failures, 120_000);
            await page.close().catch(() => {});
            slot.page = null;
            throw error;
        }
    }

    handlePush(slot, params) {
        if (this.stopped || params?.name !== 'netquelBoardPush' || typeof params.payload !== 'string') return;
        let state = null;
        try {
            state = JSON.parse(params.payload);
        } catch {
            return;
        }
        this.emit(slot, state);
    }

    emit(slot, state) {
        if (this.stopped || !slot || !state) return;
        const rows = Array.isArray(state.rows) ? state.rows : [];
        this.stats.reads += 1;

        if (!state.serverId) {
            this.scheduleRejoin(slot, 'the client is not in an arena');
            return;
        }
        if (String(state.serverId) !== String(slot.serverId)) {
            this.scheduleRejoin(slot, `the client is on ${state.serverId}`);
            return;
        }
        /* A destroyed tab is not a quiet board; it has to play again. */
        if (state.dead) {
            this.scheduleRespawn(slot, 'the match ended');
            return;
        }
        /* An empty table is a repaint, not an empty server: the bot is on it. */
        if (!rows.length) return;

        const server = serverName(state.serverId, state.hudName);
        const signature = boardSignature(rows, state.serverId);
        const now = Date.now();
        const changed = signature !== slot.signature;
        /*
         * The poll is 2s, but a quiet server has no rows to change. Every
         * `publishMs` the board is reported again with a fresh fetchedAt so
         * the embed's Updated stamp means "last read", not "last score".
         */
        const due = now - (slot.lastOnBoardAt ?? 0) >= this.publishMs;
        slot.lastRowsAt = now;
        if (!changed && !due) return;
        if (changed) {
            slot.signature = signature;
            slot.seenRows = true;
            slot.server = server;
        }
        slot.lastOnBoardAt = now;

        const board = {
            ...serverBoard(slot.mode, server, toServerRows(rows), state.serverId),
            fetchedAt: now
        };
        try {
            this.onBoard?.(board);
        } catch (error) {
            this.report(`Netquel resident ${slot.mode} ${server} board handler failed: ${error.message}`);
        }
    }

    /*
     * The death screen persists until Play Again is clicked, so the poll sees
     * it every 2s; the guard keeps that from starting a respawn storm.
     */
    scheduleRespawn(slot, reason) {
        if (this.stopped || !slot?.ready || slot.respawning) return;
        const now = Date.now();
        if (slot.respawnAt && now < slot.respawnAt) return;
        slot.respawnAt = now + 5_000;
        this.report(`Netquel resident ${slot.mode} ${slot.server || slot.serverId}: ${reason}; respawning in 5s.`);
        const timer = setTimeout(() => {
            slot.respawnAt = 0;
            slot.respawning = true;
            /* One foreground click at a time: six tabs dying together would
             * otherwise steal each other's focus mid-respawn. */
            this.respawnQueue = this.respawnQueue
                .then(() => this.respawn(slot))
                .catch(error => {
                    this.stats.errors += 1;
                    this.report(`Netquel resident ${slot.mode} ${slot.serverId} respawn failed: ${error.message}; rejoining.`);
                    return this.ensureTab({ mode: slot.mode, serverId: slot.serverId }, { force: true }).catch(fail => {
                        this.stats.errors += 1;
                        this.report(`Netquel resident ${slot.mode} ${slot.serverId} rejoin failed: ${fail.message}`);
                    });
                })
                .finally(() => { slot.respawning = false; });
        }, 5_000);
        if (typeof timer.unref === 'function') timer.unref();
    }

    async respawn(slot) {
        if (this.stopped || !slot?.ready || !slot.page?.alive) return;
        const current = await slot.page.readPlayState().catch(() => null);
        /* A queued respawn can arrive after the client already recovered. */
        if (current && !current.dead && current.rows?.length) {
            if (String(current.serverId) === String(slot.serverId)) return current;
            throw new Error(`the client is on ${current.serverId}`);
        }

        const state = await slot.page.respawn().catch(() => null);
        if (!state?.serverId || !state.rows?.length || state.dead) {
            throw new Error('the client did not return to an arena');
        }
        if (String(state.serverId) !== String(slot.serverId)) {
            throw new Error(`the client respawned on ${state.serverId}`);
        }
        /* Force one publish so the embed's age reflects the new match. */
        slot.signature = null;
        slot.emptyReads = 0;
        slot.server = serverName(state.serverId, state.hudName);
        slot.lastRowsAt = Date.now();
        slot.lastOnBoardAt = 0;
        this.stats.rejoins += 1;
        this.emit(slot, state);
        this.report(`Netquel resident ${slot.mode} ${slot.server}: respawned (${state.rows.length} row(s))`, 'log');
    }

    async poll(slot) {
        if (this.stopped || !slot?.page?.alive) return;
        /*
         * A busy renderer can hold one read for the full 20s CDP deadline.
         * The 2s interval used to start another read on top of it, so a slow
         * tab piled up evaluations and starved itself into a rejoin.
         */
        if (slot.polling) return;
        slot.polling = true;
        try {
            const state = await slot.page.readPlayState().catch(() => null);
            if (!state) {
                slot.emptyReads = (slot.emptyReads ?? 0) + 1;
                if (slot.emptyReads >= 3) this.scheduleRejoin(slot, 'the HUD stopped answering');
                return;
            }
            slot.emptyReads = 0;

            this.emit(slot, state);
        } finally {
            slot.polling = false;
        }
    }

    scheduleRejoin(slot, reason) {
        if (this.stopped || !slot?.ready) return;
        const now = Date.now();
        if (slot.rejoinAt && now < slot.rejoinAt) return;
        slot.rejoinAt = now + 5_000;
        this.stats.rejoins += 1;
        this.report(`Netquel resident ${slot.mode} ${slot.serverId}: ${reason}; rejoining in 5s.`);
        const timer = setTimeout(() => {
            slot.rejoinAt = 0;
            this.ensureTab({ mode: slot.mode, serverId: slot.serverId }, { force: true }).catch(error => {
                this.stats.errors += 1;
                this.report(`Netquel resident ${slot.mode} ${slot.serverId} rejoin failed: ${error.message}`);
            });
        }, 5_000);
        if (typeof timer.unref === 'function') timer.unref();
    }

    armHealth() {
        if (this.healthTimer) clearInterval(this.healthTimer);
        this.healthTimer = setInterval(() => {
            this.checkHealth().catch(error => {
                this.report(`Netquel resident health check failed: ${error.message}`);
            });
        }, this.healthMs);
        if (typeof this.healthTimer.unref === 'function') this.healthTimer.unref();
    }

    async checkHealth() {
        if (this.stopped) return;
        /* The interval must never overlap itself; a join can take ~15s. */
        if (this.healthInFlight) return this.healthInFlight;
        this.healthInFlight = this.runHealthCheck().finally(() => {
            this.healthInFlight = null;
        });
        return this.healthInFlight;
    }

    async runHealthCheck() {
        if (!this.running) {
            for (const slot of this.tabs.values()) {
                slot.ready = false;
                slot.page = null;
                if (slot.timer) clearInterval(slot.timer);
                slot.timer = null;
            }
            await this.start();
            return;
        }

        for (const entry of this.entries()) {
            if (this.stopped) return;
            const slot = this.tabs.get(`${entry.mode}|${entry.serverId}`);
            if (!slot?.ready || !slot.page?.alive) {
                try {
                    await this.ensureTab(entry);
                } catch (error) {
                    this.stats.errors += 1;
                    this.report(`Netquel resident ${entry.mode} ${entry.serverId} repair failed: ${error.message}`);
                }
                continue;
            }

            const responsive = await this.pageResponds(slot);
            if (!responsive) {
                this.scheduleRejoin(slot, 'the tab stopped answering');
                continue;
            }
            const state = await slot.page.readPlayState().catch(() => null);
            /* A failed read is the poll's three-strike path, not proof the
             * client left: the renderer may just be mid-repaint. */
            if (!state) continue;
            if (!state.serverId) {
                this.scheduleRejoin(slot, 'the client left the arena');
                continue;
            }
            this.emit(slot, state);
        }
    }

    /* One busy frame must not cost a fresh 13s join. */
    async pageResponds(slot) {
        for (let attempt = 0; attempt < BROWSER_PING_ATTEMPTS; attempt += 1) {
            if (attempt > 0) await sleep(BROWSER_PING_RETRY_MS);
            if (!slot?.page?.alive) return false;
            if (await slot.page.ping(BROWSER_PING_TIMEOUT_MS).catch(() => false)) return true;
        }
        return false;
    }

    async stop() {
        this.stopped = true;
        if (this.healthTimer) clearInterval(this.healthTimer);
        this.healthTimer = null;
        if (this.startTimer) clearTimeout(this.startTimer);
        this.startTimer = null;

        for (const slot of this.tabs.values()) {
            if (slot.timer) clearInterval(slot.timer);
            slot.timer = null;
            slot.ready = false;
            if (slot.page) await slot.page.close().catch(() => {});
            slot.page = null;
        }
        this.tabs.clear();

        const browser = this.browser;
        this.browser = null;
        if (browser) await browser.close().catch(() => {});

        /* The profile is only a cache; the next boot pays one cold join. */
        if (!this.launchBrowser) {
            try {
                fs.rmSync(RESIDENT_PROFILE_DIR, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
            } catch {
                // The OS reaps it eventually.
            }
        }
    }
}

let residentBoards = null;

function startResidentBoards(options = {}) {
    if (residentBoards) return residentBoards;
    const pool = new ResidentBoards(options);
    residentBoards = pool;
    pool.start().catch(error => {
        pool.report(`Netquel resident boards failed to start: ${error.message}`);
    });
    return pool;
}

function getResidentBoards() {
    return residentBoards;
}

async function closeResidentBoards() {
    const pool = residentBoards;
    residentBoards = null;
    if (pool) await pool.stop().catch(() => {});
}

class SiteReloader {
    constructor(profileDir = SITE_PROFILE_DIR) {
        this.profileDir = profileDir;
        this.page = null;
        this.launching = null;
        this.failures = 0;
        this.nextLaunchAt = 0;
        this.docId = null;
    }

    get running() {
        return Boolean(this.page?.alive);
    }

    /* Start the browser ahead of the first tick so tick #1 is warm as well. */
    warm() {
        return this.ensurePage();
    }

    async ensurePage() {
        if (this.running) return this.page;
        if (this.launching) return this.launching;
        const wait = this.nextLaunchAt - Date.now();
        if (wait > 0) {
            throw new Error(
                `The site browser is backing off after a failed start (${Math.ceil(wait / 1000)}s).`
            );
        }

        this.launching = (async () => {
            try {
                const page = await this.launch();
                this.failures = 0;
                this.nextLaunchAt = 0;
                return page;
            } catch (error) {
                this.failures += 1;
                this.nextLaunchAt = Date.now()
                    + Math.min(SITE_LAUNCH_BACKOFF_MS * this.failures, SITE_LAUNCH_BACKOFF_MAX_MS);
                throw error;
            } finally {
                this.launching = null;
            }
        })();
        return this.launching;
    }

    async launch() {
        let page;
        try {
            page = await ChromePage.launch({ profileDir: this.profileDir, keepProfile: true });
        } catch (error) {
            /*
             * A profile left half-written by a crash can keep Chrome from
             * starting at all. It is only a cache, so drop it once and retry.
             */
            console.warn(`Netquel site browser: rebuilding a stale profile (${error.message}).`);
            fs.rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
            page = await ChromePage.launch({ profileDir: this.profileDir, keepProfile: true });
        }

        /* Installed once; every new document stamps itself with a fresh id. */
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: DOC_ID_SCRIPT }).catch(() => {});
        this.page = page;
        this.docId = null;
        return page;
    }

    async restart(reason) {
        const page = this.page;
        this.page = null;
        this.docId = null;
        if (page) await page.close().catch(() => {});
        console.warn(`Netquel site browser restarting — ${reason}.`);
    }

    /* The tables for one mode, reloaded on the warm page. */
    async readMode(mode) {
        const page = await this.ensurePage();
        try {
            return await this.navigateAndRead(page, mode);
        } catch (error) {
            /* A hung navigation usually leaves a stuck loader: stop it, reload. */
            await page.send('Page.stopLoading').catch(() => {});
            try {
                return await this.navigateAndRead(page, mode, { reload: true });
            } catch (retryError) {
                await this.restart(`${mode} site tables would not render (${retryError.message})`);
                const fresh = await this.ensurePage();
                return this.navigateAndRead(fresh, mode);
            }
        }
    }

    async navigateAndRead(page, mode, { reload = false } = {}) {
        const before = this.docId;
        if (reload) {
            await page.send('Page.reload', { ignoreCache: false }, SITE_NAVIGATE_TIMEOUT_MS);
        } else {
            const result = await page.send(
                'Page.navigate',
                { url: `${BASE_URL}/${mode}/leaderboard/` },
                SITE_NAVIGATE_TIMEOUT_MS
            );
            if (result?.errorText && result.errorText !== 'net::ERR_ABORTED') {
                throw new Error(`Page.navigate failed: ${result.errorText}`);
            }
        }

        const deadline = Date.now() + SITE_RENDER_DEADLINE_MS;
        let unsupported = false;
        let lastError = null;
        while (Date.now() < deadline) {
            const raw = await page.evaluate(EXTRACT_SITE_TABLES).catch(error => {
                lastError = error;
                return null;
            });
            if (raw) {
                let parsed = null;
                try {
                    parsed = JSON.parse(raw);
                } catch {
                    parsed = null;
                }
                /*
                 * Without the guard script (an older document) the id is
                 * unknown, so a first read is accepted and later ones are not.
                 */
                const fresh = parsed ? (parsed.docId ? parsed.docId !== before : before === null) : false;
                if (fresh) {
                    if (parsed.unsupported) unsupported = true;
                    const { day, week, all } = parsed.tables || {};
                    if (day?.length && week?.length && all?.length) {
                        this.docId = parsed.docId ?? null;
                        return parsed.tables;
                    }
                }
            }
            await sleep(SITE_POLL_MS);
        }

        if (unsupported) {
            throw new Error(
                'The Netquel client reported "WebGL2 unsupported" in this browser, so no '
                + 'leaderboard could be rendered.'
            );
        }
        throw new Error(
            `Timed out waiting for the ${mode} site tables to render`
            + `${lastError ? ` (${lastError.message})` : ''}.`
        );
    }

    /*
     * The leaderboard page keeps the software-rendered client painting, which
     * measured nearly a full core while parked on it between daily reads. A
     * blank page keeps the process and its cache warm for zero render cost.
     */
    async park() {
        const page = this.page;
        if (!page?.alive) return;
        await page.send('Page.navigate', { url: 'about:blank' }, 5_000).catch(() => {});
    }

    async close() {
        const page = this.page;
        this.page = null;
        this.docId = null;
        if (page) await page.close().catch(() => {});
        /* The profile is a cache; it is only dropped when the tracker stops. */
        try {
            fs.rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        } catch {
            // The OS reaps it eventually.
        }
    }
}

/*
 * The in-game browser: the same lifecycle as the site one, one live tab,
 * parked on about:blank between sweeps. It is a separate Chrome on purpose —
 * the site tables and the game client are both software-rendered, and two
 * clients in one process starve each other.
 */
class SweepReloader {
    constructor(profileDir = SWEEP_PROFILE_DIR) {
        this.profileDir = profileDir;
        this.page = null;
        this.launching = null;
        this.failures = 0;
        this.nextLaunchAt = 0;
    }

    get running() {
        return Boolean(this.page?.alive);
    }

    /* Start it at boot so the first sweep does not pay a cold launch. */
    warm() {
        return this.ensurePage();
    }

    async ensurePage() {
        if (this.running) {
            /* A killed renderer can leave the process alive but deaf; a busy
             * one answers as soon as its current frame is done. */
            if (await this.responds()) return this.page;
            await this.restart('the page stopped answering');
        }
        if (this.launching) return this.launching;
        const wait = this.nextLaunchAt - Date.now();
        if (wait > 0) {
            throw new Error(
                `The game browser is backing off after a failed start (${Math.ceil(wait / 1000)}s).`
            );
        }

        this.launching = (async () => {
            try {
                const page = await this.launch();
                this.failures = 0;
                this.nextLaunchAt = 0;
                return page;
            } catch (error) {
                this.failures += 1;
                this.nextLaunchAt = Date.now()
                    + Math.min(SWEEP_LAUNCH_BACKOFF_MS * this.failures, SWEEP_LAUNCH_BACKOFF_MAX_MS);
                throw error;
            } finally {
                this.launching = null;
            }
        })();
        return this.launching;
    }

    async launch() {
        let page;
        try {
            page = await ChromePage.launch({ profileDir: this.profileDir, keepProfile: true });
        } catch (error) {
            /* A profile left half-written by a killed run is only a cache. */
            console.warn(`Netquel game browser: rebuilding a stale profile (${error.message}).`);
            fs.rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
            page = await ChromePage.launch({ profileDir: this.profileDir, keepProfile: true });
        }
        this.page = page;
        return page;
    }

    async restart(reason) {
        const page = this.page;
        this.page = null;
        if (page) await page.close().catch(() => {});
        console.warn(`Netquel game browser restarting — ${reason}.`);
    }

    async responds() {
        for (let attempt = 0; attempt < BROWSER_PING_ATTEMPTS; attempt += 1) {
            if (attempt > 0) await sleep(BROWSER_PING_RETRY_MS);
            if (!this.page?.alive) return false;
            if (await this.page.ping(BROWSER_PING_TIMEOUT_MS)) return true;
        }
        return false;
    }

    /* Leave the match between passes; the process and its cache stay warm. */
    async park() {
        const page = this.page;
        if (!page?.alive) return;
        await page.send('Page.navigate', { url: 'about:blank' }, 5_000).catch(() => {});
    }

    async close() {
        /* A shutdown during the boot warm-up must not leave a browser behind. */
        if (this.launching) await this.launching.catch(() => {});
        const page = this.page;
        this.page = null;
        if (page) await page.close().catch(() => {});
        /* The profile is a cache; it is only dropped when the tracker stops. */
        try {
            fs.rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        } catch {
            // The OS reaps it eventually.
        }
    }
}

let siteReloader = null;

function getSiteReloader() {
    if (!siteReloader) siteReloader = new SiteReloader();
    return siteReloader;
}

/* Kill the resident browser and its profile (tracker shutdown / fatal error). */
async function closeSiteReloader() {
    const reloader = siteReloader;
    siteReloader = null;
    if (reloader) await reloader.close().catch(() => {});
}

let sweepReloader = null;

function getSweepReloader() {
    if (!sweepReloader) sweepReloader = new SweepReloader();
    return sweepReloader;
}

/* Kill the resident game browser and its profile (tracker shutdown). */
async function closeSweepReloader() {
    const reloader = sweepReloader;
    sweepReloader = null;
    if (reloader) await reloader.close().catch(() => {});
}

/* The servers the client is currently offering (Cloud/2, Cloud/3, …). */
async function knownServers() {
    try {
        const response = await fetch(`${BASE_URL}/system.json`, { signal: AbortSignal.timeout(8000) });
        const data = await response.json();
        const servers = Array.isArray(data?.available_servers) ? data.available_servers : [];
        return servers
            .filter(serverId => /^Cloud\/\d+$/i.test(String(serverId)))
            .slice(0, MAX_SERVER_HOPS);
    } catch {
        return [];
    }
}

async function knownServerCount() {
    const servers = await knownServers();
    return servers.length ? servers.length : DEFAULT_SERVER_COUNT;
}

/* Cloud/4 -> https://4.netquel.com (the host pins that server). */
function serverBaseUrl(serverId) {
    const match = /^Cloud\/(\d+)$/i.exec(String(serverId ?? '').trim());
    if (!match) return BASE_URL;
    const url = new URL(BASE_URL);
    url.hostname = `${match[1]}.${url.hostname.replace(/^www\./, '')}`;
    return url.origin;
}

function directServersEnabled() {
    return DIRECT_SERVERS;
}

/*
 * The site publishes three tables per mode (day/week/all). The per-server
 * boards live only inside a live match: press Play and read the top-right
 * board, opening each numbered server host directly (wall hops are the fallback).
 */
async function scrapeMode(mode, serverIds) {
    const page = await ChromePage.launch();
    const boards = [];
    try {
        const tables = await page.readLeaderboard(mode);
        const siteFetchedAt = Date.now();
        for (const period of PERIODS) {
            boards.push({ mode, period, rows: toBoardRows(tables[period]), fetchedAt: siteFetchedAt });
        }

        /* A failed server read must not throw away the site boards we just read. */
        try {
            const servers = await page.collectServerBoards(mode, serverIds, { cards: 'all' });
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
 * wall, no hops — the warm browser reloads one mode at a time, so both modes
 * land in ~2.5-3s instead of paying a cold launch and cold render per mode.
 */
async function scrapeSiteBoards(modes = MODES) {
    const startedAt = Date.now();
    const reloader = getSiteReloader();
    const boards = [];
    const errors = [];
    try {
        for (const mode of modes) {
            try {
                const tables = await reloader.readMode(mode);
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
        /* Park between daily passes: the leaderboard page renders forever. */
        await reloader.park();
    }

    if (!boards.length && errors.length) throw new Error(errors.join(' | '));
    return { fetchedAt: Date.now(), boards, durationMs: Date.now() - startedAt, errors };
}

/* One server board on demand, so a card pass can yield between servers. */
async function readServerBoard(mode, serverId, options = {}) {
    const reloader = getSweepReloader();
    const page = await reloader.ensurePage();
    return page.readServerBoard(mode, serverId, options);
}

/*
 * Per-server boards. Each Cloud server has its own host, so a pass is one page
 * load per server instead of a match join plus two wall hops. The browser is
 * kept between passes and parked between matches.
 */
async function scrapeServerBoards(modes = MODES, options = {}) {
    const startedAt = Date.now();
    const serverIds = await knownServers();
    const reloader = getSweepReloader();
    const boards = [];
    const errors = [];

    for (const mode of modes) {
        const readMode = async page => {
            const servers = await page.collectServerBoards(mode, serverIds, {
                ...options,
                /* Emit one finished board at a time, so Discord can be edited
                 * before the rest of the pass has finished. */
                onBoard: entry => options.onBoard?.({
                    ...serverBoard(mode, entry.server, toServerRows(entry.rows), entry.serverId),
                    fetchedAt: Date.now()
                })
            });
            const fetchedAt = Date.now();
            return servers.map(entry => ({
                ...serverBoard(mode, entry.server, toServerRows(entry.rows), entry.serverId),
                fetchedAt
            }));
        };

        try {
            let page = await reloader.ensurePage();
            try {
                boards.push(...await readMode(page));
            } catch (error) {
                /* A browser killed mid-pass gets one fresh attempt. */
                if (page.alive) throw error;
                await reloader.restart(`${mode} browser died (${error.message})`);
                page = await reloader.ensurePage();
                boards.push(...await readMode(page));
            }
        } catch (error) {
            errors.push(`${mode}: ${error.message}`);
            console.warn(`Netquel ${mode} server boards failed:`, error.message);
        }
    }

    /* Leave the match; the browser and its cached client stay warm. */
    await reloader.park();

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
 * The direct path makes a board one page load per server. The wall-hop fallback
 * still pays the client's own teleport countdown (25-40s a hop, two per mode).
 */
async function scrapeBoards() {
    const startedAt = Date.now();
    const serverIds = await knownServers();
    const boards = [];
    const errors = [];

    for (const mode of MODES) {
        try {
            boards.push(...await scrapeMode(mode, serverIds));
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

/*
 * On-demand card refresh for a handful of names. The client drops you on
 * whichever server it likes, so joining one arena is not enough — a player
 * standing in Spiral is invisible from Zenith. This walks the mode's servers
 * with the same direct hosts the sweep uses (wall hops are the fallback), and
 * stops once every wanted name has been seen. Used by the staff commands so a card can be brought up to date
 * without waiting for the 10-minute sweep. It borrows the resident game
 * browser, which is parked between sweeps on its warm profile, so the pass
 * costs a reload instead of a cold launch and cold client render.
 */
async function refreshPlayerCards(names, modes = MODES) {
    const wanted = [...new Set((names || []).map(name => String(name ?? '').trim()).filter(Boolean))];
    const cards = [];
    const errors = [];
    const servers = [];
    if (!wanted.length) return { cards, errors, servers };

    const missing = () => wanted.filter(name => !cards.some(entry => nameMatches(name, entry.name)));
    const maxServers = await knownServerCount();

    /* The service's browser queue keeps this from running beside a sweep. */
    const reloader = getSweepReloader();
    const page = await reloader.ensurePage();
    try {
        for (const mode of modes) {
            if (!missing().length) break;
            try {
                /* One page load per server beats flying into every wall first. */
                const direct = DIRECT_SERVERS ? await knownServers() : [];
                if (direct.length) {
                    let joined = false;
                    let directFailures = 0;
                    for (const serverId of direct) {
                        if (!missing().length) break;
                        let state = null;
                        try {
                            state = await page.joinServer(mode, serverId);
                            joined = true;
                        } catch (error) {
                            directFailures += 1;
                            errors.push(`${mode}: ${serverId}: ${error.message}`);
                            continue;
                        }
                        const server = serverName(state.serverId, state.hudName);
                        servers.push(`${mode} · ${server}`);
                        const present = (state.rows || []).filter(row => missing().some(name => nameMatches(name, row.name)));
                        if (!present.length) continue;

                        const briefs = await page.readBoardBriefs(present.map(row => row.name));
                        for (const row of present) {
                            const card = briefs.get(normalizeName(row.name));
                            if (!card) continue;
                            cards.push({
                                name: row.name,
                                card,
                                mode,
                                server,
                                verified: Boolean(row.verified),
                                afk: Boolean(row.afk)
                            });
                        }
                    }
                    /* Every server answered and the name is not there; a hop
                     * would only re-read the same boards. Otherwise fall back. */
                    if (!missing().length || (joined && directFailures === 0)) continue;
                }

                let state = await page.joinArena(mode);
                const visited = new Set();
                for (let hop = 0; hop < maxServers && missing().length; hop += 1) {
                    if (!state?.serverId || visited.has(state.serverId)) break;
                    visited.add(state.serverId);

                    const server = serverName(state.serverId, state.hudName);
                    servers.push(`${mode} · ${server}`);
                    const present = (state.rows || []).filter(row => missing().some(name => nameMatches(name, row.name)));
                    if (present.length) {
                        const briefs = await page.readBoardBriefs(present.map(row => row.name));
                        for (const row of present) {
                            const card = briefs.get(normalizeName(row.name));
                            if (!card) continue;
                            cards.push({
                                name: row.name,
                                card,
                                mode,
                                server,
                                verified: Boolean(row.verified),
                                afk: Boolean(row.afk)
                            });
                        }
                    }
                    if (!missing().length) break;

                    const next = await page.waitForServerHop(state.serverId);
                    if (!next) break;
                    state = next;
                }
            } catch (error) {
                errors.push(`${mode}: ${error.message}`);
            }
        }
    } finally {
        /* Leave the match; the browser and its cached client stay warm. */
        await reloader.park();
    }
    return { cards, errors, servers };
}

/*
 * Live arena roster for one mode, used by staff checks. The target is usually
 * not on the server the client lands on, so this walks the servers too and
 * stops on the board where the name actually appears. Like the card refresh it
 * borrows the resident game browser instead of starting one, and parks it
 * afterwards.
 */
async function scrapeLive(mode, name = null, { signal } = {}) {
    const reloader = getSweepReloader();
    const page = await reloader.ensurePage();
    const checkCancelled = () => {
        if (signal?.aborted) throw new Error('Live check cancelled.');
    };
    try {
        /* Direct hosts: check every server without waiting out a wall hop. */
        const direct = DIRECT_SERVERS ? await knownServers() : [];
        if (direct.length) {
            let last = null;
            const directErrors = [];
            for (const serverId of direct) {
                checkCancelled();
                let state = null;
                try {
                    state = await page.joinServer(mode, serverId);
                } catch (error) {
                    directErrors.push(`${serverId}: ${error.message}`);
                    continue;
                }
                last = state;
                const server = serverName(state.serverId, state.hudName);
                const rows = toServerRows(state.rows || []);
                if (name) {
                    const target = (state.rows || []).find(row => nameMatches(name, row.name));
                    if (target) {
                        checkCancelled();
                        const briefs = await page.readBoardBriefs([target.name]);
                        return {
                            mode,
                            server,
                            rows,
                            card: briefs.get(normalizeName(target.name)) ?? null,
                            cardName: target.name
                        };
                    }
                } else {
                    return { mode, server, rows, card: null, cardName: null };
                }
            }
            /* A missing name could be on a server whose direct join failed,
             * so only trust the direct sweep when every server answered. */
            if (last && (!name || directErrors.length === 0)) {
                return {
                    mode,
                    server: serverName(last.serverId, last.hudName),
                    rows: toServerRows(last.rows || []),
                    card: null,
                    cardName: null
                };
            }
            console.warn(
                `Netquel ${mode}: direct live check incomplete, falling back to wall hops — ${directErrors.join(' | ')}`
            );
        }

        const maxServers = await knownServerCount();
        checkCancelled();
        let state = await page.joinArena(mode);
        const visited = new Set();
        let card = null;
        let cardName = null;
        let rows = toServerRows(state.rows || []);
        let server = serverName(state.serverId, state.hudName);

        for (let hop = 0; hop < maxServers; hop += 1) {
            checkCancelled();
            if (!state?.serverId || visited.has(state.serverId)) break;
            visited.add(state.serverId);
            server = serverName(state.serverId, state.hudName);
            rows = toServerRows(state.rows || []);

            if (name) {
                const target = (state.rows || []).find(row => nameMatches(name, row.name));
                if (target) {
                    checkCancelled();
                    const briefs = await page.readBoardBriefs([target.name]);
                    card = briefs.get(normalizeName(target.name)) ?? null;
                    cardName = target.name;
                }
            }
            if (!name || cardName) break;

            checkCancelled();
            const next = await page.waitForServerHop(state.serverId, undefined, signal);
            if (!next) break;
            state = next;
        }

        checkCancelled();
        return { mode, server, rows, card, cardName };
    } finally {
        /* Even a cancelled check leaves the browser parked, not mid-match. */
        await reloader.park();
    }
}

module.exports = {
    BASE_URL,
    MODES,
    locateChrome,
    ensureExecutable,
    ChromePage,
    ResidentBoards,
    startResidentBoards,
    getResidentBoards,
    closeResidentBoards,
    SiteReloader,
    getSiteReloader,
    closeSiteReloader,
    SweepReloader,
    getSweepReloader,
    closeSweepReloader,
    scrapeBoards,
    scrapeSiteBoards,
    scrapeServerBoards,
    readServerBoard,
    directServersEnabled,
    scrapeLive,
    refreshPlayerCards,
    knownServers,
    serverBaseUrl
};
