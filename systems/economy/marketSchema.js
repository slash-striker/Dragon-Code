// const { db } = require('../../database');

// function initMarketTable() {
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
//         );

//         INSERT OR IGNORE INTO market (id) VALUES (1);
//     `);
// }

// module.exports = { initMarketTable };