// const { db } = require('../database');

// // ==================================================
// // MINING PROFILE
// // ==================================================

// db.exec(`
// CREATE TABLE IF NOT EXISTS mining_profiles (
//     userId TEXT PRIMARY KEY,

//     miningLevel INTEGER DEFAULT 1,
//     miningXp INTEGER DEFAULT 0,

//     activePickaxe TEXT DEFAULT 'wood_pickaxe',

//     activeLocation TEXT DEFAULT 'crystal_caverns',

//     unlockedLocationsJson TEXT DEFAULT '["crystal_caverns"]',

//     droneTier INTEGER DEFAULT 0,

//     mineCooldown INTEGER DEFAULT 0,

//     relicsFound INTEGER DEFAULT 0,

//     totalMines INTEGER DEFAULT 0,
//     totalOreFound INTEGER DEFAULT 0,

//     createdAt TEXT DEFAULT CURRENT_TIMESTAMP
// );

// CREATE TABLE IF NOT EXISTS relic_collection (
//     userId TEXT NOT NULL,
//     relicId TEXT NOT NULL,
//     discoveredAt TEXT DEFAULT CURRENT_TIMESTAMP,

//     PRIMARY KEY (userId, relicId)
// );
// `);



// module.exports = db;