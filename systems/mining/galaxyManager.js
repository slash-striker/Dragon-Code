const db = require('../../database');

/*
 * GALAXIES & REBIRTH — Roblox-simulator style prestige layer.
 *
 *   • GALAXIES are travel destinations. Unlocking one costs MINING BANK
 *     credits (one-time, permanent); travelling to it multiplies every
 *     /mine run's yield AND shifts the ore gacha toward rarer rolls.
 *   • REBIRTH consumes your mining level (back to 1) plus a mining-bank
 *     payment, and grants a permanent +25% mining yield per rebirth —
 *     cumulative and never lost.
 *
 * Money charged: mining_bank only. /transfer lets players move credits
 * between wallet and mining bank, so this economy stays self-contained.
 *
 * Multiplier contract with commands/mine.js:
 *   getGalaxyMultiplier(userId)  → x1.0 … x2.0 (galaxy travel)
 *   getRebirthMultiplier(userId) → x1.0 …     (+25% per rebirth)
 * Both are plain numbers ≥ 1 and multiply the run's ore quantity.
 */

const GALAXIES = {
    andromeda: {
        name: '🌌 Andromeda Expanse',
        description: 'The starting arm — steady ore, gentle skies.',
        cost: 0,
        multiplier: 1.0,
        rarityShift: 0,
        levelRequired: 1
    },
    vortex: {
        name: '🌀 Vortex Spiral',
        description: 'Gravitational rivers concentrate richer ore.',
        cost: 250_000,
        multiplier: 1.25,
        rarityShift: 1,
        levelRequired: 10
    },
    quasar: {
        name: '✨ Quasar Reach',
        description: 'Blinding luminosity bathes the claims in exotic dust.',
        cost: 2_000_000,
        multiplier: 1.5,
        rarityShift: 2,
        levelRequired: 20
    },
    oblivion: {
        name: '🕳️ Oblivion Field',
        description: 'Dark-matter currents whisper of impossible hauls.',
        cost: 15_000_000,
        multiplier: 1.75,
        rarityShift: 3,
        levelRequired: 35
    },
    singularity: {
        name: '♾️ The Singularity',
        description: 'Beyond the event horizon, every pull is legend.',
        cost: 100_000_000,
        multiplier: 2.0,
        rarityShift: 4,
        levelRequired: 50
    }
};

const REBIRTH_COST_BASE = 10_000_000;   // mining bank, first rebirth
const REBIRTH_COST_MULT = 2;            // doubles each time
const REBIRTH_LEVEL_REQUIREMENT = 25;   // mining level needed to rebirth
const REBIRTH_YIELD_BONUS = 0.25;       // +25% ore per rebirth (multiplicative stack)
const REBIRTH_RARITY_BONUS = 0.2;       // rarityShift equivalent per rebirth

function ensureGalaxyTables() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS galaxy_profile (
            userId TEXT PRIMARY KEY,
            currentGalaxy TEXT NOT NULL DEFAULT 'andromeda',
            unlockedGalaxies TEXT NOT NULL DEFAULT '["andromeda"]',
            rebirths INTEGER NOT NULL DEFAULT 0,
            totalRebirths INTEGER NOT NULL DEFAULT 0,
            lastRebirthAt TEXT,
            updatedAt TEXT
        );
    `);
}

function safeGalaxyList(json) {
    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter(g => typeof g === 'string') : ['andromeda'];
    } catch {
        return ['andromeda'];
    }
}

function getGalaxyProfile(userId) {
    ensureGalaxyTables();
    let row = db.prepare('SELECT * FROM galaxy_profile WHERE userId = ?').get(userId);
    if (!row) {
        db.prepare(`
            INSERT INTO galaxy_profile (userId, currentGalaxy, unlockedGalaxies)
            VALUES (?, 'andromeda', '["andromeda"]')
        `).run(userId);
        row = db.prepare('SELECT * FROM galaxy_profile WHERE userId = ?').get(userId);
    }
    const unlocked = safeGalaxyList(row.unlockedGalaxies);
    if (!unlocked.includes('andromeda')) unlocked.unshift('andromeda');
    const current = GALAXIES[row.currentGalaxy] ? row.currentGalaxy : 'andromeda';
    if (!unlocked.includes(current)) unlocked.push(current);
    return {
        userId: row.userId,
        currentGalaxy: current,
        unlockedGalaxies: unlocked,
        rebirths: Math.max(0, Number(row.rebirths) || 0),
        totalRebirths: Math.max(0, Number(row.totalRebirths) || 0),
        lastRebirthAt: row.lastRebirthAt || null
    };
}

function saveGalaxyProfile(profile) {
    db.prepare(`
        UPDATE galaxy_profile
        SET currentGalaxy = ?, unlockedGalaxies = ?, rebirths = ?, totalRebirths = ?, lastRebirthAt = ?, updatedAt = ?
        WHERE userId = ?
    `).run(
        profile.currentGalaxy,
        JSON.stringify(profile.unlockedGalaxies),
        profile.rebirths,
        profile.totalRebirths,
        profile.lastRebirthAt,
        new Date().toISOString(),
        profile.userId
    );
}

function getGalaxy(userId) {
    return GALAXIES[getGalaxyProfile(userId).currentGalaxy] || GALAXIES.andromeda;
}

/** Galaxy travel yield multiplier — x1 … x2. */
function getGalaxyMultiplier(userId) {
    return getGalaxy(userId).multiplier || 1;
}

/** Rebirth yield multiplier — 1 + 0.25 × rebirths. */
function getRebirthMultiplier(userId) {
    const rebirths = getGalaxyProfile(userId).rebirths;
    return 1 + rebirths * REBIRTH_YIELD_BONUS;
}

/** Combined ore multiplier for /mine runs. */
function getMiningPrestigeMultiplier(userId) {
    return getGalaxyMultiplier(userId) * getRebirthMultiplier(userId);
}

/*
 * Rarity shift for the ore gacha: rolls twice (or more) and keeps the
 * highest-weighted-position roll, pushing results toward rarer ores.
 * galaxy.rarityShift (0-4) plus rebirth progress (0.2 each) determines
 * how many extra rolls the miner gets.
 */
function getRarityRollCount(userId) {
    const profile = getGalaxyProfile(userId);
    const galaxy = GALAXIES[profile.currentGalaxy] || GALAXIES.andromeda;
    const shift = (galaxy.rarityShift || 0) + Math.floor(profile.rebirths * REBIRTH_RARITY_BONUS);
    return 1 + Math.max(0, Math.min(6, shift));
}

function unlockGalaxy(userId, galaxyId) {
    const galaxy = GALAXIES[galaxyId];
    if (!galaxy) return { ok: false, message: 'Unknown galaxy.' };
    const profile = getGalaxyProfile(userId);
    if (profile.unlockedGalaxies.includes(galaxyId)) {
        return { ok: false, message: `You already unlocked **${galaxy.name}**.` };
    }
    const result = db.transaction(() => {
        const debit = db.prepare(
            'UPDATE users SET mining_bank = COALESCE(mining_bank, 0) - ? WHERE userId = ? AND COALESCE(mining_bank, 0) >= ?'
        ).run(galaxy.cost, userId, galaxy.cost);
        if (debit.changes !== 1) {
            throw new Error(`You need 🪙${galaxy.cost.toLocaleString()} in your **mining bank**.`);
        }
        profile.unlockedGalaxies.push(galaxyId);
        saveGalaxyProfile(profile);
    });
    try {
        result();
    } catch (error) {
        return { ok: false, message: error.message };
    }
    return { ok: true, galaxy, profile };
}

function travelToGalaxy(userId, galaxyId) {
    const galaxy = GALAXIES[galaxyId];
    if (!galaxy) return { ok: false, message: 'Unknown galaxy.' };
    const profile = getGalaxyProfile(userId);
    if (!profile.unlockedGalaxies.includes(galaxyId)) {
        return { ok: false, message: `**${galaxy.name}** is locked — unlock it first.` };
    }
    if (profile.currentGalaxy === galaxyId) {
        return { ok: false, message: `You are already in **${galaxy.name}**.` };
    }
    profile.currentGalaxy = galaxyId;
    saveGalaxyProfile(profile);
    return { ok: true, galaxy };
}

function rebirthCost(rebirths = 0) {
    return REBIRTH_COST_BASE * Math.pow(REBIRTH_COST_MULT, rebirths);
}

/*
 * Rebirth: consumes the miner's LEVEL (reset to 1, XP wiped) plus a
 * mining-bank payment scaled by how many times they have already rebirthed.
 * Rebirth count, galaxy unlocks, drill ownership, drones, and crew survive.
 */
function rebirth(userId, miningProfile) {
    const profile = getGalaxyProfile(userId);
    if (!miningProfile || (Number(miningProfile.miningLevel) || 0) < REBIRTH_LEVEL_REQUIREMENT) {
        return { ok: false, message: `You must reach mining level **${REBIRTH_LEVEL_REQUIREMENT}** before rebirthing (you are level ${miningProfile?.miningLevel ?? 1}).` };
    }
    const cost = rebirthCost(profile.rebirths);
    const result = db.transaction(() => {
        const debit = db.prepare(
            'UPDATE users SET mining_bank = COALESCE(mining_bank, 0) - ? WHERE userId = ? AND COALESCE(mining_bank, 0) >= ?'
        ).run(cost, userId, cost);
        if (debit.changes !== 1) {
            throw new Error(`Rebirth costs 🪙${cost.toLocaleString()} from your **mining bank**.`);
        }
        // Wipe level + XP back to the start; everything else survives.
        miningProfile.miningLevel = 1;
        miningProfile.miningXp = 0;
        db.prepare('UPDATE mining_profile SET miningLevel = 1, miningXp = 0 WHERE userId = ?').run(userId);
        profile.rebirths += 1;
        profile.totalRebirths += 1;
        profile.lastRebirthAt = new Date().toISOString();
        saveGalaxyProfile(profile);
    });
    try {
        result();
    } catch (error) {
        return { ok: false, message: error.message };
    }
    return { ok: true, cost, profile, nextMultiplier: getRebirthMultiplier(userId) };
}

module.exports = {
    GALAXIES,
    REBIRTH_LEVEL_REQUIREMENT,
    REBIRTH_YIELD_BONUS,
    getGalaxyProfile,
    getGalaxy,
    getGalaxyMultiplier,
    getRebirthMultiplier,
    getMiningPrestigeMultiplier,
    getRarityRollCount,
    unlockGalaxy,
    travelToGalaxy,
    rebirthCost,
    rebirth
};
