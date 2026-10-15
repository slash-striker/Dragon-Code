const db = require('../../database');
const { addOre } = require('./inventoryManager');
const { getOrePool } = require('./oreTables');
const { getMiningProfile, updateMiningProfile, addMiningXP } = require('./miningManager');
const { getGuildWorkerSlotBonus } = require('./guildPerks');

const CONTRACT_TEMPLATES = [
    ['Crystal Survey', 'raw_crystal', 8, 600, 80],
    ['Signal Recovery', 'neon_shard', 5, 1000, 120],
    ['Deep-Core Sample', 'quantum_fragment', 3, 1800, 180],
    ['Relic Expedition', 'cryo_relic', 2, 3500, 350],
    ['Nexus Commission', 'nexus_fragment', 1, 4500, 500]
];

// Drone yields are ORE UNITS (a gacha roll from the location pool per unit),
// not cash — a high tier means more rolls, not 40x the top ore per trip.
// Collection caps at 8 hours and 12 units per trip so drones are a daily
// bonus, not an idle money printer.
/*
 * Auto-miner budget: a maxed hangar (7 drones, T5) may earn roughly 1M
 * credits/day from drone deliveries, so the fleet's ore rate is deliberately
 * modest — each delivery is a 1-unit gacha roll from the location pool,
 * capped at 3 units per drone per 8-hour trip.
 */
const DRONE_TIERS = [
    { tier: 1, name: 'Scout Drone', cost: 5000, hourlyYield: 1 },
    { tier: 2, name: 'Mining Drone', cost: 25000, hourlyYield: 1 },
    { tier: 3, name: 'Swarm Drone', cost: 100000, hourlyYield: 2 },
    { tier: 4, name: 'Titan Drone', cost: 400000, hourlyYield: 2 },
    { tier: 5, name: 'Leviathan Drone', cost: 1500000, hourlyYield: 3 },
    { tier: 6, name: 'Celestial Drone', cost: 6000000, hourlyYield: 4 },
    { tier: 7, name: 'Singularity Drone', cost: 25000000, hourlyYield: 5 },
    { tier: 8, name: 'Omega Drone', cost: 100000000, hourlyYield: 6 }
];
const DRONE_MAX_HOURS = 8;
const DRONE_MAX_UNITS_PER_TRIP = 3;

/*
 * DRONE FLEET — drones are units, one per mining location.
 *
 * A player owns a HANGAR of drones (max 7, matching the 7 mining locations)
 * and assigns each to a different site. Tier upgrades apply to the whole
 * fleet; additional units are bought separately at a scaling price so the
 * fleet stays a meaningful credit sink, not a cheap money printer.
 */
const DRONE_FLEET_MAX = 7;
const DRONE_EXPANSION_COSTS = { 2: 25000, 3: 50000, 4: 100000, 5: 200000, 6: 400000, 7: 800000 };
const MINING_SITE_IDS = ['quantum_craters', 'cyber_depths', 'frozen_sector', 'lunar_station', 'nexus_core', 'asteroid_belt', 'singularity_rift'];

const WORKER_SPECIALTIES = {
    excavator: { efficiency: 1, cost: 2500 },
    geologist: { efficiency: 2, cost: 6000 },
    metallurgist: { efficiency: 3, cost: 12000 }
};

const RECIPES = {
    refined_crystal: { name: 'Refined Crystal', input: 'raw_crystal', amount: 3, output: 1, value: 260 },
    neon_alloy: { name: 'Neon Alloy', input: 'neon_shard', amount: 3, output: 1, value: 550 },
    quantum_lens: { name: 'Quantum Lens', input: 'quantum_fragment', amount: 2, output: 1, value: 900 },
    cryo_core: { name: 'Cryo Core', input: 'cryo_relic', amount: 2, output: 1, value: 12000 }
};

const ARTIFACTS = [
    { id: 'sunken_compass', name: 'Sunken Star Compass', rarity: 'rare', value: 4000, chance: 0.012 },
    { id: 'ancient_drill', name: 'Ancient Drill Head', rarity: 'epic', value: 15000, chance: 0.006 },
    { id: 'void_idol', name: 'Void Idol', rarity: 'legendary', value: 60000, chance: 0.002 }
];

const EVENT_TEMPLATES = [
    // ── Yield events (raw ore quantities) ───────────────────────────
    ['Meteor Shower', 'Falling debris exposes extra ore in every location.', 1.5, 'yield'],
    ['Cave-In', 'Unstable tunnels reduce extraction yields until crews stabilize them.', 0.7, 'yield'],
    ['Gravity Anomaly', 'Dense pockets have settled near the crust — richer pulls.', 1.4, 'yield'],
    ['Drone Swarm Bloom', 'Wild drones are strip-mining for you — take advantage.', 1.75, 'yield'],
    ['Tectonic Shift', 'Fresh strata exposed. Yields up across all claims.', 1.6, 'yield'],
    ['Dust Storm', 'Visibility near zero. Extraction efficiency suffers.', 0.6, 'yield'],
    ['Guild Strike', 'Crews walk out. Production crawls until resolved.', 0.55, 'yield'],
    ['Grid Blackout', 'A sector-wide power failure leaves drills spinning idle.', 0.45, 'yield'],
    ['Magnetic Anomaly', 'Compasses spin and drills wander — half of every pull is lost.', 0.5, 'yield'],
    ['Ice Vein Freeze', 'Flash-frozen seams turn ore brittle; half shatters on contact.', 0.5, 'yield'],
    ['Corporate Audit', 'Inspectors grounded every unlicensed rig in the sector.', 0.4, 'yield'],
    ['Radon Surge', 'Radiation alarms force reduced shifts across all claims.', 0.45, 'yield'],
    ['Swarm Infestation', 'Scrap-munching nanites have chewed through the extraction lines.', 0.35, 'yield'],
    ['Economic Slowdown', 'Ore prices collapse globally — demand dries up.', 0.5, 'yield'],
    ['Drone Recall Order', 'A firmware bug forces every autonomous unit into safe mode.', 0.4, 'yield'],
    ['Blackout Rationing', 'Energy rationing slashes drill throughput sector-wide.', 0.3, 'yield'],
    ['Voidsent Curse', 'Miners whisper of a curse — machines refuse to dig deep.', 0.25, 'yield'],
    ['Seismic Collapse', 'The main shaft has caved. Barely anything gets out.', 0.2, 'yield'],
    ['Overclocked Grid', 'Power surge pushes every drill past its safety limits.', 1.85, 'yield'],

    // ── Refine events (refining throughput/value) ───────────────────
    ['Refinery Rush', 'Refined materials are in high demand.', 1.35, 'refine'],
    ['Smelter Bounty', 'Megacorp subsidizing refinery output.', 1.6, 'refine'],
    ['Pipeline Failure', 'Refinery feedstock drying up.', 0.7, 'refine'],
    ['Smelter Fire', 'A furnace explosion halts refining output.', 0.35, 'refine'],
    ['Union Backlog', 'Refinery queues stretch for miles — throughput crawls.', 0.45, 'refine'],
    ['Contaminated Feedstock', 'Tainted ore shipments fail inspection at the smelter.', 0.5, 'refine'],

    // ── Artifact events (relic discovery chance) ────────────────────
    ['Ancient Signal', 'Relic scanners are receiving an unusually strong signal.', 2, 'artifact'],
    ['Xeno Broadcast', 'Unknown origin. Relic resonance at record highs.', 2.5, 'artifact'],
    ['Radar Blind Spot', 'Scanners offline — relics are hiding.', 0.5, 'artifact'],
    ['Signal Jamming', 'Static floods every relic scanner band.', 0.25, 'artifact'],
    ['Grave Silence', 'The deep has gone quiet. No relics answer the call.', 0.15, 'artifact'],

    // ── Flavor events (multiplier 1.0, cosmetic variety in the feed) ─
    ['Solar Flare', 'Communications scrambled. Markets are guessing.', 1.0, 'yield'],
    ['Terraforming Survey', 'Suits keep documenting new claims. Business as usual.', 1.0, 'yield']
];

function seasonKey(date = new Date()) {
    return `${date.getUTCFullYear()}-${String(Math.floor(date.getUTCMonth() / 3) + 1).padStart(2, '0')}`;
}

/* Memoized: this CREATE TABLE IF NOT EXISTS block used to run on every
   getWorkers/getActiveMiningEvent/collectDroneOre/recordMining call — several
   parses per /mine. One module-level flag keeps the first-call guarantee;
   new processes always run the first call, so upgrades without a restart
   are unaffected. */
let expansionTablesEnsured = false;

function ensureExpansionTables() {
    if (expansionTablesEnsured) return;
    db.exec(`
        CREATE TABLE IF NOT EXISTS mining_refined_inventory (
            userId TEXT NOT NULL, materialId TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(userId, materialId)
        );
        CREATE TABLE IF NOT EXISTS mining_events (
            eventId INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL,
            multiplier REAL NOT NULL DEFAULT 1, eventType TEXT NOT NULL DEFAULT 'yield',
            startsAt TEXT NOT NULL, endsAt TEXT NOT NULL, locationId TEXT, announced INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS mining_artifacts (
            userId TEXT NOT NULL, artifactId TEXT NOT NULL, name TEXT NOT NULL, rarity TEXT NOT NULL,
            value INTEGER NOT NULL DEFAULT 0, discoveredAt TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY(userId, artifactId)
        );
    `);
    expansionTablesEnsured = true;
}

function getActiveMiningEvent(create = true) {
    ensureExpansionTables();
    const now = new Date();
    const event = db.prepare(
        `SELECT * FROM mining_events WHERE startsAt <= ? AND endsAt > ? ORDER BY eventId DESC LIMIT 1`
    ).get(now.toISOString(), now.toISOString());
    if (event || !create) return event || null;
    // Events are globally shared and only roll when a mining command reads the event feed.
    if (Math.random() >= 0.12) return null;
    const template = EVENT_TEMPLATES[Math.floor(Math.random() * EVENT_TEMPLATES.length)];
    const startsAt = now.toISOString();
    const endsAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    const result = db.prepare(`
        INSERT INTO mining_events (name, description, multiplier, eventType, startsAt, endsAt)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(template[0], template[1], template[2], template[3], startsAt, endsAt);
    return db.prepare('SELECT * FROM mining_events WHERE eventId = ?').get(result.lastInsertRowid);
}

function getRecentMiningEvents(limit = 5) {
    ensureExpansionTables();
    return db.prepare('SELECT * FROM mining_events ORDER BY eventId DESC LIMIT ?').all(Math.max(1, Math.min(20, limit)));
}

function getOrCreateContract(userId) {
    const active = db.prepare(
        "SELECT * FROM mining_contracts WHERE userId = ? AND status = 'active' ORDER BY contractId DESC LIMIT 1"
    ).get(userId);
    if (active) return active;
    const template = CONTRACT_TEMPLATES[Math.floor(Math.random() * CONTRACT_TEMPLATES.length)];
    const result = db.prepare(`
        INSERT INTO mining_contracts
            (userId, title, targetOre, targetQuantity, reward, xpReward, acceptedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, template[0], template[1], template[2], template[3], template[4], new Date().toISOString());
    return db.prepare('SELECT * FROM mining_contracts WHERE contractId = ?').get(result.lastInsertRowid);
}

function getContracts(userId) {
    return db.prepare(
        'SELECT * FROM mining_contracts WHERE userId = ? ORDER BY contractId DESC LIMIT 10'
    ).all(userId);
}

function claimContract(userId, contractId) {
    const contract = db.prepare(
        "SELECT * FROM mining_contracts WHERE contractId = ? AND userId = ? AND status = 'completed'"
    ).get(contractId, userId);
    if (!contract) return { ok: false, message: 'That contract is not ready to claim.' };
    let result;
    try {
        result = db.transaction(() => {
            const claimed = db.prepare("UPDATE mining_contracts SET status = 'claimed', completedAt = ? WHERE contractId = ? AND userId = ? AND status = 'completed'")
                .run(new Date().toISOString(), contractId, userId);
            if (claimed.changes !== 1) throw new Error('That contract was already claimed.');
            db.prepare('UPDATE users SET mining_bank = COALESCE(mining_bank, 0) + ? WHERE userId = ?')
                .run(contract.reward, userId);
            const profile = getMiningProfile(userId);
            addMiningXP(profile, contract.xpReward);
            updateMiningProfile(profile);
            return profile;
        })();
    } catch (error) {
        return { ok: false, message: error.message };
    }
    return { ok: true, contract, profile: result };
}

function recordMining(userId, oreId, quantity, credits = 0) {
    ensureExpansionTables();
    const active = db.prepare(
        "SELECT * FROM mining_contracts WHERE userId = ? AND status = 'active' ORDER BY contractId DESC LIMIT 1"
    ).get(userId);
    let contractCompleted = null;
    if (active && active.targetOre === oreId) {
        const progress = Math.min(active.targetQuantity, active.progress + quantity);
        const status = progress >= active.targetQuantity ? 'completed' : 'active';
        db.prepare('UPDATE mining_contracts SET progress = ?, status = ?, completedAt = ? WHERE contractId = ?')
            .run(progress, status, status === 'completed' ? new Date().toISOString() : null, active.contractId);
        if (status === 'completed') contractCompleted = { ...active, progress, status };
    }

    const event = getActiveMiningEvent();
    const artifactEventBoost = event?.eventType === 'artifact' ? event.multiplier : 1;
    let artifact = null;
    const profile = getMiningProfile(userId);
    const artifactChance = Math.min(0.12, (0.002 + profile.miningLevel * 0.00015) * artifactEventBoost);
    if (Math.random() < artifactChance) {
        const roll = Math.random();
        let cumulative = 0;
        for (const candidate of ARTIFACTS) {
            cumulative += candidate.chance / 0.02;
            if (roll <= cumulative) {
                artifact = candidate;
                db.prepare(`
                    INSERT INTO mining_artifacts (userId, artifactId, name, rarity, value, discoveredAt)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(userId, artifactId) DO UPDATE SET quantity = quantity + 1
                `).run(userId, candidate.id, candidate.name, candidate.rarity, candidate.value, new Date().toISOString());
                db.prepare('UPDATE mining_profile SET relicsFound = relicsFound + 1 WHERE userId = ?').run(userId);
                break;
            }
        }
    }

    const season = seasonKey();
    db.prepare(`
        INSERT INTO mining_season_stats (season, userId, oreMined, creditsEarned, artifactsFound)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(season, userId) DO UPDATE SET
            oreMined = oreMined + excluded.oreMined,
            creditsEarned = creditsEarned + excluded.creditsEarned,
            artifactsFound = artifactsFound + excluded.artifactsFound
    `).run(season, userId, quantity, credits, artifact ? 1 : 0);

    const membership = db.prepare(
        'SELECT guildId FROM mining_guild_members WHERE userId = ? LIMIT 1'
    ).get(userId);
    if (membership) {
        db.prepare(`
            INSERT INTO mining_guild_contributions (guildId, userId, season, ore, credits)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(guildId, userId, season) DO UPDATE SET
                ore = ore + excluded.ore, credits = credits + excluded.credits
        `).run(membership.guildId, userId, season, quantity, credits);
        db.prepare('UPDATE mining_guilds SET totalOre = totalOre + ?, totalCredits = totalCredits + ? WHERE guildId = ?')
            .run(quantity, credits, membership.guildId);
    }
    return { event, artifact, contractCompleted };
}

function recordCredits(userId, credits) {
    if (!Number.isFinite(credits) || credits <= 0) return;
    const season = seasonKey();
    db.prepare(`
        INSERT INTO mining_season_stats (season, userId, creditsEarned)
        VALUES (?, ?, ?)
        ON CONFLICT(season, userId) DO UPDATE SET creditsEarned = creditsEarned + excluded.creditsEarned
    `).run(season, userId, Math.floor(credits));
    const membership = db.prepare('SELECT guildId FROM mining_guild_members WHERE userId = ? LIMIT 1').get(userId);
    if (membership) {
        db.prepare(`
            INSERT INTO mining_guild_contributions (guildId, userId, season, credits)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(guildId, userId, season) DO UPDATE SET credits = credits + excluded.credits
        `).run(membership.guildId, userId, season, Math.floor(credits));
        db.prepare('UPDATE mining_guilds SET totalCredits = totalCredits + ? WHERE guildId = ?')
            .run(Math.floor(credits), membership.guildId);
    }
}

// One drone row per (user, unit). Migrated from the legacy single-drone
// mining_drones table on first touch.
function ensureDroneFleet() {
    ensureExpansionTables();
    db.exec(`
        CREATE TABLE IF NOT EXISTS mining_drone_fleet (
            droneId INTEGER PRIMARY KEY AUTOINCREMENT,
            userId TEXT NOT NULL,
            tier INTEGER NOT NULL DEFAULT 1,
            assignedLocation TEXT,
            lastCollectedAt TEXT,
            totalOreCollected INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_drone_fleet_user ON mining_drone_fleet(userId);
    `);
    // Carry over any legacy single drone exactly once, then clear the old table.
    const legacy = db.prepare('SELECT * FROM mining_drones').all();
    if (legacy.length) {
        const migrated = new Set(
            db.prepare('SELECT DISTINCT userId FROM mining_drone_fleet').all().map(row => row.userId));
        db.transaction(() => {
            for (const row of legacy) {
                if (!migrated.has(row.userId)) {
                    db.prepare(`
                        INSERT INTO mining_drone_fleet (userId, tier, assignedLocation, lastCollectedAt, totalOreCollected)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(row.userId, row.tier, row.assignedLocation, row.lastCollectedAt, row.totalOreCollected);
                }
            }
            db.prepare('DELETE FROM mining_drones').run();
        })();
    }
}

function getFleet(userId) {
    ensureDroneFleet();
    return db.prepare('SELECT * FROM mining_drone_fleet WHERE userId = ? ORDER BY droneId').all(userId);
}

// Backward-compatible summary for /drill, /mining stats, etc.: highest tier,
// how many units, combined lifetime haul.
function getDrone(userId) {
    const fleet = getFleet(userId);
    if (!fleet.length) {
        return { userId, tier: 0, count: 0, assignedLocation: null,
            lastCollectedAt: new Date().toISOString(), totalOreCollected: 0 };
    }
    const top = fleet.reduce((a, b) => (b.tier > a.tier ? b : a));
    return {
        ...top,
        count: fleet.length,
        assignedLocation: fleet.find(drone => drone.assignedLocation)?.assignedLocation ?? null,
        totalOreCollected: fleet.reduce((sum, drone) => sum + (drone.totalOreCollected || 0), 0),
    };
}

function collectDroneOre(userId) {
    ensureDroneFleet();
    const fleet = getFleet(userId);
    if (!fleet.length) return { quantity: 0, ore: null };
    const now = Date.now();
    let grandTotal = 0;
    let primary = null;
    for (const drone of fleet) {
        if (!drone.tier || !drone.assignedLocation) continue;
        const last = new Date(drone.lastCollectedAt || now).getTime();
        // Time caps at 8 hours per drone — no multi-day idle accumulation.
        // A malformed timestamp just counts as "collected now" (no free ore).
        const elapsed = Number.isFinite(last) ? (now - last) / 3600000 : 0;
        const hours = Math.min(DRONE_MAX_HOURS, Math.max(0, elapsed));
        // Units are rolled ONE BY ONE from the location pool (rarity gacha),
        // capped per drone per trip.
        let quantity = Math.floor(hours * (DRONE_TIERS[drone.tier - 1]?.hourlyYield || 0));
        quantity = Math.min(DRONE_MAX_UNITS_PER_TRIP, quantity);
        if (quantity < 1) continue;
        const pool = getOrePool(drone.assignedLocation);
        if (!pool.length) continue;
        const finds = {};
        for (let i = 0; i < quantity; i++) {
            const ore = pool[Math.floor(Math.random() * pool.length)];
            if (!ore) continue;
            finds[ore.id] = (finds[ore.id] || 0) + 1;
            if (!primary) primary = ore;
        }
        let total = 0;
        for (const [oreId, qty] of Object.entries(finds)) {
            addOre(userId, oreId, qty);
            total += qty;
            recordMining(userId, oreId, qty, 0);
        }
        if (!total) continue;
        db.prepare('UPDATE mining_drone_fleet SET lastCollectedAt = ?, totalOreCollected = totalOreCollected + ? WHERE droneId = ?')
            .run(new Date().toISOString(), total, drone.droneId);
        grandTotal += total;
    }
    return { quantity: grandTotal, ore: primary };
}

/*
 * Buying:
 *   - No drones yet  → tier must be 1 (Scout), creates drone #1.
 *   - tier = max+1   → upgrades the ENTIRE fleet to that tier (ladder price).
 *   - tier = max     → adds another unit at the current tier (scaling price),
 *                      up to DRONE_FLEET_MAX drones.
 */
function buyDrone(userId, tier, wallet) {
    ensureDroneFleet();
    const config = DRONE_TIERS.find(item => item.tier === tier);
    if (!config) return { ok: false, message: 'Unknown drone tier.' };
    const fleet = getFleet(userId);
    const maxTier = fleet.reduce((best, drone) => Math.max(best, drone.tier), 0);
    if (fleet.length === 0) {
        if (tier !== 1) return { ok: false, message: 'Your first drone must be the Tier 1 Scout Drone.' };
    } else if (tier !== maxTier && tier !== maxTier + 1) {
        return { ok: false, message: `Purchase drone tiers in order — your fleet runs Tier ${maxTier}.` };
    }
    const addingUnit = fleet.length > 0 && tier === maxTier;
    if (addingUnit && fleet.length >= DRONE_FLEET_MAX) {
        return { ok: false, message: `Your hangar is full (${DRONE_FLEET_MAX} drones — one per mining location).` };
    }
    const cost = addingUnit ? (DRONE_EXPANSION_COSTS[fleet.length + 1] ?? config.cost) : config.cost;
    if (wallet < cost) return { ok: false, message: `You need 🪙${cost.toLocaleString()}.` };
    const purchase = db.transaction(() => {
        const debit = db.prepare('UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?')
            .run(cost, userId, cost);
        if (debit.changes !== 1) throw new Error(`You need 🪙${cost.toLocaleString()}.`);
        if (addingUnit) {
            db.prepare('INSERT INTO mining_drone_fleet (userId, tier, lastCollectedAt) VALUES (?, ?, ?)')
                .run(userId, tier, new Date().toISOString());
        } else if (fleet.length === 0) {
            db.prepare('INSERT INTO mining_drone_fleet (userId, tier, lastCollectedAt) VALUES (?, ?, ?)')
                .run(userId, tier, new Date().toISOString());
        } else {
            db.prepare('UPDATE mining_drone_fleet SET tier = ? WHERE userId = ?').run(tier, userId);
        }
    });
    try {
        purchase();
    } catch (error) {
        return { ok: false, message: error.message };
    }
    return { ok: true, fleet: getFleet(userId), config: { ...config, cost }, addedUnit: addingUnit };
}

/*
 * Assign a specific drone (1-based hangar number) to a location. One drone
 * per location; null or 'unassign' clears the post.
 */
function assignDrone(userId, locationId, droneNumber = null) {
    ensureDroneFleet();
    const fleet = getFleet(userId);
    if (!fleet.length) return { ok: false, message: 'Buy a drone first with `/mining drone-buy`.' };
    const clearing = !locationId || locationId === 'unassign';
    let drone;
    if (droneNumber !== null && droneNumber !== undefined) {
        drone = fleet[droneNumber - 1];
        if (!drone) return { ok: false, message: `You only have ${fleet.length} drone(s).` };
    } else if (clearing) {
        drone = fleet.find(item => item.assignedLocation) ?? fleet[0];
    } else {
        drone = fleet.find(item => !item.assignedLocation) ?? fleet[0];
    }
    if (!clearing && !MINING_SITE_IDS.includes(locationId)) {
        return { ok: false, message: 'Unknown mining site.' };
    }
    if (!clearing) {
        const occupied = fleet.find(item => item.droneId !== drone.droneId && item.assignedLocation === locationId);
        if (occupied) {
            return { ok: false, message: `Drone #${fleet.indexOf(occupied) + 1} is already stationed at that location — each site holds one drone.` };
        }
    }
    db.prepare('UPDATE mining_drone_fleet SET assignedLocation = ?, lastCollectedAt = ? WHERE droneId = ?')
        .run(clearing ? null : locationId, new Date().toISOString(), drone.droneId);
    return { ok: true, fleet: getFleet(userId), drone: { ...drone, assignedLocation: clearing ? null : locationId } };
}

function getWorkers(userId) {
    return db.prepare('SELECT * FROM mining_workers WHERE userId = ? AND active = 1 ORDER BY workerId').all(userId);
}

function hireWorker(userId, name, specialty, wallet) {
    const config = WORKER_SPECIALTIES[specialty];
    if (!config) return { ok: false, message: 'Specialty must be excavator, geologist, or metallurgist.' };
    if (wallet < config.cost) return { ok: false, message: `You need 🪙${config.cost.toLocaleString()}.` };
    // ⛏️ Guild perk: 4+ member guilds add one crew slot (5 → 6).
    const workerCap = 5 + getGuildWorkerSlotBonus(userId);
    if (getWorkers(userId).length >= workerCap) return { ok: false, message: `Your crew is full (maximum ${workerCap} workers${workerCap > 5 ? ' — includes the guild crew-slot bonus' : ''}).` };
    const purchase = db.transaction(() => {
        const debit = db.prepare('UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?')
            .run(config.cost, userId, config.cost);
        if (debit.changes !== 1) throw new Error(`You need 🪙${config.cost.toLocaleString()}.`);
        db.prepare(`
            INSERT INTO mining_workers (userId, name, specialty, efficiency, hiredAt)
            VALUES (?, ?, ?, ?, ?)
        `).run(userId, name.slice(0, 32), specialty, config.efficiency, new Date().toISOString());
    });
    try {
        purchase();
    } catch (error) {
        return { ok: false, message: error.message };
    }
    return { ok: true, worker: getWorkers(userId).at(-1), config };
}

function refineOre(userId, recipeId, quantity) {
    const recipe = RECIPES[recipeId];
    if (!recipe || !Number.isSafeInteger(quantity) || quantity < 1) return { ok: false, message: 'Invalid recipe or quantity.' };
    const input = db.prepare('SELECT quantity FROM mining_inventory WHERE userId = ? AND oreId = ?')
        .get(userId, recipe.input)?.quantity || 0;
    const required = recipe.amount * quantity;
    if (input < required) return { ok: false, message: `You need ${required} ${recipe.input.replace(/_/g, ' ')}.` };
    db.transaction(() => {
        db.prepare('UPDATE mining_inventory SET quantity = quantity - ? WHERE userId = ? AND oreId = ?')
            .run(required, userId, recipe.input);
        db.prepare(`
            INSERT INTO mining_refined_inventory (userId, materialId, quantity) VALUES (?, ?, ?)
            ON CONFLICT(userId, materialId) DO UPDATE SET quantity = quantity + excluded.quantity
        `).run(userId, recipeId, quantity * recipe.output);
    })();
    return { ok: true, recipe, quantity: quantity * recipe.output };
}

function getRefinedInventory(userId) {
    return db.prepare('SELECT materialId, quantity FROM mining_refined_inventory WHERE userId = ? AND quantity > 0').all(userId);
}

function getArtifacts(userId) {
    ensureExpansionTables();
    return db.prepare('SELECT * FROM mining_artifacts WHERE userId = ? AND quantity > 0 ORDER BY value DESC').all(userId);
}

function getLeaderboard(limit = 10) {
    return db.prepare(`
        SELECT season, userId, oreMined, creditsEarned, artifactsFound
        FROM mining_season_stats WHERE season = ?
        ORDER BY oreMined DESC, creditsEarned DESC LIMIT ?
    `).all(seasonKey(), Math.max(1, Math.min(25, limit)));
}

function createGuild(userId, name) {
    const cleanName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 32);
    if (cleanName.length < 3) return { ok: false, message: 'Guild names must be at least 3 characters.' };
    if (db.prepare('SELECT 1 FROM mining_guild_members WHERE userId = ?').get(userId)) return { ok: false, message: 'You are already in a mining guild.' };
    try {
        const guildId = db.transaction(() => {
            const result = db.prepare('INSERT INTO mining_guilds (name, ownerId, createdAt) VALUES (?, ?, ?)')
                .run(cleanName, userId, new Date().toISOString());
            db.prepare('INSERT INTO mining_guild_members (guildId, userId, role, joinedAt) VALUES (?, ?, ?, ?)')
                .run(result.lastInsertRowid, userId, 'owner', new Date().toISOString());
            return result.lastInsertRowid;
        })();
        return { ok: true, guild: getGuild(guildId) };
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return { ok: false, message: 'That guild name is already taken.' };
        throw error;
    }
}

function joinGuild(userId, name) {
    if (db.prepare('SELECT 1 FROM mining_guild_members WHERE userId = ?').get(userId)) return { ok: false, message: 'You are already in a mining guild.' };
    const guild = db.prepare('SELECT * FROM mining_guilds WHERE lower(name) = lower(?)').get(String(name || '').trim());
    if (!guild) return { ok: false, message: 'Mining guild not found.' };
    db.prepare('INSERT INTO mining_guild_members (guildId, userId, joinedAt) VALUES (?, ?, ?)')
        .run(guild.guildId, userId, new Date().toISOString());
    return { ok: true, guild: getGuild(guild.guildId) };
}

function getGuild(guildId) {
    const guild = db.prepare('SELECT * FROM mining_guilds WHERE guildId = ?').get(guildId);
    if (!guild) return null;
    return { ...guild, members: db.prepare('SELECT * FROM mining_guild_members WHERE guildId = ?').all(guildId) };
}

function getUserGuild(userId) {
    const membership = db.prepare('SELECT guildId FROM mining_guild_members WHERE userId = ?').get(userId);
    return membership ? getGuild(membership.guildId) : null;
}

function leaveGuild(userId) {
    const membership = db.prepare('SELECT guildId, role FROM mining_guild_members WHERE userId = ?').get(userId);
    if (!membership) return { ok: false, message: 'You are not in a mining guild.' };
    const result = db.transaction(() => {
        db.prepare('DELETE FROM mining_guild_members WHERE guildId = ? AND userId = ?')
            .run(membership.guildId, userId);
        const remaining = db.prepare('SELECT userId FROM mining_guild_members WHERE guildId = ? ORDER BY joinedAt LIMIT 1')
            .get(membership.guildId);
        if (!remaining) {
            db.prepare('DELETE FROM mining_guild_contributions WHERE guildId = ?').run(membership.guildId);
            db.prepare('DELETE FROM mining_guilds WHERE guildId = ?').run(membership.guildId);
        } else if (membership.role === 'owner') {
            db.prepare("UPDATE mining_guild_members SET role = 'owner' WHERE guildId = ? AND userId = ?")
                .run(membership.guildId, remaining.userId);
            db.prepare('UPDATE mining_guilds SET ownerId = ? WHERE guildId = ?')
                .run(remaining.userId, membership.guildId);
        }
        return remaining?.userId || null;
    })();
    return { ok: true, guildId: membership.guildId, successor: result };
}

module.exports = {
    CONTRACT_TEMPLATES, DRONE_TIERS, WORKER_SPECIALTIES, RECIPES, ARTIFACTS, EVENT_TEMPLATES,
    DRONE_FLEET_MAX, DRONE_EXPANSION_COSTS, DRONE_MAX_HOURS, DRONE_MAX_UNITS_PER_TRIP, MINING_SITE_IDS,
    ensureExpansionTables, seasonKey, getActiveMiningEvent, getRecentMiningEvents,
    getOrCreateContract, getContracts, claimContract, recordMining, recordCredits,
    getDrone, getFleet, collectDroneOre, buyDrone, assignDrone, getWorkers, hireWorker,
    refineOre, getRefinedInventory, getArtifacts, getLeaderboard,
    createGuild, joinGuild, leaveGuild, getGuild, getUserGuild
};
