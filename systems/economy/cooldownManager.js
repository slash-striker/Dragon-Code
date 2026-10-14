const db = require('../../database');

// Cooldown durations in milliseconds
const COOLDOWNS = {
    rob_bank: 3 * 24 * 60 * 60 * 1000, // Lunar bank robbery: 3 days
    rob_player: 24 * 60 * 60 * 1000,
    rob: 24 * 60 * 60 * 1000,
    bank_robbery: 3 * 24 * 60 * 60 * 1000,
    scratchcard: 15 * 60 * 1000,
    crime: 60 * 60 * 1000,
    beg: 10 * 60 * 1000,
    work: 30 * 60 * 1000,
    fish: 60 * 60 * 1000, // 1 hour
    daily: 24 * 60 * 60 * 1000,
    games: 30 * 60 * 1000,
    fivedice: 30 * 60 * 1000,
    'fivedice-daily': 24 * 60 * 60 * 1000,
    blackjack: 0,
    matchpairs: 30 * 60 * 1000,
    lightsout: 30 * 60 * 1000,
    mastermind: 30 * 60 * 1000,
    hangman: 30 * 60 * 1000,
    highlow: 30 * 60 * 1000,
    rps: 30 * 60 * 1000,
    tictactoe: 30 * 60 * 1000
};

// Initialize cooldowns table
function initCooldownsTable() {
    try {
        db.prepare(`
            CREATE TABLE IF NOT EXISTS command_cooldowns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userId TEXT NOT NULL,
                command TEXT NOT NULL,
                expiresAt INTEGER NOT NULL,
                UNIQUE(userId, command)
            )
        `).run();

        // Create indexes for faster queries
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_cooldowns_user ON command_cooldowns(userId)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_cooldowns_command ON command_cooldowns(command)`).run();
        db.prepare(`
            CREATE TABLE IF NOT EXISTS cooldown_settings (
                command TEXT PRIMARY KEY,
                durationMs INTEGER NOT NULL
            )
        `).run();
    } catch (e) {
        console.error('Error creating cooldowns table:', e);
    }
}

function getCooldownDuration(command) {
    const configured = db.prepare(
        'SELECT durationMs FROM cooldown_settings WHERE command = ?'
    ).get(command);
    return configured ? Number(configured.durationMs) : (COOLDOWNS[command] ?? null);
}

function setCooldownDuration(command, durationMs) {
    if (!Object.prototype.hasOwnProperty.call(COOLDOWNS, command)) {
        throw new Error(`Unknown cooldown command: ${command}`);
    }
    if (!Number.isInteger(durationMs) || durationMs < 0) {
        throw new Error('Cooldown duration must be a non-negative integer.');
    }
    db.prepare(`
        INSERT INTO cooldown_settings (command, durationMs) VALUES (?, ?)
        ON CONFLICT(command) DO UPDATE SET durationMs = excluded.durationMs
    `).run(command, durationMs);
}

// Set a cooldown for a user and command
function setCooldown(userId, command) {
    const duration = getCooldownDuration(command);
    if (duration === null || duration === undefined) {
        console.error(`Unknown command for cooldown: ${command}`);
        return;
    }

    if (duration === 0) return;
    const expiresAt = Date.now() + duration;

    try {
        db.prepare(`
            INSERT INTO command_cooldowns (userId, command, expiresAt)
            VALUES (?, ?, ?)
            ON CONFLICT(userId, command) DO UPDATE SET expiresAt = ?
        `).run(userId, command, expiresAt, expiresAt);
    } catch (e) {
        console.error('Error setting cooldown:', e);
    }
}

// Check if a user is on cooldown for a command
function getCooldown(userId, command) {
    try {
        const row = db.prepare(`
            SELECT expiresAt FROM command_cooldowns
            WHERE userId = ? AND command = ?
        `).get(userId, command);

        if (!row) return null;

        // Check if cooldown has expired
        if (Date.now() > row.expiresAt) {
            // Clean up expired cooldown
            db.prepare(`
                DELETE FROM command_cooldowns
                WHERE userId = ? AND command = ?
            `).run(userId, command);
            return null;
        }

        return row.expiresAt;
    } catch (e) {
        console.error('Error checking cooldown:', e);
        return null;
    }
}

// Get remaining time in milliseconds
function getRemainingTime(userId, command) {
    const expiresAt = getCooldown(userId, command);
    if (!expiresAt) return 0;
    return expiresAt - Date.now();
}

// Format remaining time for display
function formatRemainingTime(ms) {
    if (ms <= 0) return 'Ready';
    return formatCooldownExpiry(Date.now() + ms);
}

// Discord renders this as a localized live countdown for each user.
function formatCooldownExpiry(expiresAt) {
    const timestamp = Math.ceil(Number(expiresAt) / 1000);
    return `<t:${timestamp}:t> (<t:${timestamp}:R>)`;
}

// Get all cooldowns for a user
function getAllCooldowns(userId) {
    try {
        const rows = db.prepare(`
            SELECT command, expiresAt FROM command_cooldowns
            WHERE userId = ?
        `).all(userId);

        // Filter out expired cooldowns
        const now = Date.now();
        const activeCooldowns = rows.filter(row => row.expiresAt > now);

        // Clean up expired cooldowns
        const expiredIds = rows.filter(row => row.expiresAt <= now).map(row => row.command);
        if (expiredIds.length > 0) {
            const placeholders = expiredIds.map(() => '?').join(',');
            db.prepare(`
                DELETE FROM command_cooldowns
                WHERE userId = ? AND command IN (${placeholders})
            `).run(userId, ...expiredIds);
        }

        return activeCooldowns;
    } catch (e) {
        console.error('Error getting all cooldowns:', e);
        return [];
    }
}

// Clear a specific cooldown
function clearCooldown(userId, command) {
    try {
        db.prepare(`
            DELETE FROM command_cooldowns
            WHERE userId = ? AND command = ?
        `).run(userId, command);
    } catch (e) {
        console.error('Error clearing cooldown:', e);
    }
}

// Clear all cooldowns for a user
function clearAllCooldowns(userId) {
    try {
        db.prepare(`
            DELETE FROM command_cooldowns
            WHERE userId = ?
        `).run(userId);
    } catch (e) {
        console.error('Error clearing all cooldowns:', e);
    }
}

// Roll back a cooldown that was stamped during a command run whose Discord
// interaction had already expired (code 10062). Without this, a failed
// attempt locks the user out until the cooldown elapses even though nothing
// was paid out. Known cooldown keys roll back directly; /mine keeps its
// cooldown on the mining profile instead of this table.
function rollbackExpiredCommand(command, userId) {
    if (!command || !userId) return;
    const ALIASES = { 'rob-bank': 'rob_bank', 'rob-player': 'rob_player', 'rob': 'rob_player' };
    const key = ALIASES[command] ?? command;
    try {
        if (Object.prototype.hasOwnProperty.call(COOLDOWNS, key)) {
            clearCooldown(userId, key);
        }
        if (command === 'mine') {
            const mining = require('../mining/miningManager');
            const profile = mining.getMiningProfile(userId);
            if (profile && profile.mineCooldown) {
                profile.mineCooldown = 0;
                mining.updateMiningProfile(profile);
            }
        }
    } catch (error) {
        console.error('Cooldown rollback failed:', error);
    }
}

module.exports = {
    initCooldownsTable,
    rollbackExpiredCommand,
    setCooldown,
    getCooldown,
    getRemainingTime,
    formatRemainingTime,
    formatCooldownExpiry,
    getAllCooldowns,
    clearCooldown,
    clearAllCooldowns,
    getCooldownDuration,
    setCooldownDuration,
    COOLDOWNS
};
