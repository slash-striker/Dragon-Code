/*
 * DRAGON HATCHERY — procedural art.
 *
 * Everything is drawn with canvas primitives rather than emoji glyphs, because
 * colour-emoji rendering is unreliable across hosts (a missing emoji font
 * turns a dragon into a tofu box). A stylised sigil reads correctly everywhere
 * and can be animated frame by frame for the hatch sequence.
 *
 * Two entry points matter:
 *   • renderEggFrame()    — one frame of the crack-open animation
 *   • renderDragonCard()  — the final, permanent pet card
 *
 * Both return a discord.js AttachmentBuilder, or null when @napi-rs/canvas is
 * unavailable — callers must fall back to plain text.
 */
const { AttachmentBuilder } = require('discord.js');

let createCanvas = null;
let canvasLoadAttempted = false;

function ensureCanvas() {
    if (!canvasLoadAttempted) {
        canvasLoadAttempted = true;
        try {
            ({ createCanvas } = require('@napi-rs/canvas'));
        } catch (error) {
            createCanvas = null;
        }
    }
    return typeof createCanvas === 'function';
}

const WIDTH = 900;
const HEIGHT = 460;

const SIDE_PALETTE = {
    good: { core: '#8be9ff', edge: '#1d7bff', aura: '#00d4ff', accent: '#c9f7ff' },
    evil: { core: '#ff9aa8', edge: '#c81d4a', aura: '#ff2d6f', accent: '#ffd6de' }
};

function hexToRgba(hex, alpha) {
    const clean = String(hex || '#ffffff').replace('#', '');
    const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
    const num = parseInt(full, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function rarityHex(color) {
    return `#${Number(color || 0x8fa1b3).toString(16).padStart(6, '0')}`;
}

function drawBackdrop(ctx, { aura, glow = 1, shake = 0 }) {
    ctx.fillStyle = '#05060d';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const gradient = ctx.createRadialGradient(WIDTH / 2 + shake, HEIGHT / 2, 30, WIDTH / 2, HEIGHT / 2, WIDTH * 0.72);
    gradient.addColorStop(0, hexToRgba(aura, 0.34 * glow));
    gradient.addColorStop(0.45, hexToRgba(aura, 0.10 * glow));
    gradient.addColorStop(1, 'rgba(5, 6, 13, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Neon grid — the house style used by the rest of the bot's cards.
    ctx.strokeStyle = hexToRgba(aura, 0.09);
    ctx.lineWidth = 1;
    for (let x = 0; x <= WIDTH; x += 45) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, HEIGHT);
        ctx.stroke();
    }
    for (let y = 0; y <= HEIGHT; y += 45) {
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(WIDTH, y + 0.5);
        ctx.stroke();
    }

    ctx.strokeStyle = hexToRgba(aura, 0.55 * glow);
    ctx.lineWidth = 3;
    ctx.strokeRect(14.5, 14.5, WIDTH - 29, HEIGHT - 29);
    ctx.strokeStyle = hexToRgba(aura, 0.22);
    ctx.lineWidth = 1;
    ctx.strokeRect(24.5, 24.5, WIDTH - 49, HEIGHT - 49);
}

function drawBar(ctx, x, y, w, h, pct, color, label, valueText) {
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color;
    const filled = Math.max(0, Math.min(1, pct)) * w;
    if (filled > 0) ctx.fillRect(x, y, filled, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.font = '600 15px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, x, y - 7);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(valueText, x + w, y - 7);
    ctx.textAlign = 'left';
}

/**
 * Stylised dragon/beast head sigil.
 * `open` (0..1) opens the jaw and the eyes for the hatch reveal.
 */
function drawSigil(ctx, cx, cy, size, { side = 'good', aura = '#00d4ff', open = 1, glow = 1 }) {
    const palette = SIDE_PALETTE[side] || SIDE_PALETTE.good;
    const s = size;

    // Aura rings
    for (let i = 3; i >= 1; i -= 1) {
        ctx.beginPath();
        ctx.arc(cx, cy, s * (0.52 + i * 0.13), 0, Math.PI * 2);
        ctx.strokeStyle = hexToRgba(palette.aura, 0.10 * glow * (1 - (i - 1) * 0.22));
        ctx.lineWidth = 2 + i * 3;
        ctx.stroke();
    }

    ctx.save();
    ctx.shadowColor = palette.aura;
    ctx.shadowBlur = 34 * glow;

    // Wings (good) / spikes (evil)
    if (side === 'evil') {
        for (let i = -2; i <= 2; i += 1) {
            if (i === 0) continue;
            ctx.beginPath();
            ctx.moveTo(cx + i * s * 0.16, cy - s * 0.52);
            ctx.lineTo(cx + i * s * 0.30, cy - s * (0.86 + Math.abs(i) * 0.05));
            ctx.lineTo(cx + i * s * 0.34, cy - s * 0.44);
            ctx.closePath();
            ctx.fillStyle = hexToRgba(palette.edge, 0.9);
            ctx.fill();
        }
    } else {
        for (const dir of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(cx + dir * s * 0.18, cy - s * 0.14);
            ctx.quadraticCurveTo(cx + dir * s * 0.86, cy - s * 0.78, cx + dir * s * 0.80, cy - s * 0.02);
            ctx.quadraticCurveTo(cx + dir * s * 0.72, cy + s * 0.30, cx + dir * s * 0.20, cy + s * 0.16);
            ctx.closePath();
            ctx.fillStyle = hexToRgba(palette.edge, 0.72);
            ctx.fill();
            ctx.strokeStyle = hexToRgba(palette.core, 0.6);
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    }

    // Horns
    for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + dir * s * 0.20, cy - s * 0.30);
        ctx.lineTo(cx + dir * s * 0.52, cy - s * 0.92);
        ctx.lineTo(cx + dir * s * 0.10, cy - s * 0.56);
        ctx.closePath();
        ctx.fillStyle = hexToRgba(palette.accent, 0.92);
        ctx.fill();
    }

    // Skull
    ctx.beginPath();
    ctx.ellipse(cx, cy, s * 0.44, s * 0.40, 0, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(palette.edge, 0.95);
    ctx.fill();
    ctx.strokeStyle = palette.core;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Snout
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.26, cy + s * 0.16);
    ctx.quadraticCurveTo(cx, cy + s * 0.72, cx + s * 0.26, cy + s * 0.16);
    ctx.quadraticCurveTo(cx, cy + s * 0.34, cx - s * 0.26, cy + s * 0.16);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(palette.core, 0.55);
    ctx.fill();

    // Jaw gap — widens as `open` rises
    const gap = s * (0.05 + 0.16 * Math.max(0, Math.min(1, open)));
    ctx.fillStyle = '#05060d';
    ctx.fillRect(cx - s * 0.26, cy + s * 0.16, s * 0.52, gap);

    // Fangs
    ctx.fillStyle = '#ffffff';
    for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + dir * s * 0.20, cy + s * 0.16);
        ctx.lineTo(cx + dir * s * 0.14, cy + s * 0.16 + gap + s * 0.10);
        ctx.lineTo(cx + dir * s * 0.08, cy + s * 0.16);
        ctx.closePath();
        ctx.fill();
    }

    // Eyes — glow with `open`
    for (const dir of [-1, 1]) {
        const ex = cx + dir * s * 0.20;
        const ey = cy - s * 0.10;
        ctx.beginPath();
        ctx.arc(ex, ey, s * 0.075, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(palette.accent, 0.35 + 0.65 * glow);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ex, ey, s * 0.030, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
    }

    ctx.restore();
}

function drawEggSigil(ctx, cx, cy, size, { side = 'good', crack = 0, glow = 1, sparks = 0 }) {
    const palette = SIDE_PALETTE[side] || SIDE_PALETTE.good;
    ctx.save();
    ctx.shadowColor = palette.aura;
    ctx.shadowBlur = 40 * glow;

    for (let i = 3; i >= 1; i -= 1) {
        ctx.beginPath();
        ctx.arc(cx, cy, size * (0.62 + i * 0.14), 0, Math.PI * 2);
        ctx.strokeStyle = hexToRgba(palette.aura, 0.09 * glow);
        ctx.lineWidth = 2 + i * 3;
        ctx.stroke();
    }

    // Shell
    ctx.beginPath();
    ctx.ellipse(cx, cy, size * 0.48, size * 0.64, 0, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(palette.edge, 0.42);
    ctx.fill();
    ctx.strokeStyle = palette.core;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Cracks grow with progress
    const cracks = [
        [[-0.30, -0.30], [-0.06, -0.06], [-0.20, 0.10], [0.06, 0.26]],
        [[0.28, -0.36], [0.10, -0.10], [0.26, 0.06], [0.02, 0.30]],
        [[-0.34, 0.20], [-0.08, 0.34], [0.12, 0.16]],
        [[0.34, 0.22], [0.14, 0.40], [-0.04, 0.52]]
    ];
    const visible = Math.round(crack * cracks.length);
    ctx.strokeStyle = hexToRgba(palette.accent, 0.95);
    ctx.lineWidth = 3;
    for (let i = 0; i < visible; i += 1) {
        const path = cracks[i];
        ctx.beginPath();
        path.forEach(([px, py], index) => {
            const x = cx + px * size;
            const y = cy + py * size;
            if (index === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    }

    // Inner glow bleeding through the shell
    const inner = ctx.createRadialGradient(cx, cy, 4, cx, cy, size * 0.55);
    inner.addColorStop(0, hexToRgba(palette.accent, 0.55 * crack * glow));
    inner.addColorStop(1, hexToRgba(palette.accent, 0));
    ctx.fillStyle = inner;
    ctx.beginPath();
    ctx.ellipse(cx, cy, size * 0.46, size * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();

    // Sparks at the end of the sequence
    const count = Math.round(sparks * 14);
    for (let i = 0; i < count; i += 1) {
        const angle = (i / 14) * Math.PI * 2;
        const radius = size * (0.85 + (i % 3) * 0.16);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 3 + (i % 2) * 2, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(palette.accent, 0.35 + 0.5 * sparks);
        ctx.fill();
    }

    ctx.restore();
}

function drawText(ctx, text, x, y, { size = 28, weight = '700', color = '#ffffff', align = 'left', maxWidth = null } = {}) {
    ctx.font = `${weight} ${size}px sans-serif`;
    ctx.textAlign = align;
    ctx.fillStyle = color;
    if (maxWidth) ctx.fillText(String(text), x, y, maxWidth);
    else ctx.fillText(String(text), x, y);
    ctx.textAlign = 'left';
}

// ==================================================
// HATCH ANIMATION
// ==================================================
/*
 * 12 frames of escalating tension. `crack` ramps 0 → 1, `sparks` only fires at
 * the end, and `shake` jitters the whole card so it reads as movement inside a
 * Discord message edit.
 */
const HATCH_FRAMES = [
    { crack: 0.00, glow: 0.35, sparks: 0, shake: 0, caption: 'The egg is still.\n_Too still._' },
    { crack: 0.00, glow: 0.55, sparks: 0, shake: 2, caption: 'Something shifts inside.' },
    { crack: 0.18, glow: 0.70, sparks: 0, shake: 4, caption: 'A hairline crack splits the shell.' },
    { crack: 0.18, glow: 0.85, sparks: 0, shake: 6, caption: 'The shell is *hot* to look at.' },
    { crack: 0.40, glow: 1.00, sparks: 0, shake: 5, caption: 'Light bleeds through the cracks.' },
    { crack: 0.40, glow: 1.10, sparks: 0, shake: 8, caption: 'A sound like a struck bell.' },
    { crack: 0.62, glow: 1.25, sparks: 0, shake: 10, caption: 'The egg lifts an inch off the ground.' },
    { crack: 0.62, glow: 1.40, sparks: 0.15, shake: 12, caption: 'Pressure builds. Everyone nearby steps back.' },
    { crack: 0.85, glow: 1.60, sparks: 0.35, shake: 14, caption: 'The shell is holding on out of politeness.' },
    { crack: 1.00, glow: 1.85, sparks: 0.60, shake: 16, caption: '!!!' },
    { crack: 1.00, glow: 2.20, sparks: 0.85, shake: 8, caption: '░░ SHELL BREACH ░░' },
    { crack: 1.00, glow: 2.60, sparks: 1.00, shake: 0, caption: '✦ IT IS AWAKE ✦' }
];

function renderEggFrame({ eggType, rarityColor, side, frameIndex = 0, owner, progressPct = null }) {
    if (!ensureCanvas()) return null;
    const frame = HATCH_FRAMES[Math.max(0, Math.min(HATCH_FRAMES.length - 1, frameIndex))];
    const palette = SIDE_PALETTE[side === 'evil' ? 'evil' : 'good'];
    const aura = rarityColor ? rarityHex(rarityColor) : palette.aura;

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    drawBackdrop(ctx, { aura, glow: frame.glow, shake: frame.shake });

    drawEggSigil(ctx, 250 + frame.shake * 0.4, 230, 118, {
        side, crack: frame.crack, glow: frame.glow, sparks: frame.sparks
    });

    drawText(ctx, 'DRAGON HATCHERY', 500, 92, { size: 30, color: hexToRgba(aura, 0.95) });
    drawText(ctx, eggType?.name || 'Unknown Egg', 500, 140, { size: 40, color: '#ffffff' });

    const captionLines = String(frame.caption || '').split('\n');
    captionLines.forEach((line, index) => {
        drawText(ctx, line.replace(/[_*]/g, ''), 500, 196 + index * 34, {
            size: 22, weight: '600', color: 'rgba(200, 226, 255, 0.86)', maxWidth: 360
        });
    });

    const barY = 300;
    drawText(ctx, 'INCUBATION', 500, 282, { size: 16, color: 'rgba(255,255,255,0.6)' });
    const pct = progressPct === null ? frame.crack : progressPct;
    drawBar(ctx, 500, barY, 340, 14, pct, hexToRgba(aura, 0.95), '', `${Math.round(pct * 100)}%`);

    drawText(ctx, `FRAME ${frameIndex + 1}/${HATCH_FRAMES.length}`, 500, 372, {
        size: 16, color: 'rgba(255,255,255,0.45)'
    });
    if (owner) drawText(ctx, `HATCHER // ${owner}`, 500, 410, { size: 16, color: hexToRgba(aura, 0.8) });

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'dragon-hatch.png' });
}

// ==================================================
// FINAL DRAGON CARD
// ==================================================
function renderDragonCard({ dragon, species, trait, trait2, progress, owner, title, side }) {
    if (!ensureCanvas()) return null;
    const resolvedSide = side || species?.side || dragon?.side || 'good';
    const palette = SIDE_PALETTE[resolvedSide === 'evil' ? 'evil' : 'good'];
    const aura = rarityHex(
        { common: 0x8fa1b3, uncommon: 0x4ade80, rare: 0x38bdf8, epic: 0xa855f7, legendary: 0xf59e0b, mythic: 0xff3d81 }[dragon?.rarity]
    );

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    drawBackdrop(ctx, { aura, glow: 1.15 });

    drawSigil(ctx, 240, 230, 132, { side: resolvedSide, aura, open: 1, glow: 1.1 });

    drawText(ctx, resolvedSide === 'evil' ? 'ONSLAUGHT BEAST' : 'DRAGONFLIGHT', 500, 82, {
        size: 22, color: hexToRgba(aura, 0.95)
    });
    drawText(ctx, String(species?.name || dragon?.name || 'Dragon').toUpperCase(), 500, 126, {
        size: 40, color: '#ffffff', maxWidth: 360
    });
    drawText(ctx, `Lv ${progress?.level ?? dragon.level}${dragon?.name && dragon.name !== species?.name ? `  ·  "${dragon.name}"` : ''}`, 500, 160, {
        size: 22, weight: '600', color: 'rgba(200, 226, 255, 0.9)', maxWidth: 360
    });

    const traitLine = [trait, trait2].filter(Boolean).map(t => t.name).join('  ·  ');
    drawText(ctx, traitLine ? `TRAITS // ${traitLine}` : 'TRAITS // none', 500, 190, {
        size: 18, weight: '600', color: hexToRgba(aura, 0.9), maxWidth: 360
    });

    const stats = [
        ['POWER', Number(dragon?.power) || 0, 90],
        ['SPEED', Number(dragon?.speed) || 0, 90],
        ['STAMINA', Number(dragon?.stamina) || 0, 90]
    ];
    stats.forEach(([label, value, max], index) => {
        drawBar(ctx, 500, 232 + index * 40, 340, 14, value / max, hexToRgba(aura, 0.9), label, String(value));
    });

    drawBar(ctx, 500, 356, 160, 12, (Number(dragon?.hunger) || 0) / 100, '#ffb347', 'HUNGER', `${dragon?.hunger ?? 0}%`);
    drawBar(ctx, 680, 356, 160, 12, (Number(dragon?.happiness) || 0) / 100, '#7bffb0', 'HAPPY', `${dragon?.happiness ?? 0}%`);

    if (progress && !progress.maxed) {
        drawBar(ctx, 500, 412, 340, 10, progress.pct / 100, hexToRgba(palette.accent, 0.9), 'XP', `${progress.xp}/${progress.needed}`);
    } else {
        drawText(ctx, 'XP // MAX LEVEL REACHED', 500, 418, { size: 16, weight: '600', color: hexToRgba(palette.accent, 0.95) });
    }

    if (title) drawText(ctx, title, 40, 40, { size: 20, weight: '600', color: hexToRgba(aura, 0.9), maxWidth: 400 });
    if (owner) drawText(ctx, owner, WIDTH - 40, HEIGHT - 34, { size: 18, color: 'rgba(255,255,255,0.6)', align: 'right', maxWidth: 400 });

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'dragon.png' });
}

/** Compact egg card for the incubator panel. */
function renderEggCard({ eggType, rarityColor, side, owner, progressPct = 0, ready = false }) {
    if (!ensureCanvas()) return null;
    const palette = SIDE_PALETTE[side === 'evil' ? 'evil' : 'good'];
    const aura = rarityColor ? rarityHex(rarityColor) : palette.aura;

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    drawBackdrop(ctx, { aura, glow: ready ? 2 : 0.9 });

    drawEggSigil(ctx, 240, 230, 132, {
        side,
        crack: ready ? 0.85 : Math.max(0.05, progressPct / 100 * 0.5),
        glow: ready ? 1.9 : 0.8,
        sparks: ready ? 0.6 : 0
    });

    drawText(ctx, 'INCUBATOR', 500, 96, { size: 24, color: hexToRgba(aura, 0.95) });
    drawText(ctx, eggType?.name || 'Egg', 500, 142, { size: 38, color: '#ffffff', maxWidth: 360 });
    drawText(ctx, ready ? 'SHELL CONDITION // CRITICAL' : 'SHELL CONDITION // STABLE', 500, 180, {
        size: 18, weight: '600', color: ready ? '#ff7b96' : 'rgba(200, 226, 255, 0.85)'
    });
    drawBar(ctx, 500, 240, 340, 16, progressPct / 100, hexToRgba(aura, 0.95), 'INCUBATION', `${progressPct}%`);
    drawText(ctx, ready ? 'READY TO HATCH — use /profile → Eggs' : 'Keep it warm. It knows if you leave.', 500, 300, {
        size: 19, weight: '600', color: 'rgba(200, 226, 255, 0.85)', maxWidth: 360
    });
    if (owner) drawText(ctx, owner, WIDTH - 40, HEIGHT - 34, { size: 18, color: 'rgba(255,255,255,0.6)', align: 'right', maxWidth: 400 });

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'dragon-egg.png' });
}

module.exports = {
    HATCH_FRAMES,
    canvasAvailable: ensureCanvas,
    renderEggFrame,
    renderEggCard,
    renderDragonCard,
    SIDE_PALETTE
};
