const db = require('../../database');

// ==================================================
// ADD ORE TO INVENTORY
// ==================================================
function addOre(userId, oreId, quantity) {
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
        throw new Error('Ore quantity must be a positive whole number.');
    }

    const existing = db.prepare(`
        SELECT quantity FROM mining_inventory 
        WHERE userId = ? AND oreId = ?
    `).get(userId, oreId);

    if (existing) {
        db.prepare(`
            UPDATE mining_inventory 
            SET quantity = quantity + ? 
            WHERE userId = ? AND oreId = ?
        `).run(quantity, userId, oreId);
    } else {
        db.prepare(`
            INSERT INTO mining_inventory (userId, oreId, quantity)
            VALUES (?, ?, ?)
        `).run(userId, oreId, quantity);
    }
}

// ==================================================
// REMOVE ORE FROM INVENTORY
// ==================================================
function removeOre(userId, oreId, quantity) {
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
        return false;
    }

    const existing = db.prepare(`
        SELECT quantity FROM mining_inventory 
        WHERE userId = ? AND oreId = ?
    `).get(userId, oreId);

    if (!existing || existing.quantity < quantity) {
        return false;
    }

    if (existing.quantity === quantity) {
        db.prepare(`
            DELETE FROM mining_inventory 
            WHERE userId = ? AND oreId = ?
        `).run(userId, oreId);
    } else {
        db.prepare(`
            UPDATE mining_inventory 
            SET quantity = quantity - ? 
            WHERE userId = ? AND oreId = ?
        `).run(quantity, userId, oreId);
    }

    return true;
}

// ==================================================
// GET USER INVENTORY
// ==================================================
function getInventory(userId) {
    const items = db.prepare(`
        SELECT oreId, quantity FROM mining_inventory 
        WHERE userId = ? AND quantity > 0
    `).all(userId);

    return items;
}

// ==================================================
// GET SPECIFIC ORE QUANTITY
// ==================================================
function getOreQuantity(userId, oreId) {
    const result = db.prepare(`
        SELECT quantity FROM mining_inventory 
        WHERE userId = ? AND oreId = ?
    `).get(userId, oreId);

    return result ? result.quantity : 0;
}

// ==================================================
// GET TOTAL INVENTORY VALUE
// ==================================================
function getTotalInventoryValue(userId, oreValues) {
    const items = getInventory(userId);
    let total = 0;

    for (const item of items) {
        const oreValue = oreValues[item.oreId] || 0;
        total += oreValue * item.quantity;
    }

    return total;
}

module.exports = {
    addOre,
    removeOre,
    getInventory,
    getOreQuantity,
    getTotalInventoryValue
};
