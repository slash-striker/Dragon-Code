/*
 * Flash deals — the daily roguelike discount.
 *
 * Every UTC midnight 2-3 random shop items go on a 24h flash sale at either
 * -20% or -50%. The roll is idempotent per calendar day, so a restart (or the
 * minute scheduler firing repeatedly) can never reroll the day's picks, and
 * /shop trawling for the discounted price is always safe.
 *
 * SLASH services and premium items are excluded on purpose: those are
 * fulfilled personally, so a discount would just be a promise to discount.
 */
const db = require('../../database');
const { SHOP_ITEMS } = require('./shopItems');

const DISCOUNTS = [20, 50];
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 7;

function dateKeyFor(now) {
    return new Date(now).toISOString().slice(0, 10);
}

function startOfUtcDay(now) {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/*
 * Only stackable / instantly-fulfilled items can be discounted. Hidden items
 * are secret (SMI) and services/premium are built by hand.
 */
function eligibleItems() {
    return Object.values(SHOP_ITEMS).filter(item =>
        item && !item.hidden && item.category !== 'services' && item.category !== 'premium'
    );
}

function purgeOldDeals(now) {
    db.prepare('DELETE FROM flash_deals WHERE endsAt < ?').run(now - KEEP_DAYS * DAY_MS);
}

function dealsForDate(dateKey) {
    return db.prepare('SELECT * FROM flash_deals WHERE dateKey = ? ORDER BY dealId ASC').all(dateKey);
}

function insertDeal(itemId, discount, dateKey, startsAt, endsAt) {
    db.prepare(`
        INSERT INTO flash_deals (itemId, discount, dateKey, startsAt, endsAt)
        VALUES (?, ?, ?, ?, ?)
    `).run(itemId, discount, dateKey, startsAt, endsAt);
}

/*
 * Roll (or return) the deals for the UTC day containing `now`.
 * `force` re-rolls the current day — that is the admin path only.
 */
function rollDailyDeals(now = Date.now(), force = false) {
    const dateKey = dateKeyFor(now);
    purgeOldDeals(now);

    const existing = dealsForDate(dateKey);
    if (existing.length && !force) return existing;

    if (existing.length && force) {
        db.prepare('DELETE FROM flash_deals WHERE dateKey = ?').run(dateKey);
    }

    const pool = eligibleItems();
    if (!pool.length) return [];

    const count = Math.min(pool.length, 2 + Math.floor(Math.random() * 2)); // 2-3
    const chosen = [];
    const remaining = [...pool];
    while (chosen.length < count && remaining.length) {
        const index = Math.floor(Math.random() * remaining.length);
        chosen.push(remaining.splice(index, 1)[0]);
    }

    const startsAt = startOfUtcDay(now);
    const endsAt = startsAt + DAY_MS;

    db.transaction(() => {
        for (const item of chosen) {
            const discount = DISCOUNTS[Math.floor(Math.random() * DISCOUNTS.length)];
            insertDeal(item.id, discount, dateKey, startsAt, endsAt);
        }
    })();

    return dealsForDate(dateKey);
}

function getActiveDeals(now = Date.now()) {
    return db.prepare(
        'SELECT * FROM flash_deals WHERE endsAt > ? ORDER BY dateKey DESC, discount DESC'
    ).all(now);
}

function getDeal(itemId, now = Date.now()) {
    if (!itemId) return null;
    const row = db.prepare(
        'SELECT * FROM flash_deals WHERE itemId = ? AND endsAt > ? ORDER BY dealId DESC LIMIT 1'
    ).get(itemId, now);
    return row || null;
}

function discountedPrice(item, deal) {
    if (!item) return 0;
    const base = Number(item.price) || 0;
    if (!deal) return base;
    const discount = Number(deal.discount) || 0;
    return Math.max(1, Math.floor(base * (100 - discount) / 100));
}

function getItemWithDeal(itemId, now = Date.now()) {
    const item = SHOP_ITEMS[itemId];
    if (!item) return null;
    const deal = getDeal(itemId, now);
    return { item, deal, price: discountedPrice(item, deal) };
}

function describeDeals(now = Date.now()) {
    const deals = getActiveDeals(now);
    return deals.map(deal => {
        const item = SHOP_ITEMS[deal.itemId];
        if (!item) return null;
        const price = discountedPrice(item, deal);
        const ends = Math.floor(deal.endsAt / 1000);
        return `🔥 **${item.name}** — ~~🪙${Number(item.price).toLocaleString()}~~ **🪙${price.toLocaleString()}** ` +
            `(−${deal.discount}%) · ends <t:${ends}:R>`;
    }).filter(Boolean);
}

/*
 * Map of itemId -> discounted price for every live deal, so a purchase path
 * can price a whole cart in one call.
 */
function activePriceMap(now = Date.now()) {
    const map = new Map();
    for (const deal of getActiveDeals(now)) {
        const item = SHOP_ITEMS[deal.itemId];
        if (!item) continue;
        map.set(deal.itemId, discountedPrice(item, deal));
    }
    return map;
}

module.exports = {
    DISCOUNTS,
    DAY_MS,
    eligibleItems,
    dealsForDate,
    rollDailyDeals,
    getActiveDeals,
    getDeal,
    discountedPrice,
    getItemWithDeal,
    describeDeals,
    activePriceMap
};
