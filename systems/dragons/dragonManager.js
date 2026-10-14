/*
 * DRAGON HATCHERY — the engine.
 *
 * Lifecycle: an egg drops (or is bought) → it sits in an incubator for 24-48h
 * → it hatches into a dragon or beast pet with random traits → the pet is fed
 * fish and ore, trained, petted and raced, gaining levels and bond → the
 * ACTIVE pet applies its trait as a passive bonus to mining, fishing, robbing
 * and heists.
 *
 * Side rivalry: 'good' eggs hatch Dragonflight dragons, 'evil' eggs hatch
 * Onslaught beasts. Season stats keep a server-wide scoreboard so the two
 * sides compete for the bigger flock.
 *
 * All random rolls accept an injected `rng` so the flow is unit-testable.
 */
const db = require('../../database');
const { logTransaction } = require('../economy/transactionLogger');
const catalog = require('./dragonCatalog');

const {
    RARITY_ORDER, RARITY_STYLE, rarityRank, rarityAtLeast,
    TRAITS, TRAIT_IDS, SPECIES, SPECIES_BY_SIDE, EGG_TYPES, EGG_IDS,
    DROP_SOURCES, boostedRarityWeights,
    MAX_LEVEL, xpForLevel, totalXpForLevel,
    HUNGER_DECAY_PER_HOUR, HAPPINESS_DECAY_PER_HOUR,
    feedValue, TRAIN_COST, TRAIN_COOLDOWN_MS, PLAY_COOLDOWN_MS,
    STAT_KEYS, LEVEL_GROWTH, INCUBATOR_SLOTS, INCUBATOR_UNLOCK_PRICES, ITEMS
} = catalog;

function nowIso(now) {
    return new Date(now).toISOString();
}

function roll(rng) {
    return (typeof rng === 'function' ? rng() : Math.random());
}

function pickWeighted(entries, rng) {
    const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
    if (total <= 0) return entries[0];
    let ticket = roll(rng) * total;
    for (const entry of entries) {
        ticket -= Math.max(0, entry.weight);
        if (ticket <= 0) return entry;
    }
    return entries[entries.length - 1];
}

// ==================================================
// ORE LOOKUP — used for feeding and for drop quality
// ==================================================
let oreIndex = null;
function getOreIndex() {
    if (oreIndex) return oreIndex;
    oreIndex = {};
    try {
        const { locations, seasonalOres } = require('../mining/oreTables');
        const harvest = pool => {
            for (const ore of pool || []) {
                if (ore?.id) oreIndex[ore.id] = { id: ore.id, name: ore.name, rarity: ore.rarity || 'common', value: Number(ore.value) || 0 };
            }
        };
        for (const location of Object.values(locations || {})) harvest(location?.ores);
        for (const pool of Object.values(seasonalOres || {})) {
            if (Array.isArray(pool)) harvest(pool);
            else if (pool && Array.isArray(pool.ores)) harvest(pool.ores);
        }
    } catch (error) {
        oreIndex = {};
    }
    return oreIndex;
}

function oreRarity(oreId) {
    const entry = getOreIndex()[oreId];
    if (entry?.rarity) return entry.rarity;
    // Fallback: bucket by value so a missing ore table never breaks feeding.
    let value = 0;
    try {
        value = require('../mining/oreTables').BASE_ORE_VALUES?.[oreId] || 0;
    } catch (error) {
        value = 0;
    }
    if (value >= 4000) return 'mythic';
    if (value >= 2000) return 'legendary';
    if (value >= 900) return 'epic';
    if (value >= 400) return 'rare';
    if (value >= 150) return 'uncommon';
    return 'common';
}

// ==================================================
// SEASON STATS (good vs evil rivalry)
// ==================================================
function seasonKey(date = new Date()) {
    const d = new Date(date);
    const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
    return `${d.getUTCFullYear()}-Q${quarter}`;
}

function recordSeasonEvent(userId, side, field) {
    if (!userId || !['eggsFound', 'dragonsHatched', 'racesWon', 'battlesWon'].includes(field)) return;
    try {
        db.prepare(`
            INSERT INTO dragon_season_stats (season, userId, side, ${field})
            VALUES (?, ?, ?, 1)
            ON CONFLICT(season, userId) DO UPDATE SET
                side = excluded.side,
                ${field} = ${field} + 1
        `).run(seasonKey(), userId, side === 'evil' ? 'evil' : 'good');
    } catch (error) {
        /* season stats are flavour — never let them break the main flow */
    }
}

function getSideStandings(now = Date.now()) {
    const season = seasonKey(new Date(now));
    const empty = { season, good: 0, evil: 0, eggs: 0, hatched: 0, races: 0 };
    try {
        const row = db.prepare(`
            SELECT
                SUM(CASE WHEN side = 'good' THEN 1 ELSE 0 END) AS good,
                SUM(CASE WHEN side = 'evil' THEN 1 ELSE 0 END) AS evil,
                SUM(eggsFound) AS eggs,
                SUM(dragonsHatched) AS hatched,
                SUM(racesWon) AS races
            FROM dragon_season_stats WHERE season = ?
        `).get(season);
        if (!row) return empty;
        return {
            season,
            good: Number(row.good) || 0,
            evil: Number(row.evil) || 0,
            eggs: Number(row.eggs) || 0,
            hatched: Number(row.hatched) || 0,
            races: Number(row.races) || 0
        };
    } catch (error) {
        return empty;
    }
}

function getUserSeasonStats(userId) {
    const season = seasonKey();
    try {
        const row = db.prepare('SELECT * FROM dragon_season_stats WHERE season = ? AND userId = ?').get(season, userId);
        return row || { season, userId, side: 'good', eggsFound: 0, dragonsHatched: 0, racesWon: 0, battlesWon: 0 };
    } catch (error) {
        return { season, userId, side: 'good', eggsFound: 0, dragonsHatched: 0, racesWon: 0, battlesWon: 0 };
    }
}

// ==================================================
// EGG DROPS
// ==================================================
function pickEggRarity(source, tierScore, rng) {
    const weights = boostedRarityWeights(source, tierScore);
    const entries = RARITY_ORDER.map(rarity => ({ rarity, weight: weights[rarity] || 0 })).filter(e => e.weight > 0);
    return pickWeighted(entries, rng).rarity;
}

function fillEggPool(rarity, rng) {
    const ids = EGG_IDS.filter(id => EGG_TYPES[id].rarity === rarity);
    return ids.length ? ids : EGG_IDS;
}

/**
 * Roll a drop. Returns null when the source's flat chance fails, otherwise the
 * new egg row.
 *
 * `tierScore` 0..4 is the quality of whatever the player just did —
 * ore rarity, fish rarity, heist tier. It shifts the egg rarity upward.
 */
function rollEggDrop(userId, { source = 'mine', tierScore = 0, rarityFloor = null, rng, now = Date.now() } = {}) {
    const table = DROP_SOURCES[source] || DROP_SOURCES.mine;
    if (roll(rng) > table.chance) return null;
    let rarity = pickEggRarity(source, tierScore, rng);
    if (rarityFloor && !rarityAtLeast(rarity, rarityFloor)) rarity = rarityFloor;
    return grantEgg(userId, { rarity, source, rng, now });
}

function grantEgg(userId, { rarity = 'common', source = 'event', eggType = null, rng, now = Date.now() } = {}) {
    const pool = eggType ? [eggType] : fillEggPool(rarity, rng);
    const chosen = pool[Math.floor(roll(rng) * pool.length)] || pool[0];
    const type = EGG_TYPES[chosen] || EGG_TYPES.ashen_egg;
    const info = db.prepare(`
        INSERT INTO dragon_eggs (userId, eggType, rarity, side, source, status, foundAt)
        VALUES (?, ?, ?, ?, ?, 'idle', ?)
    `).run(userId, type.id, type.rarity, type.side, source, nowIso(now));
    recordSeasonEvent(userId, type.side, 'eggsFound');
    return getEgg(Number(info.lastInsertRowid));
}

function getEgg(eggId) {
    return db.prepare('SELECT * FROM dragon_eggs WHERE eggId = ?').get(eggId) || null;
}

function listEggs(userId, { status = null } = {}) {
    return status
        ? db.prepare('SELECT * FROM dragon_eggs WHERE userId = ? AND status = ? ORDER BY rarity DESC, foundAt ASC').all(userId, status)
        : db.prepare('SELECT * FROM dragon_eggs WHERE userId = ? ORDER BY foundAt ASC').all(userId);
}

function eggType(eggOrId) {
    if (eggOrId && typeof eggOrId === 'object') return EGG_TYPES[eggOrId.eggType] || null;
    return EGG_TYPES[eggOrId] || null;
}

// ==================================================
// INCUBATORS
// ==================================================
function getIncubators(userId) {
    const owned = db.prepare('SELECT slot, unlocked FROM dragon_incubators WHERE userId = ?').all(userId);
    const unlockedMap = new Map(owned.map(row => [Number(row.slot), Boolean(row.unlocked)]));
    const eggs = listEggs(userId, { status: 'incubating' });
    const slots = [];
    for (let slot = 0; slot < INCUBATOR_SLOTS; slot += 1) {
        const unlocked = unlockedMap.get(slot) ?? false;
        slots.push({
            slot,
            unlocked,
            price: INCUBATOR_UNLOCK_PRICES[slot] ?? 0,
            egg: eggs.find(row => Number(row.incubatorSlot) === slot) || null
        });
    }
    return slots;
}

function unlockIncubator(userId, slot) {
    const index = Number(slot);
    if (!Number.isInteger(index) || index < 0 || index >= INCUBATOR_SLOTS) {
        return { ok: false, message: 'That incubator slot does not exist.' };
    }
    const existing = db.prepare('SELECT unlocked FROM dragon_incubators WHERE userId = ? AND slot = ?').get(userId, index);
    if (existing?.unlocked) return { ok: false, message: 'You already unlocked that incubator.' };

    const occupied = db.prepare('SELECT 1 FROM dragon_eggs WHERE userId = ? AND incubatorSlot = ? AND status = ?')
        .get(userId, index, 'incubating');
    if (occupied) return { ok: false, message: 'That incubator is busy — hatch the egg in it first.' };

    const price = INCUBATOR_UNLOCK_PRICES[index] ?? 0;
    if (price > 0) {
        const debit = db.prepare('UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?')
            .run(price, userId, price);
        if (debit.changes !== 1) return { ok: false, message: `You need 🪙${price.toLocaleString()} in your wallet to unlock incubator ${index + 1}.` };
        logTransaction(userId, 'incubator_unlock', -price, `Unlocked incubator slot ${index + 1}`);
    }
    db.prepare(`
        INSERT INTO dragon_incubators (userId, slot, unlocked) VALUES (?, ?, 1)
        ON CONFLICT(userId, slot) DO UPDATE SET unlocked = 1
    `).run(userId, index);
    return { ok: true, slot: index, price };
}

function startIncubation(userId, eggId, slot, now = Date.now()) {
    const egg = getEgg(eggId);
    if (!egg || egg.userId !== userId) return { ok: false, message: 'That egg is not yours.' };
    if (egg.status === 'hatched') return { ok: false, message: 'That egg already hatched.' };
    if (egg.status === 'incubating') return { ok: false, message: 'That egg is already incubating.' };

    const slots = getIncubators(userId);
    const target = slots[Number(slot)];
    if (!target) return { ok: false, message: 'Unknown incubator slot.' };
    if (!target.unlocked) {
        const unlock = unlockIncubator(userId, slot);
        if (!unlock.ok) return unlock;
    }
    if (target.egg) return { ok: false, message: `Incubator ${Number(slot) + 1} already holds an egg.` };

    const type = eggType(egg);
    const endsAt = now + (type?.incubateMs ?? 24 * 60 * 60 * 1000);
    db.prepare(`
        UPDATE dragon_eggs
        SET status = 'incubating', incubatorSlot = ?, incubateStartedAt = ?, incubateEndsAt = ?
        WHERE eggId = ? AND userId = ?
    `).run(Number(slot), nowIso(now), nowIso(endsAt), eggId, userId);
    return { ok: true, egg: getEgg(eggId), endsAt, incubateMs: type?.incubateMs ?? 0 };
}

/** Shorten an egg's remaining incubation (shop item / admin action). */
function accelerateIncubation(userId, eggId, hours = 6, now = Date.now()) {
    const egg = getEgg(eggId);
    if (!egg || egg.userId !== userId) return { ok: false, message: 'That egg is not yours.' };
    if (egg.status !== 'incubating') return { ok: false, message: 'That egg is not incubating.' };
    const endsAt = new Date(egg.incubateEndsAt || now).getTime();
    const next = Math.max(now, endsAt - Number(hours) * 60 * 60 * 1000);
    db.prepare('UPDATE dragon_eggs SET incubateEndsAt = ? WHERE eggId = ?').run(nowIso(next), eggId);
    return { ok: true, endsAt: next, ready: next <= now, egg: getEgg(eggId) };
}

function readyEggs(userId, now = Date.now()) {
    return listEggs(userId, { status: 'incubating' })
        .filter(egg => new Date(egg.incubateEndsAt || 0).getTime() <= now);
}

function incubationProgress(egg, now = Date.now()) {
    const start = new Date(egg.incubateStartedAt || egg.foundAt).getTime();
    const end = new Date(egg.incubateEndsAt || start).getTime();
    const span = Math.max(1, end - start);
    const elapsed = Math.max(0, Math.min(span, now - start));
    const pct = Math.round((elapsed / span) * 100);
    return { pct, remainingMs: Math.max(0, end - now), ready: end - now <= 0, start, end };
}

// ==================================================
// HATCHING
// ==================================================
function speciesHatchWeight(speciesId) {
    const species = SPECIES[speciesId];
    if (!species) return 1;
    // Apex species are deliberately rare even inside their own egg pool.
    if (species.rarity === 'mythic') return 0.32;
    if (species.rarity === 'legendary') return 0.6;
    if (species.rarity === 'epic') return 0.9;
    return 1;
}

function rollSpecies(egg, rng) {
    const type = eggType(egg);
    const pool = (type?.pool || ['ember_scale']).filter(id => SPECIES[id]);
    const pool2 = pool.length ? pool : Object.keys(SPECIES);
    const entry = pickWeighted(pool2.map(id => ({ id, weight: speciesHatchWeight(id) })), rng);
    return SPECIES[entry?.id] || SPECIES.ember_scale;
}

function rollTraits(rng) {
    const primary = TRAIT_IDS[Math.floor(roll(rng) * TRAIT_IDS.length)] || 'ember';
    let secondary = null;
    if (roll(rng) < 0.35) {
        const pool = TRAIT_IDS.filter(id => id !== primary);
        secondary = pool[Math.floor(roll(rng) * pool.length)] || null;
    }
    return { primary, secondary };
}

function rollName(species) {
    return species.name;
}

/**
 * Hatch an incubated egg. Returns the new dragon row plus the species data so
 * the caller can drive the reveal animation.
 *
 * `force` is the admin path: it skips the ready check.
 */
function hatchEgg(userId, eggId, { rng, now = Date.now(), force = false } = {}) {
    const egg = getEgg(eggId);
    if (!egg || egg.userId !== userId) return { ok: false, message: 'That egg is not yours.' };
    if (egg.status === 'hatched') return { ok: false, message: 'That egg already hatched.' };
    if (egg.status !== 'incubating') return { ok: false, message: 'That egg is not in an incubator yet.' };

    const endsAt = new Date(egg.incubateEndsAt || 0).getTime();
    if (!force && endsAt > now) {
        return { ok: false, message: 'That egg is still incubating.', endsAt };
    }

    const species = rollSpecies(egg, rng);
    const { primary, secondary } = rollTraits(rng);
    const variance = () => Math.floor(roll(rng) * 7) - 3;

    const result = db.transaction(() => {
        db.prepare(`
            UPDATE dragon_eggs SET status = 'hatched', hatchedAt = ?, incubatorSlot = NULL,
                incubateEndsAt = NULL
            WHERE eggId = ?
        `).run(nowIso(now), eggId);

        const existing = db.prepare('SELECT COUNT(*) AS count FROM dragons WHERE userId = ?').get(userId)?.count || 0;
        const info = db.prepare(`
            INSERT INTO dragons
                (userId, eggId, speciesId, name, side, rarity, trait, trait2,
                 level, xp, hunger, happiness, power, speed, stamina, bond,
                 active, hatchedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 100, 100, ?, ?, ?, 0, ?, ?)
        `).run(
            userId, eggId, species.id, rollName(species), species.side, species.rarity,
            primary, secondary,
            Math.max(1, species.base.power + variance()),
            Math.max(1, species.base.speed + variance()),
            Math.max(1, species.base.stamina + variance()),
            existing === 0 ? 1 : 0,
            nowIso(now)
        );
        return Number(info.lastInsertRowid);
    })();

    recordSeasonEvent(userId, species.side, 'dragonsHatched');
    const dragon = getDragon(result);
    return { ok: true, dragon, species, egg: getEgg(eggId), traits: { primary, secondary } };
}

// ==================================================
// DRAGONS
// ==================================================
function getDragon(dragonId) {
    const dragon = db.prepare('SELECT * FROM dragons WHERE dragonId = ?').get(dragonId);
    if (!dragon) return null;
    return applyDecay(dragon);
}

function applyDecay(dragon, now = Date.now()) {
    if (!dragon) return dragon;
    const last = new Date(dragon.lastFedAt || dragon.hatchedAt || now).getTime();
    const hours = Math.max(0, (now - last) / (60 * 60 * 1000));
    if (hours < 1) return dragon;

    const hunger = Math.max(0, Math.round((dragon.hunger ?? 100) - hours * HUNGER_DECAY_PER_HOUR));
    const happiness = Math.max(0, Math.round((dragon.happiness ?? 100) - hours * HAPPINESS_DECAY_PER_HOUR));
    if (hunger === dragon.hunger && happiness === dragon.happiness) return dragon;

    try {
        db.prepare('UPDATE dragons SET hunger = ?, happiness = ? WHERE dragonId = ?')
            .run(hunger, happiness, dragon.dragonId);
    } catch (error) {
        /* a stale decay write is harmless */
    }
    return { ...dragon, hunger, happiness };
}

function listDragons(userId) {
    return db.prepare('SELECT * FROM dragons WHERE userId = ? ORDER BY active DESC, level DESC, dragonId ASC')
        .all(userId).map(dragon => applyDecay(dragon));
}

function getActiveDragon(userId) {
    const dragon = db.prepare('SELECT * FROM dragons WHERE userId = ? AND active = 1 LIMIT 1').get(userId);
    if (dragon) return applyDecay(dragon);
    const fallback = db.prepare('SELECT * FROM dragons WHERE userId = ? ORDER BY level DESC, dragonId ASC LIMIT 1').get(userId);
    return fallback ? applyDecay(fallback) : null;
}

function setActiveDragon(userId, dragonId) {
    const dragon = db.prepare('SELECT * FROM dragons WHERE dragonId = ? AND userId = ?').get(dragonId, userId);
    if (!dragon) return { ok: false, message: 'You do not own that dragon.' };
    db.transaction(() => {
        db.prepare('UPDATE dragons SET active = 0 WHERE userId = ?').run(userId);
        db.prepare('UPDATE dragons SET active = 1 WHERE dragonId = ?').run(dragonId);
    })();
    return { ok: true, dragon: getDragon(dragonId) };
}

function renameDragon(userId, dragonId, name) {
    const clean = String(name || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 24);
    if (clean.length < 2) return { ok: false, message: 'Names need at least 2 characters.' };
    const info = db.prepare('UPDATE dragons SET name = ? WHERE dragonId = ? AND userId = ?').run(clean, dragonId, userId);
    if (!info.changes) return { ok: false, message: 'You do not own that dragon.' };
    return { ok: true, name: clean, dragon: getDragon(dragonId) };
}

function releaseDragon(userId, dragonId) {
    const dragon = db.prepare('SELECT * FROM dragons WHERE dragonId = ? AND userId = ?').get(dragonId, userId);
    if (!dragon) return { ok: false, message: 'You do not own that dragon.' };
    const owned = db.prepare('SELECT COUNT(*) AS count FROM dragons WHERE userId = ?').get(userId)?.count || 0;
    if (owned <= 1) return { ok: false, message: 'You cannot release your only dragon — you would have nobody to feed.' };
    // Refund a slice of the egg's value, scaled by level, so release is not a pure loss.
    const type = EGG_TYPES[dragon.eggId ? getEgg(dragon.eggId)?.eggType : null];
    const base = type?.value ?? 25_000;
    const refund = Math.max(5_000, Math.floor(base * 0.15 * (1 + dragon.level * 0.08)));
    const wasActive = Boolean(dragon.active);
    db.transaction(() => {
        db.prepare('DELETE FROM dragons WHERE dragonId = ?').run(dragonId);
        db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(userId);
        db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(refund, userId);
        if (wasActive) {
            const next = db.prepare('SELECT dragonId FROM dragons WHERE userId = ? ORDER BY level DESC LIMIT 1').get(userId);
            if (next) db.prepare('UPDATE dragons SET active = 1 WHERE dragonId = ?').run(next.dragonId);
        }
    })();
    logTransaction(userId, 'dragon_release', refund, `Released ${dragon.name} (Lv${dragon.level})`);
    return { ok: true, refund, name: dragon.name, dragonId };
}

// ==================================================
// XP / LEVELING
// ==================================================
function xpProgress(dragon) {
    const level = Math.min(MAX_LEVEL, Math.max(1, Number(dragon?.level) || 1));
    const xp = Math.max(0, Number(dragon?.xp) || 0);
    if (level >= MAX_LEVEL) return { level, xp, needed: 0, pct: 100, maxed: true };
    const needed = xpForLevel(level);
    return { level, xp, needed, pct: Math.min(100, Math.round((xp / needed) * 100)), maxed: false };
}

function grantXp(dragon, amount) {
    const gained = Math.max(0, Math.floor(amount));
    let level = Math.min(MAX_LEVEL, Math.max(1, Number(dragon.level) || 1));
    let xp = Math.max(0, Number(dragon.xp) || 0) + gained;
    let power = Number(dragon.power) || 0;
    let speed = Number(dragon.speed) || 0;
    let stamina = Number(dragon.stamina) || 0;
    const levelsGained = [];

    while (level < MAX_LEVEL && xp >= xpForLevel(level)) {
        xp -= xpForLevel(level);
        level += 1;
        const favoured = STAT_KEYS[(level + (dragon.dragonId || 0)) % STAT_KEYS.length];
        for (const key of STAT_KEYS) {
            const gain = LEVEL_GROWTH[key] + (key === favoured ? 2 : 0);
            if (key === 'power') power += gain;
            if (key === 'speed') speed += gain;
            if (key === 'stamina') stamina += gain;
        }
        levelsGained.push(level);
    }
    if (level >= MAX_LEVEL) xp = Math.min(xp, xpForLevel(MAX_LEVEL - 1));

    return { level, xp, power, speed, stamina, levelsGained, gained };
}

function persistGrowth(dragon, growth) {
    db.prepare(`
        UPDATE dragons SET level = ?, xp = ?, power = ?, speed = ?, stamina = ?
        WHERE dragonId = ?
    `).run(growth.level, growth.xp, growth.power, growth.speed, growth.stamina, dragon.dragonId);
}

// ==================================================
// FEEDING
// ==================================================
/**
 * List everything the user can feed a dragon right now: unsold fish from the
 * fishing inventory and stored ore from the mining inventory.
 */
function listFeedOptions(userId) {
    let fish = [];
    let ore = [];
    try {
        fish = db.prepare(`
            SELECT fishId AS id, name, rarity, emoji, COUNT(*) AS quantity, MAX(value) AS value
            FROM fishing_inventory
            WHERE userId = ? AND soldAt IS NULL
            GROUP BY fishId, name, rarity, emoji
            ORDER BY value DESC
        `).all(userId);
    } catch (error) { fish = []; }
    try {
        const index = getOreIndex();
        ore = db.prepare(`
            SELECT oreId AS id, quantity FROM mining_inventory
            WHERE userId = ? AND quantity > 0 ORDER BY quantity DESC
        `).all(userId).map(row => ({
            id: row.id,
            quantity: row.quantity,
            name: index[row.id]?.name || String(row.id).replace(/_/g, ' '),
            rarity: oreRarity(row.id)
        }));
    } catch (error) { ore = []; }

    return { fish, ore };
}

function feedDragon(userId, dragonId, { kind, foodId, quantity = 1, now = Date.now() } = {}) {
    const dragon = db.prepare('SELECT * FROM dragons WHERE dragonId = ? AND userId = ?').get(dragonId, userId);
    if (!dragon) return { ok: false, message: 'You do not own that dragon.' };

    const amount = Math.max(1, Math.min(20, Number(quantity) || 1));
    let consumed = 0;
    let foodName = '';
    let rarity = 'common';
    let source;

    if (kind === 'fish') {
        const rows = db.prepare(`
            SELECT catchId, name, rarity, value FROM fishing_inventory
            WHERE userId = ? AND fishId = ? AND soldAt IS NULL
            ORDER BY value ASC LIMIT ?
        `).all(userId, foodId, amount);
        if (!rows.length) return { ok: false, message: 'You have none of that fish stored.' };
        consumed = rows.length;
        foodName = rows[0].name;
        rarity = rows[0].rarity;
        source = 'fish';
    } else {
        const row = db.prepare('SELECT quantity FROM mining_inventory WHERE userId = ? AND oreId = ?').get(userId, foodId);
        if (!row || row.quantity <= 0) return { ok: false, message: 'You have none of that ore stored.' };
        consumed = Math.min(amount, Number(row.quantity));
        rarity = oreRarity(foodId);
        foodName = getOreIndex()[foodId]?.name || String(foodId).replace(/_/g, ' ');
        source = 'ore';
    }

    const per = feedValue(source, rarity);
    const totalXp = per.xp * consumed;
    const totalHunger = per.hunger * consumed;
    const growth = grantXp(dragon, totalXp);

    db.transaction(() => {
        if (source === 'fish') {
            const ids = db.prepare(`
                SELECT catchId FROM fishing_inventory
                WHERE userId = ? AND fishId = ? AND soldAt IS NULL
                ORDER BY value ASC LIMIT ?
            `).all(userId, foodId, consumed);
            const markFed = db.prepare('DELETE FROM fishing_inventory WHERE catchId = ?');
            for (const row of ids) markFed.run(row.catchId);
        } else {
            db.prepare('UPDATE mining_inventory SET quantity = quantity - ? WHERE userId = ? AND oreId = ?')
                .run(consumed, userId, foodId);
        }
        persistGrowth(dragon, growth);
        db.prepare(`
            UPDATE dragons
            SET hunger = MIN(100, hunger + ?),
                happiness = MIN(100, happiness + ?),
                bond = MIN(300, bond + ?),
                fedCount = fedCount + 1,
                lastFedAt = ?
            WHERE dragonId = ?
        `).run(totalHunger, Math.max(1, Math.round(totalHunger / 3)), consumed, nowIso(now), dragonId);
        db.prepare(`
            INSERT INTO dragon_feed_log (dragonId, userId, foodType, foodName, xp, fedAt)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(dragonId, userId, source, foodName, totalXp, nowIso(now));
    })();

    // 📋 Quest board hook — one call here covers every feeding path.
    try {
        require('../economy/questManager').recordQuestEvent(userId, 'dragon_feed', consumed, { dragonId });
    } catch (error) {
        console.error('Dragon feed quest hook failed:', error.message);
    }

    const updated = getDragon(dragonId);
    return {
        ok: true,
        consumed,
        foodName,
        rarity,
        xp: totalXp,
        hunger: totalHunger,
        levelsGained: growth.levelsGained,
        dragon: updated,
        progress: xpProgress(updated)
    };
}

// ==================================================
// TRAIN / PLAY
// ==================================================
function trainDragon(userId, dragonId, { stat = 'power', now = Date.now() } = {}) {
    const dragon = db.prepare('SELECT * FROM dragons WHERE dragonId = ? AND userId = ?').get(dragonId, userId);
    if (!dragon) return { ok: false, message: 'You do not own that dragon.' };

    const last = dragon.lastTrainedAt ? new Date(dragon.lastTrainedAt).getTime() : 0;
    const remaining = last + TRAIN_COOLDOWN_MS - now;
    if (remaining > 0) {
        return { ok: false, cooldown: remaining, message: `Your dragon is still recovering — try again <t:${Math.ceil((now + remaining) / 1000)}:R>.` };
    }

    const key = STAT_KEYS.includes(stat) ? stat : 'power';
    const debit = db.prepare('UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?')
        .run(TRAIN_COST, userId, TRAIN_COST);
    if (debit.changes !== 1) return { ok: false, message: `Training costs 🪙${TRAIN_COST.toLocaleString()} — you do not have enough in your wallet.` };
    logTransaction(userId, 'dragon_training', -TRAIN_COST, `Trained ${dragon.name} (${key})`);

    const gain = 1 + Math.floor(Math.random() * 3);
    const growth = grantXp(dragon, 45);
    db.prepare(`
        UPDATE dragons SET ${key} = ${key} + ?, hunger = MAX(0, hunger - 8), happiness = MAX(0, happiness - 4),
            bond = MIN(300, bond + 1), trainCount = trainCount + 1, lastTrainedAt = ?
        WHERE dragonId = ?
    `).run(gain, nowIso(now), dragonId);
    persistGrowth(dragon, growth);

    return { ok: true, stat: key, gain, cost: TRAIN_COST, dragon: getDragon(dragonId), levelsGained: growth.levelsGained };
}

function playWithDragon(userId, dragonId, { now = Date.now() } = {}) {
    const dragon = db.prepare('SELECT * FROM dragons WHERE dragonId = ? AND userId = ?').get(dragonId, userId);
    if (!dragon) return { ok: false, message: 'You do not own that dragon.' };

    const last = dragon.lastPlayedAt ? new Date(dragon.lastPlayedAt).getTime() : 0;
    const remaining = last + PLAY_COOLDOWN_MS - now;
    if (remaining > 0) {
        return { ok: false, cooldown: remaining, message: `They are still out of breath — try again <t:${Math.ceil((now + remaining) / 1000)}:R>.` };
    }

    const happy = 6 + Math.floor(Math.random() * 9);
    const growth = grantXp(dragon, 25);
    db.prepare(`
        UPDATE dragons SET happiness = MIN(100, happiness + ?), hunger = MAX(0, hunger - 5),
            bond = MIN(300, bond + 2), playCount = playCount + 1, lastPlayedAt = ?
        WHERE dragonId = ?
    `).run(happy, nowIso(now), dragonId);
    persistGrowth(dragon, growth);

    const lines = [
        'chases a laser pointer made of actual plasma.',
        'rolls over and pretends that was intentional.',
        'hoards three bottle caps and a receipt.',
        'headbutts your leg with alarming affection.',
        'attempts a roar, produces a squeak, commits anyway.'
    ];
    return {
        ok: true,
        happiness: happy,
        line: lines[Math.floor(Math.random() * lines.length)],
        dragon: getDragon(dragonId),
        levelsGained: growth.levelsGained
    };
}

// ==================================================
// PASSIVE BONUSES
// ==================================================
/*
 * The ACTIVE dragon contributes its trait bonus. Bonus scales with level and
 * bond (max +150%) and is throttled when the dragon is starving, so neglect has
 * a real cost. Secondary traits stack.
 */
function getDragonBonus(userId, kind) {
    const dragon = getActiveDragon(userId);
    if (!dragon) return 0;
    const traits = [dragon.trait, dragon.trait2].filter(Boolean);
    let raw = 0;
    for (const id of traits) {
        const trait = TRAITS[id];
        if (!trait) continue;
        raw += trait.bonus[kind] || 0;
    }
    if (raw === 0) return 0;
    const scale = 1 + Math.min(1.5, dragon.level * 0.015 + dragon.bond * 0.002);
    const hungerFactor = dragon.hunger < 25 ? 0.25 : dragon.hunger < 55 ? 0.65 : 1;
    const happyFactor = dragon.happiness < 25 ? 0.6 : 1;
    return raw * scale * hungerFactor * happyFactor;
}

/** Human-readable description of everything the active dragon is giving you. */
function describeDragonBonus(userId) {
    const dragon = getActiveDragon(userId);
    if (!dragon) return ['_No active dragon — hatch one to start earning passive bonuses._'];
    const kinds = [
        ['mine_yield', 'Ore yield', '%'],
        ['fish_value', 'Fish value', '%'],
        ['credits', 'All payouts', '%'],
        ['xp', 'XP gain', '%'],
        ['rob_success', 'Rob success', '%'],
        ['rob_defense', 'Rob defence', '%'],
        ['heist_payout', 'Heist payout', '%'],
        ['race_speed', 'Race speed', '%']
    ];
    const lines = [];
    for (const [kind, label, unit] of kinds) {
        const value = getDragonBonus(userId, kind);
        if (value > 0) lines.push(`${label}: **+${(value * 100).toFixed(1)}${unit}**`);
    }
    if (!lines.length) lines.push('_No trait bonus active right now._');
    return lines;
}

// ==================================================
// SUMMARY / DISPLAY HELPERS
// ==================================================
function getHatcherySummary(userId, now = Date.now()) {
    const eggs = listEggs(userId);
    const dragons = listDragons(userId);
    const incubating = eggs.filter(egg => egg.status === 'incubating');
    const ready = incubating.filter(egg => new Date(egg.incubateEndsAt || 0).getTime() <= now);
    const active = getActiveDragon(userId);
    return {
        eggs,
        incubators: getIncubators(userId),
        dragons,
        incubating,
        ready,
        active,
        side: active?.side || null,
        counts: {
            eggsIdle: eggs.filter(egg => egg.status === 'idle').length,
            incubating: incubating.length,
            ready: ready.length,
            hatched: eggs.filter(egg => egg.status === 'hatched').length,
            dragons: dragons.length
        }
    };
}

function describeEgg(egg, now = Date.now()) {
    const type = eggType(egg);
    const style = RARITY_STYLE[egg.rarity] || RARITY_STYLE.common;
    if (egg.status === 'incubating') {
        const progress = incubationProgress(egg, now);
        return `${type?.emoji || '🥚'} **${type?.name || 'Egg'}** — ${style.emoji} ${style.label}` +
            (progress.ready
                ? ' · ✅ **READY TO HATCH**'
                : ` · \`${'▰'.repeat(Math.round(progress.pct / 10))}${'▱'.repeat(10 - Math.round(progress.pct / 10))}\` ${progress.pct}% (<t:${Math.ceil(progress.end / 1000)}:R>)`);
    }
    if (egg.status === 'hatched') return `✅ **${type?.name || 'Egg'}** — hatched <t:${Math.floor(new Date(egg.hatchedAt).getTime() / 1000)}:R>`;
    return `${type?.emoji || '🥚'} **${type?.name || 'Egg'}** — ${style.emoji} ${style.label} · 💤 unincubated`;
}

function describeDragon(dragon, { index = null, showSide = true } = {}) {
    if (!dragon) return '_none_';
    const species = SPECIES[dragon.speciesId] || { name: dragon.name, emoji: '🐉', side: 'good', rarity: 'common' };
    const style = RARITY_STYLE[dragon.rarity] || RARITY_STYLE.common;
    const trait = TRAITS[dragon.trait];
    const trait2 = dragon.trait2 ? TRAITS[dragon.trait2] : null;
    const progress = xpProgress(dragon);
    const prefix = index === null ? '' : `\`#${index + 1}\` `;
    const active = dragon.active ? '⭐ ' : '';
    const sideTag = showSide ? (species.side === 'evil' ? ' 🩸' : ' 🌌') : '';
    return `${prefix}${active}${species.emoji} **${dragon.name}**${sideTag} — Lv **${progress.level}** ${style.emoji}` +
        `\n> ${trait ? `${trait.emoji} ${trait.name}` : 'no trait'}${trait2 ? ` · ${trait2.emoji} ${trait2.name}` : ''}` +
        ` · ❤️ ${dragon.hunger} · 😊 ${dragon.happiness} · XP ${progress.xp}/${progress.needed || 'MAX'}`;
}

function getDragonLeaderboard(limit = 10) {
    return db.prepare(`
        SELECT d.*, (SELECT COUNT(*) FROM dragons x WHERE x.userId = d.userId) AS owned
        FROM dragons d
        ORDER BY d.level DESC, d.bond DESC, d.dragonId ASC
        LIMIT ?
    `).all(limit).map(row => ({ ...row, species: SPECIES[row.speciesId] || null }));
}

function getStats(userId) {
    const dragons = listDragons(userId);
    const eggs = listEggs(userId);
    const season = getUserSeasonStats(userId);
    const totals = dragons.reduce((acc, dragon) => {
        acc.levels += dragon.level;
        acc.bond += dragon.bond;
        acc.fed += dragon.fedCount;
        acc.trained += dragon.trainCount;
        return acc;
    }, { levels: 0, bond: 0, fed: 0, trained: 0 });
    return {
        dragons: dragons.length,
        eggs: eggs.length,
        hatched: eggs.filter(egg => egg.status === 'hatched').length,
        bestLevel: dragons.reduce((max, dragon) => Math.max(max, dragon.level), 0),
        side: season.side,
        season,
        ...totals
    };
}

module.exports = {
    // catalog passthroughs the commands need
    EGG_TYPES, SPECIES, TRAITS, RARITY_STYLE, RARITY_ORDER, rarityRank, rarityAtLeast,
    MAX_LEVEL, xpForLevel, xpProgress, INCUBATOR_SLOTS, INCUBATOR_UNLOCK_PRICES,
    TRAIN_COST, TRAIN_COOLDOWN_MS, PLAY_COOLDOWN_MS, ITEMS,
    // drops
    rollEggDrop, grantEgg, DROP_SOURCES,
    // eggs
    getEgg, listEggs, eggType, describeEgg, incubationProgress, readyEggs,
    // incubators
    getIncubators, unlockIncubator, startIncubation, accelerateIncubation,
    // dragons
    hatchEgg, getDragon, listDragons, getActiveDragon, setActiveDragon,
    renameDragon, releaseDragon, describeDragon, getDragonLeaderboard,
    // care
    feedDragon, listFeedOptions, trainDragon, playWithDragon,
    // bonuses
    getDragonBonus, describeDragonBonus,
    // meta
    getHatcherySummary, getStats, seasonKey, getSideStandings, getUserSeasonStats,
    recordSeasonEvent, oreRarity
};
