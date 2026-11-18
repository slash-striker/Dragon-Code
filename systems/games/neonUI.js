const { EmbedBuilder } = require('discord.js');
const { isHighTech } = require('../economy/uiStyleHelper');

// Shared "high-tech" visual language for the Netquel mini-game suite:
// neon palette, panel dividers, ANSI stat blocks, and progress bars.
//
// Plain-style support: when a player has picked the "normal" UI via
// /ui-style, the shared builders automatically render a cleaner, plainer
// panel (no neon header bars, no ANSI color codes) — commands only pass
// their plainStyle option to go further.

const NEON = {
    cyan: 0x00d4ff,
    green: 0x00e5a8,
    magenta: 0xff38d1,
    red: 0xff5577,
    gold: 0xffcc66,
    purple: 0x8b5cf6
};

const RESET = '\u001b[0m';
const CYAN = '\u001b[0;36m';
const GREEN = '\u001b[0;32m';
const RED = '\u001b[0;31m';
const YELLOW = '\u001b[0;33m';
const MAGENTA = '\u0b1b[0;35m'.replace('\u0b1b', '\u001b'); // safety: keep ESC correct
const DIM = '\u001b[0;90m';
const BOLD = '\u001b[1m';

// `◢ ═══ TITLE ═══ ◣` header style already used across the bot (career grid).
function neonTitle(text) {
    return `◢ ═══ ${text} ═══ ◣`;
}

function heading(text) {
    return `${BOLD}${MAGENTA}◈ ${text}${RESET}`;
}

function divider(width = 26) {
    return `${DIM}${'▓▒░'.repeat(Math.ceil(width / 3)).slice(0, width)}${RESET}`;
}

// An ```ansi``` block renders as a futuristic terminal panel in Discord.
// Falsy lines (null/undefined/'') collapse: '' becomes a blank spacer line.
function panel(...lines) {
    return ['```ansi', ...lines.filter(line => line !== null && line !== undefined), '```'].join('\n');
}

// Plain counterpart of panel(): no code block, no ANSI — just the lines.
function plainPanel(...lines) {
    return lines.filter(line => line !== null && line !== undefined).join('\n');
}

// `Label            » value` row for stat panels.
function kv(label, value, color = CYAN) {
    return `${DIM}${String(label).padEnd(16)}${RESET}${color}»${RESET} ${value}`;
}

function progressBar(value, max, width = 10) {
    const clamped = Math.max(0, Math.min(value, max));
    const filled = max > 0 ? Math.round((clamped / max) * width) : 0;
    return `${GREEN}${'▰'.repeat(filled)}${RESET}${DIM}${'▱'.repeat(width - filled)}${RESET}`;
}

// Resolve the per-player style: 'auto' defers to their saved preference,
// 'hightech'/'normal' force one explicitly (e.g. channel-fixed games).
function styleOf(userId, override) {
    if (override === 'hightech' || override === 'normal') return override;
    return isHighTech(userId) ? 'hightech' : 'normal';
}

/* Strip terminal colour codes, for the plain rendering of the same lines. */
function stripAnsi(text) {
    return String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

/* Markdown bold → ANSI bold, so a line keeps its emphasis inside a panel. */
function toAnsi(text) {
    return String(text).replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
}

/* Split a multi-line body into panel-ready ANSI lines. */
function panelLines(text) {
    return String(text ?? '').split('\n').map(toAnsi);
}

/*
 * One embed, two looks:
 *   high-tech → `◢ ═══ TITLE ═══ ◣` + a ```ansi terminal panel
 *   normal    → the plain title and the same lines as ordinary text
 * Pass `normalTitle` / `normalLines` when the plain version should read
 * differently (shorter headers, no terminal jargon) rather than just losing
 * its colour codes.
 */
function neonEmbed({
    title,
    normalTitle,
    lines,
    normalLines,
    description,
    color = NEON.cyan,
    footer,
    timestamp = true,
    userId,
    plainStyle
}) {
    const style = styleOf(userId, plainStyle);
    const embed = new EmbedBuilder().setColor(color);

    if (style === 'normal') {
        embed.setTitle(String(normalTitle || title).replace(/[\uE000-\uF8FF]/g, '').trim());
        // Callers that pass ANSI-coloured `lines` still get readable plain text:
        // escape codes are stripped instead of leaking into the embed.
        const bodyLines = normalLines || (lines ? lines.map(stripAnsi) : null);
        embed.setDescription(bodyLines ? plainPanel(...bodyLines) : (description || ''));
    } else {
        embed.setTitle(neonTitle(title));
        embed.setDescription(lines ? panel(...lines) : description);
    }

    if (footer) embed.setFooter({ text: footer });
    if (timestamp) embed.setTimestamp();
    return embed;
}

module.exports = {
    NEON,
    panel,
    plainPanel,
    kv,
    heading,
    divider,
    neonTitle,
    neonEmbed,
    progressBar,
    styleOf,
    toAnsi,
    stripAnsi,
    panelLines,
    ANSI: { RESET, CYAN, GREEN, RED, YELLOW, MAGENTA, DIM, BOLD }
};
