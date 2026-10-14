const db = require('../../database');
const { getUser, updateUser } = require('./userManager');
const { logTransaction } = require('./transactionLogger');

/*
 * SlashDragon economy — income policy (owner directive):
 *
 *   1. Daily allowance: exactly 50,000 credits, credited to the wallet once
 *      every 24h (this is what pays out giveaways).
 *   2. Taxes: 10% of /work gross at career level 1+ — handled in commands/work.js
 *      and deposited straight into the bank.
 *
 * Nothing else may credit the bot account. The old autonomous "work" rewards
 * and random reserve replenishment were removed because the bank was growing
 * too fast.
 */

const DAILY_ALLOWANCE = 50_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function initBankAutomation() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS slashdragon_bank (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            nextAllowanceAt TEXT NOT NULL,
            lastAction TEXT
        )
    `);

    // Migration: the legacy table tracked autonomous work + replenish cycles.
    // Those income sources no longer exist, so retire that schema wholesale.
    const columns = db.prepare('PRAGMA table_info(slashdragon_bank)').all().map(col => col.name);
    if (columns.length && columns.includes('nextWorkAt')) {
        db.exec('DROP TABLE slashdragon_bank');
        db.exec(`
            CREATE TABLE slashdragon_bank (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                nextAllowanceAt TEXT NOT NULL,
                lastAction TEXT
            )
        `);
    }

    const state = db.prepare('SELECT * FROM slashdragon_bank WHERE id = 1').get();
    if (!state) {
        db.prepare(`
            INSERT INTO slashdragon_bank (id, nextAllowanceAt, lastAction)
            VALUES (1, ?, 'Bank automation initialized (daily allowance policy)')
        `).run(new Date(Date.now() + DAY_MS).toISOString());
    }
}

function runSlashDragonBankCycle(botId) {
    if (!botId) return;
    initBankAutomation();

    const now = Date.now();
    const state = db.prepare('SELECT * FROM slashdragon_bank WHERE id = 1').get();
    const dueAt = new Date(state.nextAllowanceAt).getTime();

    if (now >= dueAt) {
        const user = getUser(botId);
        user.wallet = Number(user.wallet || 0) + DAILY_ALLOWANCE;
        updateUser(user);
        logTransaction(botId, 'allowance', DAILY_ALLOWANCE, 'SlashDragon daily allowance');
        db.prepare(`
            UPDATE slashdragon_bank
            SET nextAllowanceAt = ?, lastAction = ?
            WHERE id = 1
        `).run(
            new Date(now + DAY_MS).toISOString(),
            `Daily allowance received: ${DAILY_ALLOWANCE.toLocaleString()}`
        );
    }
}

module.exports = { initBankAutomation, runSlashDragonBankCycle };
