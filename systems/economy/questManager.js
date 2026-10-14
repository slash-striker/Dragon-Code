/*
 * Quest & achievement board.
 *
 * Three layers, all persistent:
 *   • DAILY_QUESTS  — 3 seeded picks per UTC day, identical for everyone
 *   • WEEKLY_QUESTS — 3 seeded picks per ISO week
 *   • BADGES        — lifetime achievements shown on /profile
 *
 * Existing commands never write this table directly: they call the single
 * generic hook recordQuestEvent(userId, type, amount, meta) with one of the
 * QUEST_TYPES keys, and this module fans that out to every matching quest.
 *
 * Quest selection is DETERMINISTIC (FNV-1a over the date key) so a restart or
 * a different reader never shows a different board for the same day.
 */
const db = require('../../database');
const { logTransaction } = require('./transactionLogger');

/* Rarities that count as "Mythic or better" for the fish_rarity gate. */
const MYTHIC_PLUS = ['Mythic', 'Legendary', 'Impossible', 'LEGENDARY EVENT'];

/* Canonical event names. Hooks call recordQuestEvent with exactly these keys. */
const QUEST_TYPES = {
    mine_run: 'Mining runs',
    ore_mined: 'Ore mined',
    fish_catch: 'Fish caught',
    fish_rarity: 'Mythic+ fish caught',
    work: 'Shifts worked',
    beg: 'Beggings',
    crime_win: 'Crimes won',
    heist_win: 'Heists won',
    rob_win: 'Robberies won',
    game_win: 'Minigames won',
    ttt_win: 'Tic-tac-toe wins',
    rps_win_streak: 'RPS win streak',
    dragon_hatch: 'Dragons hatched',
    dragon_feed: 'Dragon feedings',
    dragon_race_win: 'Dragon races won',
    invest_win: 'Market rounds won',
    trade: 'Trades completed',
    daily_claim: 'Dailies claimed',
    sell_ore: 'Ore sales',
    tournament_catch: 'Tournament catches',
    market_sell: 'Market sales'
};

/* ---- Daily board ------------------------------------------------------- */
const DAILY_QUESTS = [
    { id: 'd_mine_runs', name: 'Deep Core Shift', emoji: '⛏️', type: 'mine_run', target: 3, reward: 6000, description: 'Complete 3 mining runs today.' },
    { id: 'd_ore_haul', name: 'Ore Haul', emoji: '🪨', type: 'ore_mined', target: 50, reward: 8000, description: 'Mine 50 ore today.' },
    { id: 'd_fresh_catch', name: 'Fresh Catch', emoji: '🎣', type: 'fish_catch', target: 5, reward: 7000, description: 'Catch 5 fish today.' },
    { id: 'd_mythic_waters', name: 'Mythic Waters', emoji: '🐉', type: 'fish_rarity', target: 1, reward: 25000, description: 'Catch a Mythic or better fish.' },
    { id: 'd_clock_in', name: 'Clock In', emoji: '💼', type: 'work', target: 3, reward: 5000, description: 'Work 3 shifts today.' },
    { id: 'd_humble', name: 'Humble Request', emoji: '🥺', type: 'beg', target: 3, reward: 3000, description: 'Beg 3 times today.' },
    { id: 'd_clean_getaway', name: 'Clean Getaway', emoji: '🕵️', type: 'crime_win', target: 1, reward: 9000, description: 'Pull off a successful crime.' },
    { id: 'd_sticky_fingers', name: 'Sticky Fingers', emoji: '🧤', type: 'rob_win', target: 1, reward: 9000, description: 'Win a robbery today.' },
    { id: 'd_arcade_sweep', name: 'Arcade Sweep', emoji: '🎮', type: 'game_win', target: 2, reward: 8000, description: 'Win 2 minigames today.' },
    { id: 'd_daily_ritual', name: 'Daily Ritual', emoji: '📅', type: 'daily_claim', target: 1, reward: 2000, description: 'Claim your /daily.' },
    { id: 'd_hatch_day', name: 'Hatch Day', emoji: '🥚', type: 'dragon_hatch', target: 1, reward: 20000, description: 'Hatch a dragon egg today.' },
    { id: 'd_keeper_duty', name: 'Keeper Duty', emoji: '🍖', type: 'dragon_feed', target: 3, reward: 6000, description: 'Feed your dragon 3 times.' },
    { id: 'd_market_day', name: 'Market Day', emoji: '📈', type: 'sell_ore', target: 1, reward: 5000, description: 'Sell ore at the market.' },
    { id: 'd_bull_run', name: 'Bull Run', emoji: '🐂', type: 'invest_win', target: 1, reward: 15000, description: 'Win a market round.' },
    { id: 'd_fair_exchange', name: 'Fair Exchange', emoji: '🤝', type: 'trade', target: 1, reward: 6000, description: 'Complete a trade.' },
    { id: 'd_derby_contender', name: 'Derby Contender', emoji: '🏆', type: 'tournament_catch', target: 3, reward: 10000, description: 'Log 3 catches in a fishing tournament.' }
];

/* ---- Weekly board ------------------------------------------------------ */
const WEEKLY_QUESTS = [
    { id: 'w_syndicate_payday', name: 'Syndicate Payday', emoji: '🏦', type: 'heist_win', target: 3, reward: 120000, description: 'Complete 3 heists this week.' },
    { id: 'w_ladder_climber', name: 'Ladder Climber', emoji: '⭕', type: 'ttt_win', target: 5, reward: 90000, description: 'Win 5 ladder tic-tac-toe matches.' },
    { id: 'w_track_champion', name: 'Track Champion', emoji: '🏁', type: 'dragon_race_win', target: 1, reward: 150000, description: 'Win a dragon race this week.' },
    { id: 'w_industrial', name: 'Industrial Week', emoji: '🏭', type: 'ore_mined', target: 300, reward: 100000, description: 'Mine 300 ore this week.' },
    { id: 'w_trawl_week', name: 'Trawl Week', emoji: '🐟', type: 'fish_catch', target: 40, reward: 80000, description: 'Catch 40 fish this week.' },
    { id: 'w_merchant', name: 'Merchant Week', emoji: '🤝', type: 'trade', target: 3, reward: 60000, description: 'Complete 3 trades this week.' },
    { id: 'w_derby_grinder', name: 'Derby Grinder', emoji: '🎣', type: 'tournament_catch', target: 2, reward: 70000, description: 'Win 2 tournament catches this week.' },
    { id: 'w_underworld', name: 'Underworld Week', emoji: '🌑', type: 'crime_win', target: 5, reward: 110000, description: 'Succeed at 5 crimes this week.' },
    { id: 'w_market_week', name: 'Market Week', emoji: '📊', type: 'invest_win', target: 3, reward: 130000, description: 'Win 3 market rounds this week.' },
    { id: 'w_streak_architect', name: 'Streak Architect', emoji: '✊', type: 'rps_win_streak', target: 3, reward: 70000, description: 'Win 3 RPS matches in a row.' },
    { id: 'w_hatchery_tender', name: 'Hatchery Tender', emoji: '🍖', type: 'dragon_feed', target: 15, reward: 75000, description: 'Feed your dragons 15 times.' },
    { id: 'w_lounge_legend', name: 'Lounge Legend', emoji: '🎲', type: 'game_win', target: 10, reward: 95000, description: 'Win 10 minigames this week.' }
];

/* ---- Badges ------------------------------------------------------------
 * `type` is the event that triggers a re-check (or 'flag' when the badge is
 * only ever granted by an explicit awardBadge() call from a system that knows
 * the achievement happened). `target` is what the check compares against.
 */
const BADGES = [
    { id: 'first_egg', name: 'First Light', emoji: '🥚', type: 'dragon_hatch', target: 1, description: 'Hatch your very first egg.' },
    { id: 'hatchery_10', name: 'Hatchery Keeper', emoji: '🏰', type: 'dragon_hatch', target: 10, description: 'Hatch 10 dragons or beasts.' },
    { id: 'ember_hoarder', name: 'Ember Hoarder', emoji: '💎', type: 'dragon_hatch', target: 25, description: 'Own 25 dragons and beasts.' },
    { id: 'knightfury_keeper', name: 'KnightFury Keeper', emoji: '🐉', type: 'dragon_hatch', target: 1, description: 'Raise the legendary KnightFury.' },
    { id: 'alpha_beast', name: 'Alpha Beast', emoji: '🐺', type: 'dragon_hatch', target: 5, description: 'Command 5 bad-side beasts.' },
    { id: 'dragon_rider', name: 'Dragon Rider', emoji: '🪽', type: 'dragon_feed', target: 50, description: 'Feed your dragons 50 times.' },
    { id: 'miner_1000', name: 'Deep Core Veteran', emoji: '⛏️', type: 'ore_mined', target: 1000, description: 'Mine 1,000 ore lifetime.' },
    { id: 'angler_500', name: 'Master Angler', emoji: '🎣', type: 'fish_catch', target: 500, description: 'Catch 500 fish lifetime.' },
    { id: 'mythic_hunter', name: 'Mythic Hunter', emoji: '✨', type: 'fish_rarity', target: 1, description: 'Catch a Mythic or better fish.' },
    { id: 'crime_boss', name: 'Crime Boss', emoji: '💀', type: 'crime_win', target: 50, description: 'Succeed at 50 solo crimes.' },
    { id: 'heist_legend', name: 'Heist Legend', emoji: '🏦', type: 'flag', target: 5, description: 'Complete 5 full-scale heists.' },
    { id: 'ttt_grandmaster', name: 'Grid Grandmaster', emoji: '⭕', type: 'ttt_win', target: 2000, description: 'Reach 2,000 Elo on the tic-tac-toe ladder.' },
    { id: 'race_champion', name: 'Race Champion', emoji: '🏁', type: 'dragon_race_win', target: 1, description: 'Win a dragon race.' },
    { id: 'market_shark', name: 'Market Shark', emoji: '📈', type: 'invest_win', target: 10, description: 'Win 10 market rounds.' },
    { id: 'bounty_hunter', name: 'Bounty Hunter', emoji: '🎯', type: 'flag', target: 1, description: 'Claim a player bounty.' },
    { id: 'trader', name: 'Wheel & Deal', emoji: '🤝', type: 'trade', target: 10, description: 'Complete 10 player trades.' },
    { id: 'tournament_champion', name: 'Derby Champion', emoji: '🏆', type: 'flag', target: 1, description: 'Win a fishing tournament.' },
    { id: 'dedicated_daily', name: 'Ritualist', emoji: '🔥', type: 'daily_claim', target: 30, description: 'Hold a 30-day quest streak.' },
    { id: 'quest_master', name: 'Quest Master', emoji: '📜', type: 'quest_claim', target: 100, description: 'Claim 100 quests.' }
];

/*
 * Value readers — one per badge that can be checked from stored data. 'flag'
 * badges (heist_legend, bounty_hunter, tournament_champion) have no reader:
 * the owning system calls awardBadge() when the achievement actually lands.
 */
const BADGE_READERS = {
    first_egg: userId => dragonsOwned(userId),
    hatchery_10: userId => dragonsOwned(userId),
    ember_hoarder: userId => dragonsOwned(userId),
    knightfury_keeper: userId => countOne(
        'SELECT COUNT(*) AS value FROM dragons WHERE userId = ? AND speciesId = ?', userId, 'knightfury'
    ),
    alpha_beast: userId => countOne(
        'SELECT COUNT(*) AS value FROM dragons WHERE userId = ? AND side = ?', userId, 'evil'
    ),
    dragon_rider: userId => countOne(
        'SELECT COALESCE(SUM(fedCount), 0) AS value FROM dragons WHERE userId = ?', userId
    ),
    miner_1000: userId => countOne(
        'SELECT COALESCE(totalOreFound, 0) AS value FROM mining_profile WHERE userId = ?', userId
    ),
    angler_500: userId => countOne('SELECT COALESCE(fishCount, 0) AS value FROM users WHERE userId = ?', userId),
    mythic_hunter: userId => countOne(
        `SELECT COUNT(*) AS value FROM fishing_inventory
         WHERE userId = ? AND rarity IN (${MYTHIC_PLUS.map(() => '?').join(', ')})`,
        userId, ...MYTHIC_PLUS
    ),
    crime_boss: userId => countOne(
        'SELECT COALESCE(crimeSuccess, 0) AS value FROM users WHERE userId = ?', userId
    ),
    ttt_grandmaster: userId => countOne('SELECT COALESCE(elo, 0) AS value FROM ttt_elo WHERE userId = ?', userId),
    race_champion: userId => countOne(
        `SELECT COUNT(*) AS value FROM dragon_race_records r
         JOIN dragons d ON d.dragonId = r.dragonId
         WHERE d.userId = ? AND r.wins > 0`,
        userId
    ),
    market_shark: userId => countOne(
        'SELECT COALESCE(wins, 0) AS value FROM market_pvp_stats WHERE userId = ?', userId
    ),
    dedicated_daily: userId => countOne(
        'SELECT COALESCE(dailyStreak, 0) AS value FROM quest_stats WHERE userId = ?', userId
    ),
    quest_master: userId => countOne(
        'SELECT COALESCE(questsClaimed, 0) AS value FROM quest_stats WHERE userId = ?', userId
    )
};

function countOne(sql, ...params) {
    try {
        const row = db.prepare(sql).get(...params);
        return Number(row?.value || 0);
    } catch {
        return 0;
    }
}

function dragonsOwned(userId) {
    return countOne('SELECT COUNT(*) AS value FROM dragons WHERE userId = ?', userId);
}

/* ---- Date keys --------------------------------------------------------- */
function todayKey(date = Date.now()) {
    return new Date(date).toISOString().slice(0, 10);
}

/* ISO-ish week key: YYYY-Www (UTC, Monday-start, ISO week number). */
function weekKey(date = Date.now()) {
    const d = new Date(date);
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = (target.getUTCDay() + 6) % 7; // Monday = 0
    target.setUTCDate(target.getUTCDate() - dayNum + 3); // Thursday of this week
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
    const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 60 * 60 * 1000));
    return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function shiftDayKey(dayKey, delta) {
    const [y, m, d] = String(dayKey).split('-').map(Number);
    const date = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
    date.setUTCDate(date.getUTCDate() + delta);
    return date.toISOString().slice(0, 10);
}

/* ---- Deterministic picks ---------------------------------------------- */
function fnv1a(input) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

function pickSeeded(pool, count, seedKey, salt) {
    const picks = [];
    const used = new Set();
    let cursor = 0;
    while (picks.length < count && cursor < pool.length * 8) {
        const index = fnv1a(`${seedKey}:${salt}:${cursor}`) % pool.length;
        if (!used.has(index)) {
            used.add(index);
            picks.push(pool[index]);
        }
        cursor += 1;
    }
    for (const quest of pool) {
        if (picks.length >= count) break;
        if (!picks.some(picked => picked.id === quest.id)) picks.push(quest);
    }
    return picks;
}

function getDailyQuests(dateKey = todayKey()) {
    return pickSeeded(DAILY_QUESTS, 3, dateKey, 'daily');
}

function getWeeklyQuests(key = weekKey()) {
    return pickSeeded(WEEKLY_QUESTS, 3, key, 'weekly');
}

/* ---- Progress plumbing ------------------------------------------------- */
function readProgress(userId, quest, period, dateKey) {
    const row = db.prepare(`
        SELECT progress, completed, claimed, claimedAt FROM quest_progress
        WHERE userId = ? AND questId = ? AND period = ? AND dateKey = ?
    `).get(userId, quest.id, period, dateKey);
    return row || { progress: 0, completed: 0, claimed: 0, claimedAt: null };
}

function materialize(userId, quest, period, dateKey) {
    db.prepare(`
        INSERT OR IGNORE INTO quest_progress (userId, questId, period, dateKey, progress, completed, claimed)
        VALUES (?, ?, ?, ?, 0, 0, 0)
    `).run(userId, quest.id, period, dateKey);
}

function getQuestBoard(userId, now = Date.now()) {
    if (!userId) return { daily: [], weekly: [] };
    const day = todayKey(now);
    const week = weekKey(now);

    const build = (quests, period, key) => quests.map(quest => {
        materialize(userId, quest, period, key);
        const row = readProgress(userId, quest, period, key);
        return {
            quest,
            progress: Math.min(Number(row.progress) || 0, quest.target),
            completed: Boolean(row.completed),
            claimed: Boolean(row.claimed)
        };
    });

    return {
        daily: build(getDailyQuests(day), 'daily', day),
        weekly: build(getWeeklyQuests(week), 'weekly', week),
        dailyKey: day,
        weeklyKey: week
    };
}

/* ---- The single event hook -------------------------------------------- */
function recordQuestEvent(userId, type, amount = 1, meta = {}) {
    const empty = { completed: [], badges: [] };
    if (!userId || !QUEST_TYPES[type]) return empty;
    const step = Number(amount);
    if (!Number.isFinite(step) || step <= 0) return empty;

    const now = Date.now();
    const day = todayKey(now);
    const week = weekKey(now);
    /* 'fish_rarity' only advances on a Mythic-or-better catch. */
    const gated = type === 'fish_rarity' && !MYTHIC_PLUS.includes(String(meta.rarity || ''));
    const completed = [];

    if (!gated) {
        const candidates = [
            ...getDailyQuests(day).filter(q => q.type === type).map(q => ({ quest: q, period: 'daily', dateKey: day })),
            ...getWeeklyQuests(week).filter(q => q.type === type).map(q => ({ quest: q, period: 'weekly', dateKey: week }))
        ];
        if (candidates.length) {
            db.transaction(() => {
                for (const entry of candidates) {
                    const { quest, period, dateKey } = entry;
                    const row = readProgress(userId, quest, period, dateKey);
                    if (row.claimed) continue;
                    const progress = Math.min(quest.target, (Number(row.progress) || 0) + Math.floor(step));
                    const isDone = progress >= quest.target ? 1 : 0;
                    if (row.progress === 0 && !row.completed) {
                        materialize(userId, quest, period, dateKey);
                    }
                    db.prepare(`
                        UPDATE quest_progress SET progress = ?, completed = ?
                        WHERE userId = ? AND questId = ? AND period = ? AND dateKey = ?
                    `).run(progress, isDone, userId, quest.id, period, dateKey);
                    if (isDone && !row.completed) {
                        completed.push({ questId: quest.id, period, name: quest.name, emoji: quest.emoji, reward: quest.reward });
                    }
                }
            })();
        }
    }

    const badges = evaluateBadges(userId, type, amount, meta);
    return { completed, badges };
}

/* ---- Badges ------------------------------------------------------------ */
function ensureStats(userId) {
    db.prepare('INSERT OR IGNORE INTO quest_stats (userId) VALUES (?)').run(userId);
}

function evaluateBadges(userId, type, amount = 1, meta = {}) {
    if (!userId || !type) return [];
    const awarded = [];
    const already = new Set(
        db.prepare('SELECT badgeId FROM badges WHERE userId = ?').all(userId).map(row => row.badgeId)
    );
    for (const badge of BADGES) {
        if (badge.type !== type || already.has(badge.id)) continue;
        const reader = BADGE_READERS[badge.id];
        if (!reader) continue; // 'flag' badge — granted explicitly elsewhere
        let value = 0;
        try {
            value = Number(reader(userId)) || 0;
        } catch {
            value = 0;
        }
        if (value >= badge.target && awardBadge(userId, badge.id)) {
            awarded.push(badge);
        }
    }
    return awarded;
}

function awardBadge(userId, badgeId) {
    if (!userId || !BADGES.some(badge => badge.id === badgeId)) return false;
    const result = db.prepare(
        'INSERT OR IGNORE INTO badges (userId, badgeId, earnedAt) VALUES (?, ?, ?)'
    ).run(userId, badgeId, new Date().toISOString());
    if (result.changes === 1) {
        ensureStats(userId);
        db.prepare('UPDATE quest_stats SET badgesEarned = badgesEarned + 1 WHERE userId = ?').run(userId);
        return true;
    }
    return false;
}

function getBadges(userId) {
    if (!userId) return [];
    const earned = new Map(
        db.prepare('SELECT badgeId, earnedAt FROM badges WHERE userId = ?').all(userId)
            .map(row => [row.badgeId, row.earnedAt])
    );
    return BADGES.filter(badge => earned.has(badge.id))
        .map(badge => ({ ...badge, earnedAt: earned.get(badge.id) }));
}

function getAllBadges(userId) {
    const earned = new Map(
        userId
            ? db.prepare('SELECT badgeId, earnedAt FROM badges WHERE userId = ?').all(userId)
                .map(row => [row.badgeId, row.earnedAt])
            : []
    );
    return BADGES.map(badge => ({ ...badge, earned: earned.has(badge.id), earnedAt: earned.get(badge.id) || null }));
}

/* ---- Claiming ---------------------------------------------------------- */
function claimQuest(userId, questId, period = 'daily', now = Date.now()) {
    if (!userId) return { ok: false, message: 'No user.' };
    const isDaily = period === 'daily';
    const dateKey = isDaily ? todayKey(now) : weekKey(now);
    const pool = isDaily ? getDailyQuests(dateKey) : getWeeklyQuests(dateKey);
    const quest = pool.find(entry => entry.id === questId);
    if (!quest) return { ok: false, message: 'That quest is not on your board right now.' };

    const row = readProgress(userId, quest, period, dateKey);
    if (!row.completed) return { ok: false, message: `**${quest.name}** is not finished yet (${row.progress}/${quest.target}).` };
    if (row.claimed) return { ok: false, message: `You already claimed **${quest.name}**.` };

    const reward = Math.max(0, Number(quest.reward) || 0);
    db.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(userId);
        db.prepare(`
            UPDATE quest_progress SET claimed = 1, claimedAt = ?
            WHERE userId = ? AND questId = ? AND period = ? AND dateKey = ?
        `).run(new Date().toISOString(), userId, quest.id, period, dateKey);
        if (reward > 0) {
            db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(reward, userId);
        }
        ensureStats(userId);
        db.prepare('UPDATE quest_stats SET questsClaimed = questsClaimed + 1 WHERE userId = ?').run(userId);
        if (isDaily) {
            const stats = db.prepare('SELECT dailyStreak, lastDailyKey FROM quest_stats WHERE userId = ?').get(userId);
            let streak = 1;
            if (stats?.lastDailyKey === dateKey) streak = Number(stats.dailyStreak) || 1;
            else if (stats?.lastDailyKey === shiftDayKey(dateKey, -1)) streak = (Number(stats.dailyStreak) || 0) + 1;
            db.prepare('UPDATE quest_stats SET dailyStreak = ?, lastDailyKey = ? WHERE userId = ?')
                .run(streak, dateKey, userId);
        }
    })();

    if (reward > 0) {
        try {
            logTransaction(userId, 'quest_reward', reward, `Quest reward — ${quest.name} (${period})`);
        } catch { /* logging is best-effort */ }
    }

    const badges = evaluateBadges(userId, 'quest_claim');
    return {
        ok: true,
        reward,
        quest,
        badges,
        message: `Claimed **${quest.emoji} ${quest.name}** — 🪙${reward.toLocaleString()} added to your wallet.`
    };
}

function getStats(userId) {
    if (!userId) return { questsClaimed: 0, badgesEarned: 0, dailyStreak: 0, lastDailyKey: null };
    ensureStats(userId);
    const row = db.prepare('SELECT * FROM quest_stats WHERE userId = ?').get(userId);
    return {
        questsClaimed: Number(row?.questsClaimed || 0),
        badgesEarned: Number(row?.badgesEarned || 0),
        dailyStreak: Number(row?.dailyStreak || 0),
        lastDailyKey: row?.lastDailyKey || null
    };
}

module.exports = {
    MYTHIC_PLUS,
    QUEST_TYPES,
    DAILY_QUESTS,
    WEEKLY_QUESTS,
    BADGES,
    todayKey,
    weekKey,
    getDailyQuests,
    getWeeklyQuests,
    getQuestBoard,
    recordQuestEvent,
    evaluateBadges,
    awardBadge,
    getBadges,
    getAllBadges,
    claimQuest,
    getStats
};
