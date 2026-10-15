const db = require('../../database');
const { getUser, updateUser } = require('./userManager');
const { logTransaction } = require('./transactionLogger');

/*
 * SlashDragon economy — income policy (owner directive):
 *
 *   1. Daily allowance: exactly 50,000 credits, credited to the wallet once
 *      every 24h (this is what pays out giveaways).
 *   2. At the end of each UTC day, 70% of the remaining wallet is moved into
 *      SlashDragon's bank as a reserve; the transfer is stamped per day.
 *   3. Taxes: 10% of /work gross at career level 1+ — handled in commands/work.js
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

function runSlashDragonBankCycle(botId, now = Date.now()) {
    if (!botId) return;
    initBankAutomation();

    const state = db.prepare('SELECT * FROM slashdragon_bank WHERE id = 1').get();
    const dueAt = new Date(state.nextAllowanceAt).getTime();
    const reserveWindow = new Date(now).getUTCHours() === 0 && new Date(now).getUTCMinutes() <= 5;

    const migratedDueAt = state.lastAction === 'Bank automation initialized (daily allowance policy)' && state.nextAllowanceAt;
    const allowanceDue = now >= dueAt && !(reserveWindow && migratedDueAt);
    const allowanceResetAt = new Date(now);
    allowanceResetAt.setUTCHours(0, 0, 0, 0);
    allowanceResetAt.setUTCDate(allowanceResetAt.getUTCDate() + 1);
    if (allowanceDue) {
        const user = getUser(botId);
        user.wallet = Number(user.wallet || 0) + DAILY_ALLOWANCE;
        updateUser(user);
        logTransaction(botId, 'allowance', DAILY_ALLOWANCE, 'SlashDragon daily allowance');
        db.prepare(`
            UPDATE slashdragon_bank
            SET nextAllowanceAt = ?, lastAction = ?
            WHERE id = 1
        `).run(
            allowanceResetAt.toISOString(),
            `Daily allowance received: ${DAILY_ALLOWANCE.toLocaleString()}`
        );
    }

    // The scheduler polls throughout the day. A UTC day-key makes this
    // a once-daily close-of-day transfer without relying on one exact tick.
    const utc = new Date(now);
    const dayKey = new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate()) - DAY_MS)
        .toISOString().slice(0, 10);
    if (!reserveWindow) return 0;
    const stampKey = `slashdragon:reserve:${dayKey}`;
    const stamped = db.prepare('SELECT value FROM bot_meta WHERE key = ?').get(stampKey);
    if (!stamped) {
        const moved = db.transaction(() => {
            db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(botId);
            const row = db.prepare('SELECT wallet FROM users WHERE userId = ?').get(botId);
            const wallet = Math.max(0, Number(row?.wallet) || 0);
            const closeBalance = wallet;
            const amount = Math.floor(closeBalance * 0.70);
            if (amount > 0) {
                const update = db.prepare('UPDATE users SET wallet = wallet - ?, bank = bank + ? WHERE userId = ? AND wallet >= ?')
                    .run(amount, amount, botId, amount);
                if (update.changes !== 1) throw new Error('SlashDragon reserve transfer lost its wallet balance race.');
                db.prepare('UPDATE slashdragon_bank SET lastAction = ? WHERE id = 1')
                    .run(`End-of-day 70% wallet reserve transfer: ${amount.toLocaleString()} credits (${dayKey})`);
                logTransaction(botId, 'reserve_deposit', -amount, `End-of-day 70% wallet reserve transfer to bank (${dayKey})`);
            }
            db.prepare(`INSERT INTO bot_meta (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(stampKey, String(now));
            return amount;
        })();
        return moved;
    }
    return 0;
}

module.exports = { initBankAutomation, runSlashDragonBankCycle, DAILY_ALLOWANCE, DAY_MS };
