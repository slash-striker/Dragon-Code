const db = require('../../database');

// Prices are deliberately data-driven so every command can display and debit
// the exact same amount.
const MINING_PROPERTIES = [
    {
        id: 'crater_claim',
        name: 'Crater Claim',
        description: 'A reliable starter claim on the edge of Quantum Craters.',
        price: 12_000,
        upgradeBase: 18_000,
        maxLevel: 5,
        yieldPerLevel: 0.08,
        incomePerLevel: 0.015
    },
    {
        id: 'neon_quarry',
        name: 'Neon Quarry',
        description: 'High-density neon seams with a stronger extraction bonus.',
        price: 45_000,
        upgradeBase: 55_000,
        maxLevel: 5,
        yieldPerLevel: 0.12,
        incomePerLevel: 0.025
    },
    {
        id: 'void_mine',
        name: 'Void Mine',
        description: 'A dangerous deep-core lease that pays premium mining yields.',
        price: 150_000,
        upgradeBase: 175_000,
        maxLevel: 5,
        yieldPerLevel: 0.18,
        incomePerLevel: 0.04
    }
];

function ensureTable() {
    db.exec(`CREATE TABLE IF NOT EXISTS mining_properties (
        userId TEXT NOT NULL,
        propertyId TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 1,
        purchasedAt TEXT NOT NULL,
        PRIMARY KEY(userId, propertyId)
    )`);
}

function getProperty(propertyId) {
    return MINING_PROPERTIES.find(property => property.id === propertyId) || null;
}

function getOwnedProperties(userId) {
    ensureTable();
    return db.prepare('SELECT * FROM mining_properties WHERE userId = ? ORDER BY propertyId')
        .all(userId)
        .map(row => ({ ...row, ...getProperty(row.propertyId) }));
}

function getOwnedProperty(userId, propertyId) {
    ensureTable();
    return db.prepare('SELECT * FROM mining_properties WHERE userId = ? AND propertyId = ?')
        .get(userId, propertyId);
}

function getYieldMultiplier(userId) {
    ensureTable();
    const rows = db.prepare(
        'SELECT propertyId, level FROM mining_properties WHERE userId = ?'
    ).all(userId);
    return 1 + rows.reduce((sum, row) => {
        const property = getProperty(row.propertyId);
        return sum + (property ? Number(row.level) * property.yieldPerLevel : 0);
    }, 0);
}

function getPropertyIncome(userId, oreValue, quantity) {
    ensureTable();
    const rows = db.prepare('SELECT propertyId, level FROM mining_properties WHERE userId = ?').all(userId);
    const rate = rows.reduce((sum, row) => {
        const property = getProperty(row.propertyId);
        return sum + (property ? Number(row.level) * property.incomePerLevel : 0);
    }, 0);
    return Math.max(0, Math.floor(Number(oreValue) * Number(quantity) * rate));
}

function creditPropertyIncome(userId, oreValue, quantity) {
    const income = getPropertyIncome(userId, oreValue, quantity);
    if (!income) return 0;
    db.prepare('UPDATE users SET mining_bank = COALESCE(mining_bank, 0) + ? WHERE userId = ?').run(income, userId);
    return income;
}

function buyProperty(userId, propertyId) {
    ensureTable();
    const property = getProperty(propertyId);
    if (!property) return { ok: false, message: 'Unknown mining property.' };
    if (getOwnedProperty(userId, propertyId)) return { ok: false, message: 'You already own this claim.' };
    const result = db.transaction(() => {
        const debit = db.prepare(
            'UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?'
        ).run(property.price, userId, property.price);
        if (debit.changes !== 1) throw new Error(`You need 🪙${property.price.toLocaleString()} in your wallet.`);
        db.prepare(
            'INSERT INTO mining_properties (userId, propertyId, level, purchasedAt) VALUES (?, ?, 1, ?)'
        ).run(userId, propertyId, new Date().toISOString());
    });
    try {
        result();
        return { ok: true, property, price: property.price };
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

function upgradeProperty(userId, propertyId) {
    ensureTable();
    const property = getProperty(propertyId);
    const owned = property && getOwnedProperty(userId, propertyId);
    if (!property || !owned) return { ok: false, message: 'Buy this claim before upgrading it.' };
    if (owned.level >= property.maxLevel) return { ok: false, message: 'This claim is fully upgraded.' };
    const price = property.upgradeBase * owned.level;
    const result = db.transaction(() => {
        const debit = db.prepare(
            'UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?'
        ).run(price, userId, price);
        if (debit.changes !== 1) throw new Error(`You need 🪙${price.toLocaleString()} in your wallet.`);
        const updated = db.prepare(
            'UPDATE mining_properties SET level = level + 1 WHERE userId = ? AND propertyId = ? AND level = ?'
        ).run(userId, propertyId, owned.level);
        if (updated.changes !== 1) throw new Error('The claim changed before the upgrade completed.');
    });
    try {
        result();
        return { ok: true, property, price, level: owned.level + 1 };
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

module.exports = {
    MINING_PROPERTIES,
    getProperty,
    getOwnedProperties,
    getYieldMultiplier,
    getPropertyIncome,
    creditPropertyIncome,
    buyProperty,
    upgradeProperty
};
