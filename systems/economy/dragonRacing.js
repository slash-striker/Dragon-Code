/*
 * Dragon Racing — the weekly simulated derby.
 *
 * A race opens for the week (idempotent per ISO week via bot_meta), owners
 * enter hatched dragons from the `dragons` table, and players bet credits on
 * an entrant. `settleRace` runs the simulation: every dragon advances along
 * the track one segment at a time using its speed / level / bond plus a
 * terrain bonus derived from its trait — an Ember dragon loves Ember Canyon,
 * a Frost dragon loves the Frozen Rift, and so on. The champion's owner
 * pockets a stud fee and every bettor who backed the winner doubles their
 * stake.
 *
 * The `dragon_races` table predates the race log, so the entrants column
 * stores a JSON payload `{ entries: [...], log: [...] }`. `readPayload` still
 * accepts a bare array so rows written by the older shape keep loading.
 */
const db = require('../../database');
const { logTransaction } = require('./transactionLogger');

const BET_MIN = 1000;
const BET_MAX = 2_000_000;
const MAX_ENTRIES_PER_USER = 2;
const STUD_FEE_RATE = 0.20;   // champion owner's cut of the pot
const WIN_MULTIPLIER = 2;     // stake back + 1x profit
const RACE_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;

const TRACKS = [
    {
        id: 'ember_canyon',
        name: 'Ember Canyon',
        emoji: '🌋',
        length: 48,
        terrain: 'fire',
        description: 'Lava fissures and ash storms the whole way down.'
    },
    {
        id: 'frozen_rift',
        name: 'Frozen Rift',
        emoji: '❄️',
        length: 52,
        terrain: 'ice',
        description: 'A glacier trench that punishes anything cold-blooded.'
    },
    {
        id: 'thunder_ring',
        name: 'Thunder Ring',
        emoji: '⚡',
        length: 45,
        terrain: 'storm',
        description: 'Static walls close in with every lap.'
    },
    {
        id: 'abyssal_run',
        name: 'Abyssal Run',
        emoji: '🕳️',
        length: 56,
        terrain: 'void',
        description: 'No light, no ground, no rules.'
    },
    {
        id: 'verdant_maze',
        name: 'Verdant Maze',
        emoji: '🌿',
        length: 50,
        terrain: 'nature',
        description: 'A living hedge labyrinth that grows back behind you.'
    },
    {
        id: 'neon_skyway',
        name: 'Neon Skyway',
        emoji: '🌆',
        length: 42,
        terrain: 'storm',
        description: 'A wireframe skyline run at full throttle.'
    }
];

/*
 * Trait → terrain affinity. Traits come from the dragon system
 * (ember/frost/storm/void/verdant/gilded/shadow/radiant). The three
 * "neutral" traits are at home everywhere, so they carry a small flat bonus
 * on every track instead of a specialist one.
 */
const TERRAIN_MATCH_BONUS = 0.22;
const NEUTRAL_TRAIT_BONUS = 0.08;

const TRAIT_AFFINITY = {
    ember: { terrain: 'fire', bonus: TERRAIN_MATCH_BONUS },
    frost: { terrain: 'ice', bonus: TERRAIN_MATCH_BONUS },
    storm: { terrain: 'storm', bonus: TERRAIN_MATCH_BONUS },
    void: { terrain: 'void', bonus: TERRAIN_MATCH_BONUS },
    verdant: { terrain: 'nature', bonus: TERRAIN_MATCH_BONUS },
    gilded: { terrain: '*', bonus: NEUTRAL_TRAIT_BONUS },
    shadow: { terrain: '*', bonus: NEUTRAL_TRAIT_BONUS },
    radiant: { terrain: '*', bonus: NEUTRAL_TRAIT_BONUS }
};

function metaGet(key) {
    const row = db.prepare('SELECT value FROM bot_meta WHERE key = ?').get(key);
    return row ? row.value : null;
}

function metaSet(key, value) {
    db.prepare(`INSERT INTO bot_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

/* ISO-8601 week key ('YYYY-Www') — the race cycle is one calendar week. */
function weekKey(date = new Date()) {
    const d = new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate()
    ));
    const mondayOffset = (d.getUTCDay() + 6) % 7;      // Monday = 0
    d.setUTCDate(d.getUTCDate() - mondayOffset + 3);   // Thursday of this week
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const firstOffset = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstOffset + 3);
    const week = 1 + Math.round((d - firstThursday) / (7 * 24 * 60 * 60 * 1000));
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function getTrack(trackId) {
    return TRACKS.find(track => track.id === trackId) || TRACKS[0];
}

/* ---- Row helpers --------------------------------------------------------- */

function normalizeEntry(entry) {
    return {
        dragonId: Number(entry.dragonId),
        userId: String(entry.userId),
        name: String(entry.name || 'Unnamed'),
        speciesId: entry.speciesId || 'unknown',
        side: entry.side === 'evil' ? 'evil' : 'good',
        trait: entry.trait || 'radiant',
        trait2: entry.trait2 || null,
        speed: Number(entry.speed) || 0,
        power: Number(entry.power) || 0,
        bond: Number(entry.bond) || 0,
        level: Number(entry.level) || 1,
        position: Number(entry.position) || 0,
        progress: Number(entry.progress) || 0,
        time: entry.time === null || entry.time === undefined ? null : Number(entry.time)
    };
}

/*
 * The entrants column holds `{ entries, log }`. Older rows (and the admin
 * tools) may still write a bare array, so both shapes load.
 */
function readPayload(race) {
    const raw = race && race.entrants;
    if (!raw) return { entries: [], log: [] };
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return { entries: parsed.map(normalizeEntry), log: [] };
        }
        return {
            entries: Array.isArray(parsed.entries) ? parsed.entries.map(normalizeEntry) : [],
            log: Array.isArray(parsed.log) ? parsed.log : []
        };
    } catch {
        return { entries: [], log: [] };
    }
}

function writePayload(raceId, entries, log) {
    db.prepare('UPDATE dragon_races SET entrants = ? WHERE raceId = ?')
        .run(JSON.stringify({ entries, log: log || [] }), raceId);
}

/*
 * `dragons.wins` / `dragons.losses` are optional: the table does not carry
 * them in every schema revision, so the tally is only written when both
 * columns are actually present. Racing records in `dragon_race_records` are
 * the source of truth either way.
 */
let dragonWinColumns = null;
function hasDragonWinColumns() {
    if (dragonWinColumns !== null) return dragonWinColumns;
    try {
        const columns = new Set(db.prepare('PRAGMA table_info(dragons)').all().map(column => column.name));
        dragonWinColumns = columns.has('wins') && columns.has('losses');
    } catch {
        dragonWinColumns = false;
    }
    return dragonWinColumns;
}

function getRace(raceId) {
    const id = Number(raceId);
    if (!Number.isInteger(id) || id <= 0) return null;
    return db.prepare('SELECT * FROM dragon_races WHERE raceId = ?').get(id) || null;
}

function getCurrentRace(now = Date.now()) {
    return db.prepare(
        "SELECT * FROM dragon_races WHERE status = 'open' ORDER BY raceId DESC LIMIT 1"
    ).get() || null;
}

function getLastSettledRace() {
    return db.prepare(
        "SELECT * FROM dragon_races WHERE status = 'settled' ORDER BY raceId DESC LIMIT 1"
    ).get() || null;
}

function getRaceHistory(limit = 5) {
    return db.prepare(
        "SELECT * FROM dragon_races WHERE status = 'settled' ORDER BY raceId DESC LIMIT ?"
    ).all(limit);
}

function getEntrants(raceId) {
    return readPayload(getRace(raceId)).entries;
}

/* ---- Opening the weekly race --------------------------------------------- */

function openRaceForWeek(now = Date.now()) {
    const key = weekKey(new Date(now));
    const stamp = `race:week:${key}`;

    // A race for this week already exists — reuse it (and re-arm the stamp if
    // the row survived a database restore without its meta key).
    const existingId = metaGet(stamp);
    if (existingId) {
        const existing = getRace(existingId);
        if (existing && existing.status === 'open') {
            if (existing.endsAt <= now) return settleRace(existing.raceId);
            return existing;
        }
    }

    const track = TRACKS[Math.floor(Math.random() * TRACKS.length)];
    const created = db.transaction(() => {
        const info = db.prepare(`
            INSERT INTO dragon_races (status, trackId, entrants, pot, startsAt, endsAt)
            VALUES ('open', ?, '[]', 0, ?, ?)
        `).run(track.id, now, now + RACE_WINDOW_MS);
        const raceId = Number(info.lastInsertRowid);
        metaSet(stamp, String(raceId));
        return raceId;
    })();

    return getRace(created);
}

/* ---- Entries ------------------------------------------------------------- */

function registerDragon(raceId, userId, dragonId) {
    const race = getRace(raceId);
    if (!race) return { ok: false, message: 'That race no longer exists.' };
    if (race.status !== 'open') return { ok: false, message: 'That race has already run — wait for the next one.' };

    const dragon = db.prepare('SELECT * FROM dragons WHERE dragonId = ?').get(Number(dragonId));
    if (!dragon) return { ok: false, message: 'No dragon with that id.' };
    if (dragon.userId !== String(userId)) return { ok: false, message: 'That dragon is not yours to race.' };

    const payload = readPayload(race);
    if (payload.entries.some(entry => entry.dragonId === Number(dragonId))) {
        return { ok: false, message: `${dragon.name} is already entered in this race.` };
    }
    const mine = payload.entries.filter(entry => entry.userId === String(userId));
    if (mine.length >= MAX_ENTRIES_PER_USER) {
        return { ok: false, message: `You can enter at most ${MAX_ENTRIES_PER_USER} dragons per race.` };
    }

    payload.entries.push(normalizeEntry({
        dragonId: dragon.dragonId,
        userId: dragon.userId,
        name: dragon.name,
        speciesId: dragon.speciesId,
        side: dragon.side,
        trait: dragon.trait,
        trait2: dragon.trait2,
        speed: dragon.speed,
        power: dragon.power,
        bond: dragon.bond,
        level: dragon.level,
        position: 0,
        progress: 0,
        time: null
    }));
    writePayload(race.raceId, payload.entries, payload.log);

    return { ok: true, message: `${dragon.name} is on the starting line.`, entry: payload.entries[payload.entries.length - 1] };
}

/* ---- Betting ------------------------------------------------------------- */

function placeBet(raceId, userId, dragonId, amount) {
    const race = getRace(raceId);
    if (!race) return { ok: false, message: 'That race no longer exists.' };
    if (race.status !== 'open') return { ok: false, message: 'Betting is closed for that race.' };

    const stake = Math.floor(Number(amount) || 0);
    if (!Number.isFinite(stake) || stake < BET_MIN) {
        return { ok: false, message: `The minimum bet is 🪙${BET_MIN.toLocaleString()}.` };
    }
    if (stake > BET_MAX) {
        return { ok: false, message: `The maximum bet is 🪙${BET_MAX.toLocaleString()}.` };
    }

    const payload = readPayload(race);
    const entry = payload.entries.find(item => item.dragonId === Number(dragonId));
    if (!entry) return { ok: false, message: 'That dragon is not entered in this race.' };

    const already = db.prepare('SELECT betId FROM dragon_race_bets WHERE raceId = ? AND userId = ?')
        .get(race.raceId, userId);
    if (already) return { ok: false, message: 'You already have a bet on this race — one per player.' };

    try {
        const bet = db.transaction(() => {
            const debit = db.prepare(
                'UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?'
            ).run(stake, userId, stake);
            if (debit.changes !== 1) {
                throw new Error(`You need 🪙${stake.toLocaleString()} in your wallet.`);
            }
            const info = db.prepare(`
                INSERT INTO dragon_race_bets (raceId, userId, dragonId, amount, payout, settled, createdAt)
                VALUES (?, ?, ?, ?, 0, 0, ?)
            `).run(race.raceId, userId, entry.dragonId, stake, Date.now());
            db.prepare('UPDATE dragon_races SET pot = pot + ? WHERE raceId = ?').run(stake, race.raceId);
            logTransaction(userId, 'race_bet', -stake, `Dragon race bet on ${entry.name}`);
            return { betId: Number(info.lastInsertRowid), raceId: race.raceId, userId, dragonId: entry.dragonId, amount: stake };
        })();
        return { ok: true, message: `🪙${stake.toLocaleString()} on **${entry.name}**. Good luck.`, bet };
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

/* ---- Simulation ---------------------------------------------------------- */

/*
 * Terrain affinity: a specialist trait that matches the track gets the full
 * bonus, a neutral trait gets its flat bonus, and a mismatched specialist gets
 * nothing extra (but is never penalised).
 */
function traitTerrainBonus(trait, trait2, terrain) {
    let bonus = 0;
    for (const id of [trait, trait2]) {
        const affinity = TRAIT_AFFINITY[id];
        if (!affinity) continue;
        if (affinity.terrain === '*') bonus += affinity.bonus;
        else if (affinity.terrain === terrain) bonus += affinity.bonus;
    }
    return bonus;
}

function pick(array, rng = Math.random) {
    return array[Math.floor(rng() * array.length)];
}

function simulateRace(raceId, rng = Math.random) {
    const race = getRace(raceId);
    if (!race) return null;

    const payload = readPayload(race);
    const track = getTrack(race.trackId);
    const entries = payload.entries;

    if (entries.length === 0) {
        return { log: ['🌫️ The starting gate swings open onto an empty track. Nobody entered.'], standings: [], winnerDragonId: null, track };
    }

    const startLog = [
        `🏁 **${track.name}** ${track.emoji} — ${entries.length} runner${entries.length === 1 ? '' : 's'} on the line.`,
        `${track.description}`
    ];

    if (entries.length === 1) {
        const solo = entries[0];
        const time = Number((track.length * 0.9).toFixed(2));
        return {
            log: [
                ...startLog,
                `🦴 ${solo.name} runs the whole circuit alone and crosses the line to polite applause.`,
                `👑 **${solo.name}** wins by default — a win is a win.`
            ],
            standings: [{ dragonId: solo.dragonId, userId: solo.userId, name: solo.name, side: solo.side, time, position: 1 }],
            winnerDragonId: solo.dragonId,
            track
        };
    }

    // Each runner accumulates progress; the first past `track.length` wins and
    // everyone keeps rolling until they finish (or the tick cap is hit).
    const runners = entries.map(entry => ({
        ...entry,
        affinity: traitTerrainBonus(entry.trait, entry.trait2, track.terrain),
        lane: entry.position || 0
    }));

    const tickLimit = track.length * 12;
    let tick = 0;
    const finished = [];

    while (finished.length < runners.length && tick < tickLimit) {
        tick += 1;
        for (const runner of runners) {
            if (runner.finished) continue;
            const pace =
                1
                + runner.speed / 22
                + runner.level * 0.045
                + runner.bond / 220
                + runner.affinity
                + runner.power / 90;
            const surge = 0.45 + rng() * 1.15;
            runner.progress += pace * surge;
            if (runner.progress >= track.length && !runner.finished) {
                runner.finished = true;
                runner.finishTick = tick;
                // Sub-tick precision keeps photo finishes from all tying.
                runner.time = Number((tick * 1.15 + rng()).toFixed(2));
                finished.push(runner);
            }
        }
    }

    // Anyone the tick cap stranded still finishes, stragglers in order.
    for (const runner of runners) {
        if (!runner.finished) {
            tick += 1;
            runner.finished = true;
            runner.time = Number((tick * 1.15 + rng()).toFixed(2));
            finished.push(runner);
        }
    }

    const standings = finished.map((runner, index) => ({
        dragonId: runner.dragonId,
        userId: runner.userId,
        name: runner.name,
        side: runner.side,
        time: runner.time,
        position: index + 1
    }));

    const winner = standings[0];
    const runnerUp = standings[1];
    const hasBothSides = standings.some(entry => entry.side === 'good') && standings.some(entry => entry.side === 'evil');
    const rivalLine = hasBothSides
        ? pick([
            '⚔️ Dragonflight and Onslaught traded the lead all race — the rivalry is very much alive.',
            '⚔️ A beast ran shoulder-to-shoulder with a dragon the entire final stretch.',
            '⚔️ Two sides, one track, and absolutely no love lost.'
        ], rng)
        : '🕊️ A peaceful field today — no cross-side drama.';

    const gap = runnerUp ? Number((runnerUp.time - winner.time).toFixed(2)) : null;
    const finishLine = gap !== null && gap <= 0.35
        ? `📸 **PHOTO FINISH!** ${winner.name} edges out ${runnerUp.name} by ${gap.toFixed(2)}s.`
        : `👑 **${winner.name}** takes it${gap !== null ? ` by ${gap.toFixed(2)}s over ${runnerUp.name}` : ''}.`;

    const log = [
        ...startLog,
        pick([
            `💨 They break fast — ${pick(standings.slice(0, 3), rng).name} leads the early split.`,
            `💨 ${pick(standings.slice(0, 3), rng).name} punches to the front immediately.`
        ], rng),
        runnerUp ? `🔄 ${runnerUp.name} takes it wide and closes the gap.` : '🔄 The field strings out early.',
        hasBothSides ? '🔥 The Onslaught contingent is roaring from the rail.' : '📣 The crowd is on its feet.',
        `🏁 Final stretch — ${winner.name} and ${runnerUp ? runnerUp.name : 'nobody'} ${gap !== null && gap <= 1 ? 'neck and neck' : 'spread wide'}.`,
        finishLine,
        rivalLine
    ];

    return { log, standings, winnerDragonId: winner.dragonId, track };
}

/* ---- Settlement ---------------------------------------------------------- */

function settleRace(raceId, rng = Math.random) {
    const race = getRace(raceId);
    if (!race) return null;
    if (race.status !== 'open') return null;

    const payload = readPayload(race);
    const simulation = simulateRace(race.raceId, rng);
    if (!simulation) return null;

    const winner = simulation.standings[0] || null;
    const pot = Number(race.pot) || 0;
    const bets = db.prepare('SELECT * FROM dragon_race_bets WHERE raceId = ? AND settled = 0').all(race.raceId);

    const studFee = winner ? Math.floor(pot * STUD_FEE_RATE) : 0;
    const betPool = Math.max(0, pot - studFee);

    /*
     * Bettors who backed the champion get stake × 2. If the champion carried
     * more than half the pot that would pay out more than the pool holds, so
     * the winners' total is capped at the pool and scaled pro-rata — the bet
     * still always pays at least the stake back.
     */
    const winningBets = winner ? bets.filter(bet => Number(bet.dragonId) === Number(winner.dragonId)) : [];
    const winningStake = winningBets.reduce((sum, bet) => sum + Number(bet.amount), 0);
    const idealPayout = winningStake * WIN_MULTIPLIER;
    const scale = idealPayout > betPool && betPool > 0 ? betPool / idealPayout : 1;

    let championPayout = 0;
    const betPayouts = [];

    db.transaction(() => {
        // Update the stored entries + log for the record.
        writePayload(race.raceId, payload.entries.map(entry => {
            const standing = simulation.standings.find(item => item.dragonId === entry.dragonId);
            return { ...entry, position: standing ? standing.position : 0, time: standing ? standing.time : null };
        }), simulation.log);

        db.prepare(`
            UPDATE dragon_races
            SET status = 'settled', winnerDragonId = ?, settledAt = ?, pot = ?
            WHERE raceId = ?
        `).run(winner ? winner.dragonId : null, Date.now(), pot, race.raceId);

        // Per-dragon race records + the dragon's own win/loss tally.
        for (const standing of simulation.standings) {
            const won = winner && standing.dragonId === winner.dragonId ? 1 : 0;
            db.prepare(`
                INSERT INTO dragon_race_records (dragonId, races, wins, bestTime, earnings)
                VALUES (?, 1, ?, ?, 0)
                ON CONFLICT(dragonId) DO UPDATE SET
                    races = races + 1,
                    wins = wins + excluded.wins,
                    bestTime = CASE
                        WHEN bestTime IS NULL THEN excluded.bestTime
                        WHEN excluded.bestTime IS NULL THEN bestTime
                        ELSE MIN(bestTime, excluded.bestTime)
                    END
            `).run(standing.dragonId, won, Number.isFinite(standing.time) ? standing.time : null);
            if (hasDragonWinColumns()) {
                db.prepare('UPDATE dragons SET wins = COALESCE(wins, 0) + ?, losses = COALESCE(losses, 0) + ? WHERE dragonId = ?')
                    .run(won, won ? 0 : 1, standing.dragonId);
            }
        }

        // Pay the champion's owner the stud fee.
        if (winner && studFee > 0) {
            db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(winner.userId);
            db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(studFee, winner.userId);
            db.prepare('UPDATE dragon_race_records SET earnings = earnings + ? WHERE dragonId = ?')
                .run(studFee, winner.dragonId);
            logTransaction(winner.userId, 'race_stud_fee', studFee, `Dragon race stud fee — ${winner.name} won race #${race.raceId}`);
            championPayout = studFee;
        }

        // Settle every bet.
        for (const bet of bets) {
            const isWinner = winner && Number(bet.dragonId) === Number(winner.dragonId);
            const payout = isWinner
                ? Math.max(Number(bet.amount), Math.floor(Number(bet.amount) * WIN_MULTIPLIER * scale))
                : 0;
            db.prepare('UPDATE dragon_race_bets SET payout = ?, settled = 1 WHERE betId = ?')
                .run(payout, bet.betId);
            if (payout > 0) {
                db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(bet.userId);
                db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(payout, bet.userId);
                logTransaction(bet.userId, 'race_payout', payout, `Dragon race payout — race #${race.raceId}`);
            }
            betPayouts.push({ userId: bet.userId, amount: Number(bet.amount), payout });
        }
    })();

    return {
        raceId: race.raceId,
        trackId: race.trackId,
        track: simulation.track,
        winner,
        standings: simulation.standings,
        log: simulation.log,
        pot,
        betPayouts,
        championPayout
    };
}

function settleIfDue(now = Date.now()) {
    const race = getCurrentRace(now);
    if (!race) return null;
    if (Number(race.endsAt) > now) return null;
    return settleRace(race.raceId);
}

/* ---- Stats --------------------------------------------------------------- */

function getStats(userId) {
    const row = db.prepare(`
        SELECT
            COALESCE(SUM(r.races), 0)    AS races,
            COALESCE(SUM(r.wins), 0)     AS wins,
            COALESCE(SUM(r.earnings), 0) AS earnings,
            MIN(r.bestTime)              AS bestTime
        FROM dragon_race_records r
        JOIN dragons d ON d.dragonId = r.dragonId
        WHERE d.userId = ?
    `).get(userId);
    return {
        races: Number(row?.races) || 0,
        wins: Number(row?.wins) || 0,
        earnings: Number(row?.earnings) || 0,
        bestTime: row?.bestTime === null || row?.bestTime === undefined ? null : Number(row.bestTime)
    };
}

function getDragonRecord(dragonId) {
    return db.prepare('SELECT * FROM dragon_race_records WHERE dragonId = ?').get(Number(dragonId)) || null;
}

module.exports = {
    BET_MIN,
    BET_MAX,
    MAX_ENTRIES_PER_USER,
    STUD_FEE_RATE,
    WIN_MULTIPLIER,
    RACE_WINDOW_MS,
    TRACKS,
    TRAIT_AFFINITY,
    TERRAIN_MATCH_BONUS,
    NEUTRAL_TRAIT_BONUS,
    weekKey,
    getTrack,
    traitTerrainBonus,
    hasDragonWinColumns,
    openRaceForWeek,
    getRace,
    getCurrentRace,
    getLastSettledRace,
    getRaceHistory,
    getEntrants,
    registerDragon,
    placeBet,
    simulateRace,
    settleRace,
    settleIfDue,
    getStats,
    getDragonRecord
};
