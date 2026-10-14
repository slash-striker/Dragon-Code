const db = require('../../database');

// ==================================================
// INIT TABLE
// ==================================================

/* Memoized: CREATE TABLE IF NOT EXISTS parses ~15 column definitions on EVERY
   getMiningProfile call, and /mine touches the profile several times per run
   (getMineCooldown, XP, streaks). One module-level flag keeps the first-call
   guarantee while making repeat calls free. Idempotent by design — new
   processes always run the first call. */
let miningTableEnsured = false;

function initMiningTable() {
    if (miningTableEnsured) return;
    db.exec(`
        CREATE TABLE IF NOT EXISTS mining_profile (
            userId TEXT PRIMARY KEY,

            miningLevel INTEGER DEFAULT 1,
            miningXp INTEGER DEFAULT 0,

            activeDrill TEXT DEFAULT 'basic_drill',
            activeLocation TEXT DEFAULT 'quantum_craters',

            unlockedLocations TEXT DEFAULT '["quantum_craters"]',

            droneTier INTEGER DEFAULT 0,
            mineCooldown INTEGER DEFAULT 0,

            relicsFound INTEGER DEFAULT 0,
            totalMines INTEGER DEFAULT 0,
            totalOreFound INTEGER DEFAULT 0,

            miningStreak INTEGER DEFAULT 0,
            lastMineTime TEXT DEFAULT NULL
        )
    `);
    miningTableEnsured = true;
}

// ==================================================
// SAFE JSON PARSE
// ==================================================
function safeParse(json, fallback = ["quantum_craters"]) {
    if (Array.isArray(json)) {
        return json;
    }

    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
}

// ==================================================
// GET PROFILE
// ==================================================
function getMiningProfile(userId) {
    initMiningTable();

    let profile = db.prepare(`
        SELECT *
        FROM mining_profile
        WHERE userId = ?
    `).get(userId);

    if (!profile) {
        db.prepare(`
            INSERT INTO mining_profile (
                userId,
                unlockedLocations
            )
            VALUES (?, ?)
        `).run(
            userId,
            JSON.stringify(["quantum_craters"])
        );

        profile = db.prepare(`
            SELECT *
            FROM mining_profile
            WHERE userId = ?
        `).get(userId);
    }

    return normalize(profile);
}

// ==================================================
// NORMALIZE (SAFE)
// ==================================================
function normalize(profile) {
    if (!profile) {
        return {
            userId: null,
            miningLevel: 1,
            miningXp: 0,
            activeDrill: 'basic_drill',
            activeLocation: 'quantum_craters',
            unlockedLocations: ["quantum_craters"],
            ownedDrills: ["basic_drill"],
            boostTier: 0,
            droneTier: 0,
            mineCooldown: 0,
            relicsFound: 0,
            totalMines: 0,
            totalOreFound: 0,
            miningStreak: 0,
            lastMineTime: null
        };
    }

    const unlockedLocations = safeParse(profile.unlockedLocations)
        .filter(locationId => typeof locationId === 'string');
    if (!unlockedLocations.includes("quantum_craters")) {
        unlockedLocations.unshift("quantum_craters");
    }
    const ownedDrills = safeParse(profile.ownedDrills, ["basic_drill"])
        .filter(drillId => typeof drillId === 'string');
    if (!ownedDrills.includes("basic_drill")) {
        ownedDrills.unshift("basic_drill");
    }

    return {
        userId: profile.userId,

        miningLevel: Math.max(1, Number(profile.miningLevel) || 1),
        miningXp: Math.max(0, Number(profile.miningXp) || 0),

        activeDrill: profile.activeDrill ?? 'basic_drill',
        activeLocation: profile.activeLocation ?? 'quantum_craters',

        unlockedLocations,
        ownedDrills,
        boostTier: Math.max(0, Number(profile.boostTier) || 0),

        droneTier: Math.max(0, Number(profile.droneTier) || 0),
        mineCooldown: Math.max(0, Number(profile.mineCooldown) || 0),

        relicsFound: Math.max(0, Number(profile.relicsFound) || 0),
        totalMines: Math.max(0, Number(profile.totalMines) || 0),
        totalOreFound: Math.max(0, Number(profile.totalOreFound) || 0),

        miningStreak: Math.max(0, Number(profile.miningStreak) || 0),
        lastMineTime: profile.lastMineTime ?? null
    };
}

// ==================================================
// SAVE PROFILE
// ==================================================
function updateMiningProfile(profile) {
    const p = normalize(profile);

    db.prepare(`
        UPDATE mining_profile
        SET
            miningLevel = ?,
            miningXp = ?,

            activeDrill = ?,
            activeLocation = ?,

            unlockedLocations = ?,
            ownedDrills = ?,
            boostTier = ?,

            droneTier = ?,
            mineCooldown = ?,

            relicsFound = ?,
            totalMines = ?,
            totalOreFound = ?,

            miningStreak = ?,
            lastMineTime = ?

        WHERE userId = ?
    `).run(
        p.miningLevel,
        p.miningXp,

        p.activeDrill,
        p.activeLocation,

        JSON.stringify(p.unlockedLocations),
        JSON.stringify(p.ownedDrills),
        p.boostTier,

        p.droneTier,
        p.mineCooldown,

        p.relicsFound,
        p.totalMines,
        p.totalOreFound,

        p.miningStreak,
        p.lastMineTime,

        p.userId
    );
}

// ==================================================
// XP SYSTEM
// ==================================================
function xpNeeded(level) {
    return Math.floor(100 * Math.pow(level, 1.5));
}

function addMiningXP(profile, amount) {
    profile.miningXp = profile.miningXp ?? 0;
    profile.miningLevel = profile.miningLevel ?? 1;

    profile.miningXp += amount;

    let leveledUp = false;

    while (profile.miningXp >= xpNeeded(profile.miningLevel)) {
        profile.miningXp -= xpNeeded(profile.miningLevel);
        profile.miningLevel++;
        leveledUp = true;
    }

    return leveledUp;
}

// ==================================================
// LOCATION UNLOCK
// ==================================================
function unlockLocation(profile, locationId) {
    if (!profile.unlockedLocations) {
        profile.unlockedLocations = ["quantum_craters"];
    }

    if (!profile.unlockedLocations.includes(locationId)) {
        profile.unlockedLocations.push(locationId);
    }
}

// ==================================================
// STREAK SYSTEM
// ==================================================
function updateMiningStreak(profile) {
    const now = new Date();
    const lastMine = profile.lastMineTime ? new Date(profile.lastMineTime) : null;

    if (!lastMine) {
        profile.miningStreak = 1;
    } else {
        const hoursDiff = (now - lastMine) / (1000 * 60 * 60);
        
        if (hoursDiff < 24) {
            profile.miningStreak++;
        } else if (hoursDiff < 48) {
            profile.miningStreak = 1;
        } else {
            profile.miningStreak = 0;
        }
    }

    profile.lastMineTime = now.toISOString();
}

// ==================================================
// COOLDOWN CHECK
// ==================================================
function canMine(profile) {
    if (profile.mineCooldown === 0) return true;
    
    const now = Date.now();
    return now >= profile.mineCooldown;
}

function setCooldown(profile, milliseconds) {
    profile.mineCooldown = Date.now() + milliseconds;
    return profile.mineCooldown;
}

/*
 * Cooldown math: progressive tier base (keyed on lifetime totalMines) −
 * drill reduction, then boost %. The boost array is CUMULATIVE reduction
 * per tier — keep it in sync with MINING_BOOSTS.reduction in drillTables.js.
 * Floor is 15 minutes. Full stack at tier 0 (tier-4 boost + Omega drill):
 * (3h − 60k) × 0.60 ≈ 1h47m; the same stack at the top tier (4h base)
 * lands ≈ 2h20m.
 */
const MIN_COOLDOWN_MS = 15 * 60 * 1000;

/*
 * Progressive cooldown ladder: veterans mine on a slightly longer cadence.
 * Tiers key off totalMines (lifetime /mine runs) and REPLACE the 3h location
 * base — each tier adds 15 minutes, so the ladder runs 3h → 3h15m → 3h30m →
 * 3h45m → 4h. Boosts and drill reductions still apply on top, and the
 * 15-minute floor still wins. Tier 0 is the historical 3h base, so nobody
 * changes until they cross 200 lifetime mines. The tier base wins over the
 * location base (max), so a future location with a longer base still applies.
 */
const MINE_TIER_STEP_MS = 15 * 60 * 1000;
const MINE_TIER_THRESHOLDS = [0, 200, 500, 1000, 2000];
const MINE_TIERS = MINE_TIER_THRESHOLDS.map((minMines, index) => ({
    minMines,
    baseMs: 3 * 60 * 60 * 1000 + index * MINE_TIER_STEP_MS
}));

function getMineTier(totalMines) {
    const mines = Math.max(0, Number(totalMines) || 0);
    let tier = MINE_TIERS[0];
    for (const candidate of MINE_TIERS) {
        if (mines >= candidate.minMines) tier = candidate;
    }
    return tier;
}

/*
 * Admin override: /set-cooldown command='mine' sets the TIER-0 BASE via the
 * cooldown_settings table under key 'mine_base'. The +15 min/tier ladder
 * STILL climbs on top of the pin — pin 30 gives 30m → 45m → 60m → 75m → 90m
 * as lifetime mines cross each tier threshold (200/500/1000/2000). Drill
 * reductions and boost % cut the result, floor 15m. minutes:0 clears the
 * pin and restores the built-in 3h base ladder (3h → 3h15m → … → 4h).
 */
function getPinnedMineBaseMs() {
    try {
        const db = require('../../database');
        const row = db.prepare(
            'SELECT durationMs FROM cooldown_settings WHERE command = ?'
        ).get('mine_base');
        if (!row) return null;
        const ms = Number(row.durationMs);
        return Number.isFinite(ms) && ms > 0 ? ms : null;
    } catch {
        return null;
    }
}

function getMineCooldown(profile, baseCooldown, cooldownReduction = 0) {
    const tier = getMineTier(profile?.totalMines);
    const tierIndex = Math.max(0, MINE_TIERS.indexOf(tier));
    const pinnedBase = getPinnedMineBaseMs();
    // The pin sets the TIER-0 base; the +15m/tier ladder shifts every tier
    // exactly like it shifts the built-in 3h base. Without a pin the tier
    // base wins over the location base (a future longer location applies).
    const base = pinnedBase != null
        ? pinnedBase + tierIndex * MINE_TIER_STEP_MS
        : Math.max(tier.baseMs, Number(baseCooldown));
    const net = Math.max(5000, base - Number(cooldownReduction || 0));
    const boostReduction = profile?.boostReduction != null
        ? Number(profile.boostReduction)
        : [0, 0.10, 0.20, 0.30, 0.40][Math.max(0, Math.min(4, Number(profile?.boostTier) || 0))];
    return Math.max(MIN_COOLDOWN_MS, Math.floor(net * (1 - boostReduction)));
}

// ==================================================
// EXPORTS
// ==================================================
module.exports = {
    getMiningProfile,
    updateMiningProfile,
    addMiningXP,
    xpNeeded,
    unlockLocation,
    updateMiningStreak,
    canMine,
    setCooldown,
    getMineCooldown,
    getMineTier,
    MINE_TIERS
};
