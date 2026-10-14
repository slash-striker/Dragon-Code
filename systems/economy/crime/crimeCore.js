const db = require('../../../database');
const { addItem } = require('../inventoryh');
const { getItemQuantity, removeItem } = require('../shopItems');
const { logTransaction } = require('../transactionLogger');
const { setCooldown, getRemainingTime, formatCooldownExpiry } = require('../cooldownManager');

/* =========================
   SAFE HELPERS
========================= */

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/* =========================
   SOLO CRIME SYSTEM
   (25% win chance, 1% diamond)
   Lucky Dice increases win chance to 40%
========================= */

async function runSolo(userId) {

    let row = db.prepare(`
        SELECT * FROM users WHERE userId = ?
    `).get(userId);

    if (!row) {
        db.prepare(`INSERT INTO users (userId) VALUES (?)`).run(userId);
        row = db.prepare(`SELECT * FROM users WHERE userId = ?`).get(userId);
    }

    // Check cooldown
    const remainingTime = getRemainingTime(userId, 'crime');
    if (remainingTime > 0) {
        const cooldownExpiresAt = Date.now() + remainingTime;
        return {
            type: "cooldown",
            message: `You are on cooldown for crime.`,
            cooldownExpiresAt,
            cooldownDisplay: formatCooldownExpiry(cooldownExpiresAt),
            color: 0xff9900
        };
    }

    // Check for Lucky Dice
    const hasLuckyDice = getItemQuantity(userId, 'lucky_dice', db) > 0;
    let luckyDiceUsed = false;

    if (hasLuckyDice) {
        luckyDiceUsed = true;
        removeItem(userId, 'lucky_dice', 1);
    }

    const roll = Math.random();

    let result = {
        type: "fail",
        reward: 0,
        item: null,
        message: "🚨 SECURITY SYSTEM BLOCKED YOU",
        color: 0xff0033
    };

    // 💎 1% DIAMOND
    if (roll < 0.01) {
        result = {
            type: "diamond",
            reward: 5000,
            item: "diamond",
            message: "💎 THE DIAMOND HEIST SUCCESSFUL",
            color: 0x00ffff
        };
    }

    // 🟢 25% WIN (40% with Lucky Dice)
    else if (roll < (luckyDiceUsed ? 0.41 : 0.26)) {
        const reward = rand(800, 2500);

        result = {
            type: "win",
            reward,
            item: null,
            message: luckyDiceUsed ? "💰 SUCCESSFUL DARKNET BREACH (LUCKY DICE)" : "💰 SUCCESSFUL DARKNET BREACH",
            color: 0x00ffcc
        };
    }

    // ❌ 74% FAIL
    else {
        const heat = (row.heatLevel || 0) + rand(5, 20);

        db.prepare(`
            UPDATE users SET heatLevel = ? WHERE userId = ?
        `).run(heat, userId);

        result = {
            type: "fail",
            reward: 0,
            item: null,
            message: "❌ TRACE DETECTED — HEAT INCREASED",
            color: 0xff0033
        };
    }

    // APPLY REWARD
    if (result.reward > 0) {
        db.prepare(`
            UPDATE users SET wallet = wallet + ?, crimeSuccess = COALESCE(crimeSuccess, 0) + 1 WHERE userId = ?
        `).run(result.reward, userId);

        // Log transaction
        logTransaction(userId, 'crime', result.reward, luckyDiceUsed ? 'Lucky Dice used' : '');
    }

    // Set cooldown
    setCooldown(userId, 'crime');

    // DIAMOND ITEM
    if (result.item === "diamond") {
        addItem(userId, "diamond", 1);
    }

    return result;
}

/* =========================
   MULTIPLAYER HEIST STUB
   (we expand this next step)
========================= */

async function runHeist(heistId) {
    const participants = db.prepare(`
        SELECT * FROM heist_participants WHERE heistId = ?
    `).all(heistId);

    const successChance = 0.4 + (participants.length * 0.05);

    const roll = Math.random();

    const success = roll < Math.min(successChance, 0.85);

    return {
        success,
        participants: participants.length,
        reward: success ? rand(3000, 15000) : 0
    };
}

/* =========================
   EXPORTS
========================= */

module.exports = {
    runSolo,
    runHeist
};