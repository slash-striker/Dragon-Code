const db = require('../../database');

/*
 * Purchased /daily Streak Protection.
 *
 * Players buy cover days (1-day or 7-day packs). Each day they fail to claim,
 * /daily burns one cover day instead of resetting their streak — so a missed
 * day no longer breaks the streak while protection remains. Days stack and
 * never expire; they are only consumed when a claim is actually missed.
 */

const ITEMS = {
    streak_protection_day: { coverDays: 1, label: 'Streak Protection (1 Day)' },
    streak_protection_week: { coverDays: 7, label: 'Streak Protection (7 Days)' }
};

function ensureRow(userId) {
    db.prepare('INSERT OR IGNORE INTO streak_protection (userId, coverDays, purchasedAt) VALUES (?, 0, NULL)')
        .run(userId);
}

function getCoverDays(userId) {
    ensureRow(userId);
    return db.prepare('SELECT coverDays FROM streak_protection WHERE userId = ?')
        .get(userId)?.coverDays ?? 0;
}

function addCoverDays(userId, days) {
    ensureRow(userId);
    db.prepare('UPDATE streak_protection SET coverDays = coverDays + ?, purchasedAt = ? WHERE userId = ?')
        .run(days, new Date().toISOString(), userId);
    return getCoverDays(userId);
}

/*
 * Consume one cover day after a missed day. Returns true when protection
 * saved the streak, false when there was no coverage left.
 */
function consumeCoverDay(userId) {
    ensureRow(userId);
    const result = db.prepare(
        'UPDATE streak_protection SET coverDays = coverDays - 1 WHERE userId = ? AND coverDays > 0'
    ).run(userId);
    return result.changes === 1;
}

function describeBalance(userId) {
    const days = getCoverDays(userId);
    return days > 0
        ? `🛡️ **${days}** protection day${days === 1 ? '' : 's'} banked — a missed /daily will no longer break your streak.`
        : '🛡️ No protection banked. Grab some from the shop so a missed day never costs your streak.';
}

module.exports = {
    ITEMS,
    getCoverDays,
    addCoverDays,
    consumeCoverDay,
    describeBalance
};
