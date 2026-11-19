/*
 * Enemy list + alert bookkeeping for the Netquel tracker.
 *
 * Enemies are stored by their normalized alias so "Apex" and "apex " are one
 * enemy, while the display name keeps whatever the staff member typed.
 * `netquel_enemy_alerts` remembers when a board last alerted, so a name that
 * sits on the leaderboard for days does not re-alert every refresh.
 */

const db = require('../../database');
const { normalizeName } = require('./netquelLogic');

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

CREATE TABLE IF NOT EXISTS netquel_board_messages (
    mode TEXT PRIMARY KEY,
    channelId TEXT NOT NULL,
    messageId TEXT NOT NULL,
    updatedAt TEXT NOT NULL
);
`);

function addEnemy({ name, addedBy = null, channelId = null }) {
    const displayName = String(name ?? '').replace(/\s+/g, ' ').trim();
    const key = normalizeName(displayName);
    if (!key) throw new Error('An enemy needs a name.');

    db.prepare(`
        INSERT INTO netquel_enemies (name, displayName, addedBy, channelId, addedAt)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            displayName = excluded.displayName,
            channelId = COALESCE(excluded.channelId, netquel_enemies.channelId)
    `).run(key, displayName, addedBy, channelId, new Date().toISOString());

    return getEnemy(key);
}

function getEnemy(name) {
    return db.prepare('SELECT * FROM netquel_enemies WHERE name = ?')
        .get(normalizeName(name)) ?? null;
}

function removeEnemy(name) {
    const key = normalizeName(name);
    const info = db.prepare('DELETE FROM netquel_enemies WHERE name = ?').run(key);
    db.prepare('DELETE FROM netquel_enemy_alerts WHERE name = ?').run(key);
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
    shouldAlert,
    recordAlert,
    getBoardMessage,
    setBoardMessage,
    clearBoardMessage
};
