const db = require('../../database');

const COUNTING_CHANNEL_ID = '1548362129713930355';

/* Memoized: the counting watcher fires per message, and this CREATE TABLE IF
   NOT EXISTS block used to parse on every single one. One module-level flag
   keeps the first-call guarantee; new processes always run the first call. */
let countingTablesEnsured = false;

function ensureCountingTables() {
    if (countingTablesEnsured) return;
    db.exec(`
        CREATE TABLE IF NOT EXISTS counting_state (
            channelId TEXT PRIMARY KEY,
            currentCount INTEGER NOT NULL DEFAULT 0,
            lastUserId TEXT,
            lastMessageId TEXT,
            bestCount INTEGER NOT NULL DEFAULT 0,
            updatedAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS counting_scores (
            channelId TEXT NOT NULL,
            userId TEXT NOT NULL,
            validCounts INTEGER NOT NULL DEFAULT 0,
            bestStreak INTEGER NOT NULL DEFAULT 0,
            currentStreak INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(channelId, userId)
        );
        CREATE TABLE IF NOT EXISTS counting_violations (
            channelId TEXT NOT NULL,
            userId TEXT NOT NULL,
            consecutiveInvalid INTEGER NOT NULL DEFAULT 0,
            lastInvalidAt TEXT,
            PRIMARY KEY(channelId, userId)
        );
        /* Ledger of which messages were ACCEPTED counts. Edit/delete alerts
         * fire ONLY for messages in this table — a rejected chat message that
         * the bot deletes must not also produce a "deleted their counted
         * number" alert. */
        CREATE TABLE IF NOT EXISTS counting_counts (
            channelId TEXT NOT NULL,
            messageId TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            count INTEGER NOT NULL,
            countedAt TEXT NOT NULL
        );
    `);
    const columns = new Set(db.prepare('PRAGMA table_info(counting_state)').all().map(column => column.name));
    if (!columns.has('lastMessageId')) {
        db.exec('ALTER TABLE counting_state ADD COLUMN lastMessageId TEXT');
    }
    countingTablesEnsured = true;
}

function getState(channelId = COUNTING_CHANNEL_ID) {
    ensureCountingTables();
    let state = db.prepare('SELECT * FROM counting_state WHERE channelId = ?').get(channelId);
    if (!state) {
        db.prepare(`
            INSERT INTO counting_state (channelId, currentCount, updatedAt)
            VALUES (?, 0, ?)
        `).run(channelId, new Date().toISOString());
        state = db.prepare('SELECT * FROM counting_state WHERE channelId = ?').get(channelId);
    }
    return state;
}

function setStartingCount(nextCount, channelId = COUNTING_CHANNEL_ID) {
    if (!Number.isSafeInteger(nextCount) || nextCount < 1) {
        throw new Error('Starting count must be a positive whole number.');
    }
    ensureCountingTables();
    db.prepare(`
        INSERT INTO counting_state (channelId, currentCount, lastUserId, bestCount, updatedAt)
        VALUES (?, ?, NULL, 0, ?)
        ON CONFLICT(channelId) DO UPDATE SET
            currentCount = excluded.currentCount,
            lastUserId = NULL,
            lastMessageId = NULL,
            updatedAt = excluded.updatedAt
    `).run(channelId, nextCount - 1, new Date().toISOString());
    return getState(channelId);
}

function recordValidCount(userId, count, messageId, channelId = COUNTING_CHANNEL_ID) {
    const state = getState(channelId);
    if (state.lastUserId === userId) {
        return {
            valid: false,
            reason: 'same-user',
            expected: state.currentCount + 1,
            state
        };
    }
    if (count !== state.currentCount + 1) {
        return { valid: false, expected: state.currentCount + 1, state };
    }

    db.transaction(() => {
        db.prepare(`
            UPDATE counting_state
            SET currentCount = ?, lastUserId = ?, lastMessageId = ?, bestCount = MAX(bestCount, ?), updatedAt = ?
            WHERE channelId = ?
        `).run(count, userId, messageId, count, new Date().toISOString(), channelId);

        const previous = db.prepare(`
            SELECT currentStreak FROM counting_scores WHERE channelId = ? AND userId = ?
        `).get(channelId, userId);
        const streak = (previous?.currentStreak || 0) + 1;

        db.prepare(`
            INSERT INTO counting_scores (channelId, userId, validCounts, bestStreak, currentStreak)
            VALUES (?, ?, 1, ?, ?)
            ON CONFLICT(channelId, userId) DO UPDATE SET
                validCounts = validCounts + 1,
                bestStreak = MAX(bestStreak, excluded.bestStreak),
                currentStreak = excluded.currentStreak
        `).run(channelId, userId, streak, streak);
        db.prepare(`
            INSERT INTO counting_counts (channelId, messageId, userId, count, countedAt)
            VALUES (?, ?, ?, ?, ?)
        `).run(channelId, messageId, userId, count, new Date().toISOString());
        db.prepare(`
            INSERT INTO counting_violations (channelId, userId, consecutiveInvalid, lastInvalidAt)
            VALUES (?, ?, 0, NULL)
            ON CONFLICT(channelId, userId) DO UPDATE SET
                consecutiveInvalid = 0,
                lastInvalidAt = NULL
        `).run(channelId, userId);
    })();

    return { valid: true, expected: count + 1, state: getState(channelId) };
}

/* Was this message an ACCEPTED count? Gates the edit/delete alerts so a
 * deleted non-counting message (spam, chat) never produces a false alert. */
function wasCountedMessage(channelId, messageId) {
    ensureCountingTables();
    return Boolean(db.prepare(
        'SELECT 1 FROM counting_counts WHERE channelId = ? AND messageId = ?'
    ).get(channelId, messageId));
}

function recordInvalidCount(userId, channelId = COUNTING_CHANNEL_ID) {
    ensureCountingTables();
    db.prepare(`
        UPDATE counting_scores
        SET currentStreak = 0
        WHERE channelId = ?
    `).run(channelId);
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO counting_violations (channelId, userId, consecutiveInvalid, lastInvalidAt)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(channelId, userId) DO UPDATE SET
            consecutiveInvalid = consecutiveInvalid + 1,
            lastInvalidAt = excluded.lastInvalidAt
    `).run(channelId, userId, now);
    return db.prepare(`
        SELECT consecutiveInvalid FROM counting_violations
        WHERE channelId = ? AND userId = ?
    `).get(channelId, userId)?.consecutiveInvalid || 0;
}

function getLeaderboard(limit = 10, channelId = COUNTING_CHANNEL_ID) {
    ensureCountingTables();
    return db.prepare(`
        SELECT userId, validCounts, bestStreak, currentStreak
        FROM counting_scores
        WHERE channelId = ?
        ORDER BY validCounts DESC, bestStreak DESC, userId ASC
        LIMIT ?
    `).all(channelId, Math.max(1, Math.min(25, limit)));
}

module.exports = {
    COUNTING_CHANNEL_ID,
    ensureCountingTables,
    getState,
    setStartingCount,
    recordValidCount,
    wasCountedMessage,
    recordInvalidCount,
    getLeaderboard
};
