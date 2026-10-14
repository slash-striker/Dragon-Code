const db = require('../../database');
const { logTransaction } = require('./transactionLogger');

/*
 * Fishing tournaments — a server-wide, 30-minute race.
 *
 * A tournament opens with a window (default 30 minutes) and a pot. Every
 * catch landed while the window is live is worth points based on the fish's
 * RARITY (a Legendary is worth far more than a junk boot) plus a small nudge
 * from the fish's sale value, so both luck and volume matter.
 *
 * When the window closes the pot pays out 50% / 30% / 20% to the top three
 * anglers. One tournament is ever live at a time — starting a new one first
 * settles anything that expired.
 */

// Points per rarity tier. Unknown rarities fall back to a token 3 points.
const RARITY_WEIGHTS = {
    Junk: 1,
    Common: 2,
    Uncommon: 4,
    Rare: 8,
    Epic: 14,
    Mythic: 26,
    Legendary: 45,
    Impossible: 70,
    'LEGENDARY EVENT': 30
};

const RARITY_RANK = {
    Junk: 0,
    Common: 1,
    Uncommon: 2,
    Rare: 3,
    Epic: 4,
    Mythic: 5,
    Legendary: 6,
    Impossible: 7,
    'LEGENDARY EVENT': 8
};

// 50 / 30 / 20 across the podium.
const PAYOUT_SPLIT = [0.5, 0.3, 0.2];
const MEDALS = ['🥇', '🥈', '🥉'];

function nowMs(now) {
    return Number.isFinite(now) ? Number(now) : Date.now();
}

function scoreForCatch(fish) {
    if (!fish) return 0;
    const weight = RARITY_WEIGHTS[fish.rarity] ?? 3;
    const valueBonus = Math.min(20, Math.floor((Number(fish.value) || 0) / 2500));
    return Math.max(1, Math.floor(weight + valueBonus));
}

function getActiveTournament(now = Date.now()) {
    const at = nowMs(now);
    return db.prepare(`
        SELECT * FROM fishing_tournaments
        WHERE status = 'live' AND endsAt > ?
        ORDER BY tournamentId DESC LIMIT 1
    `).get(at) || null;
}

function isLive(now = Date.now()) {
    return Boolean(getActiveTournament(now));
}

function startTournament({ channelId, durationMs = 30 * 60 * 1000, entryFee = 0, name = 'Neon Fishing Derby', pot = 0 } = {}) {
    // Only one derby may be live — settle anything that ran out its clock.
    closeExpired();

    const startedAt = Date.now();
    const endsAt = startedAt + Math.max(60 * 1000, Number(durationMs) || 30 * 60 * 1000);
    const info = db.prepare(`
        INSERT INTO fishing_tournaments (channelId, name, pot, entryFee, status, startsAt, endsAt)
        VALUES (?, ?, ?, ?, 'live', ?, ?)
    `).run(
        String(channelId || ''),
        String(name || 'Neon Fishing Derby'),
        Math.max(0, Math.floor(Number(pot) || 0)),
        Math.max(0, Math.floor(Number(entryFee) || 0)),
        startedAt,
        endsAt
    );
    return db.prepare('SELECT * FROM fishing_tournaments WHERE tournamentId = ?').get(info.lastInsertRowid) || null;
}

/*
 * Score one catch. Returns null when no derby is live so the caller can
 * simply ignore the result.
 */
function addCatchScore(userId, fish, now = Date.now()) {
    const tournament = getActiveTournament(now);
    if (!tournament || !userId) return null;

    const points = scoreForCatch(fish);
    const previous = db.prepare(
        'SELECT bestRarity FROM fishing_tournament_scores WHERE tournamentId = ? AND userId = ?'
    ).get(tournament.tournamentId, userId);

    let bestRarity = fish?.rarity ?? null;
    if (previous?.bestRarity) {
        const prevRank = RARITY_RANK[previous.bestRarity] ?? -1;
        const nextRank = RARITY_RANK[bestRarity] ?? -1;
        if (prevRank > nextRank) bestRarity = previous.bestRarity;
    }

    db.prepare(`
        INSERT INTO fishing_tournament_scores (tournamentId, userId, score, catches, bestRarity)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(tournamentId, userId) DO UPDATE SET
            score = score + excluded.score,
            catches = catches + 1,
            bestRarity = excluded.bestRarity
    `).run(tournament.tournamentId, userId, points, bestRarity);

    const row = db.prepare(
        'SELECT score, catches FROM fishing_tournament_scores WHERE tournamentId = ? AND userId = ?'
    ).get(tournament.tournamentId, userId);

    return {
        score: points,
        total: Number(row?.score) || 0,
        tournamentId: tournament.tournamentId
    };
}

function getLeaderboard(tournamentId, limit = 10) {
    if (!tournamentId) return [];
    return db.prepare(`
        SELECT userId, score, catches
        FROM fishing_tournament_scores
        WHERE tournamentId = ?
        ORDER BY score DESC, catches DESC
        LIMIT ?
    `).all(tournamentId, Math.max(1, Math.floor(limit) || 10));
}

function describeLeaderboard(tournamentId, limit = 10) {
    const rows = getLeaderboard(tournamentId, limit);
    return rows.map((row, index) => {
        const medal = MEDALS[index] || `#${index + 1}`;
        const points = Number(row.score || 0).toLocaleString();
        return `${medal} <@${row.userId}> — **${points}** pts (${row.catches} catch${row.catches === 1 ? '' : 'es'})`;
    });
}

function getStats(userId) {
    const row = db.prepare('SELECT * FROM fishing_tournament_records WHERE userId = ?').get(userId);
    return row || { userId, wins: 0, podiums: 0, bestScore: 0, tournaments: 0 };
}

function bumpRecord(userId, place, score) {
    db.prepare(`
        INSERT INTO fishing_tournament_records (userId, wins, podiums, bestScore, tournaments)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(userId) DO UPDATE SET
            wins = wins + excluded.wins,
            podiums = podiums + excluded.podiums,
            bestScore = MAX(bestScore, excluded.bestScore),
            tournaments = tournaments + 1
    `).run(
        userId,
        place === 1 ? 1 : 0,
        place <= 3 ? 1 : 0,
        Number(score) || 0
    );
}

/*
 * Settle one tournament: pay the podium from the pot, bump the lifetime
 * record book, and stamp the row closed. Returns null when the tournament is
 * missing or was already settled.
 */
function settleTournament(tournamentId, now = Date.now()) {
    const tournament = db.prepare(
        'SELECT * FROM fishing_tournaments WHERE tournamentId = ?'
    ).get(tournamentId);
    if (!tournament || tournament.status !== 'live') return null;

    const standings = getLeaderboard(tournamentId, 1000);
    const pot = Math.max(0, Math.floor(Number(tournament.pot) || 0));

    const payout = db.transaction(() => {
        const winners = [];

        if (pot > 0 && standings.length > 0) {
            /*
             * Only as many podium slots as there are anglers. Shares are
             * normalized over the slots that exist so a two-angler derby
             * still pays the whole pot (50/30 becomes 62.5/37.5).
             */
            const places = Math.min(PAYOUT_SPLIT.length, standings.length);
            const rawShares = PAYOUT_SPLIT.slice(0, places);
            const totalShare = rawShares.reduce((sum, share) => sum + share, 0) || 1;
            let distributed = 0;

            for (let index = 0; index < places; index += 1) {
                const row = standings[index];
                const prize = Math.floor(pot * (rawShares[index] / totalShare));
                if (prize <= 0) continue;

                db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(row.userId);
                db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(prize, row.userId);
                logTransaction(row.userId, 'fishing_tournament', prize,
                    `Fishing derby #${tournamentId} — place ${index + 1} of ${standings.length}`);

                distributed += prize;
                winners.push({
                    userId: row.userId,
                    score: Number(row.score) || 0,
                    catches: Number(row.catches) || 0,
                    prize,
                    place: index + 1
                });
            }

            // Rounding remainder always belongs to the champion.
            const remainder = pot - distributed;
            if (remainder > 0 && winners.length) {
                db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?')
                    .run(remainder, winners[0].userId);
                logTransaction(winners[0].userId, 'fishing_tournament', remainder, `Fishing derby #${tournamentId} rounding remainder`);
                winners[0].prize += remainder;
            }
        }

        standings.forEach((row, index) => bumpRecord(row.userId, index + 1, row.score));

        db.prepare(`UPDATE fishing_tournaments SET status = 'closed', endsAt = ? WHERE tournamentId = ?`)
            .run(nowMs(now), tournamentId);

        return winners;
    });

    const winners = payout();
    return {
        tournamentId,
        pot,
        entrants: standings.length,
        winners
    };
}

function closeExpired(now = Date.now()) {
    const at = nowMs(now);
    const expired = db.prepare(`
        SELECT tournamentId FROM fishing_tournaments
        WHERE status = 'live' AND endsAt <= ?
    `).all(at);

    const results = [];
    for (const row of expired) {
        const result = settleTournament(row.tournamentId, at);
        if (result) results.push(result);
    }
    return results;
}

module.exports = {
    RARITY_WEIGHTS,
    scoreForCatch,
    getActiveTournament,
    isLive,
    startTournament,
    addCatchScore,
    getLeaderboard,
    describeLeaderboard,
    settleTournament,
    closeExpired,
    getStats
};
