const { EmbedBuilder } = require('discord.js');
const db = require('../../database');

/*
 * Timed role grants — currently the XP / Mega XP Boost roles.
 *
 * Buying (or receiving) an xp_boost grants the XP Boost role for 3 days;
 * mega_xp_boost grants the Mega XP Boost role for 7 days with a bigger
 * multiplier. Durations stack: buying again extends the expiry. While the
 * role is active the holder earns boosted XP even after their inventory
 * charges run out; when the role expires it is removed automatically and an
 * announcement is posted in the economy channel.
 */

const BOOST_ROLES = {
    xp_boost: {
        itemId: 'xp_boost',
        roleId: '1549289525065420831',
        label: 'XP Boost',
        emoji: '⬆️',
        color: 0x00d4ff,
        durationMs: 3 * 24 * 60 * 60 * 1000,
        multiplier: 2
    },
    mega_xp_boost: {
        itemId: 'mega_xp_boost',
        roleId: '1550743714333204510',
        label: 'Mega XP Boost',
        emoji: '🚀',
        color: 0xff38d1,
        durationMs: 7 * 24 * 60 * 60 * 1000,
        multiplier: 3
    }
};

const EXPIRY_ANNOUNCE_CHANNEL = '1504562791967756448';
const ROLE_BY_ID = Object.fromEntries(Object.values(BOOST_ROLES).map(cfg => [cfg.roleId, cfg]));

let ticker = null;

function getExpiry(userId, roleId) {
    const row = db.prepare(
        'SELECT expiresAt FROM timed_roles WHERE userId = ? AND roleId = ?'
    ).get(userId, roleId);
    return row?.expiresAt ?? null;
}

/*
 * Grant (or extend) a timed boost role. Returns the new expiry timestamp.
 * Extends from the current expiry when one is already running, so repeated
 * purchases stack instead of resetting.
 */
function grantTimedRole(userId, itemId) {
    const cfg = BOOST_ROLES[itemId];
    if (!cfg) return null;
    const now = Date.now();
    const current = getExpiry(userId, cfg.roleId);
    const base = current && current > now ? current : now;
    const expiresAt = base + cfg.durationMs;
    db.prepare(`
        INSERT INTO timed_roles (userId, roleId, expiresAt, source)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(userId, roleId) DO UPDATE SET expiresAt = excluded.expiresAt
    `).run(userId, cfg.roleId, expiresAt, itemId);
    return expiresAt;
}

function grantBoostFromPurchase(userId, itemId, quantity = 1) {
    const cfg = BOOST_ROLES[itemId];
    if (!cfg) return null;
    let expiresAt = null;
    for (let i = 0; i < Math.max(1, quantity); i++) {
        expiresAt = grantTimedRole(userId, itemId);
    }
    return expiresAt;
}

function getActiveBoost(userId) {
    const now = Date.now();
    const mega = ROLE_BY_ID[BOOST_ROLES.mega_xp_boost.roleId];
    const normal = ROLE_BY_ID[BOOST_ROLES.xp_boost.roleId];
    const megaExpiry = getExpiry(userId, mega.roleId);
    if (megaExpiry && megaExpiry > now) return { ...mega, expiresAt: megaExpiry };
    const normalExpiry = getExpiry(userId, normal.roleId);
    if (normalExpiry && normalExpiry > now) return { ...normal, expiresAt: normalExpiry };
    return null;
}

function formatDuration(ms) {
    const days = Math.floor(ms / 86_400_000);
    const hours = Math.floor((ms % 86_400_000) / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

/*
 * Periodic sweep: remove expired boost roles from members and announce each
 * expiry in the economy channel. Runs once a minute while the bot is up, plus
 * once at startup so offline expiries are caught on boot.
 */
/*
 * Boot-time reconciliation: re-grant roles to anyone whose timed grant is
 * still active (survives restarts) and strip roles from anyone holding one
 * without an active grant (e.g. role added manually).
 */
async function syncBoostRoles(client) {
    try {
        const now = Date.now();
        const active = db.prepare('SELECT * FROM timed_roles WHERE expiresAt > ?').all(now);
        for (const row of active) {
            for (const guild of client.guilds.cache.values()) {
                const member = await guild.members.fetch(row.userId).catch(() => null);
                if (member && !member.roles.cache.has(row.roleId)) {
                    await member.roles.add(row.roleId, 'Boost role re-synced on boot').catch(() => {});
                }
                break;
            }
        }
        for (const cfg of Object.values(BOOST_ROLES)) {
            for (const guild of client.guilds.cache.values()) {
                const role = guild.roles.cache.get(cfg.roleId) ??
                    await guild.roles.fetch(cfg.roleId).catch(() => null);
                if (!role) continue;
                const members = await guild.members.fetch().catch(() => null);
                if (!members) continue;
                for (const member of members.values()) {
                    if (member.roles.cache.has(cfg.roleId) && !getExpiry(member.id, cfg.roleId)) {
                        await member.roles.remove(cfg.roleId, 'No active boost grant').catch(() => {});
                    }
                }
                break;
            }
        }
    } catch (error) {
        console.error('boost role sync error:', error);
    }
}

function startTimedRoleTicker(client) {
    const sweep = async () => {
        try {
            const expired = db.prepare(
                'SELECT * FROM timed_roles WHERE expiresAt <= ?'
            ).all(Date.now());
            for (const row of expired) {
                db.prepare('DELETE FROM timed_roles WHERE userId = ? AND roleId = ?')
                    .run(row.userId, row.roleId);
                const cfg = ROLE_BY_ID[row.roleId];
                if (!cfg) continue;
                for (const guild of client.guilds.cache.values()) {
                    const member = await guild.members.fetch(row.userId).catch(() => null);
                    if (!member || !member.roles.cache.has(row.roleId)) continue;
                    await member.roles.remove(row.roleId, 'Boost expired').catch(() => {});
                    const channel = await client.channels.fetch(EXPIRY_ANNOUNCE_CHANNEL).catch(() => null);
                    if (channel?.isTextBased()) {
                        const embed = new EmbedBuilder()
                            .setColor(cfg.color)
                            .setTitle(`${cfg.emoji} ${cfg.label.toUpperCase()} EXPIRED`)
                            .setDescription(
                                `> \`OPERATIVE\` ...... <@${row.userId}>\n` +
                                `> \`BOOST\` ......... \`${cfg.label}\`\n` +
                                `> \`STATUS\` ........ \`⚠️ OFFLINE\`\n\n` +
                                `The ${cfg.label} boost has run out. Grab another from the shop to get back up to **${cfg.multiplier}x XP**.`)
                            .setFooter({ text: "SLASH's YT SERVER · boost telemetry" })
                            .setTimestamp();
                        await channel.send({ embeds: [embed] }).catch(() => {});
                    }
                    break; // user is only in one relevant guild
                }
            }
        } catch (error) {
            console.error('timed-role sweep error:', error);
        }
    };

    if (ticker) clearInterval(ticker);
    syncBoostRoles(client).then(() => sweep());
    ticker = setInterval(sweep, 60 * 1000);
    if (ticker.unref) ticker.unref();
    return ticker;
}

module.exports = {
    BOOST_ROLES,
    EXPIRY_ANNOUNCE_CHANNEL,
    getExpiry,
    grantTimedRole,
    grantBoostFromPurchase,
    getActiveBoost,
    formatDuration,
    syncBoostRoles,
    startTimedRoleTicker
};
