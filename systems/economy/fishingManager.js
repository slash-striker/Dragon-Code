const db = require('../../database');

/*
 * Fishing locations, gated behind one-time purchases. Ownership is tracked
 * via a single `locationTier` on fishing_equipment: tier N owns locations
 * 0..N, so deeper (better) spots require buying every rung of the ladder.
 * Rarity pool weights per location live in commands/fish.js (LOCATIONS).
 */
const MAX_LOCATION_TIER = 6;

/*
 * Canonical fishing-location ladder (one-time purchases). `commands/fish.js`
 * holds the rarity pools keyed by these ids; the deeper the spot, the better
 * the value multiplier and rarity distribution.
 */
const FISHING_LOCATIONS = [
    { id: 'shoreline', name: 'Neon Shoreline', emoji: '🏖️', price: 0 },
    { id: 'neon_marina', name: 'Neon Marina', emoji: '⛵', price: 5_000 },
    { id: 'coral_flats', name: 'Coral Flats', emoji: '🪸', price: 15_000 },
    { id: 'kelp_forest', name: 'Kelp Cathedral', emoji: '🌿', price: 40_000 },
    { id: 'open_water', name: 'Open Neon Water', emoji: '🌊', price: 100_000 },
    { id: 'trench', name: 'Abyssal Trench', emoji: '🕳️', price: 250_000 },
    { id: 'singularity', name: 'The Singularity', emoji: '🌌', price: 600_000 }
];

const EQUIPMENT = {
    rod: [
        { tier: 0, name: 'Starter Rod', price: 0, valueBonus: 0, rarityBonus: 0 },
        { tier: 1, name: 'Carbon Rod', price: 8_000, valueBonus: 0.12, rarityBonus: 0.02 },
        { tier: 2, name: 'Neon Rod', price: 25_000, valueBonus: 0.28, rarityBonus: 0.05 },
        { tier: 3, name: 'Quantum Rod', price: 75_000, valueBonus: 0.55, rarityBonus: 0.1 }
    ],
    bait: [
        { tier: 0, name: 'Basic Bait', price: 0, valueBonus: 0, rarityBonus: 0 },
        { tier: 1, name: 'Prism Bait', price: 5_000, valueBonus: 0.08, rarityBonus: 0.06 },
        { tier: 2, name: 'Void Bait', price: 18_000, valueBonus: 0.18, rarityBonus: 0.14 }
    ],
    net: [
        { tier: 0, name: 'Hand Net', price: 0, valueBonus: 0, rarityBonus: 0 },
        { tier: 1, name: 'Drone Net', price: 35_000, valueBonus: 0.2, rarityBonus: 0.08 },
        { tier: 2, name: 'Singularity Net', price: 120_000, valueBonus: 0.45, rarityBonus: 0.18 }
    ]
};

function ensureEquipment(userId) {
    db.prepare('INSERT OR IGNORE INTO fishing_equipment (userId) VALUES (?)').run(userId);
}

function getEquipment(userId) {
    ensureEquipment(userId);
    const row = db.prepare('SELECT * FROM fishing_equipment WHERE userId = ?').get(userId);
    return {
        ...row,
        rod: EQUIPMENT.rod[row.rodTier],
        bait: EQUIPMENT.bait[row.baitTier],
        net: EQUIPMENT.net[row.netTier]
    };
}

function getBonuses(userId) {
    const equipment = getEquipment(userId);
    return {
        value: 1 + equipment.rod.valueBonus + equipment.bait.valueBonus + equipment.net.valueBonus,
        rarity: equipment.rod.rarityBonus + equipment.bait.rarityBonus + equipment.net.rarityBonus
    };
}

function recordCatch(userId, fish) {
    return db.prepare(`
        INSERT INTO fishing_inventory
            (userId, fishId, name, rarity, emoji, weight, value, caughtAt, location)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        userId,
        fish.id || fish.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        fish.name,
        fish.rarity,
        fish.emoji,
        Number(fish.weight) || 0,
        Math.max(0, Math.floor(fish.value)),
        new Date().toISOString(),
        fish.location || null
    );
}

/*
 * COLLECTION LOG — species dex.
 *
 * Every catch is written to fishing_inventory and stays there forever
 * (selling only stamps soldAt), so the dex works even for fish the player
 * has sold. Returns per-species aggregates keyed by fishId.
 */
function getDex(userId) {
    const rows = db.prepare(`
        SELECT fishId,
               COUNT(*)              AS caught,
               MAX(value)            AS bestValue,
               MAX(weight)           AS bestWeight,
               MAX(caughtAt)         AS lastCaught,
               SUM(CASE WHEN soldAt IS NULL THEN 1 ELSE 0 END) AS stored
        FROM fishing_inventory
        WHERE userId = ?
        GROUP BY fishId
    `).all(userId);
    return Object.fromEntries(rows.map(row => [row.fishId, row]));
}

function getCaughtSpeciesCount(userId) {
    return db.prepare('SELECT COUNT(DISTINCT fishId) AS species FROM fishing_inventory WHERE userId = ?')
        .get(userId)?.species || 0;
}

function getCollection(userId, limit = 25) {
    return db.prepare(`
        SELECT * FROM fishing_inventory
        WHERE userId = ? AND soldAt IS NULL
        ORDER BY caughtAt DESC
        LIMIT ?
    `).all(userId, limit);
}

function getStats(userId) {
    return db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(value), 0) AS value
        FROM fishing_inventory WHERE userId = ? AND soldAt IS NULL
    `).get(userId);
}

function sellCatch(userId, catchId) {
    const result = db.transaction(() => {
        const fish = db.prepare(
            'SELECT * FROM fishing_inventory WHERE catchId = ? AND userId = ? AND soldAt IS NULL'
        ).get(catchId, userId);
        if (!fish) return null;
        const soldAt = new Date().toISOString();
        db.prepare('UPDATE fishing_inventory SET soldAt = ? WHERE catchId = ?').run(soldAt, catchId);
        db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(fish.value, userId);
        return fish;
    })();
    return result;
}

function sellFish(userId, fishId, amount) {
    return db.transaction(() => {
        const fish = db.prepare(`
            SELECT * FROM fishing_inventory
            WHERE userId = ? AND fishId = ? AND soldAt IS NULL
            ORDER BY caughtAt ASC
            LIMIT ?
        `).all(userId, fishId, amount);
        if (fish.length !== amount) return null;
        const total = fish.reduce((sum, row) => sum + row.value, 0);
        const soldAt = new Date().toISOString();
        const markSold = db.prepare('UPDATE fishing_inventory SET soldAt = ? WHERE catchId = ?');
        for (const row of fish) markSold.run(soldAt, row.catchId);
        db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(total, userId);
        return { fish, total };
    })();
}

function sellAll(userId) {
    return db.transaction(() => {
        // No effective limit — the total must cover EVERY stored fish, not just the newest 1000.
        const fish = getCollection(userId, 1_000_000);
        if (!fish.length) return { fish: [], total: 0 };
        const total = fish.reduce((sum, row) => sum + row.value, 0);
        db.prepare('UPDATE fishing_inventory SET soldAt = ? WHERE userId = ? AND soldAt IS NULL')
            .run(new Date().toISOString(), userId);
        db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(total, userId);
        return { fish, total };
    })();
}

function getLocationTier(userId) {
    ensureEquipment(userId);
    const row = db.prepare('SELECT locationTier FROM fishing_equipment WHERE userId = ?').get(userId);
    return row?.locationTier ?? 0;
}

function getOwnedLocations(userId) {
    return FISHING_LOCATIONS.slice(0, getLocationTier(userId) + 1);
}

function getNextLocationUnlock(userId) {
    const tier = getLocationTier(userId);
    const next = FISHING_LOCATIONS[tier + 1];
    return next ? { ...next, tier: tier + 1 } : null;
}

function purchaseNextLocation(userId) {
    const next = getNextLocationUnlock(userId);
    if (!next) return { ok: false, message: 'Every fishing location is already unlocked. You own the whole ocean.' };
    const result = db.transaction(() => {
        const debit = db.prepare(
            'UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?'
        ).run(next.price, userId, next.price);
        if (debit.changes !== 1) throw new Error(`You need 🪙${next.price.toLocaleString()} in your wallet.`);
        db.prepare('UPDATE fishing_equipment SET locationTier = ? WHERE userId = ?')
            .run(next.tier, userId);
    });
    try {
        result();
        return { ok: true, location: next, price: next.price };
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

function getAvailableUpgrades(userId) {
    const equipment = getEquipment(userId);
    return Object.entries(EQUIPMENT).flatMap(([type, tiers]) => {
        const current = equipment[`${type}Tier`];
        const next = tiers[current + 1];
        return next ? [{ type, ...next }] : [];
    });
}

function upgrade(userId, type) {
    const equipment = getEquipment(userId);
    const tiers = EQUIPMENT[type];
    if (!tiers) return { ok: false, message: 'Unknown equipment type.' };
    const currentTier = equipment[`${type}Tier`];
    const next = tiers[currentTier + 1];
    if (!next) return { ok: false, message: 'That equipment is already fully upgraded.' };
    const result = db.transaction(() => {
        const debit = db.prepare(
            'UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?'
        ).run(next.price, userId, next.price);
        if (debit.changes !== 1) throw new Error(`You need 🪙${next.price.toLocaleString()} in your wallet.`);
        db.prepare(`UPDATE fishing_equipment SET ${type}Tier = ? WHERE userId = ?`)
            .run(next.tier, userId);
    });
    try {
        result();
        return { ok: true, equipment: next, price: next.price };
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

module.exports = {
    MAX_LOCATION_TIER,
    FISHING_LOCATIONS,
    getLocationTier,
    getOwnedLocations,
    getNextLocationUnlock,
    purchaseNextLocation,
    EQUIPMENT,
    getEquipment,
    getBonuses,
    recordCatch,
    getCollection,
    getStats,
    getDex,
    getCaughtSpeciesCount,
    sellCatch,
    sellFish,
    sellAll,
    getAvailableUpgrades,
    upgrade
};
