/*
 * Pure helpers for the Netquel leaderboard tracker.
 *
 * Kept free of child_process / discord.js so the matching rules can be unit
 * tested without launching a browser or a client. The scraper feeds raw table
 * cells in here; the service compares the result with the enemy list.
 */

const PERIODS = ['day', 'week', 'all'];
const MODES = ['FFA', 'Forge'];

/*
 * Leaderboard names are player aliases: case and spacing are not meaningful
 * ("M A R K E Z" is not "MARK EZ"), but leading/trailing space and case are.
 */
function normalizeName(name) {
    return String(name ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/* The site truncates long aliases with a trailing ellipsis ("CAT..."). */
function truncatedPrefix(name) {
    const text = String(name ?? '').trim();
    const match = /^(.*?)(?:\.\.\.|…)$/.exec(text);
    if (!match) return null;
    const prefix = normalizeName(match[1]);
    return prefix.length >= 3 ? prefix : null;
}

/*
 * An enemy matches when the names are identical, or when the board only
 * shows a truncated alias that is a prefix of the full name.
 */
function nameMatches(query, candidate) {
    const wanted = normalizeName(query);
    const found = normalizeName(candidate);
    if (!wanted || !found) return false;
    if (wanted === found) return true;
    const prefix = truncatedPrefix(candidate);
    return Boolean(prefix && wanted.startsWith(prefix));
}

function parseScore(value) {
    const digits = String(value ?? '').replace(/[^\d]/g, '');
    if (!digits) return null;
    const score = Number(digits);
    return Number.isFinite(score) ? score : null;
}

/*
 * Raw rows come from the page as { name, score } strings. Ranks are derived
 * from the row order (the site never re-sorts a rendered table).
 */
function toBoardRows(rawRows) {
    const rows = [];
    for (const raw of rawRows || []) {
        const name = String(raw?.name ?? '').replace(/\s+/g, ' ').trim();
        if (!name || name === '-') continue;
        rows.push({
            rank: rows.length + 1,
            name,
            normalized: normalizeName(name),
            score: parseScore(raw?.score)
        });
    }
    return rows;
}

function boardKey(mode, period) {
    return `${String(mode).toLowerCase()}:${String(period).toLowerCase()}`;
}

function formatScore(score) {
    return Number.isFinite(score) ? score.toLocaleString('en-US') : '—';
}

function periodLabel(period) {
    return period === 'day' ? 'Daily' : period === 'week' ? 'Weekly' : 'All-time';
}

/*
 * Per-server boards come from the in-game HUD instead of the site tables:
 * each row is "rank, name, score" and the board belongs to one server
 * (Cloud/2, Cloud/3, …) rather than a day/week/all period.
 */
function toServerRows(rawRows) {
    const rows = [];
    for (const raw of rawRows || []) {
        const name = String(raw?.name ?? '').replace(/\s+/g, ' ').trim();
        if (!name || name === '-') continue;
        const rank = Number.parseInt(String(raw?.rank ?? '').replace(/[^\d]/g, ''), 10);
        rows.push({
            rank: Number.isFinite(rank) && rank > 0 ? rank : rows.length + 1,
            name,
            normalized: normalizeName(name),
            score: parseScore(raw?.score)
        });
    }
    return rows;
}

function serverKey(mode, server) {
    return `${String(mode).toLowerCase()}:server:${String(server ?? '').toLowerCase()}`;
}

/*
 * `server` is the label the client shows (Zenith/FFA); `serverId` is the
 * stable internal id (Cloud/4) used for keys and deduplication.
 */
function serverBoard(mode, server, rows, serverId = null) {
    return {
        mode,
        period: 'server',
        server,
        serverId: serverId || server,
        key: serverKey(mode, serverId || server),
        rows
    };
}

/* "FFA · Daily" for a site board, "FFA · Cloud/3" for a server board. */
function boardLabel(board) {
    if (!board) return 'unknown board';
    if (board.server) return `${board.mode} · ${board.server}`;
    return `${board.mode} · ${periodLabel(board.period)}`;
}

/*
 * The client's own server names. The internal id is Cloud/<n> and the game
 * shows the server as "<n>-<Name>" (2-Spiral, 4-Vortex, …), so the index in
 * the id is the number players see. The join message in chat names a server
 * too, but it arrives a hop late (you can land in Cloud/4 and still read the
 * welcome for Cloud/3), so the id is the reliable source here.
 */
const SERVER_NAMES = {
    'Cloud/2': 'Spiral',
    'Cloud/3': 'Zenith',
    'Cloud/4': 'Vortex'
};
const KNOWN_SERVER_NAMES = Object.values(SERVER_NAMES);

/*
 * Boards are named the way the in-game leaderboard names its server — Spiral,
 * Zenith, Vortex — with no Cloud/<n> prefix and no mode suffix: the mode is
 * already in the board's title. The Cloud id stays the stable key, and
 * `observed` (the caption the in-game board itself showed) wins over the map
 * when the client gives us one.
 */
function serverName(serverId, observed = null) {
    const seen = String(observed ?? '').trim().toLowerCase();
    if (seen) {
        const match = KNOWN_SERVER_NAMES.find(name => name.toLowerCase() === seen);
        if (match) return match;
    }
    const id = String(serverId ?? '').trim();
    return SERVER_NAMES[id] || id || 'Server';
}

/* Does this board belong to what the user typed ("zenith", "Cloud/3", …)? */
function matchesServer(board, query) {
    const wanted = normalizeName(query);
    if (!wanted) return false;
    if (wanted === normalizeName(board?.serverId)) return true;
    const bare = wanted.replace(/^\d+-/, '').replace(/\/.*$/, '');
    return bare === normalizeName(serverName(board?.serverId, board?.server));
}

/*
 * Discord caps an embed description at 4096 characters and a field value at
 * 1024, so boards are rendered line by line until the budget runs out instead
 * of being sliced mid-line.
 */
function fitLines(rows, limit, format) {
    const lines = [];
    let used = 0;
    for (const row of rows || []) {
        const line = format(row);
        if (!line) continue;
        const cost = line.length + (lines.length ? 1 : 0);
        if (used + cost > limit) break;
        lines.push(line);
        used += cost;
    }
    return lines;
}

/*
 * Discord's own relative timestamp markup ("2 hours ago"). Rendered as plain
 * text, so it must sit outside code blocks to work.
 */
function relativeStamp(at) {
    const ms = Number(at);
    if (!Number.isFinite(ms) || ms <= 0) return 'never';
    return `<t:${Math.floor(ms / 1000)}:R>`;
}

/* The freshest board in a group; a server sweep writes all of them at once. */
function newestFetchedAt(boards) {
    let newest = null;
    for (const board of boards || []) {
        const at = Number(board?.fetchedAt);
        if (!Number.isFinite(at) || at <= 0) continue;
        if (newest === null || at > newest) newest = at;
    }
    return newest;
}

/*
 * Replace one group of boards (a single mode, site or server) and keep every
 * other group, so the fast site refresh never wipes the slow server sweep's
 * rows — or a mode whose scrape just failed.
 */
function mergeBoardGroup(boards, incoming, { mode, server }) {
    const wantedMode = String(mode).toLowerCase();
    const keep = board => !(
        String(board?.mode).toLowerCase() === wantedMode &&
        Boolean(board?.server) === Boolean(server)
    );
    return [...(boards || []).filter(keep), ...(incoming || [])];
}

/* A single key per board, used to deduplicate enemy alerts. */
function boardIdentity(board) {
    return board?.key || boardKey(board?.mode, board?.period);
}

/*
 * Every place an enemy currently appears. Returns one hit per board so the
 * alert can say which leaderboard matched.
 */
function findEnemyHits(enemies, boards) {
    const hits = [];
    for (const enemy of enemies || []) {
        const query = enemy?.displayName || enemy?.name;
        for (const board of boards || []) {
            const row = (board.rows || []).find(candidate => nameMatches(query, candidate.name));
            if (!row) continue;
            hits.push({
                name: enemy.name,
                displayName: row.name,
                mode: board.mode,
                period: board.period,
                server: board.server || null,
                board: boardIdentity(board),
                label: boardLabel(board),
                rank: row.rank,
                score: row.score
            });
        }
    }
    return hits;
}

module.exports = {
    MODES,
    PERIODS,
    normalizeName,
    nameMatches,
    parseScore,
    toBoardRows,
    toServerRows,
    boardKey,
    boardIdentity,
    boardLabel,
    serverKey,
    serverBoard,
    serverName,
    matchesServer,
    SERVER_NAMES,
    formatScore,
    periodLabel,
    relativeStamp,
    fitLines,
    newestFetchedAt,
    mergeBoardGroup,
    findEnemyHits
};
