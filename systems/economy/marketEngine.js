// const { db } = require('../../database');
// const { getEvent } = require('./marketEvents');

// // ==================================================
// // INIT MARKET TABLE (RUN ONCE AT STARTUP)
// // ==================================================
// function initMarket() {
//     db.exec(`
//         CREATE TABLE IF NOT EXISTS market (
//             id INTEGER PRIMARY KEY,
//             lastUpdate TEXT DEFAULT CURRENT_TIMESTAMP,

//             ironMultiplier REAL DEFAULT 1,
//             copperMultiplier REAL DEFAULT 1,
//             silverMultiplier REAL DEFAULT 1,
//             goldMultiplier REAL DEFAULT 1,
//             platinumMultiplier REAL DEFAULT 1,
//             mythrilMultiplier REAL DEFAULT 1
//         )
//     `);

//     db.prepare(`
//         INSERT OR IGNORE INTO market (id)
//         VALUES (1)
//     `).run();
// }

// // ==================================================
// // RANDOM SHIFT ENGINE
// // ==================================================
// function randomShift(base) {
//     const variance = 0.15;
//     return base + (Math.random() * variance * 2 - variance);
// }

// // ==================================================
// // UPDATE MARKET STATE
// // ==================================================
// function updateMarket() {
//     const treasury = getTreasury();

//     const inflationFactor = 1 + Math.min(treasury / 1_000_000, 0.25);

//     const shifts = {
//         ironMultiplier: randomShift(1.0) * inflationFactor,
//         copperMultiplier: randomShift(1.1) * inflationFactor,
//         silverMultiplier: randomShift(1.2) * inflationFactor,
//         goldMultiplier: randomShift(1.4) * inflationFactor,
//         platinumMultiplier: randomShift(1.6) * inflationFactor,
//         mythrilMultiplier: randomShift(2.0) * inflationFactor
//     };

//     db.prepare(`
//         UPDATE market SET
//             lastUpdate = CURRENT_TIMESTAMP,
//             ironMultiplier = ?,
//             copperMultiplier = ?,
//             silverMultiplier = ?,
//             goldMultiplier = ?,
//             platinumMultiplier = ?,
//             mythrilMultiplier = ?
//         WHERE id = 1
//     `).run(
//         shifts.ironMultiplier,
//         shifts.copperMultiplier,
//         shifts.silverMultiplier,
//         shifts.goldMultiplier,
//         shifts.platinumMultiplier,
//         shifts.mythrilMultiplier
//     );

//     return shifts;
// }

// // ==================================================
// // GET MARKET STATE
// // ==================================================
// function getMarket() {
//     return db.prepare(`
//         SELECT * FROM market WHERE id = 1
//     `).get();
// }

// // ==================================================
// // PRICE ENGINE
// // ==================================================
// function getOrePrice(oreId, baseValue) {
//     const market = getMarket();
//     if (!market) return baseValue;

//     const event = typeof getEvent === 'function' ? getEvent() : null;

//     const map = {
//         iron_ore: market.ironMultiplier,
//         copper_ore: market.copperMultiplier,
//         silver_ore: market.silverMultiplier,
//         gold_ore: market.goldMultiplier,
//         platinum_ore: market.platinumMultiplier,
//         mythril_ore: market.mythrilMultiplier
//     };

//     let multiplier = Number(map[oreId]) || 1;

//     if (event?.multiplier?.[oreId]) {
//         multiplier *= event.multiplier[oreId];
//     }

//     return Math.max(1, Math.floor(baseValue * multiplier));
// }

// // ==================================================
// // EXPORTS
// // ==================================================
// module.exports = {
//     initMarket,
//     updateMarket,
//     getMarket,
//     getOrePrice
// };
