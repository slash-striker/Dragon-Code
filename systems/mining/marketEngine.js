const db = require('../../database');

// ==================================================
// BASE ORE VALUES (matches oreTables.js)
// ==================================================
const { BASE_ORE_VALUES } = require('./oreTables');

// ==================================================
// MARKET EVENTS
// ==================================================
const MARKET_EVENTS = [
    // ── Bullish ─────────────────────────────────────────
    {
        name: 'Mining Boom',
        description: 'High demand for ores!',
        multiplier: 1.5,
        duration: 1800000 // 1 hour
    },
    {
        name: 'Tech Surge',
        description: 'Tech sector buying!',
        multiplier: 1.3,
        duration: 2000000 // 1 hour
    },
    {
        name: 'Black Market Rush',
        description: 'Shadow buyers paying premium rates!',
        multiplier: 1.75,
        duration: 450000 // 30 minutes
    },
    {
        name: 'Corporate Buyout',
        description: 'A megacorp is stockpiling ore!',
        multiplier: 1.6,
        duration: 1500000 // 45 minutes
    },
    {
        name: 'Orbital Contract',
        description: 'Off-world colony needs raw materials!',
        multiplier: 1.8,
        duration: 120000 // 30 minutes
    },
    {
        name: 'Artifact Frenzy',
        description: 'Collectors bidding up rare finds!',
        multiplier: 1.45,
        duration: 1800000 // 1 hour
    },
    {
        name: 'Quantum Demand Spike',
        description: 'Fusion plants are hungry!',
        multiplier: 1.55,
        duration: 1700000 // 45 minutes
    },
    {
        name: 'Festival Uplink',
        description: 'Guild celebration drives spending!',
        multiplier: 1.35,
        duration: 2000000 // 90 minutes
    },

    // ── Bearish ─────────────────────────────────────────
    {
        name: 'Market Crash',
        description: 'Ore prices plummet!',
        multiplier: 0.6,
        duration: 9000000 // 1 hour
    },
    {
        name: 'Supply Glut',
        description: 'Oversupply in market!',
        multiplier: 0.7,
        duration: 9000000 // 1 hour
    },
    {
        name: 'Trade Embargo',
        description: 'Major routes closed — prices sink!',
        multiplier: 0.55,
        duration: 9000000 // 45 minutes
    },
    {
        name: 'Warehouse Fire',
        description: 'Destroyed stock floods the market cheap!',
        multiplier: 0.65,
        duration: 9000000 // 30 minutes
    },
    {
        name: 'Insider Leak',
        description: 'Whales are dumping inventory!',
        multiplier: 0.7,
        duration: 9000000 // 45 minutes
    },

    // ── Volatile / chaotic ──────────────────────────────
    {
        name: 'AI Trader Meltup',
        description: 'Algorithms are going feral — wild prices!',
        multiplier: 2.0,
        duration: 300000 // 15 minutes — big money, tiny window
    },
    {
        name: 'Dragon Hoard Dump',
        description: 'Slashdragon flooded the market with treasury ore!',
        multiplier: 0.5,
        duration: 9000000 // 30 minutes — the big dip
    },
    {
        name: 'Nebular Interference',
        description: 'Comms down — nobody knows real prices!',
        multiplier: 1.0,
        duration: 9000000 // 1 hour — flat, but flavor event
    },
    {
        name: 'Deep Core Discovery',
        description: 'New vein found — prospectors swarm!',
        multiplier: 1.7,
        duration: 1000000 // 1 hour
    }
];

// ==================================================
// INITIALIZE MARKET TABLE
// ==================================================
function initMarketTable() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS market_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            currentEvent TEXT,
            eventStartTime TEXT,
            eventMultiplier REAL DEFAULT 1.0,
            lastUpdate TEXT
        );
    `);
    
    // Initialize if empty
    const existing = db.prepare('SELECT * FROM market_state WHERE id = 1').get();
    if (!existing) {
        db.prepare(`
            INSERT INTO market_state (id, currentEvent, eventStartTime, eventMultiplier, lastUpdate)
            VALUES (1, NULL, NULL, 1.0, ?)
        `).run(new Date().toISOString());
    }
}

// ==================================================
// GET CURRENT MARKET STATE
// ==================================================
function getMarketState() {
    initMarketTable();
    const state = db.prepare('SELECT * FROM market_state WHERE id = 1').get();
    return state;
}

// ==================================================
// UPDATE MARKET STATE
// ==================================================
function updateMarketState(state) {
    db.prepare(`
        UPDATE market_state 
        SET currentEvent = ?, eventStartTime = ?, eventMultiplier = ?, lastUpdate = ?
        WHERE id = 1
    `).run(state.currentEvent, state.eventStartTime, state.eventMultiplier, state.lastUpdate);
}

// ==================================================
// CHECK AND UPDATE MARKET EVENT
// ==================================================
function checkMarketEvent() {
    const state = getMarketState();
    const now = new Date();
    
    // Check if event has expired
    if (state.currentEvent && state.eventStartTime) {
        const eventStart = new Date(state.eventStartTime);
        const event = MARKET_EVENTS.find(e => e.name === state.currentEvent);
        
        if (event && (now - eventStart) > event.duration) {
            // Event expired, reset to normal
            state.currentEvent = null;
            state.eventStartTime = null;
            state.eventMultiplier = 1.0;
            state.lastUpdate = now.toISOString();
            updateMarketState(state);
            return state;
        }
    }
    
    // Random chance to trigger new event (1.5% chance per call — shifts last
    // longer and market stays calm between moves).
    if (!state.currentEvent && Math.random() < 0.015) {
        const randomEvent = MARKET_EVENTS[Math.floor(Math.random() * MARKET_EVENTS.length)];
        state.currentEvent = randomEvent.name;
        state.eventStartTime = now.toISOString();
        state.eventMultiplier = randomEvent.multiplier;
        state.lastUpdate = now.toISOString();
        updateMarketState(state);
    }
    
    return state;
}

// ==================================================
// GET DYNAMIC ORE PRICE
// ==================================================
function getOrePrice(oreId) {
    const state = checkMarketEvent();
    const baseValue = BASE_ORE_VALUES[oreId] || 0;
    
    // Apply market multiplier
    const dynamicPrice = Math.floor(baseValue * state.eventMultiplier);
    
    // Add small random fluctuation (±5%)
    const fluctuation = 1 + (Math.random() * 0.1 - 0.05);
    const finalPrice = Math.floor(dynamicPrice * fluctuation);
    
    return Math.max(1, finalPrice);
}

// ==================================================
// GET ALL ORE PRICES
// ==================================================
function getAllOrePrices() {
    const state = checkMarketEvent();
    const prices = {};
    
    for (const [oreId, baseValue] of Object.entries(BASE_ORE_VALUES)) {
        const dynamicPrice = Math.floor(baseValue * state.eventMultiplier);
        const fluctuation = 1 + (Math.random() * 0.1 - 0.05);
        const finalPrice = Math.floor(dynamicPrice * fluctuation);
        prices[oreId] = Math.max(1, finalPrice);
    }
    
    return { prices, state };
}

// ==================================================
// GET MARKET INFO FOR DISPLAY
// ==================================================
function getMarketInfo() {
    const state = checkMarketEvent();
    const prices = getAllOrePrices();
    const now = new Date();
    const hourPhase = (now.getUTCHours() + now.getUTCMinutes() / 60) / 24;
    const cycle = Math.sin(hourPhase * Math.PI * 2);
    const volatility = 4 + Math.abs(cycle) * 8;
    const sentiment = Math.round(cycle * 100);
    const activity = Math.round(50 + cycle * 30 + Math.random() * 20);
    const event = MARKET_EVENTS.find(item => item.name === state.currentEvent);
    const eventEndsAt = event && state.eventStartTime
        ? new Date(new Date(state.eventStartTime).getTime() + event.duration)
        : null;

    return {
        event: state.currentEvent,
        eventDescription: state.currentEvent 
            ? MARKET_EVENTS.find(e => e.name === state.currentEvent)?.description 
            : null,
        multiplier: state.eventMultiplier,
        prices: prices.prices,
        stats: {
            volatility,
            sentiment,
            activity,
            liquidity: Math.max(15, Math.round(100 - volatility * 2 + Math.random() * 10)),
            cycle: sentiment >= 0 ? 'ACCUMULATION' : 'DISTRIBUTION',
            nextShift: new Date(now.getTime() + (30 - (now.getMinutes() % 30)) * 60000).toISOString(),
            eventEndsAt: eventEndsAt?.toISOString() || null
        }
    };
}

module.exports = {
    initMarketTable,
    getMarketState,
    updateMarketState,
    checkMarketEvent,
    getOrePrice,
    getAllOrePrices,
    getMarketInfo,
    BASE_ORE_VALUES
};
