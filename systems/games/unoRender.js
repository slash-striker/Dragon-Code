const uno = require('./uno');

const COLOR_HEX = { red: '#ff3b5c', yellow: '#ffd23f', green: '#2ee59d', blue: '#3a86ff', wild: '#111111' };
const COLOR_EMOJI = { red: '🟥', yellow: '🟨', green: '🟩', blue: '🟦', wild: '⬛' };
const COLOR_NAMES = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue', wild: 'Wild' };
const VALUE_NAMES = { skip: 'Skip', reverse: 'Reverse', draw2: '+2', wild: '', wild4: '+4' };
const CORNER_LABELS = { skip: 'SKIP', reverse: 'REV', draw2: '+2', wild: 'WILD', wild4: '+4' };

// Seat centres (player index 0 sits at the bottom).
const SEATS = {
    2: [[450, 448], [450, 92]],
    3: [[450, 448], [130, 180], [770, 180]],
    4: [[450, 448], [130, 290], [450, 92], [770, 290]]
};

let canvasLib = null;
function loadCanvas() {
    if (!canvasLib) canvasLib = require('@napi-rs/canvas');
    return canvasLib;
}

/* Human-readable card name for menus and logs, e.g. "Red 7" or "Wild +4". */
function cardLabel(card) {
    if (card.color === 'wild') return card.value === 'wild4' ? 'Wild +4' : 'Wild';
    const value = VALUE_NAMES[card.value] ?? card.value;
    return `${COLOR_NAMES[card.color]} ${value}`.trim();
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/* One card. `card` null or `back` true draws the face-down pile style. */
function drawCard(ctx, card, x, y, w = 110, h = 160, { back = false } = {}) {
    const r = Math.min(14, w / 2, h / 2);
    ctx.save();
    if (back || !card) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetY = 4;
        roundRect(ctx, x, y, w, h, r);
        const grad = ctx.createLinearGradient(x, y, x + w, y + h);
        grad.addColorStop(0, '#1b1f4b');
        grad.addColorStop(1, '#6d28d9');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.lineWidth = Math.max(1, w * 0.03);
        ctx.strokeStyle = '#ffd23f';
        roundRect(ctx, x + w * 0.08, y + h * 0.06, w * 0.84, h * 0.88, r * 0.7);
        ctx.stroke();
        if (w >= 60) {
            ctx.fillStyle = '#ffd23f';
            ctx.font = `bold ${Math.round(w * 0.2)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('UNO', x + w / 2, y + h / 2);
        }
        ctx.restore();
        return;
    }

    const isWild = card.color === 'wild';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    roundRect(ctx, x, y, w, h, r);
    if (isWild) {
        ctx.fillStyle = '#111111';
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.save();
        roundRect(ctx, x, y, w, h, r);
        ctx.clip();
        const cx = x + w / 2;
        const cy = y + h / 2;
        ctx.fillStyle = COLOR_HEX.red;
        ctx.fillRect(x, y, w / 2, h / 2);
        ctx.fillStyle = COLOR_HEX.yellow;
        ctx.fillRect(cx, y, w / 2, h / 2);
        ctx.fillStyle = COLOR_HEX.green;
        ctx.fillRect(x, cy, w / 2, h / 2);
        ctx.fillStyle = COLOR_HEX.blue;
        ctx.fillRect(cx, cy, w / 2, h / 2);
        ctx.restore();
    } else {
        ctx.fillStyle = COLOR_HEX[card.color];
        ctx.fill();
        ctx.shadowColor = 'transparent';
    }

    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w * 0.36, h * 0.4, -0.45, 0, Math.PI * 2);
    ctx.fillStyle = '#fff8e7';
    ctx.fill();

    const isNumber = /^\d$/.test(card.value);
    const label = isNumber ? card.value : CORNER_LABELS[card.value] ?? card.value;
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(-0.45);
    ctx.fillStyle = isWild ? '#111111' : COLOR_HEX[card.color];
    ctx.font = `bold ${Math.round(w * (label.length <= 2 ? 0.42 : 0.2))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 0);
    ctx.restore();

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(w * 0.16)}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label.slice(0, 4), x + w * 0.08, y + h * 0.06);
    ctx.restore();
}

function drawSeat(ctx, player, cx, cy, isTurn) {
    const w = 230;
    const h = 96;
    const x = cx - w / 2;
    const y = cy - h / 2;
    roundRect(ctx, x, y, w, h, 16);
    ctx.fillStyle = isTurn ? 'rgba(74, 46, 150, 0.95)' : 'rgba(14, 10, 40, 0.9)';
    ctx.fill();
    ctx.lineWidth = isTurn ? 4 : 2;
    ctx.strokeStyle = isTurn ? '#ffd23f' : 'rgba(255, 255, 255, 0.18)';
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 19px sans-serif';
    ctx.fillText(`${player.isBot ? '[BOT] ' : ''}${player.name}`.slice(0, 22), x + 14, y + 20);
    ctx.fillStyle = '#b8c0ff';
    ctx.font = '14px sans-serif';
    ctx.fillText(`${player.hand.length} cards · ${player.score} pts`, x + 14, y + 42);

    const shown = Math.min(player.hand.length, 12);
    for (let i = 0; i < shown; i++) {
        drawCard(ctx, null, x + 14 + i * 16, y + 58, 14, 22, { back: true });
    }

    if (player.hand.length === 1) {
        roundRect(ctx, x + w - 70, y + 10, 58, 24, 8);
        ctx.fillStyle = player.calledUno ? COLOR_HEX.green : COLOR_HEX.red;
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(player.calledUno ? 'UNO!' : 'NO UNO', x + w - 41, y + 22);
    }
}

/* Render the whole table. Returns a PNG buffer. */
function renderTable(state, { turnPlayerId = null } = {}) {
    const { createCanvas } = loadCanvas();
    const W = 900;
    const H = 560;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    const bg = ctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, 620);
    bg.addColorStop(0, '#22195c');
    bg.addColorStop(1, '#05060f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.beginPath();
    ctx.ellipse(W / 2, 280, 360, 185, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(16, 92, 78, 0.55)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(120, 255, 220, 0.35)';
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffd23f';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('UNO', 22, 30);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#b8c0ff';
    ctx.font = '16px sans-serif';
    const direction = state.direction === 1 ? 'Clockwise' : 'Counter-clockwise';
    const modeLabel = `${state.rulesMode ?? 'stack'} mode`.toUpperCase();
    ctx.fillText(`${direction} · Round ${state.round} · ${modeLabel} · First to ${state.targetScore}`, W / 2, 30);

    drawCard(ctx, null, 300, 165, 110, 160, { back: true });
    const top = uno.topCard(state);
    if (top) drawCard(ctx, top, 420, 165, 110, 160);

    ctx.beginPath();
    ctx.arc(W / 2 - 40, 350, 13, 0, Math.PI * 2);
    ctx.fillStyle = COLOR_HEX[state.color] ?? '#ffffff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(`Colour: ${(state.color ?? '').toUpperCase()}`, W / 2 - 20, 350);
    if (state.pendingDraw > 0) {
        ctx.textAlign = 'center';
        ctx.fillStyle = COLOR_HEX.red;
        ctx.font = 'bold 20px sans-serif';
        ctx.fillText(`+${state.pendingDraw} pending`, W / 2, 378);
    }

    const seats = SEATS[state.players.length] ?? SEATS[4];
    state.players.forEach((player, index) => {
        const [cx, cy] = seats[index];
        drawSeat(ctx, player, cx, cy, player.id === turnPlayerId);
    });

    const note = state.log[state.log.length - 1] ?? '';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = '16px sans-serif';
    ctx.fillText(note.slice(0, 90), W / 2, H - 22);

    return canvas.toBuffer('image/png');
}

module.exports = { renderTable, cardLabel, COLOR_HEX, COLOR_EMOJI };
