/*
 * Pure helpers for the Netquel leaderboard tracker.
 *
 * Kept free of child_process / discord.js so the matching rules can be unit
 * tested without launching a browser or a client. The scraper feeds raw table
 * cells in here; the service compares the result with the enemy list.
 */

const PERIODS = ['day', 'week', 'all'];
const MODES = ['FFA', 'Forge'];

/* A live server-board score at or above this is worth one alert ping. */
const HIGH_SCORE_PING_THRESHOLD = 50_000;

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
        const profile = parseBrief(raw?.brief);
        rows.push({
            rank: Number.isFinite(rank) && rank > 0 ? rank : rows.length + 1,
            name,
            normalized: normalizeName(name),
            score: parseScore(raw?.score),
            /* CSS-only markers read off the live HUD row. */
            verified: Boolean(raw?.verified),
            afk: Boolean(raw?.afk),
            ...(profile ? { profile } : {})
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

/*
 * Replace one board by its key. Server boards land one at a time now, and a
 * fresh Spiral board must not wipe the Zenith and Vortex boards beside it.
 */
function mergeBoard(boards, incoming) {
    if (!incoming) return [...(boards || [])];
    const key = boardIdentity(incoming);
    return [...(boards || []).filter(board => boardIdentity(board) !== key), incoming];
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
                score: row.score,
                verified: Boolean(row.verified),
                afk: Boolean(row.afk),
                /* The card captured on this same board walk, when there is one. */
                profile: row.profile ?? null
            });
        }
    }
    return hits;
}

/*
 * Live server boards carry scores, so a 50,000+ row is worth its own alert.
 * Site day/week/all tables are history and hold big scores all day, so they
 * are deliberately excluded.
 */
function findHighScoreRows(boards, threshold = HIGH_SCORE_PING_THRESHOLD) {
    const rows = [];
    for (const board of boards || []) {
        if (!board?.server) continue;
        for (const row of board.rows || []) {
            if (!Number.isFinite(row?.score) || row.score < threshold) continue;
            rows.push({
                name: row.name,
                key: normalizeName(row.name),
                score: row.score,
                rank: row.rank,
                mode: board.mode,
                server: board.server,
                label: boardLabel(board),
                verified: Boolean(row.verified),
                afk: Boolean(row.afk)
            });
        }
    }
    return rows;
}

/*
 * The in-game card that opens when a board name is clicked is the only place
 * netquel exposes a player's join date and high score. It renders as
 * "Joined | 11/16/2026", "High score | 10903", "Rank | Prospector".
 * The site prints M/D/YYYY, so every accepted input is normalised to that.
 */
function parseJoinedDate(input) {
    const text = String(input ?? '').trim();
    if (!text) return null;

    let year;
    let month;
    let day;
    const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
    if (iso) {
        year = Number(iso[1]);
        month = Number(iso[2]);
        day = Number(iso[3]);
    } else {
        const local = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
        if (!local) return null;
        month = Number(local[1]);
        day = Number(local[2]);
        year = Number(local[3]);
    }

    const date = new Date(Date.UTC(year, month - 1, day));
    const real = date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
    return real ? `${month}/${day}/${year}` : null;
}

/*
 * A card cell can carry a badge or separator before the text (the rank badge
 * renders as "| Prospector"), so labels are stripped of leading punctuation.
 */
function cleanLabel(value) {
    const text = String(value ?? '')
        .replace(/[\u00a0\u200b]/g, ' ')
        .replace(/^[\s|·•:/-]+/, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text || /^(none|unranked|-|—)$/i.test(text)) return null;
    return text;
}

/* Clans are shown with brackets on the card and before names in chat. */
function parseClan(value) {
    const text = cleanLabel(value);
    if (!text) return null;
    const bare = text.replace(/^\[+/, '').replace(/\]+$/, '').trim();
    return bare || null;
}

function normalizeClan(value) {
    return normalizeName(parseClan(value) ?? '');
}

/*
 * Normalises one profile card into the fields the tracker keeps.
 * Accepts both the raw "Joined"/"High score" labels the page produces and the
 * stored lower-case shape. `notice` is the panel's plain text, which is the
 * only place a private profile says so.
 */
function parseBrief(raw, notice = '') {
    if (!raw || typeof raw !== 'object') return null;
    const read = (...keys) => {
        for (const key of keys) {
            if (raw[key] !== undefined && raw[key] !== null) return raw[key];
        }
        return null;
    };

    const noticeText = `${notice} ${Object.values(raw).join(' ')}`;
    if (/this profile is private/i.test(noticeText)) {
        return { joined: null, highScore: null, rank: null, streak: null, clan: null, private: true };
    }
    if (/profile not found/i.test(noticeText)) return null;

    const joined = parseJoinedDate(read('Joined', 'joined'));
    const highScore = parseScore(read('High score', 'highScore'));
    const rank = cleanLabel(read('Rank', 'rank'));
    const streak = cleanLabel(read('Streak', 'streak'));
    const clan = parseClan(read('Clan', 'clan'));

    if (!joined && highScore === null && !rank && !clan) return null;
    return { joined, highScore, rank, streak, clan, private: false };
}

/*
 * A player on a one-day streak has just started, so their card is a guest
 * account worth nothing yet. They are not worth keeping in the player list
 * unless they were already there or are on the watch list.
 */
function isOneDayStreak(profile) {
    return /^1\s*-?\s*day streak$/i.test(String(profile?.streak ?? '').trim());
}

/*
 * An enemy can be followed by name alone, or pinned to the join date AND high
 * score from their profile card. A pinned enemy only pings when both still
 * match; anything else becomes a quiet warning, because a name is not proof
 * of identity (aliases get reused).
 */
function verifyEnemy(enemy, profile) {
    const wantedJoined = parseJoinedDate(enemy?.joined) ?? enemy?.joined ?? null;
    const highRaw = enemy?.highScore;
    const wantedHigh = highRaw === null || highRaw === undefined || highRaw === '' ? null : Number(highRaw);
    const wantedClan = normalizeClan(enemy?.clan);
    const hasCriteria = Boolean(wantedJoined) || Number.isFinite(wantedHigh) || Boolean(wantedClan);
    if (!hasCriteria) return { status: 'ok', reason: null };

    if (!profile) {
        return {
            status: 'unverified',
            reason: 'no profile card has been captured for this name yet'
        };
    }

    /* A private card shows no join date, score or clan, so nothing can match. */
    if (profile.private || profile.isPrivate) {
        return { status: 'unverified', reason: 'their profile is private, so the card can not confirm them' };
    }

    /*
     * A brand-new player can have a blank high score on their card. That is
     * "cannot verify yet", not "different person", so it warns instead of
     * claiming the identity is wrong.
     */
    const missing = [];
    if (wantedJoined && !profile.joined) missing.push('join date');
    if (Number.isFinite(wantedHigh) && (profile.highScore === null || profile.highScore === undefined)) {
        missing.push('high score');
    }
    if (missing.length) {
        return { status: 'unverified', reason: `the captured card has no ${missing.join(' or ')} yet` };
    }

    /* A clan-only pin can not be checked when the card shows no clan. */
    if (wantedClan && !profile.clan && !wantedJoined && !Number.isFinite(wantedHigh)) {
        return { status: 'unverified', reason: 'the captured card does not show a clan' };
    }

    const problems = [];
    if (wantedJoined && profile.joined !== wantedJoined) {
        problems.push(`joined ${profile.joined ?? 'unknown'} (expected ${wantedJoined})`);
    }
    if (Number.isFinite(wantedHigh) && Number(profile.highScore) !== wantedHigh) {
        problems.push(`high score ${formatScore(profile.highScore)} (expected ${formatScore(wantedHigh)})`);
    }
    /*
     * The card panel the tracker reads has no clan row — a clan is only shown
     * in the profile dialog and in front of names in chat. So a clan can only
     * be compared when the captured card happens to carry one; a missing clan
     * is not a different person.
     */
    if (wantedClan && profile.clan && normalizeClan(profile.clan) !== wantedClan) {
        problems.push(`clan ${profile.clan} (expected ${enemy.clan})`);
    }
    if (problems.length) return { status: 'mismatch', reason: problems.join(' · ') };
    return { status: 'ok', reason: null };
}

/*
 * A compact fingerprint of a live HUD board. The resident tracker re-reads
 * the same table every couple of seconds, so an unchanged board must not
 * spend a Discord edit (or a database write).
 */
function boardSignature(rows, serverId = '') {
    const cells = (rows || []).map(row => [
        row?.rank ?? '',
        String(row?.name ?? '').replace(/\s+/g, ' ').trim(),
        String(row?.score ?? '').replace(/\s+/g, ' ').trim(),
        row?.verified ? 1 : 0,
        row?.afk ? 1 : 0
    ].join('~'));
    /*
     * The HUD caption is deliberately not part of the signature: the client
     * sometimes paints it a frame late, which would republish identical rows.
     */
    return `${serverId ?? ''}|${cells.join('|')}`;
}

/*
 * Collapse a burst of board changes into one publish per window. Discord
 * edits are rate-limited, and a busy server can repaint its HUD several times
 * a second; the newest rows are always the ones in the snapshot when the
 * window closes.
 *
 * `minIntervalMs` caps how often the run itself can happen. Three resident
 * servers publish independently and their scores change at different moments;
 * without the cap the shared channel is edited every few seconds even though
 * the embed is unchanged.
 */
function createCoalescer({ delayMs = 2_000, minIntervalMs = 0, run } = {}) {
    let timer = null;
    let lastRunAt = 0;
    const pending = new Set();
    const gap = Math.max(0, Number(minIntervalMs) || 0);

    const waitForNext = () => {
        const delay = Math.max(0, Number(delayMs) || 0);
        const remaining = lastRunAt ? lastRunAt + gap - Date.now() : 0;
        return Math.max(delay, remaining);
    };

    const flush = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (!pending.size) return Promise.resolve();
        const keys = [...pending];
        pending.clear();
        lastRunAt = Date.now();
        return Promise.resolve().then(() => run?.(keys));
    };

    return {
        push(key) {
            if (key !== undefined && key !== null) pending.add(key);
            if (timer) return;
            timer = setTimeout(() => {
                timer = null;
                flush().catch(() => {});
            }, waitForNext());
            if (typeof timer.unref === 'function') timer.unref();
        },
        flush,
        size: () => pending.size
    };
}

/*
 * The Lobby tab is scene-local, unlike the server-wide HUD. It also carries a
 * few chat/global names in every tier (the old bot's duplicate "tiger"). A
 * real player cannot stand in two FFA tiers of one server, so a name seen in
 * more than one tier is not proof of presence in either and is dropped from
 * both instead of being guessed.
 */
function filterTierRosters(entries) {
    const grouped = new Map();
    for (const entry of entries || []) {
        const serverId = String(entry?.serverId || entry?.server || '');
        if (!grouped.has(serverId)) grouped.set(serverId, []);
        grouped.get(serverId).push(entry);
    }

    const result = [];
    for (const serverEntries of grouped.values()) {
        const seenIn = new Map();
        for (const entry of serverEntries) {
            for (const name of entry.names || []) {
                const key = normalizeName(name);
                if (!key) continue;
                if (!seenIn.has(key)) seenIn.set(key, new Set());
                seenIn.get(key).add(String(entry.tier));
            }
        }
        for (const entry of serverEntries) {
            const names = [...new Set((entry.names || [])
                .map(name => String(name ?? '').replace(/\s+/g, ' ').trim())
                .filter(Boolean))]
                .filter(name => seenIn.get(normalizeName(name))?.size === 1);
            const online = Number(entry.online);
            result.push({ ...entry, names, online: Number.isFinite(online) ? online : null });
        }
    }
    return result;
}

/*
 * The live per-server HUD merges every FFA tier and has no tier column, so a
 * player's tier comes from the Lobby roster scan. Index one server at a time:
 * the same alias on Spiral and Vortex is not the same person.
 */
const TIER_LABELS = { 0: 'Entry', A: 'A', B: 'B' };

function tierLabel(tier) {
    const key = String(tier ?? '').trim().toUpperCase();
    if (!key) return null;
    return TIER_LABELS[key] ?? key;
}

function rosterTierLookup(entries) {
    const lookup = new Map();
    for (const entry of entries || []) {
        const servers = [...new Set([entry?.serverId, entry?.server]
            .map(server => normalizeName(server))
            .filter(Boolean))];
        if (!servers.length) continue;
        for (const server of servers) {
            if (!lookup.has(server)) lookup.set(server, new Map());
            const names = lookup.get(server);
            for (const name of entry.names || []) {
                const key = normalizeName(name);
                if (!key) continue;
                const display = String(name).replace(/\s+/g, ' ').trim();
                const tier = String(entry.tier);
                const existing = names.get(key);
                if (!existing) {
                    names.set(key, { name: display, tier, ambiguous: false });
                } else if (existing.tier !== tier) {
                    /* A name in two tiers is not proof of either. */
                    existing.ambiguous = true;
                }
            }
        }
    }
    return lookup;
}

function rosterTierFor(lookup, server, name) {
    if (!lookup?.get) return null;
    const wanted = normalizeName(name);
    if (!wanted) return null;
    const names = lookup.get(normalizeName(server));
    if (!names?.size) return null;

    const exact = names.get(wanted);
    if (exact) return exact.ambiguous ? null : tierLabel(exact.tier);

    /* The HUD cuts long aliases to "CAT…", so a board row can be a prefix. */
    const prefix = truncatedPrefix(name);
    if (prefix) {
        for (const entry of names.values()) {
            if (entry.ambiguous) continue;
            if (normalizeName(entry.name).startsWith(prefix)) return tierLabel(entry.tier);
        }
    }

    /* The Lobby list can be truncated too. */
    for (const entry of names.values()) {
        if (entry.ambiguous) continue;
        const rosterPrefix = truncatedPrefix(entry.name);
        if (rosterPrefix && wanted.startsWith(rosterPrefix)) return tierLabel(entry.tier);
    }
    return null;
}

module.exports = {
    MODES,
    PERIODS,
    filterTierRosters,
    tierLabel,
    rosterTierLookup,
    rosterTierFor,
    parseJoinedDate,
    parseBrief,
    parseClan,
    normalizeClan,
    cleanLabel,
    isOneDayStreak,
    verifyEnemy,
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
    mergeBoard,
    boardSignature,
    createCoalescer,
    findEnemyHits,
    findHighScoreRows,
    HIGH_SCORE_PING_THRESHOLD
};
