/*
 * Heist escalation + role gates.
 *
 * The original co-op heist is a 4-slot lobby that never really resolved.
 * This module adds three tiers above it — each needs MORE players AND a
 * specific crew composition (a hacker, a driver, some muscle). A lobby that
 * cannot fill the roles does not quietly succeed: it fails loud and funny.
 *
 * Pure logic + a small persistence helper. `commands/crime.js` owns the UI.
 */
const db = require('../../../database');

const ROLES = {
    hacker: {
        id: 'hacker',
        name: 'Hacker',
        emoji: '🖥️',
        description: 'Cracks cameras, keypads and the vault firmware.'
    },
    driver: {
        id: 'driver',
        name: 'Driver',
        emoji: '🚗',
        description: 'Owns the escape route and the decoy engine noise.'
    },
    muscle: {
        id: 'muscle',
        name: 'Muscle',
        emoji: '💪',
        description: 'Carries the bags and convinces guards to reconsider.'
    }
};

/*
 * Tier ladder. `rolePlan` counts REQUIRED crew per role; `requiredPlayers`
 * is the hard headcount floor (it always includes anyone filling a role).
 */
const TIERS = [
    {
        id: 'standard',
        name: 'Standard Vault Job',
        emoji: '🏦',
        requiredPlayers: 2,
        rolePlan: {},
        basePayout: 40000,
        perPlayerBonus: 12000,
        successChance: 0.78,
        heat: 2,
        risk: 'LOW',
        description: 'Two bodies, one vault, no questions asked.'
    },
    {
        id: 'syndicate',
        name: 'Syndicate Data Heist',
        emoji: '🛰️',
        requiredPlayers: 5,
        rolePlan: { hacker: 1, driver: 1, muscle: 1 },
        basePayout: 160000,
        perPlayerBonus: 38000,
        successChance: 0.72,
        heat: 5,
        risk: 'MEDIUM',
        description: 'Wired in and wheeled up — a real crew takes the datacore.'
    },
    {
        id: 'cartel',
        name: 'Cartel Reserve Crack',
        emoji: '🧨',
        requiredPlayers: 7,
        rolePlan: { hacker: 2, driver: 2, muscle: 2 },
        basePayout: 420000,
        perPlayerBonus: 90000,
        successChance: 0.66,
        heat: 8,
        risk: 'HIGH',
        description: 'Two of everything, or the reserve door eats you.'
    },
    {
        id: 'blacksite',
        name: 'Blacksite Override',
        emoji: '☠️',
        requiredPlayers: 9,
        rolePlan: { hacker: 3, driver: 3, muscle: 3 },
        basePayout: 1100000,
        perPlayerBonus: 240000,
        successChance: 0.6,
        heat: 12,
        risk: 'EXTREME',
        description: 'The grid stops pretending you are not a threat.'
    }
];

const DEFAULT_TIER = TIERS[0];

/* Funny refusals for a lobby that cannot staff the job. */
const FAIL_LINES = [
    'Your hacker showed up with a rubber duck and a library card. The vault is unimpressed.',
    'The getaway driver cannot drive stick. He also cannot drive automatic. He drives vibes.',
    'Your muscle is a golden retriever in a stab vest. Morale is up. Security is not.',
    'Nobody picked hacker. The team is currently brute-forcing a keypad by staring at it.',
    'The driver is on speakerphone, in a different city, describing the route from memory.',
    'You brought one body to a nine-body job. The vault actually laughed.',
    'Your hacker is the guy who says "I know a guy". He does not know a guy.',
    'The muscle brought a chair leg and a lot of confidence.',
    'The crew is complete except for the two people who could actually open the door.',
    'Your driver warmed up the van, then locked the keys inside it.',
    'The hacker needs the password. The password needs the hacker. Nobody has either.',
    'The plan is on a napkin and the napkin is a receipt for three coffees.',
    'Everyone picked muscle. The vault is now being robbed by four very strong spectators.',
    'Your hacker is autocompleting the security prompt. Slowly. Out loud.'
];

/* Second wave of flavour when a properly staffed job still goes sideways. */
const BUST_LINES = [
    'The vault door closed early and the crew is now a very expensive group photo.',
    'The escape van got a flat. On the way in.',
    'Someone sneezed during the silent phase. There is no silent phase anymore.',
    'The datacore copied 99% and then asked for a software update.',
    'The alarm went off because the driver leaned on it. Twice. On purpose, he says.',
    'A guard recognised the muscle from a bake sale and started negotiating.',
    'The hacker typed "exit" and the whole power grid believed him.',
    'The floor plan turned out to be a menu. A good menu. Everyone ordered.'
];

const OPENING_LINES = [
    'Crew threads the service tunnel single file.',
    'Cameras cycle into a soft loop.',
    'The driver holds the van at a quiet idle on the corner.',
    'Keypad firmware gives up in four seconds.',
    'Muscle stacks the bags by the freight lift.',
    'Vault seal releases with a sound like a swallowed swear.',
    'The grid stops logging for eleven beautiful seconds.'
];

const CLOSING_LINES = [
    'The crew walks out at a calm, illegal pace.',
    'Bags hit the van floor. Nobody looks back.',
    'The service tunnel swallows the sound of running.',
    'The engine noise disappears into traffic like it was never there.'
];

function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

/*
 * Deterministic-by-default picker: when no rng is supplied the same lobby
 * always reads the same joke (stable while the embed keeps refreshing).
 */
function makePicker(participants, rng) {
    if (typeof rng === 'function') return () => rng();
    const seedSource = (participants || [])
        .map(entry => String(entry && entry.userId ? entry.userId : entry))
        .sort()
        .join('|');
    let state = hashString(seedSource || 'empty-lobby');
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function pick(lines, rng) {
    if (!lines.length) return null;
    const index = Math.min(lines.length - 1, Math.floor(rng() * lines.length));
    return lines[index];
}

function getTier(id) {
    return TIERS.find(tier => tier.id === id) || DEFAULT_TIER;
}

function listTiers(maxUnlocked = null) {
    const unlockIndex = typeof maxUnlocked === 'number'
        ? maxUnlocked
        : maxUnlocked === null || maxUnlocked === undefined
            ? Infinity
            : TIERS.findIndex(tier => tier.id === maxUnlocked);
    return TIERS.map((tier, index) => ({
        ...tier,
        index,
        locked: index > unlockIndex,
        requiredRoles: Object.entries(tier.rolePlan).map(([roleId, need]) => ({
            ...ROLES[roleId],
            need
        }))
    }));
}

function parseRolePlan(json) {
    if (!json) return {};
    if (typeof json === 'object') return json;
    try {
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const clean = {};
        for (const [key, value] of Object.entries(parsed)) {
            const count = Number(value);
            if (ROLES[key] && Number.isFinite(count) && count > 0) clean[key] = Math.floor(count);
        }
        return clean;
    } catch (error) {
        return {};
    }
}

function encodeRolePlan(plan) {
    return JSON.stringify(parseRolePlan(plan || {}));
}

/*
 * checkComposition — the gate. `participants` is [{ userId, role }].
 * Returns every missing role plus a funny refusal when the job cannot go.
 */
function checkComposition(tierId, participants = [], rng = null) {
    const tier = getTier(tierId);
    const crew = Array.isArray(participants) ? participants : [];
    const rolePlan = tier.rolePlan || {};
    const roller = makePicker(crew, rng);

    const roleCounts = {};
    for (const roleId of Object.keys(ROLES)) roleCounts[roleId] = 0;
    for (const member of crew) {
        const roleId = member && member.role ? String(member.role) : '';
        if (roleId in roleCounts) roleCounts[roleId] += 1;
    }

    const missing = Object.entries(rolePlan)
        .map(([roleId, need]) => ({ role: roleId, need, have: roleCounts[roleId] || 0 }))
        .filter(entry => entry.have < entry.need);

    const reasons = [];
    if (crew.length < tier.requiredPlayers) {
        reasons.push(`needs **${tier.requiredPlayers}** players (crew has **${crew.length}**)`);
    }
    if (missing.length) {
        reasons.push(missing
            .map(entry => `needs ${entry.need - entry.have} more ${ROLES[entry.role].emoji} ${ROLES[entry.role].name.toLowerCase()}`)
            .join(', '));
    }

    const ok = reasons.length === 0;
    return {
        ok,
        tier,
        requiredPlayers: tier.requiredPlayers,
        have: crew.length,
        roleCounts,
        missing,
        reason: ok ? 'Crew is fully staffed — ready to breach.' : `This job ${reasons.join(' and ')}.`,
        funny: ok ? null : pick(FAIL_LINES, roller)
    };
}

/* Rough lobby payout estimate shown before anyone commits. */
function payoutFor(tierId, participants = []) {
    const tier = getTier(tierId);
    const crew = Array.isArray(participants) ? participants.length : 0;
    const overstaffed = Math.max(0, crew - tier.requiredPlayers);
    return Math.floor(tier.basePayout + tier.perPlayerBonus * crew + overstaffed * tier.perPlayerBonus * 0.25);
}

/*
 * resolveHeist — run the job. A composition failure always returns ok:false so
 * the caller renders the refusal; a full crew rolls for success and either
 * takes the payout or eats a flavoured bust.
 */
function resolveHeist({ tierId, participants = [], rng = Math.random } = {}) {
    const tier = getTier(tierId);
    const crew = Array.isArray(participants) ? participants : [];
    const composition = checkComposition(tierId, crew, rng);

    if (!composition.ok) {
        return {
            ok: false,
            success: false,
            tier,
            payout: 0,
            perPlayer: 0,
            funny: composition.funny,
            reason: composition.reason,
            missing: composition.missing,
            log: [
                `${tier.emoji} **${tier.name}** — launch aborted.`,
                composition.reason,
                composition.funny
            ]
        };
    }

    const roller = makePicker([], rng);
    const overstaffed = Math.max(0, crew.length - tier.requiredPlayers);
    const chance = Math.min(0.95, tier.successChance + Math.min(0.08, overstaffed * 0.02));
    const success = roller() < chance;

    const log = [];
    for (let i = 0; i < 5; i += 1) {
        const line = pick(OPENING_LINES, roller);
        if (line && !log.includes(line)) log.push(line);
    }

    if (!success) {
        const bust = pick(BUST_LINES, roller);
        log.push(bust);
        return {
            ok: true,
            success: false,
            tier,
            payout: 0,
            perPlayer: 0,
            chance,
            funny: bust,
            log
        };
    }

    const variance = 1 + (roller() - 0.5) * 0.2;
    const payout = Math.max(1, Math.floor(payoutFor(tierId, crew) * variance));
    const perPlayer = Math.floor(payout / crew.length);
    log.push(pick(CLOSING_LINES, roller));
    log.push(`Payout split ${crew.length} ways → 🪙 **${perPlayer.toLocaleString()}** each.`);

    return {
        ok: true,
        success: true,
        tier,
        payout,
        perPlayer,
        chance,
        funny: null,
        log
    };
}

/* ---- Optional persistence for heist_runs (the caller may use or ignore) --- */
function persistRun(run) {
    if (!run || !run.runId) return false;
    try {
        db.prepare(`
            INSERT INTO heist_runs
                (runId, heistId, tier, target, requiredPlayers, rolePlan, status, outcome, payout, log, startedAt, resolvedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(runId) DO UPDATE SET
                status = excluded.status,
                outcome = excluded.outcome,
                payout = excluded.payout,
                log = excluded.log,
                resolvedAt = excluded.resolvedAt
        `).run(
            run.runId,
            run.heistId || null,
            getTier(run.tier || run.tierId).id,
            run.target || getTier(run.tier || run.tierId).name,
            Number(run.requiredPlayers) || getTier(run.tier || run.tierId).requiredPlayers,
            encodeRolePlan(run.rolePlan || getTier(run.tier || run.tierId).rolePlan),
            run.status || 'lobby',
            run.outcome || null,
            Number(run.payout) || 0,
            JSON.stringify(run.log || []),
            Number(run.startedAt) || Date.now(),
            run.resolvedAt ? Number(run.resolvedAt) : null
        );
        return true;
    } catch (error) {
        console.error('heist run persist failed:', error.message);
        return false;
    }
}

function getRun(runId) {
    try {
        const row = db.prepare('SELECT * FROM heist_runs WHERE runId = ?').get(runId);
        if (!row) return null;
        return {
            ...row,
            rolePlan: parseRolePlan(row.rolePlan),
            log: (() => {
                try {
                    const parsed = JSON.parse(row.log || '[]');
                    return Array.isArray(parsed) ? parsed : [];
                } catch (error) {
                    return [];
                }
            })()
        };
    } catch (error) {
        return null;
    }
}

module.exports = {
    ROLES,
    TIERS,
    DEFAULT_TIER,
    FAIL_LINES,
    BUST_LINES,
    getTier,
    listTiers,
    checkComposition,
    payoutFor,
    resolveHeist,
    parseRolePlan,
    encodeRolePlan,
    persistRun,
    getRun
};
