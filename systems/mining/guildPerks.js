const db = require('../../database');

/*
 * ⛏️ GUILD PERKS — what membership actually DOES.
 *
 * Grounded entirely in existing mechanics (no invented systems):
 *
 *   1. YIELD BONUS — members mine more. /mine applies a multiplier after all
 *      other scaling: +5% at 2 members → +20% at 6+. Pure personal buff, so
 *      membership is always net-positive.
 *
 *   2. TITHE — 10% of every member's /mine mining-bank deposit flows into the
 *      guild's SEASON FUND (mining_guild_fund, one row per guild per season).
 *      Zero-sum inside the guild: it does not shrink anyone's personal ore,
 *      it just routes part of the guild's earnings into a shared pool.
 *
 *   3. DAILY PAYROLL — every 24h (triggered by any /mine run, guild member
 *      or not), each guild's season fund is split EQUALLY among all members
 *      and the fund resets. Active miners circulate earnings to the whole
 *      roster; bigger active guilds move more credits. Bounded by design:
 *      the fund only ever pays out what members tithed since the last run.
 *
 *   4. CREW SLOT — guilds of 4+ members get +1 worker slot (5 → 6).
 *
 * The payout timestamp lives in mining_economy_meta (created unconditionally
 * at startup), so this module needs no table-ensure logic beyond the fund
 * table, which database.js creates in the main schema block.
 */

const TITHE_RATE = 0.10;

const TIERS = [
    { members: 2, oreBonus: 0.05, slots: 0 },
    { members: 3, oreBonus: 0.10, slots: 0 },
    { members: 4, oreBonus: 0.15, slots: 1 },
    { members: 6, oreBonus: 0.20, slots: 1 }
];

const PAYROLL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PAYROLL_META_KEY = 'guildPayrollLastPaidAt';

function seasonKey(date = new Date()) {
    return `${date.getUTCFullYear()}-${String(Math.floor(date.getUTCMonth() / 3) + 1).padStart(2, '0')}`;
}

/* ---------- Perk lookups ---------- */

function getGuildPerkState(userId) {
    const membership = db.prepare('SELECT guildId FROM mining_guild_members WHERE userId = ?').get(userId);
    if (!membership) return { inGuild: false, guildId: null, memberCount: 0, tier: null, tierIndex: 0 };
    const memberCount = db.prepare('SELECT COUNT(*) AS n FROM mining_guild_members WHERE guildId = ?')
        .get(membership.guildId)?.n || 0;
    let tierIndex = 0;
    for (let i = 0; i < TIERS.length; i++) {
        if (memberCount >= TIERS[i].members) tierIndex = i + 1;
    }
    const tier = tierIndex > 0 ? TIERS[tierIndex - 1] : null;
    return { inGuild: true, guildId: membership.guildId, memberCount, tier, tierIndex };
}

/** /mine ore multiplier from guild size — 0 when not in a guild. */
function getGuildOreBonus(userId) {
    return getGuildPerkState(userId).tier?.oreBonus ?? 0;
}

/** Extra crew slot from guild size (4+ members → 1 extra slot). */
function getGuildWorkerSlotBonus(userId) {
    return getGuildPerkState(userId).tier?.slots ?? 0;
}

/** Worker cap for this user: base 5 + guild bonus. */
function getWorkerCap(userId) {
    return 5 + getGuildWorkerSlotBonus(userId);
}

/* ---------- Tithe (season fund inflow) ---------- */

/** Route 10% of a /mine deposit into the guild's season fund. Returns the amount moved. */
function chargeGuildTithe(userId, depositAmount) {
    const amount = Math.floor(Number(depositAmount) || 0);
    if (amount <= 0) return 0;
    const membership = db.prepare('SELECT guildId FROM mining_guild_members WHERE userId = ?').get(userId);
    if (!membership) return 0;
    const cut = Math.max(1, Math.floor(amount * TITHE_RATE));
    db.prepare(`
        INSERT INTO mining_guild_fund (guildId, season, amount) VALUES (?, ?, ?)
        ON CONFLICT(guildId, season) DO UPDATE SET amount = amount + excluded.amount
    `).run(membership.guildId, seasonKey(), cut);
    return cut;
}

function getSeasonFund(guildId) {
    return db.prepare('SELECT amount FROM mining_guild_fund WHERE guildId = ? AND season = ?')
        .get(guildId, seasonKey())?.amount || 0;
}

/* ---------- Daily payroll ---------- */

function getLastPayrollAt() {
    return Number(db.prepare('SELECT value FROM mining_economy_meta WHERE key = ?').get(PAYROLL_META_KEY)?.value) || 0;
}

function getWageStatus() {
    const lastPaidAt = getLastPayrollAt();
    return {
        intervalHours: PAYROLL_INTERVAL_MS / 3600000,
        lastPaidAt: lastPaidAt || null,
        nextAt: lastPaidAt ? lastPaidAt + PAYROLL_INTERVAL_MS : null,
        dueNow: !lastPaidAt || Date.now() - lastPaidAt >= PAYROLL_INTERVAL_MS
    };
}

/**
 * Called after every successful /mine. When the 24h clock has elapsed, every
 * guild's season fund is split equally among its members (mining bank) and
 * reset. Returns { paid, log } — log entries describe one guild's payout.
 */
function payGuildWages() {
    const status = getWageStatus();
    if (!status.lastPaidAt) {
        // First-ever call: set the baseline clock and pay nothing. Funds
        // accumulated before the first tick still pay out on schedule —
        // exactly 24h after the feature goes live.
        db.prepare(`
            INSERT INTO mining_economy_meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(PAYROLL_META_KEY, String(Date.now()));
        return { paid: false, nextAt: Date.now() + PAYROLL_INTERVAL_MS };
    }
    if (!status.dueNow) return { paid: false, nextAt: status.nextAt };

    const season = seasonKey();
    const nowIso = new Date().toISOString();
    const guilds = db.prepare('SELECT guildId, name FROM mining_guilds').all();
    const credit = db.prepare('UPDATE users SET mining_bank = COALESCE(mining_bank, 0) + ? WHERE userId = ?');
    const log = [];

    db.transaction(() => {
        for (const guild of guilds) {
            const members = db.prepare('SELECT userId FROM mining_guild_members WHERE guildId = ?')
                .all(guild.guildId);
            if (members.length < 2) continue; // solo guilds get yield perks only
            const fund = db.prepare('SELECT amount FROM mining_guild_fund WHERE guildId = ? AND season = ?')
                .get(guild.guildId, season)?.amount || 0;
            const per = Math.floor(fund / members.length);
            if (per <= 0) continue;
            for (const member of members) credit.run(per, member.userId);
            db.prepare('UPDATE mining_guild_fund SET amount = 0 WHERE guildId = ? AND season = ?')
                .run(guild.guildId, season);
            log.push({
                guildId: guild.guildId,
                name: guild.name,
                per,
                total: per * members.length,
                members: members.length,
                seasonFund: fund
            });
        }
        db.prepare(`
            INSERT INTO mining_economy_meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(PAYROLL_META_KEY, String(Date.now()));
    })();

    return { paid: true, log };
}

module.exports = {
    TITHE_RATE,
    TIERS,
    PAYROLL_INTERVAL_MS,
    getGuildPerkState,
    getGuildOreBonus,
    getGuildWorkerSlotBonus,
    getWorkerCap,
    chargeGuildTithe,
    getSeasonFund,
    getWageStatus,
    payGuildWages
};
