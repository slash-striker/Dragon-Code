/*
 * Admin-command visibility & admin configuration — the single source of
 * truth for "who is staff" in the bot. Every command that needs an admin
 * check uses this module instead of keeping its own role list.
 *
 * Discord-side: DefaultMemberPermissions(Administrator) makes the command
 * INVISIBLE to members without Administrator (server admins can still
 * re-share it via role/permission overrides). Runtime: isAdminUser() keeps
 * the in-code staff check so nothing changes for who can actually RUN it.
 *
 * Configuration is DB-backed (bot_meta) so staff can retune it live from
 * /dragon-admin config admin-roles and /dragon-admin config admin-log —
 * no restart needed. The DEFAULT_* lists below apply until a value is
 * stored in the database.
 *
 * Two role sets (both editable at runtime):
 *   admin — who can RUN the admin commands (/admin, /reset, /edit, …).
 *   audit — whose command usage is written to the admin-audit log.
 *           Defaults to the admin set plus the "Admin" role, so that role
 *           keeps audit coverage without destructive command access.
 *
 * Visible to: SLASH (bot owner, 1466461677783351447 — guaranteed through the
 * Administrator bypass) and the configured admin roles whose server roles
 * carry Administrator. Everyone else: the commands vanish from their slash
 * list entirely.
 */
const { PermissionFlagsBits } = require('discord.js');
const db = require('../../database');

const SLASH_USER_ID = '1466461677783351447';

const DEFAULT_ADMIN_ROLE_IDS = [
    '1523376328144060597', // President
    '1527531274007220326', // Vice-president
    '1504365030877954160', // Head of staff
    '1504365030877954162'  // Owner
];

const DEFAULT_AUDIT_ROLE_IDS = [
    ...DEFAULT_ADMIN_ROLE_IDS,
    '1520626392507879455'  // Admin — audit coverage only, not command access
];

const META_KEYS = {
    admin: 'admin:roles',
    audit: 'admin:audit-roles',
    log: 'admin:log-enabled'
};

const DEFAULTS = { admin: DEFAULT_ADMIN_ROLE_IDS, audit: DEFAULT_AUDIT_ROLE_IDS };
const cache = { admin: null, audit: null, log: null };

function metaGet(key) {
    try {
        return db.prepare('SELECT value FROM bot_meta WHERE key = ?').get(key)?.value ?? null;
    } catch {
        return null;
    }
}

function metaSet(key, value) {
    db.prepare(`
        INSERT INTO bot_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
}

function readRoleList(kind) {
    const raw = metaGet(META_KEYS[kind]);
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
        } catch {
            // Corrupt row — fall through to the defaults.
        }
    }
    return [...DEFAULTS[kind]];
}

// ---- role-set accessors (cached; the cache is invalidated on write) ----

function getAdminRoleIds() {
    if (!cache.admin) cache.admin = readRoleList('admin');
    return cache.admin;
}

function getAuditRoleIds() {
    if (!cache.audit) cache.audit = readRoleList('audit');
    return cache.audit;
}

function setAdminRoleIds(ids) {
    cache.admin = [...new Set(ids.map(String).filter(Boolean))];
    metaSet(META_KEYS.admin, JSON.stringify(cache.admin));
    return cache.admin;
}

function setAuditRoleIds(ids) {
    cache.audit = [...new Set(ids.map(String).filter(Boolean))];
    metaSet(META_KEYS.audit, JSON.stringify(cache.audit));
    return cache.audit;
}

// ---- admin-audit log toggle (global on/off) ----

function isAdminLogEnabled() {
    if (cache.log === null) cache.log = metaGet(META_KEYS.log) !== 'off';
    return cache.log;
}

function setAdminLogEnabled(enabled) {
    cache.log = Boolean(enabled);
    metaSet(META_KEYS.log, cache.log ? 'on' : 'off');
    return cache.log;
}

// ---- checks ----

function hasAnyRole(member, roleIds) {
    return Boolean(
        member?.roles?.cache &&
        [...member.roles.cache.keys()].some(roleId => roleIds.includes(roleId))
    );
}

// Runtime gate — keep on every hidden command so non-admin use is still
// rejected even if a server admin re-shares the command via overrides.
function isAdminUser(interaction) {
    if (interaction.user?.id === SLASH_USER_ID) return true;
    if (interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    return hasAnyRole(interaction.member, getAdminRoleIds());
}

// Audit coverage — used by index.js to decide whose command usage is
// written to the admin-audit log channel.
function isAuditUser(interaction) {
    if (interaction.user?.id === SLASH_USER_ID) return true;
    return hasAnyRole(interaction.member, getAuditRoleIds());
}

// Builder helper — chain onto any SlashCommandBuilder to hide the command
// from members without Administrator (SLASH keeps access via the owner bypass).
function hideFromMembers(builder) {
    return builder.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
}

module.exports = {
    isAdminUser,
    isAuditUser,
    hideFromMembers,
    getAdminRoleIds,
    getAuditRoleIds,
    setAdminRoleIds,
    setAuditRoleIds,
    isAdminLogEnabled,
    setAdminLogEnabled,
    SLASH_USER_ID,
    DEFAULT_ADMIN_ROLE_IDS,
    DEFAULT_AUDIT_ROLE_IDS,
    // Legacy alias (defaults snapshot) — kept for older imports.
    ADMIN_ROLE_IDS: new Set(DEFAULT_ADMIN_ROLE_IDS)
};
