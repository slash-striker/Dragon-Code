const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../database');
const capsules = require('../systems/economy/capsuleDrops');

function insertClaimedCapsule() {
    const now = Date.now();
    const info = db.prepare(`
        INSERT INTO credit_capsules (channelId, amount, status, spawnedAt, endsAt, claimedBy, claimedAt)
        VALUES ('test-capsule-channel', 5000, 'claimed', ?, ?, 'test-claimer', ?)
    `).run(now, now, now);
    return Number(info.lastInsertRowid);
}

function fakeClient(deleted) {
    return {
        channels: {
            fetch: async () => ({
                messages: {
                    fetch: async id => ({ delete: async () => { deleted.push(id); } })
                }
            })
        }
    };
}

test('capsule claim notices: the TTL is fifteen minutes', () => {
    assert.equal(capsules.CLAIM_NOTICE_TTL_MS, 15 * 60 * 1000);
});

test('capsule claim notices: deleted once the TTL has passed, then cleared', async () => {
    const capsuleId = insertClaimedCapsule();
    try {
        capsules.recordClaimNotices(capsuleId, ['111', '222'], Date.now() - 1);
        const deleted = [];
        await capsules.expireClaimNotices(fakeClient(deleted), Date.now());
        assert.deepEqual(deleted.sort(), ['111', '222']);
        const row = db.prepare('SELECT claimNoticeIds, claimDeleteAt FROM credit_capsules WHERE capsuleId = ?').get(capsuleId);
        assert.equal(row.claimNoticeIds, null);
        assert.equal(row.claimDeleteAt, null);
    } finally {
        db.prepare('DELETE FROM credit_capsules WHERE capsuleId = ?').run(capsuleId);
    }
});

test('capsule claim notices: not deleted before the TTL', async () => {
    const capsuleId = insertClaimedCapsule();
    try {
        capsules.recordClaimNotices(capsuleId, ['333'], Date.now() + capsules.CLAIM_NOTICE_TTL_MS);
        const deleted = [];
        await capsules.expireClaimNotices(fakeClient(deleted), Date.now());
        assert.deepEqual(deleted, []);
    } finally {
        db.prepare('DELETE FROM credit_capsules WHERE capsuleId = ?').run(capsuleId);
    }
});
