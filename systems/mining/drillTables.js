// ==================================================
// HIGH-TECH DRILL TABLES
// ==================================================
// Drills replace pickaxes in the high-tech theme
// Each drill has: name, rarityBonus, cooldownReduction, miningEfficiency
// ==================================================

const drills = {
    basic_drill: {
        name: '🔧 Basic Drill',
        rarityBonus: 0,
        cooldownReduction: 0,
        miningEfficiency: 1.0,
        description: 'Standard issue mining drill',
        levelRequired: 1
    },
    
    plasma_cutter: {
        name: '⚡ Plasma Cutter',
        rarityBonus: 5,
        cooldownReduction: 5000,
        miningEfficiency: 1.2,
        description: 'Cuts through rock with plasma energy',
        levelRequired: 5
    },
    
    laser_drill: {
        name: '🔴 Laser Drill',
        rarityBonus: 10,
        cooldownReduction: 10000,
        miningEfficiency: 1.4,
        description: 'Precision laser mining technology',
        levelRequired: 10
    },
    
    quantum_extractor: {
        name: '🌌 Quantum Extractor',
        rarityBonus: 15,
        cooldownReduction: 15000,
        miningEfficiency: 1.6,
        description: 'Extracts materials at the quantum level',
        levelRequired: 15
    },
    
    void_reaper: {
        name: '🖤 Void Reaper',
        rarityBonus: 20,
        cooldownReduction: 20000,
        miningEfficiency: 1.8,
        description: 'Harvests materials from the void',
        levelRequired: 20
    },
    
    stellar_harvester: {
        name: '⭐ Stellar Harvester',
        rarityBonus: 25,
        cooldownReduction: 25000,
        miningEfficiency: 2.0,
        description: 'Extracts stellar energy and matter',
        levelRequired: 25
    },
    
    primordial_core: {
        name: '👑 Primordial Core',
        rarityBonus: 35,
        cooldownReduction: 35000,
        miningEfficiency: 2.5,
        description: 'Ancient technology from the dawn of time',
        levelRequired: 35
    },
    singularity_borer: {
        name: '🌀 Singularity Borer',
        rarityBonus: 45,
        cooldownReduction: 45000,
        miningEfficiency: 3.0,
        description: 'Bores stable extraction paths through collapsed space',
        levelRequired: 45
    },
    omega_harvester: {
        name: '♾️ Omega Harvester',
        rarityBonus: 60,
        cooldownReduction: 60000,
        miningEfficiency: 3.6,
        description: 'The ultimate autonomous mineral harvesting array',
        levelRequired: 60
    }
};

// ==================================================
// LOCATION TABLES
// ==================================================
/*
 * Location cooldowns — /mine runs every 3 HOURS (10,800,000 ms), not 30–120
 * seconds. Two reasons:
 *   1. The mine cooldown ping is a purchasable shop service — it only makes
 *      sense if the cooldown is long enough to be worth notifying about.
 *   2. Auto-income (drones, crew, properties) stacks multiplicatively with
 *      /mine; a 30s loop let that printing run 360x/day. A 3h cadence keeps
 *      active income in line with the ~1M/day auto-miner budget.
 * Boost tiers and drill cooldown reductions apply on top of the tiered
 * base (see MINE_TIERS in miningManager.js — 3h grows to 4h for veterans,
 * +15 min per tier). Floor 15 minutes so a heavy stack still feels snappy.
 */
const MINE_BASE_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const MIN_COOLDOWN_FLOOR_MS = 15 * 60 * 1000;
const locations = {
    quantum_craters: {
        name: '🌌 Quantum Craters',
        description: 'Mysterious craters filled with quantum energy',
        levelRequired: 1,
        baseCooldown: MINE_BASE_COOLDOWN_MS
    },
    
    cyber_depths: {
        name: '💻 Cyber Depths',
        description: 'Deep underground data processing centers',
        levelRequired: 5,
        baseCooldown: MINE_BASE_COOLDOWN_MS
    },
    
    frozen_sector: {
        name: '❄️ Frozen Sector',
        description: 'Cryogenically preserved mining zone',
        levelRequired: 10,
        baseCooldown: MINE_BASE_COOLDOWN_MS
    },
    
    lunar_station: {
        name: '🌙 Lunar Station',
        description: 'Mining operations on the lunar surface',
        levelRequired: 15,
        baseCooldown: MINE_BASE_COOLDOWN_MS
    },
    
    nexus_core: {
        name: '⚡ Nexus Core',
        description: 'The heart of the mining network',
        levelRequired: 25,
        baseCooldown: MINE_BASE_COOLDOWN_MS
    },
    asteroid_belt: {
        name: '☄️ Asteroid Belt',
        description: 'A rich belt of drifting metal-rich asteroids',
        levelRequired: 35,
        baseCooldown: MINE_BASE_COOLDOWN_MS
    },
    singularity_rift: {
        name: '🌀 Singularity Rift',
        description: 'Dangerous spacetime fractures containing impossible ores',
        levelRequired: 50,
        baseCooldown: MINE_BASE_COOLDOWN_MS
    }
};

// ==================================================
// DRILL UPGRADE COSTS
// ==================================================
function getDrillUpgradeCost(drillId) {
    const costs = {
        basic_drill: 0,
        plasma_cutter: 5000,
        laser_drill: 15000,
        quantum_extractor: 35000,
        void_reaper: 75000,
        stellar_harvester: 150000,
        primordial_core: 500000
        ,singularity_borer: 900000
        ,omega_harvester: 1500000
    };
    return costs[drillId] || 0;
}

// ==================================================
// LOCATION UNLOCK COSTS
// ==================================================
function getLocationUnlockCost(locationId) {
    const costs = {
        quantum_craters: 0,
        cyber_depths: 10000,
        frozen_sector: 25000,
        lunar_station: 50000,
        nexus_core: 100000
        ,asteroid_belt: 250000
        ,singularity_rift: 600000
    };
    return costs[locationId] || 0;
}

// Permanent economy upgrades that reduce the effective mining cooldown.
/*
 * Mining boosts — with /mine now on a 3-hour cadence, a flat 50% cooldown
 * cut was nearly worthless (it saved at most 90 minutes and made the shop
 * ping pointless). Boosts are now a WORKS-FORCE package: each tier cuts the
 * cooldown AND adds flat bonus ore to every run.
 *
 * `reduction` is the CUMULATIVE cooldown cut at that tier — it must stay in
 * sync with the lookup array in getMineCooldown (miningManager.js). Max
 * stack (tier 4 + Omega drill) lands ≈ 1h47m cooldown at tier 0,
 * ~13 runs/day.
 */
const MINING_BOOSTS = [
    { tier: 1, name: 'Coolant Injectors', cost: 15000, reduction: 0.10, bonusOre: 0, levelRequired: 5 },
    { tier: 2, name: 'Predictive Routing', cost: 60000, reduction: 0.20, bonusOre: 1, levelRequired: 15 },
    { tier: 3, name: 'Parallel Extractors', cost: 200000, reduction: 0.30, bonusOre: 2, levelRequired: 30 },
    { tier: 4, name: 'Chrono-Sync Core', cost: 750000, reduction: 0.40, bonusOre: 3, levelRequired: 50 }
];

// Sum of bonusOre across owned boost tiers (tier <= boostTier).
function getBoostBonusOre(boostTier) {
    return MINING_BOOSTS.reduce(
        (sum, boost) => sum + (boost.tier <= (Number(boostTier) || 0) ? boost.bonusOre : 0),
        0
    );
}

function getMiningBoost(tier) {
    return MINING_BOOSTS.find(boost => boost.tier === tier) || null;
}

// ==================================================
// GET AVAILABLE DRILLS FOR LEVEL
// ==================================================
function getAvailableDrills(miningLevel) {
    return Object.entries(drills)
        .filter(([id, drill]) => drill.levelRequired <= miningLevel)
        .map(([id, drill]) => ({ id, ...drill }));
}

// ==================================================
// GET AVAILABLE LOCATIONS FOR LEVEL
// ==================================================
function getAvailableLocations(miningLevel) {
    return Object.entries(locations)
        .filter(([id, loc]) => loc.levelRequired <= miningLevel)
        .map(([id, loc]) => ({ id, ...loc }));
}

module.exports = {
    MINE_BASE_COOLDOWN_MS,
    MIN_COOLDOWN_FLOOR_MS,
    drills,
    locations,
    getDrillUpgradeCost,
    getLocationUnlockCost,
    getAvailableDrills,
    getAvailableLocations
    ,MINING_BOOSTS
    ,getMiningBoost
    ,getBoostBonusOre
};
