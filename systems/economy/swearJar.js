const db = require('../../database');

/* Channel that receives the swear-jar reports. */
const SWEAR_JAR_CHANNEL_ID = '1504365033637806134';

/*
 * Whole-word profanity list. Matching is done on word boundaries after
 * lowercasing and stripping common leetspeak, so "f*ck" style evasions are not
 * counted but plain swears and obvious substitutions are.
 */
const PROFANITY = [
    'fuck', 'fucking', 'fucked', 'fucker', 'shit', 'shitty', 'bullshit', 'bitch', 'bitches',
    'bastard', 'asshole', 'ass', 'damn', 'dammit', 'crap', 'piss', 'dick', 'cunt', 'wtf', 'stfu'
];
const PROFANITY_SET = new Set(PROFANITY);

db.exec(`
    CREATE TABLE IF NOT EXISTS swear_jar (
        userId TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
    )
`);

function normalize(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[@]/g, 'a')
        .replace(/[0]/g, 'o')
        .replace(/[1!|]/g, 'i')
        .replace(/[3]/g, 'e')
        .replace(/[$5]/g, 's');
}

/* Counts profanity words in a message. Returns 0 for clean text. */
function countSwears(text) {
    const words = normalize(text).match(/[a-z]+/g) ?? [];
    let count = 0;
    for (const word of words) {
        if (PROFANITY_SET.has(word)) count++;
    }
    return count;
}

/* Adds swears to a user's lifetime jar total and returns the new total. */
function addSwears(userId, amount) {
    db.prepare(`
        INSERT INTO swear_jar (userId, count) VALUES (?, ?)
        ON CONFLICT(userId) DO UPDATE SET count = count + excluded.count
    `).run(userId, amount);
    return getSwearCount(userId);
}

function getSwearCount(userId) {
    return db.prepare('SELECT count FROM swear_jar WHERE userId = ?').get(userId)?.count ?? 0;
}

function getSwearLeaderboard(limit = 10) {
    return db.prepare(`
        SELECT userId, count FROM swear_jar
        WHERE count > 0
        ORDER BY count DESC, userId ASC
        LIMIT ?
    `).all(limit);
}

module.exports = {
    SWEAR_JAR_CHANNEL_ID,
    countSwears,
    addSwears,
    getSwearCount,
    getSwearLeaderboard
};
