const uno = require('./uno');

const COLOR_HEX = { red: '#ff3b5c', yellow: '#ffd23f', green: '#2ee59d', blue: '#3a86ff', wild: '#111111' };
const COLOR_EMOJI = { red: '🟥', yellow: '🟨', green: '🟩', blue: '🟦', wild: '⬛' };
const COLOR_NAMES = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue', wild: 'Wild' };
const VALUE_NAMES = { skip: 'Skip', reverse: 'Reverse', draw2: '+2', wild: '', wild4: '+4' };
const CORNER_LABELS = { skip: 'SKIP', reverse: 'REV', draw2: '+2', wild: 'WILD', wild4: '+4' };

// Seat centres (player index 0 sits at the bottom).
const SEATS = {
    2: [[450, 462], [450, 120]],
    3: [[450, 462], [148, 190], [752, 190]],
    4: [[450, 462], [148, 296], [450, 120], [752, 296]]
};

const WIDTH = 900;
const HEIGHT = 580;

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

    // Corner label: dark ink on the pale cards so it never washes out.
    ctx.fillStyle = card.color === 'yellow' || card.color === 'green' ? '#132015' : '#ffffff';
    ctx.font = `bold ${Math.round(w * 0.16)}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label.slice(0, 4), x + w * 0.08, y + h * 0.06);
    ctx.restore();
}

/* One seat plate: seat number, name, cards, points, turn / UNO badge. */
function drawSeat(ctx, player, cx, cy, { isTurn = false, seat = 0 } = {}) {
    const w = 252;
    const h = 104;
    const x = cx - w / 2;
    const y = cy - h / 2;

    roundRect(ctx, x, y, w, h, 18);
    const fill = ctx.createLinearGradient(x, y, x, y + h);
    fill.addColorStop(0, isTurn ? 'rgba(92, 58, 176, 0.98)' : 'rgba(17, 13, 46, 0.94)');
    fill.addColorStop(1, isTurn ? 'rgba(52, 30, 110, 0.98)' : 'rgba(8, 6, 24, 0.94)');
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = isTurn ? 3 : 1.5;
    ctx.strokeStyle = isTurn ? '#ffd23f' : 'rgba(255, 255, 255, 0.14)';
    ctx.stroke();

    // Seat number chip.
    roundRect(ctx, x + 12, y + 12, 26, 20, 6);
    ctx.fillStyle = isTurn ? '#ffd23f' : 'rgba(255, 255, 255, 0.14)';
    ctx.fill();
    ctx.fillStyle = isTurn ? '#1a1030' : '#cfd3ff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(seat + 1), x + 25, y + 22);

    // Name.
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(`${player.isBot ? '[BOT] ' : ''}${player.name}`.slice(0, 20), x + 46, y + 23);

    // Cards + points.
    ctx.fillStyle = '#b8c0ff';
    ctx.font = '13px sans-serif';
    ctx.fillText(`${player.hand.length} cards · ${player.score} pts`, x + 14, y + 48);

    const shown = Math.min(player.hand.length, 11);
    for (let i = 0; i < shown; i++) {
        drawCard(ctx, null, x + 14 + i * 17, y + 62, 15, 24, { back: true });
    }

    // Turn / UNO badge.
    const oneLeft = player.hand.length === 1;
    if (isTurn || oneLeft) {
        const label = oneLeft ? (player.calledUno ? 'UNO!' : 'NO UNO') : 'TURN';
        const chipW = oneLeft ? 64 : 46;
        roundRect(ctx, x + w - chipW - 12, y + 12, chipW, 20, 6);
        ctx.fillStyle = oneLeft ? (player.calledUno ? COLOR_HEX.green : COLOR_HEX.red) : '#ffd23f';
        ctx.fill();
        ctx.fillStyle = oneLeft ? '#07130d' : '#1a1030';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(label, x + w - chipW / 2 - 12, y + 22);
    }
}

/* Render the whole table. Returns a PNG buffer. */
function renderTable(state, { turnPlayerId = null } = {}) {
    const { createCanvas } = loadCanvas();
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    // Table felt.
    const bg = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, 60, WIDTH / 2, HEIGHT / 2, 640);
    bg.addColorStop(0, '#22195c');
    bg.addColorStop(1, '#05060f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Header bar.
    const header = ctx.createLinearGradient(0, 0, WIDTH, 0);
    header.addColorStop(0, 'rgba(9, 7, 26, 0.98)');
    header.addColorStop(0.5, 'rgba(44, 24, 96, 0.98)');
    header.addColorStop(1, 'rgba(9, 7, 26, 0.98)');
    ctx.fillStyle = header;
    ctx.fillRect(0, 0, WIDTH, 68);
    ctx.fillStyle = '#ffd23f';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('UNO', 24, 34);
    ctx.fillStyle = '#b8c0ff';
    ctx.font = '12px sans-serif';
    ctx.fillText('NEON TABLE', 24, 54);

    const direction = state.direction === 1 ? 'CLOCKWISE' : 'COUNTER-CLOCKWISE';
    const modeLabel = `${state.rulesMode ?? 'stack'} mode`.toUpperCase();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 17px sans-serif';
    ctx.fillText(`ROUND ${state.round}  ·  ${modeLabel}  ·  FIRST TO ${state.targetScore}`, WIDTH / 2 + 30, 30);
    ctx.fillStyle = '#8f9bff';
    ctx.font = '13px sans-serif';
    ctx.fillText(`${direction}  ·  ${state.players.length} SEATS`, WIDTH / 2 + 30, 50);

    // Felt ring — sized to the piles and the centre furniture, not the seats,
    // so the plates always read as sitting AROUND the table.
    ctx.beginPath();
    ctx.ellipse(WIDTH / 2, 292, 300, 150, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(16, 92, 78, 0.55)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(120, 255, 220, 0.35)';
    ctx.stroke();

    // Piles.
    drawCard(ctx, null, 312, 176, 108, 156, { back: true });
    const top = uno.topCard(state);
    if (top) drawCard(ctx, top, 462, 176, 108, 156);

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.font = '11px sans-serif';
    ctx.fillText('DECK', 366, 348);
    ctx.fillText('DISCARD', 516, 348);

    // Colour chip + pending banner.
    ctx.beginPath();
    ctx.arc(WIDTH / 2 - 74, 378, 11, 0, Math.PI * 2);
    ctx.fillStyle = COLOR_HEX[state.color] ?? '#ffffff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(`COLOUR: ${(state.color ?? '').toUpperCase()}`, WIDTH / 2 - 54, 378);

    if (state.pendingDraw > 0) {
        ctx.textAlign = 'center';
        roundRect(ctx, WIDTH / 2 - 82, 396, 164, 30, 10);
        ctx.fillStyle = 'rgba(255, 59, 92, 0.9)';
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 15px sans-serif';
        ctx.fillText(`+${state.pendingDraw} PENDING`, WIDTH / 2, 411);
    }

    const seats = SEATS[state.players.length] ?? SEATS[4];
    state.players.forEach((player, index) => {
        const [cx, cy] = seats[index] ?? SEATS[4][index];
        drawSeat(ctx, player, cx, cy, {
            isTurn: player.id === turnPlayerId,
            seat: index
        });
    });

    // Footer strip with the last table event.
    ctx.fillStyle = 'rgba(6, 5, 20, 0.92)';
    ctx.fillRect(0, HEIGHT - 52, WIDTH, 52);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.font = '15px sans-serif';
    ctx.fillText((state.log[state.log.length - 1] ?? '').slice(0, 96), WIDTH / 2, HEIGHT - 26);

    return canvas.toBuffer('image/png');
}

module.exports = { renderTable, cardLabel, COLOR_HEX, COLOR_EMOJI, WIDTH, HEIGHT };
