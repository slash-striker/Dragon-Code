const path = require('path');

let createCanvas;
let loadImage;

try {
    ({ createCanvas, loadImage } = require('@napi-rs/canvas'));
} catch (error) {
    if (process.env.DEBUG_CANVAS === '1' || process.env.DEBUG_CANVAS === 'true') {
        console.warn('Canvas support unavailable: Five Dice will fall back to unicode dice faces.');
    }
}

const { AttachmentBuilder } = require('discord.js');

const DIE_FILE = value => path.join(__dirname, '..', '..', 'assets', 'dice', `dice-${value}.png`);
const UNICODE_FACES = ['\u2680', '\u2681', '\u2682', '\u2683', '\u2684', '\u2685'];

// The dice strip is a loose message attachment rendered BELOW the embed and
// directly ABOVE the keep-button row. Discord lays out single-digit buttons at
// ~32px wide with an 8px gap (40px pitch), so the dice use the exact same
// pitch to line up 1:1 over their buttons.
const DIE_SIZE = 40;
const DIE_GAP = 0;      // pitch = 40px, matching the five keep buttons
const STRIP_PAD_X = 0;  // button rows start flush at the message edge
const EDGE = 6;         // vertical breathing room
const CYAN = '#00d4ff';
const GREEN = '#00e5a8';

const pendingImages = new Map();
const resolvedImages = new Map();

async function loadDieImage(value) {
    if (resolvedImages.has(value)) return resolvedImages.get(value);
    if (!pendingImages.has(value)) {
        pendingImages.set(value, loadImage(DIE_FILE(value)).then(image => {
            resolvedImages.set(value, image);
            pendingImages.delete(value);
            return image;
        }));
    }
    return pendingImages.get(value);
}

// Transparent strip: no backdrop panel, so it hugs the message background.
async function renderDiceRow(dice, kept = [], { highlightKept = true, filename = 'five-dice.png' } = {}) {
    if (!createCanvas || !loadImage) {
        return { attachment: null, fallback: dice.map(die => UNICODE_FACES[die - 1]).join(' ') };
    }

    const images = await Promise.all(dice.map(die => loadDieImage(die)));

    const pitch = DIE_SIZE + DIE_GAP;
    const width = STRIP_PAD_X * 2 + DIE_SIZE * dice.length + DIE_GAP * (dice.length - 1);
    const height = EDGE * 2 + DIE_SIZE;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    for (let index = 0; index < dice.length; index++) {
        const die = dice[index];
        const isKept = highlightKept && kept[index];
        const glow = isKept ? GREEN : CYAN;
        const dx = STRIP_PAD_X + index * pitch;
        const dy = EDGE;

        ctx.save();
        // Neon under-glow behind each die.
        ctx.shadowColor = glow;
        ctx.shadowBlur = 8;
        ctx.drawImage(images[index], dx, dy, DIE_SIZE, DIE_SIZE);
        ctx.restore();

        // Holographic tint: black pips stay dark, the white face picks up the
        // neon palette (green when kept, cyan otherwise).
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        const tint = ctx.createLinearGradient(0, dy, 0, dy + DIE_SIZE);
        tint.addColorStop(0, isKept ? 'rgba(0, 229, 168, 0.20)' : 'rgba(0, 212, 255, 0.18)');
        tint.addColorStop(1, 'rgba(255, 56, 209, 0.12)');
        ctx.fillStyle = tint;
        ctx.fillRect(dx, dy, DIE_SIZE, DIE_SIZE);
        ctx.restore();

        if (isKept) {
            // KEPT ring in green, replacing the old ✅ marker.
            ctx.save();
            ctx.shadowColor = GREEN;
            ctx.shadowBlur = 6;
            ctx.strokeStyle = GREEN;
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.roundRect(dx + 1, dy + 1, DIE_SIZE - 2, DIE_SIZE - 2, 10);
            ctx.stroke();
            ctx.restore();
        }
    }

    return { attachment: new AttachmentBuilder(canvas.toBuffer('image/png'), { name: filename }), fallback: null };
}

module.exports = { renderDiceRow, UNICODE_FACES };
