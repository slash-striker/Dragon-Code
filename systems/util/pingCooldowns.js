/*
 * Per-user, per-command ping cooldown store — backs /staff and /game-pings.
 *
 * Keeps users from spamming role pings: one ping per command per user per
 * COOLDOWN_MS window, persisted in SQLite so restarts don't reset timers.
 * The cooldown is only armed AFTER a successful broadcast, so failed runs
 * (permission loss, API errors) don't burn the user's attempt.
 */
const db = require('../../database');

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/*
 * Per-command cooldowns. /staff and /game-pings each got their own window
 * (2h / 3h); anything unlisted keeps the 30-minute default. Members can
 * tune these live via /set-cooldown — the override lands in
 * cooldown_settings under the `ping:<command>` key, so it survives
 * restarts without touching this file.
 */
const COMMAND_COOLDOWNS_MS = {
    staff: 2 * 60 * 60 * 1000,       // 2 hours
    'game-pings': 3 * 60 * 60 * 1000 // 3 hours
};

function getConfiguredOverrideMs(commandName) {
    try {
        const db = require('../../database');
        const row = db.prepare(
            'SELECT durationMs FROM cooldown_settings WHERE command = ?'
        ).get(`ping:${commandName}`);
        return row ? Number(row.durationMs) : null;
    } catch {
        return null;
    }
}

function getCooldownMs(commandName) {
    if (commandName === 'mine') return null;
    const override = getConfiguredOverrideMs(commandName);
    if (override != null && override >= 0) return override;
    return COMMAND_COOLDOWNS_MS[commandName] ?? DEFAULT_COOLDOWN_MS;
}

// Legacy export kept for back-compat with older callers.
const COOLDOWN_MS = DEFAULT_COOLDOWN_MS;

db.exec(`
    CREATE TABLE IF NOT EXISTS ping_cooldowns (
        commandName TEXT NOT NULL,
        userId      TEXT NOT NULL,
        lastUsedAt  INTEGER NOT NULL,
        PRIMARY KEY (commandName, userId)
    )
`);

const getStmt = db.prepare(
    'SELECT lastUsedAt FROM ping_cooldowns WHERE commandName = ? AND userId = ?'
);
const setStmt = db.prepare(`
    INSERT INTO ping_cooldowns (commandName, userId, lastUsedAt) VALUES (?, ?, ?)
    ON CONFLICT(commandName, userId) DO UPDATE SET lastUsedAt = excluded.lastUsedAt
`);
const clearStmt = db.prepare(
    'DELETE FROM ping_cooldowns WHERE commandName = ? AND userId = ?'
);

/** Milliseconds left on the user's cooldown for this command (0 = ready). */
function getRemainingCooldownMs(commandName, userId, now = Date.now()) {
    const row = getStmt.get(String(commandName), String(userId));
    if (!row) return 0;
    const durationMs = getCooldownMs(commandName);
    if (durationMs == null || durationMs <= 0) return 0;
    const remaining = durationMs - (now - row.lastUsedAt);
    return remaining > 0 ? remaining : 0;
}

/** Arm (or restart) the user's cooldown for this command. */
function setPingCooldown(commandName, userId, now = Date.now()) {
    setStmt.run(String(commandName), String(userId), now);
}

/** Admin-facing: current window for a ping command, in minutes (or null). */
function getPingCooldownMinutes(commandName) {
    const durationMs = getCooldownMs(commandName);
    return durationMs == null ? null : Math.round(durationMs / 60000);
}

/** Clear a user's cooldown for this command (mod/testing escape hatch). */
function clearPingCooldown(commandName, userId) {
    clearStmt.run(String(commandName), String(userId));
}

/** Human-friendly remaining time, e.g. "29m 59s" or "1h 5m". */
function formatRemaining(ms) {
    const totalSec = Math.ceil(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

module.exports = {
    COOLDOWN_MS,
    DEFAULT_COOLDOWN_MS,
    COMMAND_COOLDOWNS_MS,
    getCooldownMs,
    getPingCooldownMinutes,
    getRemainingCooldownMs,
    setPingCooldown,
    clearPingCooldown,
    formatRemaining
};
