/*
 * Cosmetic titles — the prestige layer shown on /profile and beside the
 * leaderboards.
 *
 * A title is either bought with credits ('open') or EARNED by meeting a
 * requirement (badge, Elo, race wins, dragon level, quests claimed). Earned
 * titles cost nothing but must still be acquired — awardTitle() grants one
 * outright (used by the weekly TTT promotion and race winners), while
 * purchaseTitle() checks the requirement and charges credits.
 *
 * Only one title can be equipped at a time; equipping clears the others.
 */
const db = require('../../database');

const TITLES = [
    { id: 'eggkeeper', name: 'Eggkeeper', price: 3000000, color: 0xffd27f, description: 'You were there when the first shell cracked.', requirement: { kind: 'badge', badgeId: 'first_egg' } },
    { id: 'neon_angler', name: 'Neon Angler', price: 5000000, color: 0x00e5ff, description: 'The deep knows your name.', requirement: { kind: 'badge', badgeId: 'angler_500' } },
    { id: 'quest_sovereign', name: 'Quest Sovereign', price: 7000000, color: 0x9b59b6, description: 'One hundred contracts honoured.', requirement: { kind: 'quests', min: 100 } },
    { id: 'dragon_rider', name: 'Dragon Rider', price: 8000000, color: 0xff6a00, description: 'Bound to a dragon of level 15 or higher.', requirement: { kind: 'dragonLevel', min: 15 } },
    { id: 'market_shark', name: 'Market Shark', price: 9000000, color: 0x2ecc71, description: 'You smell blood in the order book.', requirement: { kind: 'badge', badgeId: 'market_shark' } },
    { id: 'deep_core_baron', name: 'Deep Core Baron', price: 12000000, color: 0x5dade2, description: 'A thousand tons of rock, moved.', requirement: { kind: 'badge', badgeId: 'miner_1000' } },
    { id: 'crimson_baron', name: 'Crimson Baron', price: 14000000, color: 0xb0003a, description: 'The underworld pays tribute.', requirement: { kind: 'badge', badgeId: 'crime_boss' } },
    { id: 'nightmare_tamer', name: 'Nightmare Tamer', price: 15000000, color: 0x8e44ad, description: 'Your beast answers to you alone.', requirement: { kind: 'dragonLevel', min: 25 } },
    { id: 'void_broker', name: 'Void Broker', price: 18000000, color: 0x4b0082, description: 'Trades settled beyond the grid.', requirement: { kind: 'open' } },
    { id: 'ember_hoarder_title', name: 'Ember Hoarder', price: 22000000, color: 0xff8c00, description: 'A hoard worth melting down.', requirement: { kind: 'badge', badgeId: 'ember_hoarder' } },
    { id: 'grid_sovereign', name: 'Grid Sovereign', price: 25000000, color: 0x00e5ff, description: 'The neon crown of the economy.', requirement: { kind: 'open' } },
    { id: 'hoardbreaker', name: 'Hoardbreaker', price: 30000000, color: 0x6c3483, description: 'You break what others hoard.', requirement: { kind: 'open' } },
    { id: 'warden_ember_hoard', name: 'Warden of the Ember Hoard', price: 0, color: 0xff4500, description: 'Raised the legendary KnightFury. The good side answers to you.', requirement: { kind: 'badge', badgeId: 'knightfury_keeper' } },
    { id: 'scourge_onslaught', name: 'Scourge of the Onslaught', price: 0, color: 0x8b0000, description: 'Command five beasts. The bad side answers to you.', requirement: { kind: 'badge', badgeId: 'alpha_beast' } },
    { id: 'circuit_champion', name: 'Champion of the Circuit', price: 0, color: 0xf1c40f, description: 'Three dragon races won.', requirement: { kind: 'raceWins', min: 3 } },
    { id: 'elo_grandmaster', name: 'Grid Grandmaster', price: 0, color: 0x00e5ff, description: 'Two thousand Elo on the tic-tac-toe ladder.', requirement: { kind: 'elo', min: 2000 } },
    { id: 'bounty_hunter_title', name: 'Bounty Hunter', price: 0, color: 0xc0392b, description: 'You collect what others put up.', requirement: { kind: 'badge', badgeId: 'bounty_hunter' } }
];

function getTitle(titleId) {
    return TITLES.find(title => title.id === titleId) || null;
}

function safeGet(sql, ...params) {
    try {
        return db.prepare(sql).get(...params) || null;
    } catch {
        return null;
    }
}

function safeAll(sql, ...params) {
    try {
        return db.prepare(sql).all(...params) || [];
    } catch {
        return [];
    }
}

/* Badges are read through questManager so there is one source of truth for the
 * catalog; the raw table is the fallback if the module cannot be loaded. */
function hasBadge(userId, badgeId) {
    try {
        const questManager = require('./questManager');
        return questManager.getBadges(userId).some(badge => badge.id === badgeId);
    } catch {
        return Boolean(safeGet('SELECT 1 AS hit FROM badges WHERE userId = ? AND badgeId = ?', userId, badgeId));
    }
}

function meetsRequirement(userId, requirement) {
    if (!requirement || requirement.kind === 'open') return true;
    switch (requirement.kind) {
        case 'badge':
            return hasBadge(userId, requirement.badgeId);
        case 'elo': {
            const row = safeGet('SELECT elo FROM ttt_elo WHERE userId = ?', userId);
            return Number(row?.elo || 0) >= Number(requirement.min || 0);
        }
        case 'raceWins': {
            const row = safeGet(`
                SELECT COUNT(*) AS wins FROM dragon_race_records r
                JOIN dragons d ON d.dragonId = r.dragonId
                WHERE d.userId = ? AND r.wins > 0
            `, userId);
            return Number(row?.wins || 0) >= Number(requirement.min || 0);
        }
        case 'dragonLevel': {
            const row = safeGet('SELECT MAX(level) AS level FROM dragons WHERE userId = ?', userId);
            return Number(row?.level || 0) >= Number(requirement.min || 0);
        }
        case 'quests': {
            const row = safeGet('SELECT questsClaimed FROM quest_stats WHERE userId = ?', userId);
            return Number(row?.questsClaimed || 0) >= Number(requirement.min || 0);
        }
        default:
            return false;
    }
}

function requirementText(requirement) {
    if (!requirement || requirement.kind === 'open') return 'Available for purchase';
    switch (requirement.kind) {
        case 'badge': {
            let label = requirement.badgeId;
            try {
                const questManager = require('./questManager');
                const badge = questManager.BADGES.find(entry => entry.id === requirement.badgeId);
                if (badge) label = `${badge.emoji} ${badge.name}`;
            } catch { /* catalog unavailable — show the raw id */ }
            return `Earn the ${label} badge`;
        }
        case 'elo':
            return `Reach ${Number(requirement.min).toLocaleString()} Elo`;
        case 'raceWins':
            return `Win ${requirement.min} dragon race${requirement.min === 1 ? '' : 's'}`;
        case 'dragonLevel':
            return `Raise a dragon to level ${requirement.min}`;
        case 'quests':
            return `Claim ${requirement.min} quests`;
        default:
            return 'Unknown requirement';
    }
}

function ownedRows(userId) {
    return safeAll('SELECT titleId, equipped, acquiredAt FROM cosmetic_titles WHERE userId = ?', userId);
}

function listOwned(userId) {
    const owned = new Map(ownedRows(userId).map(row => [row.titleId, row]));
    return TITLES.filter(title => owned.has(title.id)).map(title => ({
        ...title,
        equipped: Boolean(owned.get(title.id).equipped),
        acquiredAt: owned.get(title.id).acquiredAt
    }));
}

function listCatalog(userId) {
    const owned = new Map(ownedRows(userId).map(row => [row.titleId, row]));
    const wallet = Number(safeGet('SELECT wallet FROM users WHERE userId = ?', userId)?.wallet || 0);
    return TITLES.map(title => {
        const row = owned.get(title.id);
        const unlocked = meetsRequirement(userId, title.requirement);
        return {
            ...title,
            requirementText: requirementText(title.requirement),
            owned: Boolean(row),
            equipped: Boolean(row?.equipped),
            locked: !unlocked,
            canAfford: title.price === 0 ? unlocked : wallet >= title.price
        };
    });
}

function getEquippedTitle(userId) {
    const row = safeGet(
        'SELECT titleId FROM cosmetic_titles WHERE userId = ? AND equipped = 1 LIMIT 1', userId
    );
    return row ? getTitle(row.titleId) : null;
}

function formatTitleTag(userId) {
    const title = getEquippedTitle(userId);
    return title ? `「${title.name}」` : null;
}

function awardTitle(userId, titleId) {
    if (!userId || !getTitle(titleId)) return false;
    const result = db.prepare(`
        INSERT OR IGNORE INTO cosmetic_titles (userId, titleId, equipped, acquiredAt)
        VALUES (?, ?, 0, ?)
    `).run(userId, titleId, new Date().toISOString());
    return result.changes === 1;
}

function purchaseTitle(userId, titleId) {
    const title = getTitle(titleId);
    if (!title) return { ok: false, message: 'Unknown title.' };

    const existing = safeGet(
        'SELECT 1 AS hit FROM cosmetic_titles WHERE userId = ? AND titleId = ?', userId, titleId
    );
    if (existing) return { ok: false, message: `You already own **${title.name}**. Use /profile to equip it.` };

    if (!meetsRequirement(userId, title.requirement)) {
        return { ok: false, message: `**${title.name}** is locked — ${requirementText(title.requirement)}.` };
    }

    const price = Math.max(0, Number(title.price) || 0);
    try {
        db.transaction(() => {
            db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(userId);
            if (price > 0) {
                const debit = db.prepare(
                    'UPDATE users SET wallet = wallet - ?, moneySpent = COALESCE(moneySpent, 0) + ? WHERE userId = ? AND wallet >= ?'
                ).run(price, price, userId, price);
                if (debit.changes !== 1) throw new Error(`You need 🪙${price.toLocaleString()} in your wallet.`);
            }
            db.prepare(
                'UPDATE cosmetic_titles SET equipped = 0 WHERE userId = ?'
            ).run(userId);
            db.prepare(`
                INSERT INTO cosmetic_titles (userId, titleId, equipped, acquiredAt)
                VALUES (?, ?, 1, ?)
            `).run(userId, titleId, new Date().toISOString());
        })();
    } catch (error) {
        return { ok: false, message: error.message };
    }

    return { ok: true, title, price, message: `Acquired **「${title.name}」** and equipped it.` };
}

function equipTitle(userId, titleId) {
    const title = getTitle(titleId);
    if (!title) return { ok: false, message: 'Unknown title.' };
    const owned = safeGet('SELECT 1 AS hit FROM cosmetic_titles WHERE userId = ? AND titleId = ?', userId, titleId);
    if (!owned) return { ok: false, message: `You do not own **${title.name}**.` };

    db.transaction(() => {
        db.prepare('UPDATE cosmetic_titles SET equipped = 0 WHERE userId = ?').run(userId);
        db.prepare('UPDATE cosmetic_titles SET equipped = 1 WHERE userId = ? AND titleId = ?').run(userId, titleId);
    })();
    return { ok: true, title, message: `Equipped **「${title.name}」**.` };
}

function unequipTitle(userId) {
    const result = db.prepare('UPDATE cosmetic_titles SET equipped = 0 WHERE userId = ? AND equipped = 1').run(userId);
    return { ok: result.changes > 0, message: result.changes > 0 ? 'Title removed.' : 'You had no title equipped.' };
}

module.exports = {
    TITLES,
    getTitle,
    meetsRequirement,
    requirementText,
    listOwned,
    listCatalog,
    getEquippedTitle,
    formatTitleTag,
    awardTitle,
    purchaseTitle,
    equipTitle,
    unequipTitle
};
