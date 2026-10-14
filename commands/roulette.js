const {
    SlashCommandBuilder,
    EmbedBuilder,
    AttachmentBuilder
} = require('discord.js');
const db = require('../database');
const casino = require('../systems/casino/casinoManager');
const { NEON, gameEmbed } = require('../systems/games/gamenightUI');

/*
 * 🎡 AMERICAN ROULETTE — /roulette
 *
 * Fully command-driven: the player types the command with a bet (a color or
 * a number) and an amount, the wheel spins, and the result lands in the same
 * reply. There is NO standing board, NO auto-posted embed, and NO session —
 * the wheel only turns when a player calls for it.
 *
 * A true American wheel: 38 pockets, 1-36 alternating red/black plus the
 * green 0 and 00. Standard casino payouts:
 *
 *   straight-up .... 35:1        red/black, odd/even, low/high .... 1:1
 *   dozen/column ... 2:1         0 and 00 beat every outside bet
 */

const MIN_BET = 100;
const DEFAULT_MAX_BET = 100_000; // table limit until a casino admin raises it via /casino maxbet

// ---- The wheel --------------------------------------------------------------------
const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const BLACKS = new Set([2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35]);

const WHEEL = (() => {
    const reds = [...REDS], blacks = [...BLACKS];
    const pockets = [{ n: 0, color: 'green' }];
    const pushPair = (i) => {
        pockets.push({ n: reds[i], color: 'red' });
        pockets.push({ n: blacks[i], color: 'black' });
    };
    for (let i = 0; i < 9; i++) pushPair(i);    // indices 1-18
    pockets.push({ n: '00', color: 'green' });  // index 19 — directly opposite 0, like a real rim
    for (let i = 9; i < 18; i++) pushPair(i);   // indices 20-37
    return pockets;
})();

function pocketColor(n) {
    if (n === 0 || n === '00') return 'green';
    return REDS.has(Number(n)) ? 'red' : 'black';
}

function betDef(betId) {
    if (betId.startsWith('n')) {
        const raw = betId.slice(1);
        return {
            id: betId,
            label: `Straight-up ${raw}`,
            short: raw,
            pays: 35,
            emoji: '🟢'
        };
    }
    const map = {
        red: { label: 'Red', short: 'Red', pays: 1, emoji: '🔴' },
        black: { label: 'Black', short: 'Black', pays: 1, emoji: '⚫' },
        odd: { label: 'Odd', short: 'Odd', pays: 1, emoji: '🎣' },
        even: { label: 'Even', short: 'Even', pays: 1, emoji: '🔖' },
        low: { label: 'Low 1-18', short: '1-18', pays: 1, emoji: '📉' },
        high: { label: 'High 19-36', short: '19-36', pays: 1, emoji: '📈' },
        d1: { label: '1st Dozen (1-12)', short: '1st 12', pays: 2, emoji: '1️⃣' },
        d2: { label: '2nd Dozen (13-24)', short: '2nd 12', pays: 2, emoji: '2️⃣' },
        d3: { label: '3rd Dozen (25-36)', short: '3rd 12', pays: 2, emoji: '3️⃣' },
        c1: { label: 'Column 1', short: 'Col 1', pays: 2, emoji: '🧱' },
        c2: { label: 'Column 2', short: 'Col 2', pays: 2, emoji: '🧱' },
        c3: { label: 'Column 3', short: 'Col 3', pays: 2, emoji: '🧱' }
    };
    return map[betId] ? { id: betId, ...map[betId] } : null;
}

function betWins(betId, pocketN) {
    if (betId.startsWith('n')) {
        return String(pocketN) === betId.slice(1);
    }
    const num = typeof pocketN === 'number' ? pocketN : -1; // 0/00 never win outside bets
    switch (betId) {
        case 'red': return num > 0 && REDS.has(num);
        case 'black': return num > 0 && BLACKS.has(num);
        case 'even': return num > 0 && num % 2 === 0;
        case 'odd': return num > 0 && num % 2 === 1;
        case 'low': return num >= 1 && num <= 18;
        case 'high': return num >= 19 && num <= 36;
        case 'd1': return num >= 1 && num <= 12;
        case 'd2': return num >= 13 && num <= 24;
        case 'd3': return num >= 25 && num <= 36;
        case 'c1': return num > 0 && num % 3 === 1;
        case 'c2': return num > 0 && num % 3 === 2;
        case 'c3': return num > 0 && num % 3 === 0;
        default: return false;
    }
}

function spinWheel() {
    return WHEEL[Math.floor(Math.random() * WHEEL.length)];
}

function resolveBet(betId, amount, pocket) {
    const def = betDef(betId);
    if (!def) return { win: false, payout: 0, profit: 0 };
    if (!betWins(betId, pocket.n)) return { win: false, payout: 0, profit: 0 };
    const payout = amount * (def.pays + 1); // stake back + winnings
    return { win: true, payout, profit: amount * def.pays };
}

// ---- Rendering ------------------------------------------------------------------------
let canvasLib = null;
try { canvasLib = require('@napi-rs/canvas'); } catch { /* unicode fallback below */ }

function colorHex(color, dimmed = false) {
    if (color === 'red') return dimmed ? '#5a1620' : '#c0392b';
    if (color === 'black') return dimmed ? '#141418' : '#1c1c22';
    return dimmed ? '#0e4030' : '#1e8f5a';
}

function renderWheel(winningPocket = null, spinning = false, ballAngle = null, wheelRotation = 0) {
    if (!canvasLib) return null;
    const { createCanvas } = canvasLib;
    const size = 560;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const cx = size / 2, cy = size / 2;
    const R = size / 2 - 12;
    const wedge = (Math.PI * 2) / WHEEL.length;

    // Backdrop
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, size, size);

    // Outer rim
    const rim = ctx.createRadialGradient(cx, cy, R * 0.82, cx, cy, R);
    rim.addColorStop(0, '#2a2f3a');
    rim.addColorStop(0.5, '#3d4454');
    rim.addColorStop(1, '#171a21');
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = rim; ctx.fill();

    // Gold trim
    ctx.lineWidth = 3; ctx.strokeStyle = '#c9a227';
    ctx.beginPath(); ctx.arc(cx, cy, R - 2, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.66, 0, Math.PI * 2); ctx.stroke();

    // Pockets — the whole rim rotates by wheelRotation so the spin feels real.
    WHEEL.forEach((p, i) => {
        const a0 = i * wedge - Math.PI / 2 + wheelRotation;
        const a1 = a0 + wedge;
        const isWinner = winningPocket !== null && String(p.n) === String(winningPocket.n);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R * 0.86, a0, a1);
        ctx.closePath();
        ctx.fillStyle = colorHex(p.color, winningPocket !== null && !isWinner);
        ctx.fill();
        if (isWinner) {
            ctx.lineWidth = 4; ctx.strokeStyle = '#ffd700';
            ctx.stroke();
        }
        // Separator ticks
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a0) * R * 0.66, cy + Math.sin(a0) * R * 0.66);
        ctx.lineTo(cx + Math.cos(a0) * R * 0.86, cy + Math.sin(a0) * R * 0.86);
        ctx.lineWidth = 1.5; ctx.strokeStyle = '#c9a22755';
        ctx.stroke();
        // Number, rotated along the rim
        const mid = a0 + wedge / 2;
        ctx.save();
        ctx.translate(cx + Math.cos(mid) * R * 0.76, cy + Math.sin(mid) * R * 0.76);
        ctx.rotate(mid + Math.PI / 2);
        ctx.fillStyle = '#f5f2e8';
        ctx.font = 'bold 17px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(p.n), 0, 0);
        ctx.restore();
    });

    // Hub
    const hub = ctx.createRadialGradient(cx, cy, 4, cx, cy, R * 0.62);
    hub.addColorStop(0, '#232833');
    hub.addColorStop(1, '#0d1017');
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = hub; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#c9a227';
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.62, 0, Math.PI * 2); ctx.stroke();

    ctx.fillStyle = '#c9a227';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('LGR', cx, cy - 14);
    ctx.fillStyle = '#8892a6';
    ctx.font = '13px sans-serif';
    ctx.fillText(spinning ? 'SPINNING…' : 'AMERICAN · 38', cx, cy + 16);

    // The ball — orbiting at the given angle during the spin, parked in the
    // winning pocket (accounting for rim rotation) on the result, or resting
    // at the top otherwise.
    let ballPos = ballAngle !== null ? ballAngle : -Math.PI / 2 + wedge / 2 + wheelRotation;
    if (winningPocket !== null) {
        const idx = WHEEL.findIndex(p => String(p.n) === String(winningPocket.n));
        if (idx >= 0) ballPos = idx * wedge + wedge / 2 - Math.PI / 2 + wheelRotation;
    }
    ctx.beginPath();
    ctx.arc(cx + Math.cos(ballPos) * R * 0.92, cy + Math.sin(ballPos) * R * 0.92, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ffffff88'; ctx.shadowBlur = 14;
    ctx.fill();
    ctx.shadowBlur = 0;

    return canvas;
}

function wheelFile(canvas) {
    if (!canvas) return null;
    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'wheel.png' });
}

function pocketDot(n) {
    const color = pocketColor(n);
    return color === 'red' ? '🔴' : color === 'black' ? '⚫' : '🟢';
}

// ---- Command -------------------------------------------------------------------------------------
module.exports = {
    data: new SlashCommandBuilder()
        .setName('roulette')
        .setDescription('Spin the American roulette wheel — pick a color or a number, place your amount, spin')
        .addIntegerOption(opt => opt
            .setName('amount')
            .setDescription(`How much to bet (minimum 🪙 ${MIN_BET.toLocaleString()})`)
            .setRequired(true)
            .setMinValue(MIN_BET))
        .addStringOption(opt => opt
            .setName('bet_type')
            .setDescription('Bet on a color or area of the felt (skip this if betting a number)')
            .setRequired(false)
            .addChoices(
                { name: '🔴 Red (pays 1:1)', value: 'red' },
                { name: '⚫ Black (pays 1:1)', value: 'black' },
                { name: '🎣 Odd (pays 1:1)', value: 'odd' },
                { name: '🔖 Even (pays 1:1)', value: 'even' },
                { name: '📉 Low 1-18 (pays 1:1)', value: 'low' },
                { name: '📈 High 19-36 (pays 1:1)', value: 'high' },
                { name: '1️⃣ 1st Dozen 1-12 (pays 2:1)', value: 'd1' },
                { name: '2️⃣ 2nd Dozen 13-24 (pays 2:1)', value: 'd2' },
                { name: '3️⃣ 3rd Dozen 25-36 (pays 2:1)', value: 'd3' },
                { name: '🧱 Column 1 (pays 2:1)', value: 'c1' },
                { name: '🧱 Column 2 (pays 2:1)', value: 'c2' },
                { name: '🧱 Column 3 (pays 2:1)', value: 'c3' },
                { name: '🟢 Straight-up 0 (pays 35:1)', value: 'n0' },
                { name: '🟢 Straight-up 00 (pays 35:1)', value: 'n00' }
            ))
        .addIntegerOption(opt => opt
            .setName('number')
            .setDescription('Straight-up on a single number 0-36 (pays 35:1) — skips bet_type')
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(36)),

    async execute(interaction) {
        try {
            await interaction.deferReply();

            const userId = interaction.user.id;

            // ---- Resolve the bet from the command options ----
            const optNumber = interaction.options.getInteger('number');
            const optType = interaction.options.getString('bet_type');

            let betId;
            if (optNumber !== null) betId = `n${optNumber}`;
            else if (optType) betId = optType;

            if (!betId || !betDef(betId)) {
                await interaction.editReply(
                    '❌ **No bet given.** Use `/roulette` with either a `number:` (0-36, pays 35:1) ' +
                    'or a `bet_type:` (red/black/odd/even/low/high, a dozen or a column), plus your `amount:`.'
                ).catch(() => {});
                return;
            }

            const def = betDef(betId);
            const amount = interaction.options.getInteger('amount');

            // ---- Validate the amount ----
            if (amount < MIN_BET) {
                await interaction.editReply(`❌ Minimum bet is 🪙 **${MIN_BET.toLocaleString()}**.`).catch(() => {});
                return;
            }

            // Table limit: an admin-configured value wins; otherwise the default.
            const configured = casino.getMaxBet('roulette');
            const maxBet = configured >= 1e12 ? DEFAULT_MAX_BET : configured;
            if (amount > maxBet) {
                await interaction.editReply(`❌ Table limit for roulette is 🪙 **${maxBet.toLocaleString()}** — lower your amount.`).catch(() => {});
                return;
            }

            const wallet = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(userId)?.wallet || 0);
            if (wallet < amount) {
                await interaction.editReply(
                    `❌ Not enough chips — your wallet holds 🪙 **${wallet.toLocaleString()}**, the bet needs 🪙 **${amount.toLocaleString()}**.`
                ).catch(() => {});
                return;
            }

            // ---- Take the stake up front ----
            try {
                casino.debitWallet(userId, 'roulette', amount, `roulette bet — ${def.short}`);
            } catch (error) {
                await interaction.editReply(`❌ Could not place the bet: ${error.message}`).catch(() => {});
                return;
            }

            // ---- The spin — one reply, edited in place as the wheel turns ----
            const spinningLines = [
                '> 🎯 **Bet:** ' + `${def.emoji} ${def.label} (pays ${def.pays}:1)`,
                `> 💵 **Stake:** 🪙 ${amount.toLocaleString()}`,
                '',
                '> 🌀 *The ball rattles around the rim…*'
            ];
            const spinningEmbed = gameEmbed({
                title: '🎡 The wheel is spinning…',
                color: NEON.cyan,
                lines: spinningLines,
                userId,
                footer: 'American wheel · 38 pockets · 0 & 00 beat all outside bets'
            });

            // ---- Animated spin: the ball orbits and decelerates while the rim
            //      counter-rotates, then settles into the winning pocket. The
            //      final frame is pixel-continuous with the result render. ----
            const pocket = spinWheel();
            const winIdx = WHEEL.findIndex(p => String(p.n) === String(pocket.n));
            const FRAMES = 7;
            const SPIN_TURN = Math.PI * 2 * 2.25;                              // ~2¼ ball revolutions
            const RIM_DRIFT = SPIN_TURN * 0.14;                                // rim eases the opposite way
            const startBall = -Math.PI / 2;
            const rimEnd = -RIM_DRIFT;
            // wedge is the per-pocket angle — renderWheel computes its own copy;
            // this one keeps the ball's landing math in execute scope.
            const wedge = (Math.PI * 2) / WHEEL.length;
            // Ball must finish exactly in the winning pocket of the rotated rim.
            const endBall = winIdx * wedge + wedge / 2 - Math.PI / 2 + rimEnd;
            for (let f = 0; f < FRAMES; f++) {
                const t = (f + 1) / FRAMES;
                const ease = 1 - Math.pow(1 - t, 3);                           // deceleration curve
                const ballAng = startBall + (endBall - startBall) * ease;
                const rimRot = rimEnd * ease;
                const frameCanvas = renderWheel(null, true, ballAng, rimRot);
                const framePayload = { embeds: [spinningEmbed], components: [] };
                const frameFile = wheelFile(frameCanvas);
                if (frameFile) {
                    framePayload.files = [frameFile];
                    framePayload.embeds = [EmbedBuilder.from(spinningEmbed).setImage('attachment://wheel.png')];
                }
                await interaction.editReply(framePayload).catch(() => {});
                await new Promise(res => setTimeout(res, f < FRAMES - 2 ? 380 : 520));
            }

            // ---- Land ----
            const outcome = resolveBet(betId, amount, pocket);

            if (outcome.win) {
                try {
                    casino.creditWallet(userId, 'roulette', outcome.payout, 'credit',
                        `roulette — ${def.short} won (${pocket.n} ${pocket.color})`);
                } catch (error) {
                    console.error('roulette payout failed', userId, error);
                }
            }

            const dot = pocketDot(pocket.n);
            const resultLines = [
                `> 🎯 **The ball lands on ${dot} ${pocket.n} ${String(pocket.color).toUpperCase()}**`,
                '',
                `> 🪙 **Bet:** ${def.emoji} ${def.label} — 🪙 ${amount.toLocaleString()} (pays ${def.pays}:1)`,
                outcome.win
                    ? `> ✅ **WINNER!** <@${userId}> wins 🪙 **${outcome.payout.toLocaleString()}** (stake back + 🪙 ${outcome.profit.toLocaleString()})`
                    : `> ❌ **No luck** — the house takes 🪙 ${amount.toLocaleString()}.`
            ];
            const resultEmbed = gameEmbed({
                title: `🎡 Roulette — ${outcome.win ? 'WIN' : 'LOSS'}`,
                color: outcome.win ? (NEON.gold ?? 0xc9a227) : NEON.cyan,
                lines: resultLines,
                userId,
                footer: 'American wheel · 38 pockets · straight 35:1 · dozen/column 2:1 · outside 1:1'
            });

            const payload = {
                embeds: [resultEmbed],
                components: [],
                content: outcome.win ? `🎉 <@${userId}>` : undefined
            };
            const resultFile = wheelFile(renderWheel(pocket, false, null, rimEnd)); // same rim angle as the last frame
            if (resultFile) {
                payload.files = [resultFile];
                payload.embeds = [EmbedBuilder.from(resultEmbed).setImage('attachment://wheel.png')];
            }
            await interaction.editReply(payload).catch(() => {});
        } catch (error) {
            console.error('Error in roulette command:', error);
            const text = '❌ The wheel jammed. Please try again.';
            try {
                if (interaction.deferred || interaction.replied) await interaction.editReply({ content: text, embeds: [], components: [] });
                else await interaction.reply({ content: text });
            } catch { /* interaction expired */ }
        }
    }
};

// Exposed for tests.
module.exports._test = { WHEEL, REDS, BLACKS, betDef, betWins, resolveBet, spinWheel, renderWheel };
