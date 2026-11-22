/*
 * Enemy list + alert bookkeeping for the Netquel tracker.
 *
 * Enemies are stored by their normalized alias so "Apex" and "apex " are one
 * enemy, while the display name keeps whatever the staff member typed.
 * `netquel_enemy_alerts` remembers when a board last alerted, so a name that
 * sits on the leaderboard for days does not re-alert every refresh.
 */

const db = require('../../database');
const { normalizeName, isOneDayStreak } = require('./netquelLogic');

db.exec(`
CREATE TABLE IF NOT EXISTS netquel_enemies (
    name TEXT PRIMARY KEY,
    displayName TEXT NOT NULL,
    addedBy TEXT,
    channelId TEXT,
    addedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS netquel_enemy_alerts (
    name TEXT NOT NULL,
    board TEXT NOT NULL,
    alertedAt TEXT NOT NULL,
    PRIMARY KEY (name, board)
);

CREATE TABLE IF NOT EXISTS netquel_enemy_pings (
    name TEXT PRIMARY KEY,
    pingedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS netquel_score_alerts (
    name TEXT PRIMARY KEY,
    displayName TEXT,
    server TEXT,
    score INTEGER,
    alertedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS netquel_players (
    name TEXT PRIMARY KEY,
    displayName TEXT NOT NULL,
    joined TEXT,
    highScore INTEGER,
    rankName TEXT,
    streak TEXT,
    clan TEXT,
    isPrivate INTEGER,
    mode TEXT,
    server TEXT,
    lastSeen TEXT NOT NULL,
    seenCount INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS netquel_board_messages (
    mode TEXT PRIMARY KEY,
    channelId TEXT NOT NULL,
    messageId TEXT NOT NULL,
    updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS netquel_roster_snapshot (
    id INTEGER PRIMARY KEY,
    payload TEXT NOT NULL,
    fetchedAt TEXT NOT NULL
);
`);

/*
 * Columns added after the first release: an enemy can carry the join date and
 * high score that identify the player, so a reused alias cannot fake a ping.
 */
function ensureColumn(table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some(entry => entry.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn('netquel_enemies', 'joined', 'TEXT');
ensureColumn('netquel_enemies', 'highScore', 'INTEGER');
ensureColumn('netquel_enemies', 'clan', 'TEXT');
ensureColumn('netquel_players', 'clan', 'TEXT');
ensureColumn('netquel_players', 'isPrivate', 'INTEGER');
/* HUD markers: an italic name is a verified account, a dimmed row is AFK. */
ensureColumn('netquel_players', 'verified', 'INTEGER');
ensureColumn('netquel_players', 'afk', 'INTEGER');

function addEnemy({ name, addedBy = null, channelId = null, joined = null, highScore = null, clan = null }) {
    const displayName = String(name ?? '').replace(/\s+/g, ' ').trim();
    const key = normalizeName(displayName);
    if (!key) throw new Error('An enemy needs a name.');

    const high = Number.isFinite(Number(highScore)) && highScore !== null ? Number(highScore) : null;

    db.prepare(`
        INSERT INTO netquel_enemies (name, displayName, addedBy, channelId, addedAt, joined, highScore, clan)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            displayName = excluded.displayName,
            channelId = COALESCE(excluded.channelId, netquel_enemies.channelId),
            joined = COALESCE(excluded.joined, netquel_enemies.joined),
            highScore = COALESCE(excluded.highScore, netquel_enemies.highScore),
            clan = COALESCE(excluded.clan, netquel_enemies.clan)
    `).run(key, displayName, addedBy, channelId, new Date().toISOString(), joined || null, high, clan || null);

    return getEnemy(key);
}

/*
 * Player cards seen on the in-game server boards. The newest card wins — a
 * high score that changed is stored as it now is, which also lets a corrected
 * card overwrite a bad value from an earlier sweep. A blank cell never wipes a
 * known value.
 */
function recordPlayers(entries, trackedNames = new Set()) {
    let saved = 0;
    const statement = db.prepare(`
        INSERT INTO netquel_players
            (name, displayName, joined, highScore, rankName, streak, clan, isPrivate, verified, afk, mode, server, lastSeen, seenCount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(name) DO UPDATE SET
            displayName = excluded.displayName,
            joined = COALESCE(excluded.joined, netquel_players.joined),
            highScore = COALESCE(excluded.highScore, netquel_players.highScore),
            rankName = COALESCE(excluded.rankName, netquel_players.rankName),
            streak = COALESCE(excluded.streak, netquel_players.streak),
            clan = COALESCE(excluded.clan, netquel_players.clan),
            /* A board-only row has no card; keep the stored private flag. */
            isPrivate = COALESCE(excluded.isPrivate, netquel_players.isPrivate),
            /* A verified badge never goes away; AFK is only the last sighting. */
            verified = MAX(COALESCE(excluded.verified, 0), COALESCE(netquel_players.verified, 0)),
            afk = COALESCE(excluded.afk, netquel_players.afk),
            mode = excluded.mode,
            server = excluded.server,
            lastSeen = excluded.lastSeen,
            seenCount = netquel_players.seenCount + 1
    `);

    for (const entry of entries || []) {
        const displayName = String(entry?.name ?? '').replace(/\s+/g, ' ').trim();
        const key = normalizeName(displayName);
        if (!key) continue;

        /*
         * A board-only row carries no card, so it cannot prove the name is not
         * a one-day guest. Only refresh players already known (or tracked);
         * the card pass introduces new names with their streak intact.
         */
        if (entry.hasCard === false && !trackedNames.has(key) && !getPlayer(key)) continue;

        /*
         * A one-day streak means a brand-new guest account. They are not worth
         * storing: they churn through the board all day. An existing player or
         * a tracked enemy is kept either way — the tracked card is what proves
         * the next ping is really them.
         */
        if (isOneDayStreak(entry) && !trackedNames.has(key) && !getPlayer(key)) continue;

        /*
         * Number(null) is 0, so a blank card cell has to be filtered out
         * explicitly or a new guest's empty score is stored as a real zero.
         */
        const highRaw = entry.highScore;
        const highScore = highRaw === null || highRaw === undefined || highRaw === '' ? null : Number(highRaw);

        const isPrivate = entry.hasCard === false
            ? null
            : (entry.private || entry.isPrivate ? 1 : 0);

        statement.run(
            key,
            displayName,
            entry.joined || null,
            Number.isFinite(highScore) ? highScore : null,
            entry.rank || null,
            entry.streak || null,
            entry.clan || null,
            isPrivate,
            entry.verified ? 1 : 0,
            entry.afk ? 1 : 0,
            entry.mode || null,
            entry.server || null,
            new Date().toISOString()
        );
        saved += 1;
    }
    return saved;
}

function getPlayer(name) {
    return db.prepare('SELECT * FROM netquel_players WHERE name = ?')
        .get(normalizeName(name)) ?? null;
}

/* Used by /add-enemy when it is given a join date + high score instead of a name. */
function findPlayersByProfile({ joined = null, highScore = null, clan = null }) {
    if (!joined || highScore === null || highScore === undefined) return [];
    if (clan) {
        return db.prepare('SELECT * FROM netquel_players WHERE joined = ? AND highScore = ? AND clan = ? ORDER BY displayName ASC')
            .all(joined, Number(highScore), clan);
    }
    return db.prepare('SELECT * FROM netquel_players WHERE joined = ? AND highScore = ? ORDER BY displayName ASC')
        .all(joined, Number(highScore));
}

function listPlayers() {
    return db.prepare('SELECT * FROM netquel_players ORDER BY highScore DESC, displayName ASC').all();
}

function getEnemy(name) {
    return db.prepare('SELECT * FROM netquel_enemies WHERE name = ?')
        .get(normalizeName(name)) ?? null;
}

function removeEnemy(name) {
    const key = normalizeName(name);
    const info = db.prepare('DELETE FROM netquel_enemies WHERE name = ?').run(key);
    db.prepare('DELETE FROM netquel_enemy_alerts WHERE name = ?').run(key);
    db.prepare('DELETE FROM netquel_enemy_pings WHERE name = ?').run(key);
    return info.changes > 0;
}

function listEnemies() {
    return db.prepare('SELECT * FROM netquel_enemies ORDER BY addedAt ASC').all();
}

/* True when this enemy has not alerted on this board recently. */
function shouldAlert(name, board, cooldownMs) {
    const key = normalizeName(name);
    const row = db.prepare('SELECT alertedAt FROM netquel_enemy_alerts WHERE name = ? AND board = ?')
        .get(key, board);
    if (!row) return true;
    const last = Date.parse(row.alertedAt);
    if (!Number.isFinite(last)) return true;
    return Date.now() - last >= cooldownMs;
}

function recordAlert(name, board) {
    db.prepare(`
        INSERT INTO netquel_enemy_alerts (name, board, alertedAt)
        VALUES (?, ?, ?)
        ON CONFLICT(name, board) DO UPDATE SET alertedAt = excluded.alertedAt
    `).run(normalizeName(name), board, new Date().toISOString());
}

/*
 * A role ping is at most one per enemy per cooldown, no matter how many
 * server boards carry the name at once. The message itself still posts.
 */
function canPing(name, cooldownMs) {
    const row = db.prepare('SELECT pingedAt FROM netquel_enemy_pings WHERE name = ?')
        .get(normalizeName(name));
    if (!row) return true;
    const last = Date.parse(row.pingedAt);
    return !Number.isFinite(last) || Date.now() - last >= cooldownMs;
}

function recordPing(name) {
    db.prepare(`
        INSERT INTO netquel_enemy_pings (name, pingedAt)
        VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET pingedAt = excluded.pingedAt
    `).run(normalizeName(name), new Date().toISOString());
}

/*
 * High-score alerts are keyed by normalized name and survive until the player
 * has been off the live boards for a grace period, so one visit pings once.
 */
function hasScoreAlert(name) {
    return Boolean(db.prepare('SELECT 1 FROM netquel_score_alerts WHERE name = ?')
        .get(normalizeName(name)));
}

function recordScoreAlert({ name, displayName = null, server = null, score = null }) {
    db.prepare(`
        INSERT INTO netquel_score_alerts (name, displayName, server, score, alertedAt)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            displayName = excluded.displayName,
            server = excluded.server,
            score = excluded.score,
            alertedAt = excluded.alertedAt
    `).run(
        normalizeName(name),
        displayName,
        server,
        score === null || score === undefined ? null : Number(score),
        new Date().toISOString()
    );
}

/* Forget a high-score alert once that name has been gone a while. */
function pruneScoreAlerts(presentNames = new Set(), graceMs = 10 * 60 * 1000) {
    const rows = db.prepare('SELECT name, alertedAt FROM netquel_score_alerts').all();
    const remove = db.prepare('DELETE FROM netquel_score_alerts WHERE name = ?');
    const now = Date.now();
    let removed = 0;
    for (const row of rows) {
        if (presentNames.has(row.name)) continue;
        const at = Date.parse(row.alertedAt);
        if (Number.isFinite(at) && now - at >= graceMs) {
            removed += remove.run(row.name).changes;
        }
    }
    return removed;
}

/*
 * The latest Lobby roster survives a restart, so the per-server board tier
 * tags do not blank out until the first tour finishes again.
 */
function saveRosterSnapshot({ entries, fetchedAt } = {}) {
    if (!Array.isArray(entries) || !entries.length) return false;
    const at = Number(fetchedAt);
    if (!Number.isFinite(at) || at <= 0) return false;
    db.prepare(`
        INSERT INTO netquel_roster_snapshot (id, payload, fetchedAt)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            payload = excluded.payload,
            fetchedAt = excluded.fetchedAt
    `).run(JSON.stringify(entries), new Date(at).toISOString());
    return true;
}

function getRosterSnapshot() {
    const row = db.prepare('SELECT payload, fetchedAt FROM netquel_roster_snapshot WHERE id = 1').get();
    if (!row) return null;
    try {
        const entries = JSON.parse(row.payload);
        const fetchedAt = Date.parse(row.fetchedAt);
        if (!Array.isArray(entries) || !entries.length || !Number.isFinite(fetchedAt)) return null;
        return { entries, fetchedAt };
    } catch {
        return null;
    }
}

/* The one auto-refreshing board message per mode, so refreshes edit it. */
function getBoardMessage(mode) {
    return db.prepare('SELECT * FROM netquel_board_messages WHERE mode = ?')
        .get(String(mode)) ?? null;
}

function setBoardMessage(mode, channelId, messageId) {
    db.prepare(`
        INSERT INTO netquel_board_messages (mode, channelId, messageId, updatedAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(mode) DO UPDATE SET
            channelId = excluded.channelId,
            messageId = excluded.messageId,
            updatedAt = excluded.updatedAt
    `).run(String(mode), String(channelId), String(messageId), new Date().toISOString());
}

function clearBoardMessage(mode) {
    return db.prepare('DELETE FROM netquel_board_messages WHERE mode = ?').run(String(mode)).changes > 0;
}

module.exports = {
    addEnemy,
    getEnemy,
    removeEnemy,
    listEnemies,
    recordPlayers,
    getPlayer,
    findPlayersByProfile,
    listPlayers,
    shouldAlert,
    recordAlert,
    canPing,
    recordPing,
    hasScoreAlert,
    recordScoreAlert,
    pruneScoreAlerts,
    saveRosterSnapshot,
    getRosterSnapshot,
    getBoardMessage,
    setBoardMessage,
    clearBoardMessage
};
