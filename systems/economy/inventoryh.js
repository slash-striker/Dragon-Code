const db = require('../../database');

function getInventory(userId) {
    return db.prepare(`
        SELECT * FROM inventory WHERE userId = ?
    `).all(userId);
}

function addItem(userId, itemId, quantity = 1) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error('Item quantity must be a positive integer.');
    }

    const existing = db.prepare(`
        SELECT quantity FROM inventory WHERE userId = ? AND itemId = ?
    `).get(userId, itemId);

    if (existing) {
        db.prepare(`
            UPDATE inventory
            SET quantity = quantity + ?
            WHERE userId = ? AND itemId = ?
        `).run(quantity, userId, itemId);
    } else {
        db.prepare(`
            INSERT INTO inventory (userId, itemId, quantity)
            VALUES (?, ?, ?)
        `).run(userId, itemId, quantity);
    }
}

function removeItem(userId, itemId, quantity = 1) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error('Item quantity must be a positive integer.');
    }

    const existing = db.prepare(`
        SELECT quantity FROM inventory WHERE userId = ? AND itemId = ?
    `).get(userId, itemId);

    if (!existing) {
        return;
    }

    if (existing.quantity <= quantity) {
        db.prepare(`
            DELETE FROM inventory
            WHERE userId = ? AND itemId = ?
        `).run(userId, itemId);
        return;
    }

    db.prepare(`
        UPDATE inventory
        SET quantity = quantity - ?
        WHERE userId = ? AND itemId = ?
    `).run(quantity, userId, itemId);
}

function hasItem(userId, itemId) {
    const row = db.prepare(`
        SELECT 1 FROM inventory WHERE userId = ? AND itemId = ?
    `).get(userId, itemId);

    return !!row;
}

module.exports = { getInventory, addItem, removeItem, hasItem };