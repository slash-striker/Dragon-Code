/*
 * Market PvP — server-wide /invest rounds.
 *
 * The market engine already publishes ore prices that swing with random
 * events; until now nobody could act on an expectation. A round picks ONE
 * ore at random, runs for 5 minutes, and everyone bets `long` (price rises)
 * or `short` (price falls).
 *
 * Two deliberate design choices tie this to the rest of the economy:
 *
 *  1. Settlement tracks the SAME model /market and /sell use — price is
 *     `base value x current event multiplier`. The round snapshots the level
 *     at open and re-reads it at close, so a market event that starts or ends
 *     mid-round actually moves the price. Reading /market is therefore real
 *     intelligence, not flavour text.
 *  2. Payout is PARIMUTUEL with a contrarian bonus: every winner gets their
 *     stake back plus 1x profit plus an equal cut of the losing pool, and a
 *     player who wins ALONE takes 90% of the losing pool. Taking the side
 *     nobody else wanted is the only way to the big money.
 */
const db = require('../../database');
const { logTransaction } = require('./transactionLogger');
const { BASE_ORE_VALUES, getMarketState } = require('../mining/marketEngine');

const ROUND_MS_HOURS = 24;
const ROUND_MS = ROUND_MS_HOURS * 60 * 60 * 1000;
const MIN_BET = 1000;
const MAX_BET = 5_000_000;

// How much of a mid-round event shift the price actually capitalises, and how
// wide the per-round noise band is. 0.6 / +-5% keeps rounds a coin flip on a
// calm market while making a live event a genuine edge.
const EVENT_CAPTURE = 0.6;
const NOISE = 0.05;

function nowIso() {
    return new Date().toISOString();
}

/*
 * Event level for an ore — `base x multiplier` with no noise. Identical to
 * what marketEngine.getOrePrice produces before its own +-5% jitter, so the
 * two never disagree about where the market is.
 */
function marketLevel(oreId) {
    const base = Number(BASE_ORE_VALUES[oreId]) || 1;
    const state = getMarketState();
    const multiplier = Number(state?.eventMultiplier) || 1;
    return Math.max(1, base * multiplier);
}

function round2(value) {
    return Number(Number(value).toFixed(2));
}

function getOpenRound(now = Date.now()) {
    const row = db.prepare(
        "SELECT * FROM market_rounds WHERE status = 'open' AND endsAt > ? ORDER BY roundId DESC LIMIT 1"
    ).get(now);
    return row || null;
}

function getRound(roundId) {
    return db.prepare('SELECT * FROM market_rounds WHERE roundId = ?').get(roundId) || null;
}

function pickOreId() {
    const ids = Object.keys(BASE_ORE_VALUES);
    return ids[Math.floor(Math.random() * ids.length)];
}

/*
 * Open a fresh round. Any stale open round is settled first so there is never
 * more than one live round (the scheduler and the command both call this).
 */
function openRound({ oreId, now = Date.now() } = {}) {
    const existing = getOpenRound(now);
    if (existing) return existing;

    const stale = db.prepare("SELECT roundId FROM market_rounds WHERE status = 'open'").all();
    for (const row of stale) settleRound(row.roundId, now);

    const chosen = oreId && BASE_ORE_VALUES[oreId] ? oreId : pickOreId();
    const startPrice = round2(marketLevel(chosen));

    const info = db.prepare(`
        INSERT INTO market_rounds (oreId, status, startPrice, startedAt, endsAt)
        VALUES (?, 'open', ?, ?, ?)
    `).run(chosen, startPrice, now, now + ROUND_MS);

    return getRound(info.lastInsertRowid);
}

function ensureStats(userId) {
    db.prepare('INSERT OR IGNORE INTO market_pvp_stats (userId) VALUES (?)').run(userId);
}

function getRoundBets(roundId) {
    const rows = db.prepare(
        'SELECT direction, amount, userId FROM market_bets WHERE roundId = ?'
    ).all(roundId);

    const summary = {
        long: { count: 0, staked: 0 },
        short: { count: 0, staked: 0 },
        total: 0
    };
    for (const row of rows) {
        const bucket = row.direction === 'short' ? summary.short : summary.long;
        bucket.count += 1;
        bucket.staked += Number(row.amount) || 0;
        summary.total += Number(row.amount) || 0;
    }
    return summary;
}

function placeBet(userId, { oreId, direction, amount }, now = Date.now()) {
    if (direction !== 'long' && direction !== 'short') {
        return { ok: false, message: 'Direction must be either `long` or `short`.' };
    }
    const stake = Math.floor(Number(amount));
    if (!Number.isFinite(stake) || stake < MIN_BET) {
        return { ok: false, message: `The minimum bet is 🪙${MIN_BET.toLocaleString()}.` };
    }
    if (stake > MAX_BET) {
        return { ok: false, message: `The maximum bet is 🪙${MAX_BET.toLocaleString()}.` };
    }

    const round = getOpenRound(now);
    if (!round) return { ok: false, message: 'No round is live right now — one starts on the next tick.' };
    if (oreId && round.oreId !== oreId) {
        return {
            ok: false,
            message: `This round is trading **${String(round.oreId).replace(/_/g, ' ')}**, not ${String(oreId).replace(/_/g, ' ')}.`
        };
    }

    const already = db.prepare(
        'SELECT betId FROM market_bets WHERE roundId = ? AND userId = ?'
    ).get(round.roundId, userId);
    if (already) return { ok: false, message: 'You already took a position this round. Wait for the next one.' };

    try {
        db.transaction(() => {
            db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(userId);
            const debit = db.prepare(
                'UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?'
            ).run(stake, userId, stake);
            if (debit.changes !== 1) {
                throw new Error(`You need 🪙${stake.toLocaleString()} in your wallet to take that position.`);
            }
            db.prepare(`
                INSERT INTO market_bets (roundId, userId, oreId, direction, amount, createdAt)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(round.roundId, userId, round.oreId, direction, stake, now);
            ensureStats(userId);
            logTransaction(userId, 'market_bet', -stake,
                `Market PvP ${direction.toUpperCase()} on ${round.oreId} (round #${round.roundId})`);
        })();
    } catch (error) {
        return { ok: false, message: error.message };
    }

    const split = getRoundBets(round.roundId);
    const mine = split[direction];
    const other = direction === 'long' ? split.short : split.long;
    const soloWinners = mine.count === 1;
    const estimated = soloWinners
        ? stake * 2 + Math.floor(other.staked * 0.9)
        : stake * 2 + Math.floor(other.staked / Math.max(1, mine.count));

    return {
        ok: true,
        round: getRound(round.roundId),
        direction,
        stake,
        payoutIfWin: estimated,
        split
    };
}

function settleRound(roundId, now = Date.now()) {
    const round = getRound(roundId);
    if (!round) return null;
    if (round.status !== 'open') return null;

    const oreId = round.oreId;
    const startPrice = Number(round.startPrice) || 1;
    const target = marketLevel(oreId);
    const drift = (target - startPrice) * EVENT_CAPTURE;
    const noise = startPrice * (Math.random() * NOISE * 2 - NOISE);
    const endPrice = round2(Math.max(1, startPrice + drift + noise));
    const outcome = endPrice >= startPrice ? 'long' : 'short';

    const bets = db.prepare('SELECT * FROM market_bets WHERE roundId = ? AND settled = 0').all(roundId);
    const winners = bets.filter(bet => bet.direction === outcome);
    const losers = bets.filter(bet => bet.direction !== outcome);
    const losingPool = losers.reduce((sum, bet) => sum + Number(bet.amount), 0);
    const share = winners.length ? Math.floor(losingPool / winners.length) : 0;
    const lone = winners.length === 1;

    const paid = [];
    db.transaction(() => {
        for (const bet of winners) {
            const payout = lone
                ? Math.floor(Number(bet.amount) * 2 + losingPool * 0.9)
                : Number(bet.amount) * 2 + share;
            if (payout > 0) {
                db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(payout, bet.userId);
                logTransaction(bet.userId, 'market_pvp_win', payout,
                    `Market PvP ${outcome.toUpperCase()} won on ${oreId}${lone ? ' (lone contrarian)' : ''} (round #${roundId})`);
            }
            db.prepare('UPDATE market_bets SET payout = ?, settled = 1 WHERE betId = ?').run(payout, bet.betId);
            ensureStats(bet.userId);
            db.prepare(`
                UPDATE market_pvp_stats
                SET rounds = rounds + 1,
                    wins = wins + 1,
                    netCredits = netCredits + (? - ?),
                    bestPayout = MAX(bestPayout, ?),
                    contrarianWins = contrarianWins + ?
                WHERE userId = ?
            `).run(payout, Number(bet.amount), payout, lone ? 1 : 0, bet.userId);
            paid.push({ userId: bet.userId, amount: Number(bet.amount), payout, contrarian: lone });
            /* 📋 Quest board hook — a winning round counts for the market quests. */
            try {
                require('./questManager').recordQuestEvent(bet.userId, 'invest_win', 1, { oreId, contrarian: lone });
            } catch (error) {
                /* quests must never block a payout */
            }
        }

        for (const bet of losers) {
            db.prepare('UPDATE market_bets SET payout = 0, settled = 1 WHERE betId = ?').run(bet.betId);
            ensureStats(bet.userId);
            db.prepare(`
                UPDATE market_pvp_stats
                SET rounds = rounds + 1,
                    losses = losses + 1,
                    netCredits = netCredits - ?
                WHERE userId = ?
            `).run(Number(bet.amount), bet.userId);
        }

        db.prepare(`
            UPDATE market_rounds
            SET status = 'settled', endPrice = ?, outcome = ?, settledAt = ?
            WHERE roundId = ?
        `).run(endPrice, outcome, nowIso(), roundId);
    })();

    return {
        roundId,
        oreId,
        startPrice,
        endPrice,
        changePercent: ((endPrice - startPrice) / startPrice) * 100,
        outcome,
        event: target !== startPrice ? 'shifted' : 'stable',
        winners: paid,
        losingPool,
        loneContrarian: lone ? (paid[0]?.userId ?? null) : null,
        settledBets: bets.length
    };
}

function closeAndSettleExpired(now = Date.now()) {
    const expired = db.prepare(
        "SELECT roundId FROM market_rounds WHERE status = 'open' AND endsAt <= ? ORDER BY roundId ASC"
    ).all(now);
    const results = [];
    for (const row of expired) {
        const result = settleRound(row.roundId, now);
        if (result) results.push(result);
    }
    return results;
}

function getStats(userId) {
    const row = db.prepare('SELECT * FROM market_pvp_stats WHERE userId = ?').get(userId);
    return row || {
        userId,
        rounds: 0,
        wins: 0,
        losses: 0,
        netCredits: 0,
        bestPayout: 0,
        contrarianWins: 0
    };
}

function getRecentRounds(limit = 5) {
    return db.prepare(
        "SELECT * FROM market_rounds WHERE status = 'settled' ORDER BY roundId DESC LIMIT ?"
    ).all(limit);
}

function getLeaderboard(limit = 10) {
    return db.prepare(`
        SELECT * FROM market_pvp_stats
        ORDER BY netCredits DESC, wins DESC
        LIMIT ?
    `).all(limit);
}

function describeRound(round, now = Date.now()) {
    if (!round || round.status !== 'open') return null;
    const split = getRoundBets(round.roundId);
    const secondsLeft = Math.max(0, Math.round((round.endsAt - now) / 1000));
    return {
        oreId: round.oreId,
        oreLabel: String(round.oreId).replace(/_/g, ' '),
        startPrice: Number(round.startPrice),
        endsAt: round.endsAt,
        secondsLeft,
        split,
        longMultiplier: split.long.staked ? (split.total / split.long.staked).toFixed(2) : '—',
        shortMultiplier: split.short.staked ? (split.total / split.short.staked).toFixed(2) : '—'
    };
}

module.exports = {
    ROUND_MS,
    ROUND_MS_HOURS,
    MIN_BET,
    MAX_BET,
    getOpenRound,
    getRound,
    openRound,
    placeBet,
    settleRound,
    closeAndSettleExpired,
    getRoundBets,
    getStats,
    getLeaderboard,
    getRecentRounds,
    describeRound
};
