const db = require('../../database');

/* "HH:MM" → minutes after midnight, or null when malformed. */
function parseHM(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
}

/*
 * True when the user set a sleep schedule (/set-sleep) and the current time in
 * their timezone falls inside it. Users without a schedule are never asleep.
 */
function isUserAsleep(userId, now = Date.now()) {
    try {
        const row = db.prepare('SELECT timezone, wakeTime, sleepTime FROM users WHERE userId = ?').get(userId);
        if (!row) return false;
        const wakeMinutes = parseHM(row.wakeTime);
        const sleepMinutes = parseHM(row.sleepTime);
        if (wakeMinutes === null || sleepMinutes === null) return false;

        const offset = Number.parseInt(row.timezone ?? '0', 10) || 0;
        const local = new Date(now + offset * 60 * 60 * 1000);
        const nowMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();

        // Windows that cross midnight (sleep 23:00, wake 07:30) vs same-day windows.
        return sleepMinutes <= wakeMinutes
            ? nowMinutes >= sleepMinutes && nowMinutes < wakeMinutes
            : nowMinutes >= sleepMinutes || nowMinutes < wakeMinutes;
    } catch {
        return false;
    }
}

module.exports = { isUserAsleep, parseHM };
