const crypto = require('crypto');
const db = require('../../database');
const { getUser, updateUser } = require('../economy/userManager');

const GAME_CHANNELS = {
    blackjack: '1527148726634942614'
};
const HEAD_STAFF_ROLE_ID = '1504365030877954160';

function getMaxBet(game) {
    const row = db.prepare('SELECT value FROM casino_settings WHERE key = ?')
        .get(`${game}_max_bet`);
    return Number(row?.value || 10000000000000);
}

function setMaxBet(game, amount) {
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Max bet must be a positive whole number.');
    db.prepare(`INSERT INTO casino_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(`${game}_max_bet`, String(amount));
}

function isCasinoAdmin(interaction) {
    return interaction.user.id === interaction.guild?.ownerId ||
        interaction.member?.roles?.cache?.has(HEAD_STAFF_ROLE_ID);
}

function hasAcknowledged(userId) {
    return Boolean(db.prepare('SELECT 1 FROM casino_acknowledgements WHERE userId = ?').get(userId));
}

function acknowledge(userId) {
    db.prepare('INSERT OR REPLACE INTO casino_acknowledgements (userId, acknowledgedAt) VALUES (?, ?)')
        .run(userId, new Date().toISOString());
}
function pauseUser(userId, hours) {
    const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    db.prepare(`INSERT INTO casino_limits (userId, pausedUntil) VALUES (?, ?)
        ON CONFLICT(userId) DO UPDATE SET pausedUntil = excluded.pausedUntil`).run(userId, until);
    return until;
}
function pauseStatus(userId) {
    const row = db.prepare('SELECT pausedUntil FROM casino_limits WHERE userId = ?').get(userId);
    return row?.pausedUntil && new Date(row.pausedUntil).getTime() > Date.now() ? row.pausedUntil : null;
}
function pauseBlackjack(hours) {
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
        throw new Error('Blackjack pause must be between 1 and 720 hours.');
    }
    const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    db.prepare(`INSERT INTO casino_settings (key, value) VALUES ('blackjack_paused_until', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(until);
    return until;
}
function blackjackPauseStatus() {
    const row = db.prepare(`SELECT value FROM casino_settings
        WHERE key = 'blackjack_paused_until'`).get();
    return row?.value && new Date(row.value).getTime() > Date.now() ? row.value : null;
}

function log(userId, game, type, amount, balanceAfter, note = null) {
    db.prepare(`INSERT INTO casino_ledger (userId, game, type, amount, balanceAfter, note, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, game, type, amount, balanceAfter, note, new Date().toISOString());
}

// Blackjack uses wallet holdings only. Winnings and refunds are returned to
// the wallet as well; bank is never touched by a casino round.
const changeWallet = db.transaction((userId, game, amount, type, note) => {
    const user = getUser(userId);
    const wallet = Number(user.wallet || 0);

    if (amount < 0) {
        const wager = Math.abs(amount);
        if (wallet < wager) {
            throw new Error('Insufficient wallet balance.');
        }

        user.wallet = wallet - wager;
    } else {
        user.wallet = wallet + amount;
    }

    const next = Number(user.wallet || 0);
    updateUser(user);
    log(userId, game, type, amount, next, note);
    return next;
});

function debitWallet(userId, game, amount, note) {
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Amount must be a positive whole number.');
    return changeWallet(userId, game, -amount, 'debit', note);
}
function creditWallet(userId, game, amount, type = 'credit', note = null) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Amount must be a non-negative whole number.');
    return changeWallet(userId, game, amount, type, note);
}

function createSession({ userId, game, channelId, payload }) {
    const sessionId = `${game}-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO casino_sessions (sessionId, userId, game, channelId, state, payload, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`).run(sessionId, userId, game, channelId, JSON.stringify(payload), now, now);
    return sessionId;
}
function getActiveSession(userId, game) {
    return db.prepare(`SELECT sessionId FROM casino_sessions
        WHERE userId = ? AND game = ? AND state = 'active'
        ORDER BY createdAt DESC LIMIT 1`).get(userId, game);
}
function updateSession(sessionId, payload, state = 'active') {
    db.prepare('UPDATE casino_sessions SET payload = ?, state = ?, updatedAt = ? WHERE sessionId = ?')
        .run(JSON.stringify(payload), state, new Date().toISOString(), sessionId);
}
function closeSession(sessionId, payload) { updateSession(sessionId, payload, 'closed'); }

module.exports = {
    GAME_CHANNELS, HEAD_STAFF_ROLE_ID, getMaxBet, setMaxBet, isCasinoAdmin,
    hasAcknowledged, acknowledge, debitWallet, creditWallet,
    // Backwards-compatible names for persisted integrations; both operate on wallet.
    debitBank: debitWallet, creditBank: creditWallet, createSession,
    updateSession, closeSession, pauseUser, pauseStatus, pauseBlackjack,
    blackjackPauseStatus, getActiveSession
};
