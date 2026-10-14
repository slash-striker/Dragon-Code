// ==================================================
// HIGH-TECH ORE TABLES
// ==================================================
// Weight = chance relative to others in location
// Value = sell value in credits
// XP = mining XP earned
// ==================================================

function getCurrentSeason() {
    const month = new Date().getMonth() + 1;

    if (month === 10) return 'halloween';
    if (month === 12) return 'christmas';
    if (month === 4) return 'easter';
    if (month === 2) return 'valentines';
    if (month === 3) return 'stpatricks';
    if (month === 1) return 'newyear';

    return null;
}

// ==================================================
// LOCATION ORES (HIGH-TECH THEME)
// ==================================================

const locations = {

    quantum_craters: [
        {
            id: 'raw_crystal',
            name: '🔮 Raw Crystal',
            weight: 40,
            value: 60,
            xp: 8,
            rarity: 'common'
        },
        {
            id: 'neon_shard',
            name: '⚡ Neon Shard',
            weight: 30,
            value: 120,
            xp: 15,
            rarity: 'uncommon'
        },
        {
            id: 'quantum_fragment',
            name: '🌌 Quantum Fragment',
            weight: 20,
            value: 250,
            xp: 30,
            rarity: 'rare'
        },
        {
            id: 'void_essence',
            name: '🖤 Void Essence',
            weight: 10,
            value: 700,
            xp: 60,
            rarity: 'epic'
        }
    ],

    cyber_depths: [
        {
            id: 'data_crystal',
            name: '💾 Data Crystal',
            weight: 35,
            value: 350,
            xp: 35,
            rarity: 'uncommon'
        },
        {
            id: 'circuit_core',
            name: '🔌 Circuit Core',
            weight: 35,
            value: 550,
            xp: 50,
            rarity: 'rare'
        },
        {
            id: 'plasma_ore',
            name: '🔥 Plasma Ore',
            weight: 25,
            value: 1200,
            xp: 100,
            rarity: 'epic'
        },
        {
            id: 'dark_matter',
            name: '⚛️ Dark Matter',
            weight: 5,
            value: 3200,
            xp: 200,
            rarity: 'legendary'
        }
    ],

    frozen_sector: [
        {
            id: 'frost_data',
            name: '❄️ Frost Data',
            weight: 45,
            value: 400,
            xp: 40,
            rarity: 'uncommon'
        },
        {
            id: 'ice_processor',
            name: '🧊 Ice Processor',
            weight: 35,
            value: 800,
            xp: 70,
            rarity: 'rare'
        },
        {
            id: 'cryo_relic',
            name: '🏺 Cryo Relic',
            weight: 20,
            value: 2200,
            xp: 150,
            rarity: 'epic'
        }
    ],

    lunar_station: [
        {
            id: 'moon_chip',
            name: '🌙 Moon Chip',
            weight: 45,
            value: 700,
            xp: 75,
            rarity: 'rare'
        },
        {
            id: 'cosmic_drive',
            name: '☄️ Cosmic Drive',
            weight: 40,
            value: 1500,
            xp: 120,
            rarity: 'epic'
        },
        {
            id: 'stellar_artifact',
            name: '🏺 Stellar Artifact',
            weight: 15,
            value: 4000,
            xp: 300,
            rarity: 'legendary'
        }
    ],

    nexus_core: [
        {
            id: 'energy_crystal',
            name: '⚡ Energy Crystal',
            weight: 40,
            value: 1200,
            xp: 180,
            rarity: 'epic'
        },
        {
            id: 'nexus_fragment',
            name: '🌟 Nexus Fragment',
            weight: 45,
            value: 2200,
            xp: 300,
            rarity: 'legendary'
        },
        {
            id: 'primordial_core',
            name: '👑 Primordial Core',
            weight: 15,
            value: 7000,
            xp: 600,
            rarity: 'mythic'
        }
    ],

    asteroid_belt: [
        { id: 'titanium_lattice', name: '🛠️ Titanium Lattice', weight: 45, value: 1800, xp: 420, rarity: 'legendary' },
        { id: 'ion_crystal', name: '🔋 Ion Crystal', weight: 35, value: 2800, xp: 560, rarity: 'legendary' },
        { id: 'asteroid_core', name: '☄️ Asteroid Core', weight: 20, value: 5500, xp: 800, rarity: 'mythic' }
    ],

    singularity_rift: [
        { id: 'event_horizon_shard', name: '🌑 Event Horizon Shard', weight: 50, value: 2500, xp: 700, rarity: 'legendary' },
        { id: 'gravity_lens', name: '🔭 Gravity Lens', weight: 35, value: 4500, xp: 1000, rarity: 'mythic' },
        { id: 'singularity_core', name: '🌀 Singularity Core', weight: 15, value: 9000, xp: 1600, rarity: 'mythic' }
    ]
};

// ==================================================
// SEASONAL ORES (HIGH-TECH THEME)
// ==================================================

const seasonalOres = {

    christmas: [
        {
            id: 'gift_data',
            name: '🎁 Gift Data',
            weight: 40,
            value: 1000,
            xp: 75,
            rarity: 'rare'
        },
        {
            id: 'holo_candy',
            name: '🍬 Holo Candy',
            weight: 35,
            value: 1400,
            xp: 100,
            rarity: 'epic'
        },
        {
            id: 'frost_processor',
            name: '❄️ Frost Processor',
            weight: 20,
            value: 2500,
            xp: 200,
            rarity: 'legendary'
        },
        {
            id: 'santa_relay',
            name: '🔔 Santa Relay',
            weight: 5,
            value: 8000,
            xp: 600,
            rarity: 'mythic'
        }
    ],

    halloween: [
        {
            id: 'pumpkin_drive',
            name: '🎃 Pumpkin Drive',
            weight: 40,
            value: 1000,
            xp: 75,
            rarity: 'rare'
        },
        {
            id: 'ghost_data',
            name: '👻 Ghost Data',
            weight: 35,
            value: 1400,
            xp: 100,
            rarity: 'epic'
        },
        {
            id: 'bat_processor',
            name: '🦇 Bat Processor',
            weight: 20,
            value: 2500,
            xp: 200,
            rarity: 'legendary'
        },
        {
            id: 'cursed_core',
            name: '☠️ Cursed Core',
            weight: 5,
            value: 8000,
            xp: 600,
            rarity: 'mythic'
        }
    ],

    easter: [
        {
            id: 'egg_chip',
            name: '🥚 Egg Chip',
            weight: 40,
            value: 1000,
            xp: 75,
            rarity: 'rare'
        },
        {
            id: 'bloom_data',
            name: '🌸 Bloom Data',
            weight: 35,
            value: 1400,
            xp: 100,
            rarity: 'epic'
        },
        {
            id: 'rabbit_drive',
            name: '🐇 Rabbit Drive',
            weight: 20,
            value: 2500,
            xp: 200,
            rarity: 'legendary'
        },
        {
            id: 'golden_core',
            name: '👑 Golden Core',
            weight: 5,
            value: 8000,
            xp: 600,
            rarity: 'mythic'
        }
    ],

    valentines: [
        {
            id: 'love_data',
            name: '💖 Love Data',
            weight: 50,
            value: 1200,
            xp: 90,
            rarity: 'rare'
        },
        {
            id: 'rose_processor',
            name: '🌹 Rose Processor',
            weight: 35,
            value: 2000,
            xp: 150,
            rarity: 'epic'
        },
        {
            id: 'heart_drive',
            name: '❤️ Heart Drive',
            weight: 15,
            value: 6000,
            xp: 400,
            rarity: 'legendary'
        }
    ],

    stpatricks: [
        {
            id: 'clover_chip',
            name: '☘️ Clover Chip',
            weight: 50,
            value: 1000,
            xp: 90,
            rarity: 'rare'
        },
        {
            id: 'rainbow_data',
            name: '🌈 Rainbow Data',
            weight: 35,
            value: 2500,
            xp: 200,
            rarity: 'epic'
        },
        {
            id: 'leprechaun_core',
            name: '🏆 Leprechaun Core',
            weight: 15,
            value: 7000,
            xp: 450,
            rarity: 'legendary'
        }
    ],

    newyear: [
        {
            id: 'celebration_drive',
            name: '🎆 Celebration Drive',
            weight: 50,
            value: 1400,
            xp: 110,
            rarity: 'rare'
        },
        {
            id: 'time_crystal',
            name: '⌛ Time Crystal',
            weight: 35,
            value: 2500,
            xp: 200,
            rarity: 'epic'
        },
        {
            id: 'eternal_processor',
            name: '👑 Eternal Processor',
            weight: 15,
            value: 8000,
            xp: 500,
            rarity: 'legendary'
        }
    ]
};

// ==================================================
// HELPERS
// ==================================================

function weightedPick(items) {
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    let roll = Math.random() * total;

    for (const item of items) {
        if (roll < item.weight) {
            return item;
        }
        roll -= item.weight;
    }

    return items[0];
}

function getOrePool(locationId) {
    let pool = [...(locations[locationId] || [])];

    const season = getCurrentSeason();
    if (season && seasonalOres[season]) {
        pool.push(...seasonalOres[season]);
    }

    return pool;
}


// ==================================================
// SINGLE SOURCE OF TRUTH FOR ORE VALUES
// Built from the tables above so /mine payouts, /sell market prices, and
// any other consumer can never drift apart.
// ==================================================

const BASE_ORE_VALUES = Object.fromEntries(
    [...Object.values(locations), ...Object.values(seasonalOres)]
        .flat()
        .map(ore => [ore.id, ore.value])
);

module.exports = {
    locations,
    seasonalOres,
    weightedPick,
    getOrePool,
    getCurrentSeason,
    BASE_ORE_VALUES
};
