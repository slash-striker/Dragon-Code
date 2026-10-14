const db = require('../../../database');

function createHeist({ heistId, leaderId, maxPlayers = 4, difficulty = "standard", tier = "standard", target = 'vault', rolePlan = {} }) {
    db.prepare(`
        INSERT INTO heists (heistId, leaderId, target, difficulty, entryFee, status, maxPlayers, createdAt, tier, rolePlan)
        VALUES (?, ?, ?, ?, 0, 'lobby', ?, ?, ?, ?)
    `).run(
        heistId,
        leaderId,
        target,
        difficulty,
        maxPlayers,
        new Date().toISOString(),
        tier,
        JSON.stringify(rolePlan || {})
    );

    return getHeist(heistId);
}

/* ---------------- ESCALATION TIERS ---------------- */
function setHeistTier(heistId, tier, rolePlan, maxPlayers, target) {
    db.prepare('UPDATE heists SET tier = ?, rolePlan = ?, maxPlayers = ?, target = ? WHERE heistId = ?')
        .run(tier, JSON.stringify(rolePlan || {}), maxPlayers, target, heistId);
}

function setParticipantRole(heistId, userId, role) {
    db.prepare('UPDATE heist_participants SET role = ? WHERE heistId = ? AND userId = ?')
        .run(role, heistId, userId);
}

/* Participants WITH their chosen role — what the tier composition check needs. */
function getParticipantsDetailed(heistId) {
    return db.prepare('SELECT userId, role, contribution FROM heist_participants WHERE heistId = ?')
        .all(heistId)
        .map(row => ({ ...row, role: row.role || null }));
}

function recordResolution(heistId, outcome, payout, log) {
    db.prepare('UPDATE heists SET resolvedAt = ?, payout = ? WHERE heistId = ?')
        .run(new Date().toISOString(), Number(payout) || 0, heistId);
    if (Array.isArray(log)) {
        try {
            db.prepare('UPDATE heists SET log = ? WHERE heistId = ?').run(JSON.stringify(log), heistId);
        } catch (error) {
            /* the log is flavour — never block a payout on it */
        }
    }
    if (outcome) setHeistStatus(heistId, outcome);
}

function findOpenHeist() {
    return db.prepare(`
        SELECT * FROM heists WHERE status = 'lobby' ORDER BY createdAt DESC LIMIT 1
    `).get();
}

function addParticipant(heistId, userId) {
    db.prepare(`
        INSERT OR IGNORE INTO heist_participants (heistId, userId, contribution)
        VALUES (?, ?, 0)
    `).run(heistId, userId);
}

function getParticipants(heistId) {
    return db.prepare(`
        SELECT userId FROM heist_participants WHERE heistId = ?
    `).all(heistId);
}

function getHeist(heistId) {
    return db.prepare(`
        SELECT * FROM heists WHERE heistId = ?
    `).get(heistId);
}

function cancelHeist(heistId) {
    db.prepare(`DELETE FROM heists WHERE heistId = ?`).run(heistId);
    db.prepare(`DELETE FROM heist_participants WHERE heistId = ?`).run(heistId);
}

function setHeistStatus(heistId, status) {
    db.prepare(`
        UPDATE heists SET status = ? WHERE heistId = ?
    `).run(status, heistId);
}

module.exports = {
    createHeist,
    findOpenHeist,
    addParticipant,
    getParticipants,
    getParticipantsDetailed,
    getHeist,
    cancelHeist,
    setHeistStatus,
    setHeistTier,
    setParticipantRole,
    recordResolution
};