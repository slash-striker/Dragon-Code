/*
 * Tic-Tac-Toe Elo ladder.
 *
 * The /games hub keeps its vs-bot tictactoe; this module rates the
 * player-vs-player matches. Elo is standard (K = 32, start 1000) with draws
 * deliberately gentle — a drawn grid moves each side only half of the normal
 * delta, so playing safe is never a way to farm rating. Each week the single
 * highest-rated player is promoted and awarded the `grid_grandmaster` title
 * through the cosmetic-title system.
 *
 * The week key is shared with the dragon racing cycle so every weekly job in
 * the economy flips at the same instant.
 */
const db = require('../../database');
const { weekKey } = require('./dragonRacing');

const START_ELO = 1000;
const K = 32;
const MIN_ELO = 100;
const DRAW_DAMPING = 0.5;

function ensureRow(userId) {
    db.prepare(`
        INSERT OR IGNORE INTO ttt_elo (userId, elo, wins, losses, draws, streak, bestStreak, peakElo, updatedAt)
        VALUES (?, ?, 0, 0, 0, 0, 0, ?, ?)
    `).run(userId, START_ELO, START_ELO, new Date().toISOString());
}

function getRecord(userId) {
    ensureRow(userId);
    return db.prepare('SELECT * FROM ttt_elo WHERE userId = ?').get(userId);
}

function getElo(userId) {
    return Number(getRecord(userId)?.elo) || START_ELO;
}

/* Standard Elo expectation for `a` against `b`. */
function expectedScore(a, b) {
    return 1 / (1 + Math.pow(10, (Number(b) - Number(a)) / 400));
}

function clampElo(value) {
    return Math.max(MIN_ELO, Math.round(value));
}

function applyResult({ challengerId, opponentId, winnerId = null, now = Date.now() }) {
    if (!challengerId || !opponentId) throw new Error('A match needs two players.');
    if (String(challengerId) === String(opponentId)) throw new Error('A match needs two different players.');

    const challenger = getRecord(challengerId);
    const opponent = getRecord(opponentId);
    const ra = Number(challenger.elo) || START_ELO;
    const rb = Number(opponent.elo) || START_ELO;

    const ea = expectedScore(ra, rb);
    const eb = 1 - ea;

    const isDraw = winnerId === null || winnerId === undefined || winnerId === '';
    const outcome = isDraw
        ? 'draw'
        : String(winnerId) === String(challengerId)
            ? 'challenger'
            : 'opponent';

    const sa = outcome === 'challenger' ? 1 : outcome === 'opponent' ? 0 : 0.5;
    const sb = 1 - sa;
    const damping = outcome === 'draw' ? DRAW_DAMPING : 1;

    const challengerDelta = Math.round(K * (sa - ea) * damping);
    const opponentDelta = Math.round(K * (sb - eb) * damping);

    const challengerElo = clampElo(ra + challengerDelta);
    const opponentElo = clampElo(rb + opponentDelta);

    db.transaction(() => {
        const stamp = new Date(now).toISOString();

        db.prepare(`
            UPDATE ttt_elo
            SET elo = ?,
                wins = wins + ?,
                losses = losses + ?,
                draws = draws + ?,
                streak = ?,
                bestStreak = MAX(bestStreak, ?),
                peakElo = MAX(peakElo, ?),
                updatedAt = ?
            WHERE userId = ?
        `).run(
            challengerElo,
            outcome === 'challenger' ? 1 : 0,
            outcome === 'opponent' ? 1 : 0,
            isDraw ? 1 : 0,
            outcome === 'challenger' ? Number(challenger.streak) + 1 : 0,
            outcome === 'challenger' ? Number(challenger.streak) + 1 : Number(challenger.bestStreak) || 0,
            challengerElo,
            stamp,
            challengerId
        );

        db.prepare(`
            UPDATE ttt_elo
            SET elo = ?,
                wins = wins + ?,
                losses = losses + ?,
                draws = draws + ?,
                streak = ?,
                bestStreak = MAX(bestStreak, ?),
                peakElo = MAX(peakElo, ?),
                updatedAt = ?
            WHERE userId = ?
        `).run(
            opponentElo,
            outcome === 'opponent' ? 1 : 0,
            outcome === 'challenger' ? 1 : 0,
            isDraw ? 1 : 0,
            outcome === 'opponent' ? Number(opponent.streak) + 1 : 0,
            outcome === 'opponent' ? Number(opponent.streak) + 1 : Number(opponent.bestStreak) || 0,
            opponentElo,
            stamp,
            opponentId
        );

        db.prepare(`
            INSERT INTO ttt_matches
                (challengerId, opponentId, winnerId, result, challengerDelta, opponentDelta, playedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(challengerId, opponentId, isDraw ? null : winnerId, outcome, challengerDelta, opponentDelta, stamp);
    })();

    return { challengerDelta, opponentDelta, challengerElo, opponentElo, outcome };
}

/* Competition ranking: ties share a position and do not consume the next one. */
function getLadder(limit = 10) {
    const rows = db.prepare(`
        SELECT userId, elo, wins, losses, draws, streak, bestStreak
        FROM ttt_elo
        ORDER BY elo DESC, wins DESC, updatedAt ASC
        LIMIT ?
    `).all(limit);

    return rows.map((row, index) => {
        const higher = rows.filter(other => Number(other.elo) > Number(row.elo)).length;
        return {
            userId: row.userId,
            elo: Number(row.elo),
            wins: Number(row.wins),
            losses: Number(row.losses),
            draws: Number(row.draws),
            streak: Number(row.streak),
            bestStreak: Number(row.bestStreak),
            rank: higher + 1,
            position: index + 1
        };
    });
}

function getRank(userId) {
    const row = db.prepare('SELECT elo FROM ttt_elo WHERE userId = ?').get(userId);
    if (!row) return null;
    const higher = db.prepare('SELECT COUNT(*) AS higher FROM ttt_elo WHERE elo > ?').get(row.elo);
    return Number(higher.higher) + 1;
}

/*
 * Weekly promotion: the single top-rated player of the week is crowned and
 * handed the Grid Grandmaster title. Idempotent per week for the winner.
 */
function runWeeklyPromotion(now = Date.now()) {
    const key = weekKey(new Date(now));
    const top = db.prepare(
        'SELECT userId, elo FROM ttt_elo ORDER BY elo DESC, wins DESC, updatedAt ASC LIMIT 1'
    ).get();

    if (!top || Number(top.elo) <= START_ELO) {
        return { ok: false, weekKey: key, promoted: [], reason: 'no-qualifying-player' };
    }

    const already = db.prepare('SELECT 1 FROM ttt_promotions WHERE userId = ? AND weekKey = ?')
        .get(top.userId, key);
    if (already) return { ok: true, weekKey: key, promoted: [], reason: 'already-awarded' };

    db.prepare(`
        INSERT OR IGNORE INTO ttt_promotions (userId, weekKey, rank, elo, awardedAt)
        VALUES (?, ?, 1, ?, ?)
    `).run(top.userId, key, Number(top.elo), new Date(now).toISOString());

    let titleAwarded = false;
    try {
        // titleManager is owned by another slice of this batch; tolerate it not
        // being present yet so the ladder never breaks.
        const titles = require('./titleManager');
        if (titles && typeof titles.awardTitle === 'function') {
            titleAwarded = Boolean(titles.awardTitle(top.userId, 'grid_grandmaster'));
        }
    } catch {
        titleAwarded = false;
    }

    return {
        ok: true,
        weekKey: key,
        promoted: [{ userId: top.userId, elo: Number(top.elo), rank: 1, titleAwarded }]
    };
}

function getPromotions(limit = 10) {
    return db.prepare(
        'SELECT * FROM ttt_promotions ORDER BY awardedAt DESC LIMIT ?'
    ).all(limit);
}

function getMatchHistory(userId, limit = 5) {
    return db.prepare(`
        SELECT * FROM ttt_matches
        WHERE challengerId = ? OR opponentId = ?
        ORDER BY matchId DESC
        LIMIT ?
    `).all(userId, userId, limit);
}

module.exports = {
    START_ELO,
    K,
    MIN_ELO,
    DRAW_DAMPING,
    getRecord,
    getElo,
    expectedScore,
    applyResult,
    getLadder,
    getRank,
    runWeeklyPromotion,
    getPromotions,
    getMatchHistory
};
