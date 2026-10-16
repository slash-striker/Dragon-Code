/*
 * Credit capsules — background dopamine drops.
 *
 * Every ~10-30 hours a "credits capsule" is posted into a random allowed
 * channel and the FIRST person to click it claims the whole amount. The
 * economy scheduler polls isCapsuleDue() once a minute and calls
 * spawnCapsule(); index.js routes the `capsule:claim:<id>` button back into
 * claimCapsule(), which is transactional so two simultaneous clicks can never
 * both pay out.
 *
 * Configuration lives in bot_meta so staff can retune it without a restart:
 *   capsule:channels → JSON array of channel ids (see setAllowedChannels)
 *   capsule:min / capsule:max → payout floor and ceiling
 *   capsule:nextAt   → epoch ms of the next scheduled spawn
 */
const db = require('../../database');
const { logTransaction } = require('./transactionLogger');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const MIN_INTERVAL_MS = 10 * 60 * 60 * 1000;
const MAX_INTERVAL_MS = 30 * 60 * 60 * 1000;
const CAPSULE_TTL_MS = 15 * 60 * 1000;
const BUTTON_ID_PREFIX = 'capsule:claim:';

const DEFAULT_CHANNELS = ['1504562791967756448', '1527147135542366409'];
const DEFAULT_MIN = 5000;
const DEFAULT_MAX = 250000;

const META_CHANNELS = 'capsule:channels';
const META_NEXT_AT = 'capsule:nextAt';
const META_MIN = 'capsule:min';
const META_MAX = 'capsule:max';

function metaGet(key) {
    try {
        const row = db.prepare('SELECT value FROM bot_meta WHERE key = ?').get(key);
        return row ? row.value : null;
    } catch {
        return null;
    }
}

function metaSet(key, value) {
    try {
        db.prepare(`INSERT INTO bot_meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
    } catch (error) {
        console.error('Capsule meta write failed:', error.message);
    }
}

function getAllowedChannels() {
    const raw = metaGet(META_CHANNELS);
    if (!raw) return [...DEFAULT_CHANNELS];
    try {
        const parsed = JSON.parse(raw);
        const ids = Array.isArray(parsed) ? parsed.map(id => String(id)).filter(Boolean) : [];
        return ids.length ? ids : [...DEFAULT_CHANNELS];
    } catch {
        return [...DEFAULT_CHANNELS];
    }
}

function setAllowedChannels(ids) {
    const normalized = [...new Set((ids || []).map(id => String(id)).filter(Boolean))];
    metaSet(META_CHANNELS, JSON.stringify(normalized.length ? normalized : DEFAULT_CHANNELS));
    return getAllowedChannels();
}

/* Claim-notice columns were added after credit_capsules first shipped. */
function ensureClaimNoticeColumns() {
    const columns = new Set(db.prepare('PRAGMA table_info(credit_capsules)').all().map(column => column.name));
    if (!columns.has('claimNoticeIds')) db.exec('ALTER TABLE credit_capsules ADD COLUMN claimNoticeIds TEXT');
    if (!columns.has('claimDeleteAt')) db.exec('ALTER TABLE credit_capsules ADD COLUMN claimDeleteAt INTEGER');
}
ensureClaimNoticeColumns();

function minCapsuleValue() {
    const value = Number(metaGet(META_MIN));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MIN;
}

function maxCapsuleValue() {
    const value = Number(metaGet(META_MAX));
    const min = minCapsuleValue();
    return Number.isFinite(value) && value >= min ? Math.floor(value) : Math.max(min, DEFAULT_MAX);
}

function rollAmount() {
    const min = minCapsuleValue();
    const max = maxCapsuleValue();
    // Skew toward the floor: raising the roll to 2.5 makes small capsules far more common.
    const raw = min + Math.floor(Math.pow(Math.random(), 2.5) * (max - min));
    return Math.max(min, Math.round(raw / 500) * 500);
}

/*
 * Interval scheduling. When nothing is stored yet the first drop is a full
 * MIN_INTERVAL away so a fresh database never spawns on boot.
 */
function scheduleNextSpawn(now = Date.now(), rng = Math.random) {
    const span = MAX_INTERVAL_MS - MIN_INTERVAL_MS;
    const delay = MIN_INTERVAL_MS + Math.floor(rng() * span);
    const at = now + delay;
    metaSet(META_NEXT_AT, String(at));
    return at;
}

function getNextSpawnAt(now = Date.now()) {
    const parsed = Number(metaGet(META_NEXT_AT));
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return scheduleNextSpawn(now, () => 0);
    }
    return parsed;
}

function isCapsuleDue(now = Date.now()) {
    return getNextSpawnAt(now) <= now;
}

/*
 * Render card for one capsule row. Rebuilt from the database row so a restart
 * can re-render (or disable) a live capsule's message.
 */
function buildCapsuleCard(capsule) {
    const claimed = capsule.status === 'claimed';
    const expired = capsule.status === 'expired';
    const endsAt = Math.floor(Number(capsule.endsAt) / 1000);

    const description = claimed
        ? `💠 Capsule **#${capsule.capsuleId}** was already cracked open by <@${capsule.claimedBy}>.`
        : expired
            ? `💠 Capsule **#${capsule.capsuleId}** drifted back into the grid unclaimed.`
            : [
                '### A rogue credit capsule just dropped',
                `Somewhere in the grid, **🪙 ${Number(capsule.amount).toLocaleString()}** is sealed inside.`,
                '',
                '**First one to press the button takes the whole payload.**',
                'No cooldown, no level requirement, no mercy.'
            ].join('\n');

    const embed = new EmbedBuilder()
        .setColor(claimed ? 0x57f287 : expired ? 0x555577 : 0x00e5ff)
        .setTitle(claimed ? '💠 CAPSULE CRACKED' : expired ? '💠 CAPSULE LOST' : '💠 CREDIT CAPSULE DETECTED')
        .setDescription(description)
        .setFooter({
            text: claimed || expired
                ? `Capsule #${capsule.capsuleId} • sealed`
                : `Capsule #${capsule.capsuleId} • self-destructs`
        })
        .setTimestamp();

    if (!claimed && !expired) {
        embed.addFields({
            name: '⏳ Self-destruct',
            value: `<t:${endsAt}:R> — claim it before it vanishes.`,
            inline: false
        });
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${BUTTON_ID_PREFIX}${capsule.capsuleId}`)
            .setLabel(claimed ? 'Already claimed' : expired ? 'Expired' : 'CRACK IT OPEN')
            .setEmoji('💠')
            .setStyle(ButtonStyle.Success)
            .setDisabled(claimed || expired)
    );

    return { embed, row };
}

/*
 * Spawn one capsule in a random allowed channel. Unreachable channels are
 * skipped rather than wasting the drop, and the next spawn is always
 * scheduled — even on failure — so the loop can never stall.
 */
async function spawnCapsule(client, { now = Date.now() } = {}) {
    const channels = getAllowedChannels();
    if (!channels.length) {
        scheduleNextSpawn(now);
        return { ok: false, message: 'No capsule channels are configured.' };
    }

    const order = [...channels].sort(() => Math.random() - 0.5);
    for (const channelId of order) {
        try {
            const channel = await client?.channels?.fetch(channelId);
            if (!channel || !channel.isTextBased?.()) continue;

            const amount = rollAmount();
            const endsAt = now + CAPSULE_TTL_MS;
            const info = db.prepare(`
                INSERT INTO credit_capsules (channelId, amount, status, spawnedAt, endsAt)
                VALUES (?, ?, 'live', ?, ?)
            `).run(channelId, amount, now, endsAt);

            const capsule = db.prepare('SELECT * FROM credit_capsules WHERE capsuleId = ?')
                .get(info.lastInsertRowid);
            const { embed, row } = buildCapsuleCard(capsule);
            const message = await channel.send({ embeds: [embed], components: [row] });
            db.prepare('UPDATE credit_capsules SET messageId = ? WHERE capsuleId = ?')
                .run(message.id, capsule.capsuleId);

            scheduleNextSpawn(now);
            return { ok: true, capsuleId: capsule.capsuleId, channelId, messageId: message.id, amount };
        } catch (error) {
            console.error(`Capsule spawn failed in ${channelId}:`, error.message);
        }
    }

    scheduleNextSpawn(now);
    return { ok: false, message: 'No capsule channel was reachable.' };
}

/*
 * First click wins. The whole check-and-pay runs in one transaction so
 * simultaneous clicks resolve to exactly one winner.
 */
function claimCapsule(capsuleId, userId, now = Date.now()) {
    try {
        return db.transaction(() => {
            const capsule = db.prepare('SELECT * FROM credit_capsules WHERE capsuleId = ?').get(capsuleId);
            if (!capsule) return { ok: false, message: 'That capsule no longer exists.' };

            if (capsule.status === 'claimed') {
                return {
                    ok: false,
                    message: capsule.claimedBy === userId
                        ? 'You already cracked this one open.'
                        : 'Someone already cracked it.'
                };
            }
            if (capsule.status !== 'live' || Number(capsule.endsAt) <= now) {
                db.prepare("UPDATE credit_capsules SET status = 'expired' WHERE capsuleId = ? AND status = 'live'")
                    .run(capsuleId);
                return { ok: false, message: 'That capsule already drifted away.' };
            }

            db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(userId);
            db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(capsule.amount, userId);
            db.prepare(`
                UPDATE credit_capsules
                SET status = 'claimed', claimedBy = ?, claimedAt = ?
                WHERE capsuleId = ? AND status = 'live'
            `).run(userId, now, capsuleId);
            logTransaction(userId, 'capsule_claim', capsule.amount, `Claimed credit capsule #${capsuleId}`);

            return { ok: true, amount: capsule.amount, message: `You cracked capsule #${capsuleId}.` };
        })();
    } catch (error) {
        console.error('Capsule claim failed:', error.message);
        return { ok: false, message: 'The capsule rejected your click — try again.' };
    }
}

/* Claim notices ("captured" + "already claimed") are removed 15 minutes after the claim. */
function recordClaimNotices(capsuleId, messageIds, deleteAt) {
    db.prepare('UPDATE credit_capsules SET claimNoticeIds = ?, claimDeleteAt = ? WHERE capsuleId = ?')
        .run(JSON.stringify(messageIds.filter(Boolean)), deleteAt, capsuleId);
}

async function expireClaimNotices(client, now = Date.now()) {
    const due = db.prepare(`
        SELECT capsuleId, channelId, claimNoticeIds FROM credit_capsules
        WHERE claimDeleteAt IS NOT NULL AND claimDeleteAt <= ?
    `).all(now);
    for (const row of due) {
        const ids = JSON.parse(row.claimNoticeIds || '[]');
        let channel = null;
        try {
            channel = await client?.channels?.fetch(row.channelId);
        } catch (error) {
            console.warn(`Could not reach capsule channel for claim notices #${row.capsuleId}:`, error.message);
            continue;
        }
        let failed = false;
        for (const messageId of ids) {
            try {
                const message = await channel?.messages?.fetch(messageId);
                if (message) await message.delete();
            } catch (error) {
                // Already gone is fine; anything else is retried on the next tick.
                if (!(error?.code === 10008 || error?.status === 404)) failed = true;
            }
        }
        if (!failed) {
            db.prepare('UPDATE credit_capsules SET claimNoticeIds = NULL, claimDeleteAt = NULL WHERE capsuleId = ?')
                .run(row.capsuleId);
        }
    }
    return due.length;
}

async function expireCapsules(client, now = Date.now()) {
    await expireClaimNotices(client, now);
    db.prepare("UPDATE credit_capsules SET status = 'expired' WHERE status = 'live' AND endsAt <= ?").run(now);
    const expired = db.prepare(`
        SELECT capsuleId, channelId, messageId, status
        FROM credit_capsules
        WHERE endsAt <= ? AND messageId IS NOT NULL
    `).all(now);
    if (!expired.length) return 0;

    // Delete each announcement at the 15-minute TTL, whether claimed or not.
    // A transient channel/message fetch failure leaves the ID in place so the
    // next scheduler tick can retry deletion instead of abandoning the post.
    let deleted = 0;
    for (const capsule of expired) {
        if (!capsule.messageId) continue;
        try {
            const channel = await client?.channels?.fetch(capsule.channelId);
            const message = await channel?.messages?.fetch(capsule.messageId);
            if (message) {
                await message.delete();
                deleted++;
            }
            db.prepare('UPDATE credit_capsules SET messageId = NULL WHERE capsuleId = ?').run(capsule.capsuleId);
        } catch (error) {
            if (error?.code === 10008 || error?.status === 404) {
                db.prepare('UPDATE credit_capsules SET messageId = NULL WHERE capsuleId = ?').run(capsule.capsuleId);
                continue;
            }
            console.warn(`Could not delete expired capsule #${capsule.capsuleId}:`, error.message);
        }
    }
    return deleted;
}

function getActiveCapsules() {
    return db.prepare(`
        SELECT * FROM credit_capsules WHERE status = 'live' ORDER BY spawnedAt DESC
    `).all();
}

module.exports = {
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS,
    CAPSULE_TTL_MS,
    BUTTON_ID_PREFIX,
    DEFAULT_CHANNELS,
    getAllowedChannels,
    setAllowedChannels,
    minCapsuleValue,
    maxCapsuleValue,
    getNextSpawnAt,
    scheduleNextSpawn,
    isCapsuleDue,
    spawnCapsule,
    claimCapsule,
    recordClaimNotices,
    expireClaimNotices,
    expireCapsules,
    CLAIM_NOTICE_TTL_MS: 15 * 60 * 1000,
    getActiveCapsules,
    buildCapsuleCard
};
