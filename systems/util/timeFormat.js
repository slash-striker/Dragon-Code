/*
 * Shared clock helpers.
 *
 * Users read 12-hour clocks; logs and schedules are stored 24-hour. Every
 * surface that shows a time prints BOTH ("15:30 (3:30 PM)") so it is readable
 * whichever clock you are used to, and parseTimeInput() accepts either style so
 * nobody has to remember which one a command wants.
 */

function clampMinutes(minutes) {
    return ((Math.round(Number(minutes) || 0) % 1440) + 1440) % 1440;
}

/*
 * Forgiving parser → minutes after midnight, or null when the text is not a
 * time. Accepted: "15:30", "09:05", "3:30 pm", "3:30pm", "3 pm", "3pm",
 * "12 am", "3.30 pm", and a bare hour ("15" → 15:00, "3" → 03:00).
 * "24:00" is accepted as midnight — typing the end of the day instead of the
 * start of the next one is the single most common way people write bedtimes.
 */
function parseTimeInput(input) {
    if (input === null || input === undefined) return null;
    const text = String(input).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!text) return null;

    // 12-hour clock with an explicit AM/PM marker.
    const meridiem = text.match(/^(\d{1,2})(?:[:.](\d{1,2}))?\s*(a\.?m\.?|p\.?m\.?)$/);
    if (meridiem) {
        let hours = Number(meridiem[1]);
        const minutes = Number(meridiem[2] === undefined ? 0 : meridiem[2]);
        if (hours < 1 || hours > 12 || minutes > 59) return null;
        const isPm = meridiem[3].startsWith('p');
        if (hours === 12) hours = 0;
        if (isPm) hours += 12;
        return hours * 60 + minutes;
    }

    // 24-hour clock. 24:00 means midnight (it becomes 00:00).
    const clock = text.match(/^(\d{1,2})[:.](\d{2})$/);
    if (clock) {
        const hours = Number(clock[1]);
        const minutes = Number(clock[2]);
        if (minutes > 59 || hours > 24) return null;
        if (hours === 24 && minutes !== 0) return null;
        return (hours % 24) * 60 + minutes;
    }

    // Bare hour — 24-hour when it cannot be a clock face ("15"), else 3 AM.
    const bare = text.match(/^(\d{1,2})$/);
    if (bare) {
        const hours = Number(bare[1]);
        if (hours > 24) return null;
        return (hours % 24) * 60;
    }

    return null;
}

/* "15:30" */
function format24(minutes) {
    const total = clampMinutes(minutes);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/* "3:30 PM" */
function format12(minutes) {
    const total = clampMinutes(minutes);
    const hours24 = Math.floor(total / 60);
    const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
    return `${hours12}:${String(total % 60).padStart(2, '0')} ${hours24 < 12 ? 'AM' : 'PM'}`;
}

/* "3:30 PM (15:30)" — the form shown to humans. */
function formatBoth(minutes) {
    return `${format12(minutes)} (${format24(minutes)})`;
}

/* Current clock reading for a UTC offset, as minutes after midnight. */
function localMinutes(offsetHours, now = Date.now()) {
    const shifted = new Date(now + Number(offsetHours || 0) * 60 * 60 * 1000);
    return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/* "3:30pm" / "24:00" / "7" → "15:30" / "00:00" / "07:00"; null if unreadable. */
function normalizeTimeInput(value) {
    const minutes = parseTimeInput(value);
    return minutes === null ? null : format24(minutes);
}

/* "UTC+2" / "UTC-5" / "UTC" */
function offsetLabel(offsetHours) {
    const offset = Number(offsetHours);
    if (!Number.isFinite(offset)) return 'UTC';
    if (offset === 0) return 'UTC';
    return `UTC${offset > 0 ? '+' : ''}${offset}`;
}

module.exports = {
    parseTimeInput,
    normalizeTimeInput,
    format24,
    format12,
    formatBoth,
    localMinutes,
    offsetLabel
};
