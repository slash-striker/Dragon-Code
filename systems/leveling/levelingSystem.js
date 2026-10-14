const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let createCanvas;
let loadImage;

function warnCanvasFallback(message) {
    if (process.env.DEBUG_CANVAS === '1' || process.env.DEBUG_CANVAS === 'true') {
        console.warn(message);
    }
}

function normalizeAvatarSource(source) {
    if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
        const tempPath = path.join(os.tmpdir(), `avatar-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
        fs.writeFileSync(tempPath, Buffer.from(source));
        return tempPath;
    }

    if (typeof source === 'string' && source.startsWith('data:image/')) {
        const match = source.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/i);
        if (match) {
            const tempPath = path.join(os.tmpdir(), `avatar-${Date.now()}-${Math.random().toString(16).slice(2)}.${match[1] || 'png'}`);
            fs.writeFileSync(tempPath, Buffer.from(match[2], 'base64'));
            return tempPath;
        }
    }

    return String(source || '');
}

async function safeLoadAvatar(source, label = 'A') {
    const avatarSource = normalizeAvatarSource(source);

    try {
        return await loadImage(avatarSource);
    } catch (error) {
        if (typeof createCanvas !== 'function') {
            return null;
        }

        const fallback = createCanvas(256, 256);
        const context = fallback.getContext('2d');
        const gradient = context.createLinearGradient(0, 0, fallback.width, fallback.height);
        gradient.addColorStop(0, '#0ea5e9');
        gradient.addColorStop(1, '#7c3aed');
        context.fillStyle = gradient;
        context.fillRect(0, 0, fallback.width, fallback.height);

        context.beginPath();
        context.arc(128, 128, 92, 0, Math.PI * 2);
        context.fillStyle = 'rgba(15, 23, 42, 0.45)';
        context.fill();

        context.fillStyle = '#f8fafc';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.font = 'bold 110px sans-serif';
        context.fillText(String(label).slice(0, 1).toUpperCase(), 128, 135);

        return fallback;
    }
}

try {
    ({ createCanvas, loadImage } = require('@napi-rs/canvas'));
} catch (error) {
    warnCanvasFallback('Canvas support unavailable: level-up cards and image rendering will be disabled.');
}

const { AttachmentBuilder } = require('discord.js');

function canvasAvailable() {
    return typeof createCanvas === 'function' && typeof loadImage === 'function';
}

// Leveling Configuration
const LEVELS = {
    0: 0,
    1: 150,
    2: 750,
    3: 1800,
    4: 3500,
    5: 6000,
    6: 9500,
    7: 14000,
    8: 20000,
    9: 28000,
    10: 38000
};

/* Level 10 is the cap — /rank and the level card surface progress toward it. */
const MAX_LEVEL = Math.max(...Object.keys(LEVELS).map(Number));

/*
 * One role per level 1-10. Ordered so higher levels can strip lower-level
 * roles; index 0 is the Level 1 role. A null entry means that level has no
 * role yet (currently Level 9 — awaiting the role ID from the owner).
 */
const LEVEL_ROLE_ORDER = [
    '1504406476796465293', // Level 1
    '1504406534506156173', // Level 2
    '1504406613681770536', // Level 3
    '1504406653204824214', // Level 4
    '1523406315022581872', // Level 5
    '1523406642777948282', // Level 6
    '1523406792535707758', // Level 7
    '1523407458515812462', // Level 8
    '1523407746958098534', // Level 9
    '1504406632962986004'  // Level 10
];
const LEVEL_ROLES = Object.fromEntries(
    LEVEL_ROLE_ORDER.map((roleId, index) => [index + 1, roleId])
);

const LEVEL_ANNOUNCE_CHANNEL = '1504407044164161627';
const SPAM_CHANNEL_ID = '1504365034699096099';

/*
 * Exclusive role for whoever holds the highest level on the server. Exactly
 * one member wears it at a time; when someone else takes the top spot (or ties
 * it and outranks the holder by XP), the role is transferred automatically.
 */
const TOP_LEVELER_ROLE_ID = '1515806294131474625';

// XP tracking maps
const recentMessages = new Map();
const xpBurst = new Map();
const spamChannelCooldowns = new Map();

const cleanupTimers = [];

function startCleanupInterval(callback, delay) {
    const handle = setInterval(callback, delay);
    cleanupTimers.push(handle);
    return handle;
}

function ensureCleanupTimers() {
    if (cleanupTimers.length > 0) {
        return;
    }

    startCleanupInterval(() => {
        const now = Date.now();
        for (const [userId, data] of recentMessages) {
            if (now - data.lastMsgTime > 60 * 1000) {
                recentMessages.delete(userId);
            }
        }
    }, 60 * 1000);

    startCleanupInterval(() => {
        const now = Date.now();
        for (const key of xpBurst.keys()) {
            const timestamp = Number(key.split('_')[1]);
            if (now - timestamp > 60 * 1000) {
                xpBurst.delete(key);
            }
        }
    }, 60 * 1000);

    startCleanupInterval(() => {
        const now = Date.now();
        for (const [userId, lastXPTime] of spamChannelCooldowns) {
            if (now - lastXPTime > 5 * 60 * 1000) {
                spamChannelCooldowns.delete(userId);
            }
        }
    }, 60 * 1000);
}

function toRoman(num) {
    const romans = [
        ["M", 1000], ["CM", 900], ["D", 500], ["CD", 400],
        ["C", 100], ["XC", 90], ["L", 50], ["XL", 40],
        ["X", 10], ["IX", 9], ["V", 5], ["IV", 4], ["I", 1]
    ];

    let result = '';
    for (const [letter, value] of romans) {
        while (num >= value) {
            result += letter;
            num -= value;
        }
    }
    return result || '0';
}

function getLevelFromXP(xp) {
    const sortedLevels = Object.entries(LEVELS)
        .map(([lvl, xp]) => ({ level: Number(lvl), xp }))
        .sort((a, b) => a.xp - b.xp);

    let level = 0;
    for (const l of sortedLevels) {
        if (xp >= l.xp) {
            level = l.level;
        }
    }
    return level;
}

function getLevelProgress(xp, level = getLevelFromXP(xp)) {
    const currentXP = Math.max(0, Number(xp) || 0);
    const previous = LEVELS[level] ?? 0;
    const required = LEVELS[level + 1] ?? previous;
    const span = required - previous;

    return {
        currentXP,
        previous,
        required,
        percent: span > 0
            ? Math.min(1, Math.max(0, (currentXP - previous) / span))
            : 1
    };
}

// Level-up card creation
function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

async function createLevelCard(member, level, xp, prestige = 0) {
    if (!canvasAvailable()) {
        return null;
    }

    const canvas = createCanvas(1000, 420);
    const ctx = canvas.getContext('2d');

    const w = canvas.width;
    const h = canvas.height;

    // Prestige tiers set the accent color of the whole card.
    const accent = prestige >= 5 ? '#ffcc00' : prestige >= 3 ? '#ff00ff' : '#00e5ff';

    // Deep-space backdrop
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#030014');
    bg.addColorStop(0.55, '#060026');
    bg.addColorStop(1, '#010008');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Perspective floor grid
    ctx.strokeStyle = 'rgba(0,229,255,0.10)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 20; i++) {
        const x = (w / 20) * i;
        ctx.beginPath();
        ctx.moveTo(x, h * 0.55);
        ctx.lineTo(w / 2 + (x - w / 2) * 2.6, h);
        ctx.stroke();
    }
    for (let i = 1; i <= 6; i++) {
        const y = h * 0.55 + Math.pow(i / 6, 2.2) * (h * 0.45);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
    }

    // Ambient glow behind the avatar
    const glow = ctx.createRadialGradient(170, 195, 40, 170, 195, 330);
    glow.addColorStop(0, `${accent}22`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // HUD corner brackets
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    const bracket = 26, offset = 16;
    for (const [x, y, dx, dy] of [
        [offset, offset, 1, 1], [w - offset, offset, -1, 1],
        [offset, h - offset, 1, -1], [w - offset, h - offset, -1, -1],
    ]) {
        ctx.beginPath();
        ctx.moveTo(x + dx * bracket, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + dy * bracket);
        ctx.stroke();
    }

    // Avatar with targeting reticle
    const avatarSource = member.user?.displayAvatarURL?.({ extension: 'png', size: 512 }) ?? null;
    const avatar = await safeLoadAvatar(avatarSource, member?.user?.username || 'A');

    const cx = 170;
    const cy = 190;
    const size = 190;

    for (let i = 0; i < 3; i++) {
        const r = size / 2 + 10 + i * 7;
        ctx.beginPath();
        ctx.arc(cx, cy, r, -Math.PI * 0.42, Math.PI * 0.42);
        ctx.strokeStyle = i === 0 ? accent : 'rgba(255,255,255,0.16)';
        ctx.lineWidth = i === 0 ? 3 : 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, r, Math.PI * 0.58, Math.PI * 1.42);
        ctx.stroke();
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(avatar, cx - size / 2, cy - size / 2, size, size);
    ctx.restore();

    for (let i = 0; i < 4; i++) {
        const ang = Math.PI / 4 + i * Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * (size / 2 + 16), cy + Math.sin(ang) * (size / 2 + 16));
        ctx.lineTo(cx + Math.cos(ang) * (size / 2 + 30), cy + Math.sin(ang) * (size / 2 + 30));
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // Identity block under the avatar
    const username = String(member?.user?.username || 'Player').toUpperCase();
    ctx.textAlign = 'center';
    ctx.font = 'bold 26px monospace';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(username.length > 16 ? `${username.slice(0, 15)}…` : username, cx, 330);

    if (prestige > 0) {
        ctx.font = 'bold 16px monospace';
        ctx.fillStyle = '#ffcc00';
        ctx.fillText(`PRESTIGE ${toRoman(prestige)}`, cx, 356);
    }

    // Hex level badge
    const hx = 900, hy = 108, hr = 62;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const ang = Math.PI / 6 + i * Math.PI / 3;
        const px = hx + Math.cos(ang) * hr;
        const py = hy + Math.sin(ang) * hr;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(2,8,20,0.88)';
    ctx.fill();
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 18;
    ctx.stroke();
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.font = 'bold 13px monospace';
    ctx.fillStyle = accent;
    ctx.fillText('LEVEL', hx, hy - 26);
    ctx.font = 'bold 50px monospace';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(level), hx, hy + 24);

    // Rank title
    const rank = level >= MAX_LEVEL
        ? 'APEX PROTOCOL'
        : level < 2 ? 'NOVICE NODE' : level < 4 ? 'SYNCED AGENT' : level < 6 ? 'OVERCLOCKED ENTITY' : 'SYSTEM ANOMALY';

    ctx.textAlign = 'left';
    ctx.font = 'bold 40px monospace';
    ctx.shadowColor = accent;
    ctx.shadowBlur = 22;
    ctx.fillStyle = accent;
    ctx.fillText(rank, 312, 92);
    ctx.shadowBlur = 0;

    ctx.font = 'bold 15px monospace';
    ctx.fillStyle = 'rgba(226,232,240,0.7)';
    ctx.fillText('NEURAL RANK SYNCHRONIZED // NODE DOSSIER', 314, 120);

    // XP bar — rounded, segmented, glowing
    const barX = 330, barY = 190, barW = 570, barH = 22;
    const progress = getLevelProgress(xp, level);
    const { percent } = progress;

    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    roundRectPath(ctx, barX, barY, barW, barH, 11);
    ctx.fill();

    if (percent > 0) {
        const fillW = Math.max(barH, barW * percent);
        ctx.save();
        ctx.shadowColor = accent;
        ctx.shadowBlur = 16;
        const fillGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
        fillGrad.addColorStop(0, accent);
        fillGrad.addColorStop(1, '#ffffff');
        ctx.fillStyle = fillGrad;
        roundRectPath(ctx, barX, barY, fillW, barH, 11);
        ctx.fill();
        ctx.restore();

        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        roundRectPath(ctx, barX + 2, barY + 3, Math.max(8, fillW - 4), (barH / 2) - 4, 7);
        ctx.fill();
    }

    for (let i = 1; i < 10; i++) {
        const tx = barX + (barW / 10) * i;
        ctx.beginPath();
        ctx.moveTo(tx, barY + 3);
        ctx.lineTo(tx, barY + barH - 3);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    // Readout above the bar
    ctx.textAlign = 'left';
    ctx.font = 'bold 15px monospace';
    ctx.fillStyle = 'rgba(226,232,240,0.85)';
    const readout = level >= MAX_LEVEL
        ? `MAX LEVEL ${MAX_LEVEL} — ${xp.toLocaleString()} XP — APEX PROTOCOL`
        : `${xp.toLocaleString()} / ${progress.required.toLocaleString()} XP  →  LVL ${level + 1}  (${Math.round(percent * 100)}%)`;
    ctx.fillText(readout, barX, barY - 14);

    // Stat chips
    const chips = [
        ['TOTAL XP', xp.toLocaleString()],
        ['REMAINING', level >= MAX_LEVEL ? '—' : Math.max(0, progress.required - xp).toLocaleString()],
        ['PROGRESS', `${Math.round(percent * 100)}%`],
        ['PRESTIGE', prestige > 0 ? toRoman(prestige) : '—'],
    ];
    let chipX = barX;
    for (const [label, value] of chips) {
        ctx.fillStyle = 'rgba(0,229,255,0.06)';
        roundRectPath(ctx, chipX, 246, 132, 64, 8);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,229,255,0.22)';
        ctx.lineWidth = 1;
        roundRectPath(ctx, chipX, 246, 132, 64, 8);
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.font = 'bold 12px monospace';
        ctx.fillStyle = accent;
        ctx.fillText(label, chipX + 12, 270);
        ctx.font = 'bold 18px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(value, chipX + 12, 298);
        chipX += 132 + 14;
    }

    // Sparse data-stream noise
    const chars = '01<>#/\\|';
    for (let i = 0; i < 40; i++) {
        ctx.fillStyle = `rgba(0,229,255,${Math.random() * 0.10})`;
        ctx.font = `${10 + Math.random() * 8}px monospace`;
        ctx.fillText(chars[Math.floor(Math.random() * chars.length)], Math.random() * w, Math.random() * h);
    }

    return canvas.toBuffer('image/png');
}

async function sendLevelUpCard(member, level, xp, prestige = 0, client) {
    const channel = member.guild.channels.cache.get(LEVEL_ANNOUNCE_CHANNEL);
    if (!channel) return;

    const cardBuffer = await createLevelCard(member, level, xp, prestige);
    const isApex = level >= MAX_LEVEL;
    const announcement = isApex
        ? `🚨 APEX PROTOCOL ACHIEVED 🚨\n\n${member} has reached **LEVEL ${MAX_LEVEL}** — the final rank. 👑\nGG!`
        : `⚡ SYSTEM ALERT\n\n${member} has advanced to LEVEL ${level}`;

    if (!cardBuffer) {
        const fallbackMsg = await channel.send({ content: announcement });
        if (isApex) {
            await fallbackMsg.react('👑').catch(() => {});
            await fallbackMsg.react('🎉').catch(() => {});
        }
        return;
    }
    
    const msg = await channel.send({
        content: announcement,
        files: [{ attachment: cardBuffer, name: 'level-up.png' }]
    });

    await msg.react('🥳');
    await msg.react('😎');
    await msg.react('🔥');
    if (isApex) {
        await msg.react('👑').catch(() => {});
        await msg.react('🎉').catch(() => {});
    }
}

/*
 * Level roles are EXCLUSIVE: a member wears exactly one — the role matching
 * their highest reached level. Leveling up strips every lower level role
 * before granting the new one, and nothing re-adds stripped roles later
 * (the only paths here are level-ups and /reset xp everyone's full wipe).
 */
async function giveLevelRole(member, level) {
    if (!member.guild.members.me?.permissions.has('ManageRoles')) {
        console.warn('Skipping level role assignment: bot lacks Manage Roles permission.');
        return;
    }

    const meHighest = member.guild.members.me.roles.highest.position;
    const targetRoleId = level >= 1
        ? LEVEL_ROLES[Math.min(level, LEVEL_ROLE_ORDER.length)]
        : null;

    // 1) Strip every other level role the member is still wearing.
    for (const roleId of LEVEL_ROLE_ORDER) {
        if (roleId === targetRoleId || !member.roles.cache.has(roleId)) continue;
        const oldRole = member.guild.roles.cache.get(roleId);
        if (!oldRole) continue;
        if (oldRole.position >= meHighest) {
            console.warn(`Cannot remove level role ${roleId}: above the bot's highest role.`);
            continue;
        }
        try {
            await member.roles.remove(oldRole, 'Level roles are exclusive — replaced by the role for a higher level');
        } catch (error) {
            console.error(`Unable to remove level role ${roleId}:`, error);
        }
    }

    // 2) Grant the single role for the current level (nothing below it).
    if (!targetRoleId) return; // Below level 1 — no level role at all.
    const role = member.guild.roles.cache.get(targetRoleId);
    if (!role) {
        console.warn(`Level role ${targetRoleId} (level ${Math.min(level, LEVEL_ROLE_ORDER.length)}) does not exist.`);
        return;
    }
    if (role.position >= meHighest) {
        console.warn(`Skipping level role ${targetRoleId}: above the bot's highest role.`);
        return;
    }
    try {
        if (!member.roles.cache.has(targetRoleId)) {
            await member.roles.add(role);
        }
    } catch (error) {
        console.error(`Unable to assign level role ${targetRoleId}:`, error);
    }
}

async function checkLevel(member, xp, db, client) {
    const newLevel = getLevelFromXP(xp);
    
    const user = db.prepare("SELECT level, prestigeLevel FROM users WHERE userId = ?").get(member.id);
    const storedLevel = user?.level || 0;
    const prestige = user?.prestigeLevel || 0;
    
    if (newLevel <= storedLevel) return;

    db.prepare("UPDATE users SET level = ? WHERE userId = ?").run(newLevel, member.id);

    await giveLevelRole(member, newLevel);
    await sendLevelUpCard(member, newLevel, xp, prestige, client);
    await ensureTopLevelerRole(member, db).catch(error => {
        console.error('Top-leveler role sync failed:', error);
    });
}

/*
 * Grant the exclusive top-leveler role to `member` if they now hold the
 * highest level (ties broken by XP), stripping it from the previous holder.
 * Called after every level-up so the crown always sits on the right head.
 */
async function ensureTopLevelerRole(member, db) {
    if (!member?.guild) return;
    const guild = member.guild;
    const role = guild.roles.cache.get(TOP_LEVELER_ROLE_ID) ??
        await guild.roles.fetch(TOP_LEVELER_ROLE_ID).catch(() => null);
    if (!role) return;

    const me = guild.members.me;
    if (!me?.permissions.has('ManageRoles') || role.position >= me.roles.highest.position) {
        console.warn('Skipping top-leveler role: bot cannot manage it (permission/position).');
        return;
    }

    // Highest level wins; ties go to higher XP, then to the longer-serving member.
    const rows = db.prepare(`
        SELECT userId, xp, level FROM users
        WHERE length(userId) BETWEEN 17 AND 20 AND userId NOT GLOB '*[^0-9]*'
        ORDER BY level DESC, xp DESC LIMIT 5
    `).all();
    const top = rows[0];
    if (!top || top.userId !== member.id) return;

    // Fetch the full member list so the role is stripped from *every* other
    // holder (role.members alone can be a partial cache).
    const members = await guild.members.fetch().catch(() => null);
    const currentHolders = members
        ? [...members.values()].filter(m => m.roles.cache.has(TOP_LEVELER_ROLE_ID))
        : [];

    for (const holder of currentHolders) {
        if (holder.id === member.id) continue;
        try {
            await holder.roles.remove(role, 'Lost the #1 level spot to a higher-level member');
        } catch (error) {
            console.error(`Unable to strip top-leveler role from ${holder.id}:`, error.message);
        }
    }

    if (!member.roles.cache.has(TOP_LEVELER_ROLE_ID)) {
        try {
            await member.roles.add(role, 'Reached the highest level on the server');
            const channel = guild.channels.cache.get(LEVEL_ANNOUNCE_CHANNEL) ??
                await guild.channels.fetch(LEVEL_ANNOUNCE_CHANNEL).catch(() => null);
            if (channel?.isTextBased()) {
                await channel.send({
                    content: `👑 **APEX NODE DETECTED** — ${member} now holds the highest level on the server and takes the <@&${TOP_LEVELER_ROLE_ID}>.`
                }).catch(() => {});
            }
        } catch (error) {
            console.error(`Unable to grant top-leveler role to ${member.id}:`, error);
        }
    }
}

async function handleXP(message, db, client) {
    ensureCleanupTimers();

    const userId = message.author.id;
    const now = Date.now();

    // Check for spam channel cooldown (3 minutes)
    if (message.channelId === SPAM_CHANNEL_ID) {
        const lastXPTime = spamChannelCooldowns.get(userId);
        if (lastXPTime && now - lastXPTime < 3 * 60 * 1000) {
            return; // Skip XP gain if within 3-minute cooldown in spam channel
        }
    }

    const last = recentMessages.get(userId);
    if (last) {
        const timeDiff = now - last.lastMsgTime;
        if (timeDiff < 8000) return; // 8 second cooldown between messages
        if (last.lastContent === message.content) return; // No duplicate messages
    }

    const minuteKey = `${userId}_${Math.floor(now / 60000)}`;
    const burst = xpBurst.get(minuteKey) || 0;
    if (burst >= 5) return; // Max 5 messages per minute for XP

    xpBurst.set(minuteKey, burst + 1);
    recentMessages.set(userId, {
        lastMsgTime: now,
        lastContent: message.content
    });

    // Update spam channel cooldown if in spam channel
    if (message.channelId === SPAM_CHANNEL_ID) {
        spamChannelCooldowns.set(userId, now);
    }

    // Ensure user exists in database
    const existingUser = db.prepare("SELECT xp FROM users WHERE userId = ?").get(userId);
    if (!existingUser) {
        db.prepare("INSERT INTO users (userId, xp, level, totalMessageCount) VALUES (?, 10, 0, 1)").run(userId);
    }

    const user = db.prepare("SELECT xp FROM users WHERE userId = ?").get(userId);
    const currentXP = user?.xp || 0;

    /*
     * Boost priority: an active timed boost ROLE (from shop purchases) always
     * wins and never consumes inventory. Otherwise fall back to legacy
     * inventory charges, which burn one per XP-earning message.
     */
    const { getActiveBoost } = require('../economy/timedRoles');
    const activeRoleBoost = getActiveBoost(userId);
    let multiplier = activeRoleBoost?.multiplier ?? 1;
    if (!activeRoleBoost) {
        const { getItemQuantity } = require('../economy/shopItems');
        const { removeItem } = require('../economy/inventoryh');
        if (getItemQuantity(userId, 'mega_xp_boost', db) > 0) {
            multiplier = 3;
            removeItem(userId, 'mega_xp_boost', 1, db);
        } else if (getItemQuantity(userId, 'xp_boost', db) > 0) {
            multiplier = 2;
            removeItem(userId, 'xp_boost', 1, db);
        }
    }
    const baseXP = Math.floor(Math.random() * 6) + 3; // Random XP between 3-8
    const gainedXP = baseXP * multiplier;
    const newXP = currentXP + gainedXP;

    db.prepare("UPDATE users SET xp = ?, totalMessageCount = totalMessageCount + 1, lastSeenAt = ? WHERE userId = ?")
        .run(newXP, new Date().toISOString(), userId);

    await checkLevel(message.member, newXP, db, client);
}

function stopCleanupTimers() {
    for (const handle of cleanupTimers) {
        clearInterval(handle);
    }
    cleanupTimers.length = 0;
}

module.exports = {
    LEVELS,
    MAX_LEVEL,
    LEVEL_ROLES,
    LEVEL_ROLE_ORDER,
    LEVEL_ANNOUNCE_CHANNEL,
    SPAM_CHANNEL_ID,
    TOP_LEVELER_ROLE_ID,
    getLevelFromXP,
    getLevelProgress,
    createLevelCard,
    sendLevelUpCard,
    giveLevelRole,
    checkLevel,
    ensureTopLevelerRole,
    handleXP,
    toRoman,
    stopCleanupTimers
};
