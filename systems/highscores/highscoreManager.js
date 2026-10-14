/*
 * Netquel highscore registry — FFA and FORGE modes.
 *
 * Admins record highscores with /set hs (mode defaults to ffa) or
 * /hs set mode:<ffa|forge>; /hs reads them and /display-hs posts (and keeps
 * editing) a leaderboard message in each mode's dedicated channel.
 *
 * Ranking is COMPETITION ranking ("1224"): entries tied on score share the
 * same rank/medal, and ties do not consume the next position — two players
 * tied for #1 are both #1, and the next player is #3.
 */

const db = require('../../database');

const MODES = {
    ffa: {
        label: 'FFA',
        emoji: '🥊',
        channel: '1550176637587558522',
        metaKey: 'hs:leaderboardMessageId:ffa',
        legacyKey: 'hs:leaderboardMessageId' // pre-modes storage
    },
    forge: {
        label: 'FORGE',
        emoji: '🔥',
        channel: '1550899286219300916',
        metaKey: 'hs:leaderboardMessageId:forge',
        legacyKey: null
    }
};
const DEFAULT_MODE = 'ffa';

function normalizeMode(mode) {
    return MODES[mode] ? mode : DEFAULT_MODE;
}

function tableFor(mode) {
    // The FFA table is the pre-existing one; other modes get their own table.
    return normalizeMode(mode) === DEFAULT_MODE ? 'netquel_highscores' : 'netquel_highscores_mode';
}

function setHighscore(userId, score, setBy, note, mode = DEFAULT_MODE) {
    const m = normalizeMode(mode);
    const table = tableFor(m);
    if (table === 'netquel_highscores') {
        db.prepare(`
            INSERT INTO netquel_highscores (userId, score, setBy, setAt, note)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(userId) DO UPDATE SET
                score = excluded.score,
                setBy = excluded.setBy,
                setAt = excluded.setAt,
                note = excluded.note
        `).run(userId, score, setBy, new Date().toISOString(), note || null);
        return;
    }
    db.prepare(`
        INSERT INTO netquel_highscores_mode (userId, mode, score, setBy, setAt, note)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(userId, mode) DO UPDATE SET
            score = excluded.score,
            setBy = excluded.setBy,
            setAt = excluded.setAt,
            note = excluded.note
    `).run(userId, m, score, setBy, new Date().toISOString(), note || null);
}

function getHighscore(userId, mode = DEFAULT_MODE) {
    const m = normalizeMode(mode);
    const table = tableFor(m);
    return table === 'netquel_highscores'
        ? db.prepare('SELECT * FROM netquel_highscores WHERE userId = ?').get(userId) || null
        : db.prepare('SELECT * FROM netquel_highscores_mode WHERE userId = ? AND mode = ?').get(userId, m) || null;
}

function getTopHighscores(limit = 20, mode = DEFAULT_MODE) {
    const m = normalizeMode(mode);
    const table = tableFor(m);
    return table === 'netquel_highscores'
        ? db.prepare(
            'SELECT * FROM netquel_highscores ORDER BY score DESC, setAt ASC LIMIT ?'
        ).all(limit)
        : db.prepare(
            'SELECT * FROM netquel_highscores_mode WHERE mode = ? ORDER BY score DESC, setAt ASC LIMIT ?'
        ).all(m, limit);
}

/*
 * Competition ranking: a player's rank is 1 + (number of players with a
 * strictly higher score). Tied players therefore share the same rank.
 */
function getHighscoreRank(userId, mode = DEFAULT_MODE) {
    const m = normalizeMode(mode);
    const entry = getHighscore(userId, m);
    if (!entry) return null;
    const table = tableFor(m);
    const rank = table === 'netquel_highscores'
        ? db.prepare('SELECT COUNT(*) AS higher FROM netquel_highscores WHERE score > ?').get(entry.score)
        : db.prepare('SELECT COUNT(*) AS higher FROM netquel_highscores_mode WHERE mode = ? AND score > ?').get(m, entry.score);
    return rank.higher + 1;
}

function getMeta(key) {
    const row = db.prepare('SELECT value FROM bot_meta WHERE key = ?').get(key);
    return row ? row.value : null;
}

function setMeta(key, value) {
    db.prepare(`
        INSERT INTO bot_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
}

function getLeaderboardMessageId(mode = DEFAULT_MODE) {
    const m = normalizeMode(mode);
    const current = getMeta(MODES[m].metaKey);
    if (current) return current;
    // Fall back to the pre-modes meta key so the existing FFA message keeps editing.
    return MODES[m].legacyKey ? getMeta(MODES[m].legacyKey) : null;
}

function setLeaderboardMessageId(messageId, mode = DEFAULT_MODE) {
    const m = normalizeMode(mode);
    setMeta(MODES[m].metaKey, String(messageId));
}

module.exports = {
    MODES,
    DEFAULT_MODE,
    normalizeMode,
    setHighscore,
    getHighscore,
    getTopHighscores,
    getHighscoreRank,
    getLeaderboardMessageId,
    setLeaderboardMessageId
};
