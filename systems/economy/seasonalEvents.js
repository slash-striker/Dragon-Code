/*
 * Seasonal events — the calendar layer of the Dragon Economy.
 *
 * One module answers "is a season live right now, and what does it do to the
 * numbers?" so every other system can ask a single question instead of each
 * hardcoding dates. Seasons tint the month: summer doubles mining/fishing
 * yields, December hands out a gift a day, Halloween runs a candy economy.
 *
 * Everything here is derived from the UTC clock and is idempotent — the only
 * writes are the once-per-user-per-day seasonal_claims rows.
 */
const db = require('../../database');
const { logTransaction } = require('./transactionLogger');
const { SHOP_ITEMS } = require('./shopItems');

const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * SEASONS — month is 1-12 (human calendar, not the JS 0-11). A season whose
 * start month is greater than its end month wraps the new year.
 *
 * multipliers apply as plain factors: 2 means "double".
 */
const SEASONS = [
    {
        id: 'new_year',
        name: 'Neon New Year',
        emoji: '🎆',
        theme: 0xffd76e,
        start: { month: 12, day: 26 },
        end: { month: 1, day: 1 },
        multipliers: { yield: 1, credits: 1.3, xp: 1.25 },
        dailyGift: true,
        blurb: 'The grid reboots — fireworks in every wallet.'
    },
    {
        id: 'summer',
        name: 'Neon Summer Surge',
        emoji: '🌞',
        theme: 0xffb347,
        start: { month: 6, day: 1 },
        end: { month: 8, day: 31 },
        multipliers: { yield: 2, credits: 1.1, xp: 1.1 },
        dailyGift: false,
        blurb: 'The reactors run hot all summer — every haul is doubled.'
    },
    {
        id: 'halloween',
        name: 'Hollow Grid',
        emoji: '🎃',
        theme: 0xff7518,
        start: { month: 10, day: 25 },
        end: { month: 10, day: 31 },
        multipliers: { yield: 1, credits: 1.2, xp: 1.2 },
        dailyGift: true,
        blurb: 'The candy economy opens and the beasts get bold.'
    },
    {
        id: 'christmas',
        name: 'Christmas in the Grid',
        emoji: '🎄',
        theme: 0x2ecc71,
        start: { month: 12, day: 1 },
        end: { month: 12, day: 25 },
        multipliers: { yield: 1, credits: 1.25, xp: 1.15 },
        dailyGift: true,
        blurb: 'Twenty-five days of gifts, ending in the grand cache.'
    },
    {
        id: 'spring_event',
        name: 'Verdant Bloom',
        emoji: '🌸',
        theme: 0x7bd88f,
        start: { month: 3, day: 1 },
        end: { month: 4, day: 30 },
        multipliers: { yield: 1.15, credits: 1.05, xp: 1.1 },
        dailyGift: false,
        blurb: 'New veins break the surface — slightly better hauls all spring.'
    }
];

/* Per-season gift flavour. Pools only contain real SHOP_ITEMS ids. */
const GIFT_PROFILES = {
    christmas: {
        base: 15000,
        ramp: 6000,
        itemPool: ['coffee', 'energy_drink', 'lucky_dice', 'xp_boost', 'mystery_box', 'streak_protection_day', 'rob_insurance'],
        labels: ['Frosted Cache', 'Ember Bundle', 'Tinsel Drop', 'Holo-Snow Vault', 'Reindeer Relay Pack']
    },
    halloween: {
        base: 9000,
        ramp: 4000,
        itemPool: ['lucky_dice', 'mystery_box', 'energy_drink', 'rob_insurance'],
        labels: ['Candy Stash', 'Pumpkin Cache', 'Ghost Signal Pack', 'Bat Relay Bundle']
    },
    new_year: {
        base: 20000,
        ramp: 7000,
        itemPool: ['mystery_box', 'lucky_mystery', 'mega_xp_boost', 'streak_protection_week'],
        labels: ['Countdown Cache', 'Firework Vault', 'Midnight Bundle']
    },
    fallback: {
        base: 5000,
        ramp: 2000,
        itemPool: ['coffee', 'lucky_dice'],
        labels: ['Seasonal Cache']
    }
};

const EGG_RARITIES = ['common', 'common', 'uncommon', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

function toMs(nowOrDate) {
    if (nowOrDate instanceof Date) {
        const value = nowOrDate.getTime();
        return Number.isFinite(value) ? value : Date.now();
    }
    if (typeof nowOrDate === 'number' && Number.isFinite(nowOrDate)) return nowOrDate;
    return Date.now();
}

function dateKeyFor(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

function totalDaysOf(season) {
    const startUtc = Date.UTC(2001, season.start.month - 1, season.start.day);
    let endUtc = Date.UTC(2001, season.end.month - 1, season.end.day);
    if (endUtc < startUtc) endUtc = Date.UTC(2002, season.end.month - 1, season.end.day);
    return Math.round((endUtc - startUtc) / DAY_MS) + 1;
}

/*
 * Resolve the live window for a season against the current UTC clock. A
 * season that wraps the new year starts in the PREVIOUS calendar year while
 * we are still inside its January tail.
 */
function windowFor(season, ms) {
    const now = new Date(ms);
    const wraps = season.start.month > season.end.month;
    const month = now.getUTCMonth() + 1;
    const startYear = wraps && month <= season.end.month
        ? now.getUTCFullYear() - 1
        : now.getUTCFullYear();
    const startMs = Date.UTC(startYear, season.start.month - 1, season.start.day);
    const totalDays = totalDaysOf(season);
    const dayIndex = Math.floor((ms - startMs) / DAY_MS) + 1;
    if (dayIndex < 1 || dayIndex > totalDays) return null;
    return {
        startMs,
        totalDays,
        dayIndex,
        daysRemaining: totalDays - dayIndex + 1,
        dateKey: dateKeyFor(ms)
    };
}

function getActiveSeason(nowOrDate) {
    const ms = toMs(nowOrDate);
    for (const season of SEASONS) {
        const window = windowFor(season, ms);
        if (!window) continue;
        return {
            ...season,
            day: window.dayIndex,
            dayIndex: window.dayIndex,
            totalDays: window.totalDays,
            daysRemaining: window.daysRemaining,
            dateKey: window.dateKey,
            startsAt: window.startMs,
            startsAtIso: new Date(window.startMs).toISOString(),
            endsAtIso: new Date(window.startMs + (window.totalDays - 1) * DAY_MS).toISOString()
        };
    }
    return null;
}

function isSeasonActive(id, nowOrDate) {
    const active = getActiveSeason(nowOrDate);
    return Boolean(active && active.id === id);
}

/* Multiplier lookup — total by construction, so callers never branch. */
function getSeasonalMultiplier(kind, nowOrDate) {
    if (kind !== 'yield' && kind !== 'credits' && kind !== 'xp') return 1;
    try {
        const active = getActiveSeason(nowOrDate);
        if (!active || !active.multipliers) return 1;
        const value = Number(active.multipliers[kind]);
        return Number.isFinite(value) && value > 0 ? value : 1;
    } catch (error) {
        return 1;
    }
}

function validItems(items) {
    return (items || []).filter(entry => entry && SHOP_ITEMS[entry.itemId] && !SHOP_ITEMS[entry.itemId].hidden);
}

/*
 * getDailyGift — fully deterministic from (seasonId, dayIndex) so an admin can
 * preview any day and two players on the same day always see the same offer.
 */
function getDailyGift(seasonId, dayIndex) {
    const season = SEASONS.find(entry => entry.id === seasonId) || null;
    const profile = GIFT_PROFILES[seasonId] || GIFT_PROFILES.fallback;
    const day = Math.max(1, Math.floor(Number(dayIndex) || 1));
    const totalDays = season ? totalDaysOf(season) : Math.max(day, 25);
    const isGrand = day >= totalDays;
    const seed = day * 31 + seasonId.length * 7;

    const credits = isGrand
        ? profile.base * 8 + profile.ramp * totalDays
        : profile.base + profile.ramp * (day - 1);

    const itemId = profile.itemPool[seed % profile.itemPool.length];
    const items = validItems([{ itemId, quantity: isGrand ? 3 : 1 + (seed % 2) }]);

    const eggDay = season && season.dailyGift && (day % 7 === 0 || isGrand);
    const eggChance = isGrand ? 1 : eggDay ? 1 : (season && season.dailyGift ? 0.05 : 0);
    const eggRarity = isGrand
        ? 'mythic'
        : EGG_RARITIES[seed % EGG_RARITIES.length];

    return {
        label: isGrand
            ? `${season ? season.emoji : '🎁'} Grand Finale Cache`
            : `${season ? season.emoji : '🎁'} Day ${day} — ${profile.labels[(day - 1) % profile.labels.length]}`,
        day,
        credits,
        items,
        eggChance,
        eggRarity,
        grand: isGrand
    };
}

/*
 * claimDailyGift — one gift per user per season day (UTC). Everything that
 * touches money or inventory happens inside a single transaction so a retry
 * can never double-pay.
 */
function claimDailyGift(userId, now = Date.now()) {
    if (!userId) return { ok: false, message: 'Unknown user.' };
    const ms = toMs(now);
    const season = getActiveSeason(ms);
    if (!season) return { ok: false, message: 'No seasonal event is running right now.' };
    if (!season.dailyGift) {
        return { ok: false, message: `${season.emoji} **${season.name}** does not hand out daily gifts — enjoy the multipliers instead.` };
    }

    const dateKey = dateKeyFor(ms);
    const already = db.prepare(
        'SELECT 1 FROM seasonal_claims WHERE userId = ? AND event = ? AND dayKey = ?'
    ).get(userId, season.id, dateKey);
    if (already) {
        return { ok: false, message: `You already claimed today's **${season.name}** gift — come back tomorrow for day ${Math.min(season.dayIndex + 1, season.totalDays)}.` };
    }

    const gift = getDailyGift(season.id, season.dayIndex);

    try {
        db.transaction(() => {
            db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(userId);
            db.prepare(`
                INSERT INTO seasonal_claims (userId, event, dayKey, reward, claimedAt)
                VALUES (?, ?, ?, ?, ?)
            `).run(userId, season.id, dateKey, gift.label, new Date(ms).toISOString());

            if (gift.credits > 0) {
                db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?')
                    .run(gift.credits, userId);
                logTransaction(userId, 'seasonal_gift', gift.credits, `${season.name} — ${gift.label}`);
            }

            for (const entry of gift.items) {
                db.prepare(`
                    INSERT INTO inventory (userId, itemId, quantity) VALUES (?, ?, ?)
                    ON CONFLICT(userId, itemId) DO UPDATE SET quantity = quantity + excluded.quantity
                `).run(userId, entry.itemId, entry.quantity);
            }
        })();
    } catch (error) {
        console.error('Seasonal gift claim failed:', error);
        return { ok: false, message: 'The gift pipeline jammed — please try again in a moment.' };
    }

    /* Eggs are owned by the dragon hatchery; grant one when it is available. */
    let eggGranted = null;
    if (gift.eggChance > 0 && Math.random() < gift.eggChance) {
        try {
            const dragons = require('../dragons/dragonManager');
            if (dragons && typeof dragons.grantEgg === 'function') {
                eggGranted = dragons.grantEgg(userId, {
                    source: `seasonal:${season.id}`,
                    rarity: gift.eggRarity
                });
            }
        } catch (error) {
            eggGranted = null;
        }
    }

    const itemLines = gift.items.length
        ? gift.items.map(entry => `📦 ${SHOP_ITEMS[entry.itemId]?.name || entry.itemId} ×${entry.quantity}`).join('\n')
        : null;

    const lines = [
        `${gift.label}`,
        '',
        `🪙 **${gift.credits.toLocaleString()}** credits added to your wallet.`,
        itemLines,
        eggGranted ? '🥚 An egg was tucked into the crate — check `/profile`.' : null,
        !eggGranted && gift.eggChance > 0 ? '_A faint tapping came from the crate, but nothing hatched yet._' : null
    ].filter(Boolean);

    return {
        ok: true,
        gift,
        dayIndex: season.dayIndex,
        eggGranted,
        message: lines.join('\n')
    };
}

function describeSeason(now = Date.now()) {
    const season = getActiveSeason(now);
    if (!season) return 'No seasonal event active — the grid runs on standard rates.';
    const extras = [];
    if (season.multipliers.yield !== 1) extras.push(`×${season.multipliers.yield} yields`);
    if (season.multipliers.credits !== 1) extras.push(`×${season.multipliers.credits} credits`);
    if (season.multipliers.xp !== 1) extras.push(`×${season.multipliers.xp} XP`);
    if (season.dailyGift) extras.push('daily gift claimable');
    return `${season.emoji} **${season.name}** — day ${season.dayIndex} of ${season.totalDays}`
        + (extras.length ? ` · ${extras.join(' · ')}` : '');
}

function getSeasonHighlights(now = Date.now()) {
    const season = getActiveSeason(now);
    if (!season) {
        return [
            'No seasonal event is live right now.',
            `Next up: ${SEASONS.map(s => `${s.emoji} ${s.name}`).join(', ')} — each runs on its own UTC window.`
        ];
    }
    const highlights = [
        `${season.emoji} **${season.name}** (${season.id}) is LIVE.`,
        `Window: day ${season.dayIndex} of ${season.totalDays} — ${season.daysRemaining} day(s) remaining.`,
        `Multipliers: yield ×${season.multipliers.yield} · credits ×${season.multipliers.credits} · xp ×${season.multipliers.xp}`,
        season.dailyGift ? 'Daily gifts: ENABLED (one claim per user per UTC day).' : 'Daily gifts: disabled for this season.',
        `Today's gift preview: ${getDailyGift(season.id, season.dayIndex).label}`
    ];
    if (season.dailyGift) {
        const claimed = db.prepare(
            'SELECT COUNT(*) AS claimed FROM seasonal_claims WHERE event = ? AND dayKey = ?'
        ).get(season.id, dateKeyFor(toMs(now)))?.claimed || 0;
        highlights.push(`Claims today: **${claimed}**`);
    }
    return highlights;
}

module.exports = {
    SEASONS,
    GIFT_PROFILES,
    getActiveSeason,
    isSeasonActive,
    getSeasonalMultiplier,
    getDailyGift,
    claimDailyGift,
    describeSeason,
    getSeasonHighlights
};
