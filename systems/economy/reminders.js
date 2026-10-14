/*
 * Reminders — the data layer behind /remind.
 *
 * Players schedule a delayed alert ("/remind in 2h claim the contract"). This
 * module only writes and reads the `reminders` table; the economy scheduler
 * (systems/economy/economyScheduler.js) polls getDueReminders() every minute
 * and DMs the owner, then calls markDelivered(). Nothing here imports
 * discord.js so the parsing and lifecycle stay unit-testable.
 *
 * Durations accept Forms like `45s`, `90m`, `2h`, `1d`, `2h30m`, or a bare
 * number (read as minutes). The shortest reminder is one minute and the
 * longest is thirty days.
 */
const db = require('../../database');

const MIN_MS = 60 * 1000;
const MAX_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PENDING = 10;
const MAX_TEXT = 400;

const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
const UNIT_NAME = { d: 'day', h: 'hour', m: 'minute', s: 'second' };
const UNIT_ORDER = ['d', 'h', 'm', 's'];

function buildLabel(parts) {
    const chunks = [];
    for (const unit of UNIT_ORDER) {
        const value = Number(parts[unit] || 0);
        if (!value) continue;
        const name = UNIT_NAME[unit];
        chunks.push(`${value} ${name}${value === 1 ? '' : 's'}`);
    }
    return chunks.join(' ') || 'a moment';
}

function humanizeMs(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${Math.max(1, total)}s`;
}

/*
 * Parse a delay out of free text. Returns { ok, ms, label } on success and
 * { ok: false, message } with a user-facing hint on failure. Unparsed
 * leftovers (e.g. "2h pancakes") are rejected instead of silently guessed.
 */
function parseDuration(input) {
    if (input === null || input === undefined) {
        return { ok: false, message: 'Give me a delay like `2h`, `90m` or `1d`.' };
    }

    const raw = String(input).trim().toLowerCase().replace(/\s+/g, '');
    if (!raw) return { ok: false, message: 'Give me a delay like `2h`, `90m` or `1d`.' };

    // A bare number is read as minutes: "/remind 30 …".
    if (/^\d+$/.test(raw)) {
        const minutes = Number(raw);
        return { ok: true, ms: minutes * UNIT_MS.m, label: buildLabel({ m: minutes }) };
    }

    const pattern = /(\d+)(s|m|h|d)/g;
    const parts = {};
    let consumed = 0;
    let match = pattern.exec(raw);
    while (match) {
        const value = Number(match[1]);
        const unit = match[2];
        parts[unit] = (parts[unit] || 0) + value;
        consumed += match[0].length;
        match = pattern.exec(raw);
    }

    if (!consumed || consumed !== raw.length) {
        return { ok: false, message: 'I could not read that delay. Try `45m`, `2h`, `1d` or `2h30m`.' };
    }

    const ms = Object.entries(parts).reduce((sum, [unit, value]) => sum + value * UNIT_MS[unit], 0);
    if (!Number.isFinite(ms) || ms <= 0) {
        return { ok: false, message: 'That delay adds up to nothing — use at least `1m`.' };
    }
    return { ok: true, ms, label: buildLabel(parts) };
}

function countPending(userId) {
    const row = db.prepare('SELECT COUNT(*) AS total FROM reminders WHERE userId = ? AND delivered = 0').get(userId);
    return Number(row?.total || 0);
}

/*
 * Store a reminder. dueInMs is clamped into the supported window (the caller
 * gets a `message` note when that happened so it can tell the user).
 */
function createReminder({ userId, channelId = null, message, dueInMs, now = Date.now() }) {
    const text = String(message ?? '').trim();
    if (!text) return { ok: false, message: 'Tell me what to remind you about.' };
    if (text.length > MAX_TEXT) return { ok: false, message: `Keep the reminder under ${MAX_TEXT} characters.` };
    if (!Number.isFinite(dueInMs)) return { ok: false, message: 'I could not read that delay.' };

    let delay = Math.round(dueInMs);
    let note = null;
    if (delay < MIN_MS) {
        delay = MIN_MS;
        note = 'Shortest reminder is 1 minute — I set it for 1 minute from now.';
    }
    if (delay > MAX_MS) {
        delay = MAX_MS;
        note = 'Longest reminder is 30 days — I set it for 30 days from now.';
    }

    const pending = countPending(userId);
    if (pending >= MAX_PENDING) {
        return { ok: false, message: `You already have ${MAX_PENDING} reminders waiting. Cancel one with \`/remind list\` first.` };
    }

    const info = db.prepare(`
        INSERT INTO reminders (userId, channelId, message, dueAt, createdAt, delivered)
        VALUES (?, ?, ?, ?, ?, 0)
    `).run(userId, channelId ? String(channelId) : null, text, now + delay, now);

    const reminder = db.prepare('SELECT * FROM reminders WHERE reminderId = ?').get(info.lastInsertRowid);
    return { ok: true, reminder, message: note };
}

function getDueReminders(now = Date.now()) {
    return db.prepare(`
        SELECT * FROM reminders
        WHERE delivered = 0 AND dueAt <= ?
        ORDER BY dueAt ASC
    `).all(now);
}

function markDelivered(reminderId, now = Date.now()) {
    const info = db.prepare('UPDATE reminders SET delivered = ? WHERE reminderId = ? AND delivered = 0')
        .run(now, reminderId);
    return info.changes === 1;
}

function listPending(userId, now = Date.now()) {
    return db.prepare(`
        SELECT * FROM reminders
        WHERE userId = ? AND delivered = 0
        ORDER BY dueAt ASC
    `).all(userId);
}

function cancelReminder(userId, reminderId) {
    const info = db.prepare('DELETE FROM reminders WHERE reminderId = ? AND userId = ? AND delivered = 0')
        .run(reminderId, userId);
    if (info.changes !== 1) {
        return { ok: false, message: 'That reminder is not yours, or it already fired.' };
    }
    return { ok: true, message: 'Reminder cancelled.' };
}

function describePending(userId, now = Date.now()) {
    return listPending(userId, now).map(reminder => {
        const when = reminder.dueAt <= now ? 'due now' : `in ${humanizeMs(reminder.dueAt - now)}`;
        return `⏰ ${when} — \`${reminder.message}\` (id ${reminder.reminderId})`;
    });
}

/*
 * Render payload for the scheduler's DM. Deliberately a plain object so this
 * module never has to depend on discord.js.
 */
function buildDueEmbed(reminder) {
    return {
        title: '⏰ REMINDER',
        description: [
            'You asked to be reminded:',
            '',
            `**${reminder.message}**`,
            '',
            `_Scheduled <t:${Math.floor(Number(reminder.dueAt) / 1000)}:R> · set another with \`/remind\`._`
        ].join('\n')
    };
}

module.exports = {
    MIN_MS,
    MAX_MS,
    MAX_PENDING,
    parseDuration,
    humanizeMs,
    createReminder,
    getDueReminders,
    markDelivered,
    listPending,
    countPending,
    cancelReminder,
    describePending,
    buildDueEmbed
};
