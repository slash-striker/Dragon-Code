const {
    Events,
} = require('discord.js');
const db = require('../database');
const quoteLogger = require('../systems/games/quoteLogger');
const { isUserAsleep } = require('../systems/util/sleepSchedule');

const OWNER_USER_ID = '1466461677783351447';
const TARGET_USER_ID = '1505829367631183963';
const LIGHT_USER_ID = '1543876836209991682';

/*
 * Keyword triggers — mention any of these words (or a one-letter typo of
 * them, e.g. "salshy" for "slashy") and the OWNER USER is pinged with a
 * compact summon panel. Directly mentioning the owner user gets a "he will
 * be here momentarily" response instead. Both are suppressed when the target
 * user (1505829367631183963) is mentioned — that gets a 👀 only.
 */
const KEYWORDS = ['sassy', 'slashstriker', 'slash striker', 'Slashstriker', 'SlashStriker', 'SLASH', 'slashy', 'salshy', 'slishy', 'slash', 'striker', 'salsh', 'slahs', 'Slahs', 'Slash', 'lsash', 'str1ker', 'スラッシー', 'Slasy', 'sslash', 'aslash', 'zzslash', 'zslash', 'slasht', 'slashstr1ker_', 'str1ker', 'slhs', 'sl;ash', 'sl;sh', 'sla;sh', 's;lash', 's;ash', 's;las', 's;lsah', 's;lsah', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 'slas;h', 'slas;h', 'sl;ash', 's;lash', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 's;lashy', 's;lashy'];

/*
 * ⚡ Light's own summon keywords — same fuzzy one-edit matching as SLASH's,
 * but with NO phrase triggers (so "help me" keeps summoning SLASH, not
 * Light). Checked independently of the slash mute.
 */
const LIGHT_KEYWORDS = ['light', "grok", "GROK", "grko", "gork", "orgk"];

/*
 * Multi-word triggers — matched as an exact consecutive word pair/phrase
 * anywhere in the message ("can you help me build this" fires; the fuzzy
 * one-edit tolerance deliberately does NOT apply to phrases so random
 * sentences can't summon him).
 */
const PHRASES = ['help me', 'are you there', 'need slash', 'summon slash', 'where is slash', 'I need help', 'someone help me', 'pls delete', 'scam links', 'scam link', 'scam photos', 'scam image'];

/*
 * 📦 Panels are PLAIN TEXT now — no embeds — so they stay small and don't
 * eat half the chat. Same jokes, same tags, way less space.
 */

const FUNNY_HEADERS = [
    '📡 UPLINK ESTABLISHED',
    '🛸 SUMMON INITIATED',
    '⚡ BEACON DEPLOYED',
    '🚨 INCOMING SIGNAL',
    '🔌 NEURAL LINK ENGAGED',
    '💾 PACKET ROUTED',
];

const FUNNY_LINES = [
    'Sacred words spoken. Drone dispatched. 🛸',
    'Beacon away. Impact imminent. 🎯',
    'The dragon has been poked. 🐉',
    'Ping launched at lightspeed. ETA: soon™.',
    'Keyword reactor critical. Boss notified.',
    'BEEP BOOP — he\'s been pinged.',
    'Signal boosted 300%. He heard that.',
    'Summon ritual complete. He approaches.',
    'Paged so hard his bell filed a complaint.',
    'Quantum ping: sent mid-keystroke. ⚛️',
    'Packet loss 0%. He\'s been pinged.',
    'One (1) boss summoned. It worked.',
    'Broadcast on all frequencies. He knows.',
    'Notification laser fired. 💥 Direct hit.',
    'Now orbiting the boss\'s inbox.',
    'Alert level MAXIMUM. Summon deployed.',
    'Drone fleet delivered your ping. 📨',
    'He knows you seek him. He comes.',
];

const MOMENTARY_LINES = [
    'He will be here momentarily.',
    'Ping registered. He comes.',
    'Summon acknowledged. En route.',
    'Queued at priority HIGH.',
    'The machines have informed him.',
    'Direct ping delivered. Hold tight.',
];

const SLEEP_OUTRO = [
    'Ping stored in cold storage until reboot. 💤',
    'Message buffered — delivery at first light.',
    'The dragon rests. The machines remain vigilant.',
    'The queue never sleeps, even when he does.',
];

/*
 * A message from the owner within this window counts as "definitely awake",
 * even if the stored schedule says otherwise (schedules go stale; activity
 * does not lie).
 */
const RECENT_ACTIVITY_WINDOW_MS = 20 * 60 * 1000;

/*
 * Slash-ping kill switch — the host can mute his own summon/mention
 * notifications with /toggle-ping ping:slash. Stored in ping_subscriptions
 * as (host, 'slash'); a missing row means ON so the default behaviour is
 * unchanged until the host flips it the first time.
 */
function slashPingEnabled() {
    try {
        const row = db.prepare(
            'SELECT enabled FROM ping_subscriptions WHERE userId = ? AND command = ?'
        ).get(OWNER_USER_ID, 'slash');
        return row ? Boolean(row.enabled) : true;
    } catch {
        return true;
    }
}

/*
 * Light-ping kill switch — mirrors slashPingEnabled. Light mutes his own
 * summon panels via /toggle-ping ping:light (the host can flip it for him).
 * Stored as (LIGHT_USER_ID, 'light'); missing row = ON.
 */
function lightPingEnabled() {
    try {
        const row = db.prepare(
            'SELECT enabled FROM ping_subscriptions WHERE userId = ? AND command = ?'
        ).get(LIGHT_USER_ID, 'light');
        return row ? Boolean(row.enabled) : true;
    } catch {
        return true;
    }
}

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

/*
 * Typo tolerance — a word counts when it IS a keyword or sits within ONE
 * edit of one (Damerau-Levenshtein: substitution, single insert/delete, or
 * an adjacent swap each count as one edit). That is what makes "salshy",
 * "slahsy" or "strikerz" still summon. The length floor keeps tiny words
 * out of fuzzy range so random short words can't trip the ping.
 */
function withinOneEdit(a, b) {
    if (a === b) return true;
    const lenA = a.length;
    const lenB = b.length;
    if (Math.abs(lenA - lenB) > 1) return false;
    const d = Array.from({ length: lenA + 1 }, () => new Array(lenB + 1).fill(0));
    for (let i = 0; i <= lenA; i++) d[i][0] = i;
    for (let j = 0; j <= lenB; j++) d[0][j] = j;
    for (let i = 1; i <= lenA; i++) {
        for (let j = 1; j <= lenB; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
            }
        }
    }
    return d[lenA][lenB] <= 1;
}

const MIN_FUZZY_WORD_LENGTH = 4;

/*
 * 🚫 PING-RATE LIMITER — spam protection for BOTH summon systems.
 *
 * If the same pinger fires 2 summon pings within PING_SPAM_WINDOW_MS,
 * the target (slash OR light — they share one lockout) goes quiet for
 * that user until the lockout expires. Protects slash and light's DMs
 * and channels from keyword-spam summons without touching direct
 * mentions (mentioning the user always answers normally).
 */
const PING_SPAM_WINDOW_MS = 60 * 1000;      // 3 pings within 1 minute…
const PING_SPAM_LIMIT = 3;                  // …trips the lockout
const PING_SPAM_LOCKOUT_MS = 10 * 60 * 1000; // …for the next 10 minutes

function ensurePingRateTable() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS ping_rate_limit (
            userId   TEXT NOT NULL,
            target   TEXT NOT NULL,
            pingedAt INTEGER NOT NULL
        )
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS ping_lockouts (
            userId      TEXT PRIMARY KEY,
            lockedUntil INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_ping_rate_user ON ping_rate_limit(userId, target)');
}

/**
 * Check whether `userId` may summon right now. On an allowed ping this
 * records the attempt inside the sliding window; a THIRD attempt inside
 * the window still goes through but starts a lockout — the NEXT attempt
 * (fourth message) is refused with a “don't spam” notice. While locked,
 * pings are refused without recording anything (waiting, not spamming,
 * clears it).
 */
function checkPingRate(userId) {
    ensurePingRateTable();
    const now = Date.now();
    try {
        // Sliding window: forget attempt rows older than the window.
        db.prepare('DELETE FROM ping_rate_limit WHERE pingedAt <= ?').run(now - PING_SPAM_WINDOW_MS);

        // Shared lockout — earned on slash or light, blocks both.
        const lock = db.prepare('SELECT lockedUntil FROM ping_lockouts WHERE userId = ?').get(userId);
        if (lock && lock.lockedUntil > now) {
            const minutes = Math.max(1, Math.ceil((lock.lockedUntil - now) / 60000));
            return {
                allowed: false,
                reason: `🚫 Don't spam the summon words — you've been locked out for **${minutes} minute${minutes === 1 ? '' : 's'}**. Wait it out, then try again.`
            };
        }

        const count = db.prepare(
            'SELECT COUNT(*) AS n FROM ping_rate_limit WHERE userId = ?'
        ).get(userId)?.n || 0;

        if (count + 1 >= PING_SPAM_LIMIT) {
            // This ping still goes through (it is the second) but trips the lock —
            // the pinger's NEXT summon inside the window is the refused one.
            db.prepare('INSERT INTO ping_rate_limit (userId, target, pingedAt) VALUES (?, ?, ?)')
                .run(userId, 'summon', now);
            db.prepare(`
                INSERT INTO ping_lockouts (userId, lockedUntil) VALUES (?, ?)
                ON CONFLICT(userId) DO UPDATE SET lockedUntil = excluded.lockedUntil
            `).run(userId, now + PING_SPAM_LOCKOUT_MS);
            return { allowed: true, locked: true };
        }

        db.prepare('INSERT INTO ping_rate_limit (userId, target, pingedAt) VALUES (?, ?, ?)')
            .run(userId, 'summon', now);
        return { allowed: true };
    } catch {
        // If the tables cannot be created, fail OPEN — pings always work.
        return { allowed: true };
    }
}

function findKeyword(content, keywords = KEYWORDS, phrases = PHRASES, options = {}) {
    const { exactOnly = false } = options;
    if (!content) return null;
    const words = content.toLowerCase().match(/[a-z]+/g) ?? [];
    // Multi-word phrases first ("help me", "come here"...) — exact consecutive
    // sequence, no fuzzy tolerance so ordinary sentences can't trigger it.
    if (phrases.length && words.length >= 2) {
        for (const phrase of phrases) {
            const parts = phrase.split(' ');
            for (let i = 0; i <= words.length - parts.length; i++) {
                if (parts.every((part, offset) => words[i + offset] === part)) return phrase;
            }
        }
    }
    // Exact keyword hits so 'salshy' reports itself rather than a fuzzy cousin.
    for (const word of words) {
        if (keywords.includes(word)) return word;
    }
    // Then one-edit typos ('slahsy' → slashy, 'strikers' → striker).
    // Skipped entirely for exact-only keyword sets: Light's "light" must be
    // typed as "light" — fuzzy matching made "right" ping him too.
    if (exactOnly) return null;
    for (const word of words) {
        if (word.length < MIN_FUZZY_WORD_LENGTH) continue;
        for (const keyword of keywords) {
            if (withinOneEdit(word, keyword)) return keyword;
        }
    }
    return null;
}

/*
 * Live status from the gateway presence cache (ships with the Guilds intent,
 * no privileged Presence intent required). 'idle' counts as awake — Discord
 * only sets it after real client activity, so the user is at their device.
 */
function getPresenceStatus(client) {
    try {
        const guild = client?.guilds?.cache?.first();
        const member = guild?.members?.cache?.get(OWNER_USER_ID);
        return member?.presence?.status ?? null;
    } catch {
        return null;
    }
}

/*
 * Recent owner activity, most-reliable source first:
 *   1. lastSeenAt (updated by handleXP on every counted message)
 *   2. MAX(createdAt) over the owner's messages in the log/messages DB
 *   3. MIN over the guild's text channels of MAX(createdAt) — the owner may
 *      have no messages in the small channel set the DB covers.
 */
async function getMinutesSinceLastActivity(client) {
    try {
        const row = db.prepare(
            'SELECT lastSeenAt FROM users WHERE userId = ?'
        ).get(OWNER_USER_ID);
        if (row?.lastSeenAt) {
            const seen = Date.parse(row.lastSeenAt);
            if (!Number.isNaN(seen)) {
                const minutes = (Date.now() - seen) / 60000;
                if (minutes >= 0) return minutes;
            }
        }

        if (client) {
            const guild = client.guilds?.cache?.first();
            if (guild) {
                // If the messages DB tracks authors, trust the owner's latest message.
                try {
                    const latest = db.prepare(
                        'SELECT MAX(createdAt) AS createdAt FROM messages WHERE authorId = ?'
                    ).get(OWNER_USER_ID);
                    if (latest?.createdAt) {
                        const seen = Date.parse(latest.createdAt);
                        if (!Number.isNaN(seen)) {
                            const minutes = (Date.now() - seen) / 60000;
                            if (minutes >= 0) return minutes;
                        }
                    }
                } catch { /* no messages table or different column names */ }

                // Fall back to scanning channels for the owner's newest message.
                const timeouts = [];
                const withTimeout = (promise, ms) => {
                    const timer = setTimeout(() => timeouts.push(() => promise.catch(() => {})), ms);
                    return promise.finally(() => clearTimeout(timer));
                };
                let newest = 0;
                for (const channel of guild.channels.cache.values()) {
                    if (!channel.isTextBased?.() || channel.type === 4) continue;
                    try {
                        const msgs = await withTimeout(channel.messages.fetch({ limit: 5 }), 4000);
                        for (const msg of msgs.values()) {
                            if (msg.author.id === OWNER_USER_ID) {
                                newest = Math.max(newest, msg.createdTimestamp);
                            }
                        }
                    } catch { /* missing permissions or fetch error */ }
                }
                await Promise.allSettled(timeouts.map(fn => fn()));
                if (newest) return (Date.now() - newest) / 60000;
            }
        }

        return null;
    } catch {
        return null;
    }
}

/*
 * Sleep detection, most-reliable signal first:
 *   1. LIVE PRESENCE   — online/idle/dnd in the gateway cache  → definitely awake.
 *   2. RECENT ACTIVITY — the owner messaged within 20 minutes  → definitely awake.
 *   3. SCHEDULE        — the /set-sleep window (only trusted when 1 and 2 are silent).
 *
 * This kills the false "he is asleep" panels: previously a stale or
 * mis-entered schedule claimed sleep even while the owner was chatting.
 *
 * Returns { asleep, awakeOverride, wakeTime, timezoneOffset, ... } or null
 * when no schedule exists.
 */
async function getSleepState(client) {
    try {
        const row = db.prepare(
            'SELECT timezone, wakeTime, sleepTime FROM users WHERE userId = ?'
        ).get(OWNER_USER_ID);
        if (!row || !row.wakeTime || !row.sleepTime) return null;

        const parseHM = value => {
            const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
            if (!match) return null;
            const hours = Number(match[1]);
            const minutes = Number(match[2]);
            if (hours > 23 || minutes > 59) return null;
            return hours * 60 + minutes;
        };

        const wakeMinutes = parseHM(row.wakeTime);
        const sleepMinutes = parseHM(row.sleepTime);
        if (wakeMinutes === null || sleepMinutes === null) return null;

        const offset = Number.parseInt(row.timezone ?? '0', 10) || 0;

        // Recent activity is the strongest awake signal — a message minutes old
        // cannot lie, while gateway presence can go stale. Presence is the
        // fallback; only when both are silent is the schedule trusted.
        const minutesSinceActivity = await getMinutesSinceLastActivity(client);
        const presence = getPresenceStatus(client);
        const liveStatuses = ['online', 'idle', 'dnd'];
        const definitelyAwake =
            (minutesSinceActivity !== null &&
                minutesSinceActivity * 60 * 1000 <= RECENT_ACTIVITY_WINDOW_MS) ||
            liveStatuses.includes(presence);

        // "Now" in the owner's timezone via the offset-shift trick.
        const now = new Date(Date.now() + offset * 60 * 60 * 1000);
        const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

        // Window crossing midnight (e.g. sleep 23:00, wake 07:30) vs same-day.
        const asleep = sleepMinutes <= wakeMinutes
            ? nowMinutes >= sleepMinutes && nowMinutes < wakeMinutes
            : nowMinutes >= sleepMinutes || nowMinutes < wakeMinutes;

        if (!asleep) {
            return { asleep: false, awakeOverride: false, wakeTime: row.wakeTime, timezoneOffset: offset };
        }

        // Schedule says asleep — but live signals outrank it.
        if (definitelyAwake) {
            return { asleep: false, awakeOverride: true, wakeTime: row.wakeTime, timezoneOffset: offset };
        }

        // Next wake: today at wakeTime if still ahead (owner-timezone), else
        // tomorrow. Computed in the shifted frame, then converted back to REAL
        // epoch time (the shifted frame is off by exactly `offset` hours) so
        // Discord's <t:...:R> countdown renders correctly.
        const nextWake = new Date(now.getTime());
        nextWake.setUTCHours(Math.floor(wakeMinutes / 60), wakeMinutes % 60, 0, 0);
        if (nextWake.getTime() <= now.getTime()) {
            nextWake.setUTCDate(nextWake.getUTCDate() + 1);
        }
        return {
            asleep: true,
            awakeOverride: false,
            wakeTime: row.wakeTime,
            timezoneOffset: offset,
            nextWakeTimestamp: Math.floor((nextWake.getTime() - offset * 60 * 60 * 1000) / 1000)
        };
    } catch {
        return null;
    }
}

/*
 * Plain-text panels — no embeds, so they render as one compact message.
 * Everything after the first line is a blockquote ("> ") which Discord
 * collapses visually into a tidy grey strip.
 */
function targetLine(targetUserId, state) {
    let line = `> 🎯 Target: <@${targetUserId}>`;
    if (state?.asleep) {
        line += '\n> 💤 Host in SLEEP_MODE — delivery on next boot.';
    }
    return line;
}

function buildSummonPanel(state, targetUserId = OWNER_USER_ID) {
    return `${pick(FUNNY_HEADERS)} — ${pick(FUNNY_LINES)}\n${targetLine(targetUserId, state)}`;
}

function buildMomentaryPanel(state, targetUserId = OWNER_USER_ID) {
    if (state?.asleep) {
        const offsetLabel = `UTC${state.timezoneOffset >= 0 ? '+' : ''}${state.timezoneOffset}`;
        return [
            `> 💤 **HOST CURRENTLY OFFLINE** — SLEEP_MODE`,
            `> REBOOT .. ${state.wakeTime} (${offsetLabel})`,
            `> ⏰ Boots again <t:${state.nextWakeTimestamp}:R>`,
            `> ${pick(SLEEP_OUTRO)}`,
            `> 🎯 Target: <@${targetUserId}>`,
        ].join('\n');
    }
    return `${pick(MOMENTARY_LINES)}\n${targetLine(targetUserId, state)}`;
}

module.exports = {
    name: Events.MessageCreate,
    findKeyword,
    slashPingEnabled,
    checkPingRate,
    async execute(message) {
        try {
            if (!message.guild || message.author?.bot) return;

            const mentionedUserIds = message.mentions?.users?.map(user => user.id) ?? [];
            const targetPinged = mentionedUserIds.includes(TARGET_USER_ID);

            /*
             * 📼 QUOTE LOGGER — pinging the watch emoji (949479338275913799)
             * archives the PINGED message (or the replied-to message) for QOTD:
             * what was said and who said it — never who pinged.
             */
            if (quoteLogger.messagePingsWatchEmoji(message)) {
                let source = null;
                if (message.reference?.messageId) {
                    source = await message.channel.messages
                        .fetch(message.reference.messageId).catch(() => null);
                }
                if (!source && mentionedUserIds.length === 0 && !message.reference) {
                    // No reply target — nothing sensible to archive.
                    source = null;
                }
                if (source?.author && !source.author.bot) {
                    const saved = await quoteLogger.logQuote(source, message.client);
                    if (saved) {
                        await quoteLogger.confirmLog(message.channel, source, message.author.id);
                        message.react('📼').catch(() => {});
                    }
                } else if (!source) {
                    message.reply({
                        content: '📼 Reply to a message with this emoji to archive it for QOTD.',
                        allowedMentions: { parse: [] }
                    }).then(r => setTimeout(() => r.delete().catch(() => {}), 8_000)).catch(() => {});
                }
                // Emoji-ping messages do their logging and nothing else.
                return;
            }

            // 👀 reaction whenever the target user is mentioned — always, and alone.
            if (targetPinged) {
                message.react('👀').catch(() => {});
            }

            // Any mention of the target suppresses the summon/reply logic entirely.
            if (targetPinged) return;

            /*
             * 🚫 PING-RATE LIMIT — one shared check for BOTH summon systems
             * (slash + light). Three summon pings (keyword OR direct mention)
             * within one minute lock the pinger out of BOTH targets for ten
             * minutes. The owner and Light are exempt — they cannot lock
             * themselves out of their own summons.
             */
            const summonsRequested =
                mentionedUserIds.includes(OWNER_USER_ID) ||
                mentionedUserIds.includes(LIGHT_USER_ID) ||
                Boolean(findKeyword(message.content)) ||
                Boolean(findKeyword(message.content, LIGHT_KEYWORDS, [], { exactOnly: true }));
            if (summonsRequested &&
                message.author.id !== OWNER_USER_ID &&
                message.author.id !== LIGHT_USER_ID) {
                const rate = checkPingRate(message.author.id);
                if (!rate.allowed) {
                    await message.reply({
                        content: rate.reason,
                        allowedMentions: { parse: [] }
                    }).then(r => setTimeout(() => r.delete().catch(() => {}), 30_000))
                      .catch(() => {});
                    return;
                }
            } else if (summonsRequested) {
                // Owner/Light self-summons bypass the limiter entirely.
                db.prepare('DELETE FROM ping_rate_limit WHERE userId = ?').run(message.author.id);
            }

            /*
             * SLASH panels — keywords + direct mentions. Panels ALWAYS fire:
             * presence-based suppression was removed, so the host gets pinged
             * even while he is online. Fully silenced only via
             * /toggle-ping ping:slash (the 👀 reaction above still fires).
             */
            // The host never summons himself, and nothing pings him during his own sleep window.
            const slashActive = slashPingEnabled() && message.author.id !== OWNER_USER_ID && !isUserAsleep(OWNER_USER_ID);
            if (slashActive) {
                const ownerUserPinged = mentionedUserIds.includes(OWNER_USER_ID);
                const keyword = findKeyword(message.content);

                // Direct mention of the owner → "he will be here momentarily".
                if (ownerUserPinged) {
                    const state = await getSleepState(message.client);
                    await message.reply({
                        content: buildMomentaryPanel(state),
                        allowedMentions: { parse: [] }, // never add extra pings
                    }).catch(() => {});
                    return;
                }

                // Keyword → ping the OWNER USER with the summon panel.
                if (keyword) {
                    const state = await getSleepState(message.client);
                    await message.reply({
                        content: `<@${OWNER_USER_ID}>\n${buildSummonPanel(state)}`,
                        allowedMentions: { users: [OWNER_USER_ID], parse: [] },
                    }).catch(() => {});
                    return;
                }
            } else if (
                message.author.id !== OWNER_USER_ID && (
                    mentionedUserIds.includes(OWNER_USER_ID) ||
                    findKeyword(message.content)
                )
            ) {
                console.log(
                    '[slash-ping] muted — suppressed a trigger in #' + (message.channel?.name ?? message.channelId)
                );
            }

            /*
             * ⚡ LIGHT (Lightning) — his own summon system, with its own mute:
             * /toggle-ping ping:light (Light or the host). Direct mention →
             * "momentarily" panel; keywords ("light", "lightning" + one-edit
             * typos) ping him.
             */
            const lightUserPinged = mentionedUserIds.includes(LIGHT_USER_ID);
            const lightKeyword = findKeyword(message.content, LIGHT_KEYWORDS, [], { exactOnly: true });

            // Light never summons himself, and nothing pings him during his own sleep window.
            const lightActive = lightPingEnabled() && message.author.id !== LIGHT_USER_ID && !isUserAsleep(LIGHT_USER_ID);
            if (lightActive) {
                if (lightUserPinged) {
                    await message.reply({
                        content: buildMomentaryPanel(null, LIGHT_USER_ID),
                        allowedMentions: { parse: [] },
                    }).catch(() => {});
                    return;
                }

                if (lightKeyword) {
                    await message.reply({
                        content: `<@${LIGHT_USER_ID}>\n${buildSummonPanel(null, LIGHT_USER_ID)}`,
                        allowedMentions: { users: [LIGHT_USER_ID], parse: [] },
                    }).catch(() => {});
                }
            } else if (message.author.id !== LIGHT_USER_ID && (lightUserPinged || lightKeyword)) {
                console.log(
                    '[light-ping] muted — suppressed a trigger in #' + (message.channel?.name ?? message.channelId)
                );
            }
        } catch (error) {
            console.error('mentionWatcher error:', error);
        }
    },
};
