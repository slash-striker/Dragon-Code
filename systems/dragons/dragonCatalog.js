/*
 * DRAGON HATCHERY — static catalog.
 *
 * The whole hatchery reads from this one file: egg types, the good-side
 * (Dragonflight) and bad-side (Onslaught) species pools, the random traits
 * that decide a pet's passive bonus, the level curve, and the drop tables
 * used by /mine, /fish and heists.
 *
 * Two rivalries drive the system:
 *   • side 'good'  → Dragonflight, apex species KNIGHTFURY
 *   • side 'evil'  → Onslaught,  apex species BLOODMAW
 *
 * Nothing here touches the database — keep it pure so it can be required by
 * tests and by both the manager and the renderer.
 */

// ==================================================
// RARITIES
// ==================================================
const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

const RARITY_STYLE = {
    common: { id: 'common', label: 'Common', emoji: '⚪', color: 0x8fa1b3, weight: 1000 },
    uncommon: { id: 'uncommon', label: 'Uncommon', emoji: '🟢', color: 0x4ade80, weight: 420 },
    rare: { id: 'rare', label: 'Rare', emoji: '🔵', color: 0x38bdf8, weight: 150 },
    epic: { id: 'epic', label: 'Epic', emoji: '🟣', color: 0xa855f7, weight: 46 },
    legendary: { id: 'legendary', label: 'Legendary', emoji: '🟠', color: 0xf59e0b, weight: 11 },
    mythic: { id: 'mythic', label: 'Mythic', emoji: '🌟', color: 0xff3d81, weight: 2 }
};

function rarityRank(rarity) {
    return Math.max(0, RARITY_ORDER.indexOf(String(rarity || 'common').toLowerCase()));
}

function rarityAtLeast(rarity, floor) {
    return rarityRank(rarity) >= rarityRank(floor);
}

// ==================================================
// TRAITS — one passive bonus each. A dragon rolls 1 primary trait and has a
// 35% chance of a second. Bonus scales with level and bond, and shrinks when
// the dragon is starving (see dragonManager.getDragonBonus).
// ==================================================
const TRAITS = {
    ember: {
        id: 'ember', name: 'Ember', emoji: '🔥', color: 0xff6b35,
        bonus: { mine_yield: 0.08 },
        blurb: 'Hatched in forge-fire — ore yields run hotter.'
    },
    frost: {
        id: 'frost', name: 'Frost', emoji: '❄️', color: 0x66d9ff,
        bonus: { fish_value: 0.08 },
        blurb: 'Cold water follows it — every catch sells higher.'
    },
    storm: {
        id: 'storm', name: 'Storm', emoji: '⚡', color: 0xffe066,
        bonus: { race_speed: 0.12 },
        blurb: 'Faster than thunder on the racing track.'
    },
    void: {
        id: 'void', name: 'Void', emoji: '🌌', color: 0x9b6bff,
        bonus: { rob_success: 0.06 },
        blurb: 'Slips through reality — handy on a quick robbery.'
    },
    verdant: {
        id: 'verdant', name: 'Verdant', emoji: '🌿', color: 0x6bff9b,
        bonus: { xp: 0.10 },
        blurb: 'Roots itself in growth — you earn XP faster.'
    },
    gilded: {
        id: 'gilded', name: 'Gilded', emoji: '🪙', color: 0xffd166,
        bonus: { credits: 0.05 },
        blurb: 'Scales flake real gold — every payout is bigger.'
    },
    shadow: {
        id: 'shadow', name: 'Shadow', emoji: '🌑', color: 0x7a7a99,
        bonus: { rob_defense: 0.10 },
        blurb: 'Shadows your vault — robbers have a harder time.'
    },
    radiant: {
        id: 'radiant', name: 'Radiant', emoji: '✨', color: 0xfff1a8,
        bonus: { heist_payout: 0.08 },
        blurb: 'A beacon for the crew — heists pay more.'
    }
};

const TRAIT_IDS = Object.keys(TRAITS);

// ==================================================
// SPECIES — 10 per side. `eggTypes` lists the eggs that can hatch it, and
// `hatchWeight` biases the roll *within* that egg's pool.
// ==================================================
const SPECIES = {
    // ---------- GOOD SIDE: DRAGONFLIGHT ----------
    knightfury: {
        id: 'knightfury', name: 'KNIGHTFURY', emoji: '🌌🐉', side: 'good', rarity: 'mythic',
        base: { power: 42, speed: 40, stamina: 38 },
        lore: 'The apex of the Dragonflight. A plasma-winged storm-dragon that answers only to riders it respects.'
    },
    star_weaver: {
        id: 'star_weaver', name: 'Star Weaver', emoji: '✨🐉', side: 'good', rarity: 'legendary',
        base: { power: 30, speed: 32, stamina: 26 },
        lore: 'Spins constellations between its claws and hums to moons it has never met.'
    },
    crystal_sentinel: {
        id: 'crystal_sentinel', name: 'Crystal Sentinel', emoji: '💎🐉', side: 'good', rarity: 'rare',
        base: { power: 22, speed: 14, stamina: 24 },
        lore: 'Its hide is a lattice of living gemstone — patient, unbreakable, quietly judging you.'
    },
    storm_herald: {
        id: 'storm_herald', name: 'Storm Herald', emoji: '⚡🐉', side: 'good', rarity: 'epic',
        base: { power: 26, speed: 28, stamina: 18 },
        lore: 'Announces itself with a pressure drop and the smell of ozone.'
    },
    dawn_bringer: {
        id: 'dawn_bringer', name: 'Dawn Bringer', emoji: '🌅🐉', side: 'good', rarity: 'epic',
        base: { power: 20, speed: 24, stamina: 26 },
        lore: 'Where it lands, the night quietly gives up.'
    },
    frost_warden: {
        id: 'frost_warden', name: 'Frost Warden', emoji: '❄️🐉', side: 'good', rarity: 'rare',
        base: { power: 20, speed: 16, stamina: 22 },
        lore: 'Guards the frozen vaults; its breath is a filing cabinet of ice.'
    },
    gale_dancer: {
        id: 'gale_dancer', name: 'Gale Dancer', emoji: '💨🐉', side: 'good', rarity: 'uncommon',
        base: { power: 12, speed: 24, stamina: 12 },
        lore: 'Never lands the same way twice. Show-off.'
    },
    stone_guardian: {
        id: 'stone_guardian', name: 'Stone Guardian', emoji: '🪨🐉', side: 'good', rarity: 'uncommon',
        base: { power: 18, speed: 8, stamina: 22 },
        lore: 'Slow, patient, and made almost entirely of reasons you should not steal from it.'
    },
    ember_scale: {
        id: 'ember_scale', name: 'Ember Scale', emoji: '🔥🐉', side: 'good', rarity: 'common',
        base: { power: 14, speed: 10, stamina: 12 },
        lore: 'A starter dragon with a chip on its shoulder and a very warm opinion of everything.'
    },
    tide_warden: {
        id: 'tide_warden', name: 'Tide Warden', emoji: '🌊🐉', side: 'good', rarity: 'common',
        base: { power: 11, speed: 13, stamina: 14 },
        lore: 'Smells of salt and old maps. Excellent at finding things you dropped.'
    },

    // ---------- BAD SIDE: ONSLAUGHT ----------
    bloodmaw: {
        id: 'bloodmaw', name: 'BLOODMAW', emoji: '🩸🐺', side: 'evil', rarity: 'mythic',
        base: { power: 44, speed: 36, stamina: 40 },
        lore: 'The apex beast of the Onslaught. It does not hunt — it collects.'
    },
    void_reaver: {
        id: 'void_reaver', name: 'Void Reaver', emoji: '🌌🐺', side: 'evil', rarity: 'legendary',
        base: { power: 34, speed: 26, stamina: 28 },
        lore: 'Eats light. Leaves a shadow with edges.'
    },
    magma_brute: {
        id: 'magma_brute', name: 'Magma Brute', emoji: '🌋🐻', side: 'evil', rarity: 'epic',
        base: { power: 30, speed: 12, stamina: 26 },
        lore: 'Its footsteps re-pave the street behind it.'
    },
    dread_maw: {
        id: 'dread_maw', name: 'Dread Maw', emoji: '🦷🐺', side: 'evil', rarity: 'epic',
        base: { power: 28, speed: 20, stamina: 18 },
        lore: 'Roughly forty percent teeth by volume.'
    },
    shadow_stalker: {
        id: 'shadow_stalker', name: 'Shadow Stalker', emoji: '🌑🐈', side: 'evil', rarity: 'rare',
        base: { power: 20, speed: 24, stamina: 14 },
        lore: 'You will hear it on the roof. You will never see it there.'
    },
    plague_crawler: {
        id: 'plague_crawler', name: 'Plague Crawler', emoji: '☣️🦂', side: 'evil', rarity: 'rare',
        base: { power: 22, speed: 14, stamina: 20 },
        lore: 'Legally a biohazard. Emotionally, a lap animal.'
    },
    iron_jaw: {
        id: 'iron_jaw', name: 'Iron Jaw', emoji: '⛓️🐗', side: 'evil', rarity: 'uncommon',
        base: { power: 22, speed: 8, stamina: 16 },
        lore: 'Bites first, files no paperwork, regrets nothing.'
    },
    venom_lurker: {
        id: 'venom_lurker', name: 'Venom Lurker', emoji: '🐍', side: 'evil', rarity: 'uncommon',
        base: { power: 16, speed: 16, stamina: 12 },
        lore: 'Fast, quiet, and 90% bad decisions for anyone nearby.'
    },
    ash_wyrm: {
        id: 'ash_wyrm', name: 'Ash Wyrm', emoji: '🌫️🐍', side: 'evil', rarity: 'common',
        base: { power: 13, speed: 12, stamina: 11 },
        lore: 'Wriggles out of burnt ground like it was never gone.'
    },
    bone_gnasher: {
        id: 'bone_gnasher', name: 'Bone Gnasher', emoji: '💀🐕', side: 'evil', rarity: 'common',
        base: { power: 15, speed: 9, stamina: 13 },
        lore: 'Chews anything. Especially things you still need.'
    }
};

const SPECIES_BY_SIDE = { good: [], evil: [] };
for (const species of Object.values(SPECIES)) SPECIES_BY_SIDE[species.side].push(species);
for (const side of Object.keys(SPECIES_BY_SIDE)) {
    SPECIES_BY_SIDE[side] = SPECIES_BY_SIDE[side].map(species => species.id);
}

// ==================================================
// EGGS — drop rarity, incubation window, species pool
// ==================================================
const EGG_TYPES = {
    ashen_egg: {
        id: 'ashen_egg', name: 'Ashen Egg', emoji: '🥚', rarity: 'common', side: 'good',
        incubateMs: 24 * 60 * 60 * 1000, value: 40_000,
        pool: ['ember_scale', 'tide_warden', 'stone_guardian', 'gale_dancer'],
        blurb: 'Warm to the touch. Something inside is already breathing.'
    },
    feral_egg: {
        id: 'feral_egg', name: 'Feral Egg', emoji: '🥚', rarity: 'common', side: 'evil',
        incubateMs: 24 * 60 * 60 * 1000, value: 40_000,
        pool: ['ash_wyrm', 'bone_gnasher', 'venom_lurker', 'iron_jaw'],
        blurb: 'The shell is scratched from the inside. Best not to shake it.'
    },
    tidal_egg: {
        id: 'tidal_egg', name: 'Tidal Egg', emoji: '🌊🥚', rarity: 'common', side: 'good',
        incubateMs: 24 * 60 * 60 * 1000, value: 45_000,
        pool: ['tide_warden', 'ember_scale', 'gale_dancer'],
        blurb: 'Sings a low note when you hold it to your ear.'
    },
    bone_egg: {
        id: 'bone_egg', name: 'Bone Egg', emoji: '💀🥚', rarity: 'common', side: 'evil',
        incubateMs: 24 * 60 * 60 * 1000, value: 45_000,
        pool: ['bone_gnasher', 'ash_wyrm', 'iron_jaw'],
        blurb: 'Not made of bone. Opinionated about that.'
    },
    gale_egg: {
        id: 'gale_egg', name: 'Gale Egg', emoji: '💨🥚', rarity: 'uncommon', side: 'good',
        incubateMs: 26 * 60 * 60 * 1000, value: 120_000,
        pool: ['gale_dancer', 'stone_guardian', 'frost_warden'],
        blurb: 'Hums whenever the door opens.'
    },
    venom_egg: {
        id: 'venom_egg', name: 'Venom Egg', emoji: '☣️🥚', rarity: 'uncommon', side: 'evil',
        incubateMs: 26 * 60 * 60 * 1000, value: 120_000,
        pool: ['venom_lurker', 'iron_jaw', 'shadow_stalker'],
        blurb: 'Handle with gloves. The gloves are now also a concern.'
    },
    frost_egg: {
        id: 'frost_egg', name: 'Frost Egg', emoji: '❄️🥚', rarity: 'rare', side: 'good',
        incubateMs: 30 * 60 * 60 * 1000, value: 400_000,
        pool: ['frost_warden', 'crystal_sentinel', 'storm_herald'],
        blurb: 'Frosts over the moment you stop watching it.'
    },
    void_egg: {
        id: 'void_egg', name: 'Void Egg', emoji: '🌌🥚', rarity: 'rare', side: 'evil',
        incubateMs: 30 * 60 * 60 * 1000, value: 400_000,
        pool: ['shadow_stalker', 'plague_crawler', 'dread_maw'],
        blurb: 'Light bends politely around it and then leaves.'
    },
    storm_egg: {
        id: 'storm_egg', name: 'Storm Egg', emoji: '⚡🥚', rarity: 'epic', side: 'good',
        incubateMs: 36 * 60 * 60 * 1000, value: 1_100_000,
        pool: ['storm_herald', 'dawn_bringer', 'star_weaver'],
        blurb: 'Static crawls up your arm. Your hair has opinions.'
    },
    magma_egg: {
        id: 'magma_egg', name: 'Magma Egg', emoji: '🌋🥚', rarity: 'epic', side: 'evil',
        incubateMs: 36 * 60 * 60 * 1000, value: 1_100_000,
        pool: ['magma_brute', 'dread_maw', 'void_reaver'],
        blurb: 'A small volcanic event you have decided to keep.'
    },
    celestial_egg: {
        id: 'celestial_egg', name: 'Celestial Egg', emoji: '🌟🥚', rarity: 'legendary', side: 'good',
        incubateMs: 42 * 60 * 60 * 1000, value: 3_500_000,
        pool: ['star_weaver', 'dawn_bringer', 'crystal_sentinel'],
        blurb: 'Weighs almost nothing. Casts a shadow anyway.'
    },
    abyssal_egg: {
        id: 'abyssal_egg', name: 'Abyssal Egg', emoji: '🩸🥚', rarity: 'legendary', side: 'evil',
        incubateMs: 42 * 60 * 60 * 1000, value: 3_500_000,
        pool: ['void_reaver', 'plague_crawler', 'magma_brute'],
        blurb: 'Drips seawater that was never part of an ocean.'
    },
    knightfury_egg: {
        id: 'knightfury_egg', name: 'KNIGHTFURY EGG', emoji: '🌌🥚', rarity: 'mythic', side: 'good',
        incubateMs: 48 * 60 * 60 * 1000, value: 12_000_000,
        pool: ['knightfury', 'star_weaver', 'storm_herald'],
        blurb: 'Plasma runs under the shell like a heartbeat with a plan.'
    },
    onslaught_egg: {
        id: 'onslaught_egg', name: 'ONSLAUGHT EGG', emoji: '🩸🥚', rarity: 'mythic', side: 'evil',
        incubateMs: 48 * 60 * 60 * 1000, value: 12_000_000,
        pool: ['bloodmaw', 'void_reaver', 'magma_brute'],
        blurb: 'The shell is warm and it is counting down.'
    }
};

const EGG_IDS = Object.keys(EGG_TYPES);

/* Weighted egg pool per rarity — used by the drop tables and the shop crate. */
function eggsOfRarity(rarity) {
    return EGG_IDS.filter(id => EGG_TYPES[id].rarity === rarity);
}

// ==================================================
// DROP TABLES
// ==================================================
/*
 * Every drop chance is intentionally low: an egg should feel like an event,
 * not a routine reward. `rarityWeights` biases the egg rarity that drops —
 * richer sources (a Mythic fish, a tier-4 heist, a big ore) push weight up.
 */
const DROP_SOURCES = {
    mine: {
        label: 'Mining run',
        chance: 0.012,
        rarityWeights: {
            common: 900, uncommon: 260, rare: 70, epic: 16, legendary: 2.4, mythic: 0.35
        },
        rarityBoost: 0.10
    },
    fish: {
        label: 'Fishing catch',
        chance: 0.015,
        rarityWeights: {
            common: 820, uncommon: 300, rare: 90, epic: 22, legendary: 3.2, mythic: 0.5
        },
        rarityBoost: 0.14
    },
    heist: {
        label: 'Heist score',
        chance: 0.09,
        rarityWeights: {
            common: 380, uncommon: 340, rare: 200, epic: 70, legendary: 12, mythic: 1.6
        },
        rarityBoost: 0.22
    },
    shop_crate: {
        label: 'Egg crate',
        chance: 1,
        rarityWeights: {
            common: 300, uncommon: 360, rare: 240, epic: 90, legendary: 16, mythic: 2
        },
        rarityBoost: 0.30
    },
    event: {
        label: 'Event gift',
        chance: 0.25,
        rarityWeights: {
            common: 200, uncommon: 320, rare: 280, epic: 140, legendary: 40, mythic: 8
        },
        rarityBoost: 0.5
    }
};

/*
 * `tierScore` is a 0..4 quality hint the caller derives from what actually
 * happened (ore rarity, fish rarity, heist tier). Higher scores shift the
 * rarity roll upward, so a Legendary fish is a materially better egg source
 * than a Junk fish without changing the base odds.
 */
function boostedRarityWeights(source, tierScore = 0) {
    const table = DROP_SOURCES[source] || DROP_SOURCES.mine;
    const shift = Math.max(0, Math.min(4, Number(tierScore) || 0));
    const weights = {};
    for (const rarity of RARITY_ORDER) {
        const base = table.rarityWeights[rarity] ?? 0;
        const boost = 1 + (table.rarityBoost || 0) * shift * rarityRank(rarity);
        weights[rarity] = base * boost;
    }
    return weights;
}

// ==================================================
// FEEDING / LEVELING
// ==================================================
const MAX_LEVEL = 30;

/* XP required to advance FROM `level` to `level + 1`. */
function xpForLevel(level) {
    const l = Math.max(1, Number(level) || 1);
    return Math.floor(120 * Math.pow(l, 1.45));
}

function totalXpForLevel(level) {
    let total = 0;
    for (let i = 1; i < Math.max(1, Number(level) || 1); i += 1) total += xpForLevel(i);
    return total;
}

/* Hunger and happiness both decay on a lazy hourly schedule. */
const HUNGER_DECAY_PER_HOUR = 4.2;
const HAPPINESS_DECAY_PER_HOUR = 2.4;

/* Feeding values per food rarity. `kind` is 'fish' or 'ore'. */
const FEED_VALUES = {
    fish: {
        Junk: { xp: 12, hunger: 5 },
        Common: { xp: 22, hunger: 8 },
        Uncommon: { xp: 38, hunger: 12 },
        Rare: { xp: 70, hunger: 18 },
        Epic: { xp: 120, hunger: 24 },
        Mythic: { xp: 220, hunger: 32 },
        Legendary: { xp: 360, hunger: 42 },
        Impossible: { xp: 520, hunger: 55 },
        'LEGENDARY EVENT': { xp: 300, hunger: 40 }
    },
    ore: {
        common: { xp: 14, hunger: 6 },
        uncommon: { xp: 30, hunger: 11 },
        rare: { xp: 58, hunger: 16 },
        epic: { xp: 105, hunger: 23 },
        legendary: { xp: 190, hunger: 30 },
        mythic: { xp: 320, hunger: 40 },
        seasonal: { xp: 90, hunger: 20 }
    }
};

function feedValue(kind, rarity) {
    const table = FEED_VALUES[kind] || {};
    return table[rarity] || { xp: 15, hunger: 6 };
}

/* Training costs a flat credit fee and trains a stat. */
const TRAIN_COST = 25_000;
const TRAIN_COOLDOWN_MS = 30 * 60 * 1000;
const PLAY_COOLDOWN_MS = 10 * 60 * 1000;

const STAT_KEYS = ['power', 'speed', 'stamina'];

/* Growth applied on every level-up, plus the stat a level favours. */
const LEVEL_GROWTH = { power: 3, speed: 3, stamina: 3 };

// ==================================================
// SHOP ITEM IDS owned by the hatchery
// ==================================================
const ITEMS = {
    EGG_CRATE: 'dragon_egg_crate',
    INCUBATION_ACCELERATOR: 'incubation_accelerator',
    FEED_PELLETS: 'dragon_feed_pellets'
};

const INCUBATOR_SLOTS = 3;
const INCUBATOR_UNLOCK_PRICES = [0, 5_000_000, 20_000_000];

module.exports = {
    RARITY_ORDER,
    RARITY_STYLE,
    rarityRank,
    rarityAtLeast,
    TRAITS,
    TRAIT_IDS,
    SPECIES,
    SPECIES_BY_SIDE,
    EGG_TYPES,
    EGG_IDS,
    eggsOfRarity,
    DROP_SOURCES,
    boostedRarityWeights,
    MAX_LEVEL,
    xpForLevel,
    totalXpForLevel,
    HUNGER_DECAY_PER_HOUR,
    HAPPINESS_DECAY_PER_HOUR,
    FEED_VALUES,
    feedValue,
    TRAIN_COST,
    TRAIN_COOLDOWN_MS,
    PLAY_COOLDOWN_MS,
    STAT_KEYS,
    LEVEL_GROWTH,
    ITEMS,
    INCUBATOR_SLOTS,
    INCUBATOR_UNLOCK_PRICES
};
