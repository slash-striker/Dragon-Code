const db = require('../../database');

function addXP(userId, amount) {
    db.prepare(`
        UPDATE users
        SET xp = xp + ?
        WHERE userId = ?
    `).run(amount, userId);
}

function getXP(userId) {
    return db.prepare(`
        SELECT xp, level, prestigeLevel
        FROM users
        WHERE userId = ?
    `).get(userId);
}

module.exports = { addXP, getXP };