const { EmbedBuilder } = require('discord.js');
const { isHighTech } = require('../economy/uiStyleHelper');

// Shared visual language for the Game Night suite — a terminal/dossier
// aesthetic built on the bot's existing neon title style.
//
// Plain-style support: when a player picked "normal" in /ui-style, the
// shared builder renders a clean panel without the neon header or fancy
// glyphs. Commands just forward userId (and optionally plainStyle to force
// a style for fixed-embed channel games).

const NEON = {
    cyan: 0x00d4ff,
    green: 0x00e5a8,
    magenta: 0xff38d1,
    red: 0xff5577,
    gold: 0xffcc66,
    purple: 0x8b5cf6,
    dim: 0x334455
};

function neonTitle(text) {
    return `◢ ═══ ${text} ═══ ◣`;
}

// Renders inside an embed description WITHOUT an ansi code block so that
// mentions (<@id>) and timestamps (<t:...>) still render as real pings.
function panel(...lines) {
    return lines.filter(l => l !== null && l !== undefined).join('\n');
}

function bar(value, max, width = 10, filledGlyph = '▰', emptyGlyph = '▱') {
    const clamped = Math.max(0, Math.min(value, max));
    const filled = max > 0 ? Math.round((clamped / max) * width) : 0;
    return filledGlyph.repeat(filled) + emptyGlyph.repeat(width - filled);
}

function kv(label, value, width = 14) {
    return `\`${String(label).padEnd(width, ' ')}\`» ${value}`;
}

// Resolve the per-player style: 'auto' defers to their saved preference,
// 'hightech'/'normal' force one explicitly.
function styleOf(userId, override) {
    if (override === 'hightech' || override === 'normal') return override;
    return isHighTech(userId) ? 'hightech' : 'normal';
}

function gameEmbed({ title, lines, description, color = NEON.cyan, footer, timestamp = true, userId, plainStyle }) {
    const style = styleOf(userId, plainStyle);
    // Plain style drops the ASCII art panels — those lines are code-block
    // hightech flavor; regular prose lines ("> ..." hints) stay readable.
    const visible = style === 'normal'
        ? (lines || []).filter(l => typeof l !== 'string' || !l.includes('```'))
        : lines;
    const body = panel(...(visible || []));
    if (style === 'normal') {
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(String(title).replace(/[\uE000-\uF8FF]/g, '').trim())
            .setDescription(body || (description || ''));
        return embed;
    }
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(neonTitle(title))
        .setDescription(body || (description || ''));
    if (footer) embed.setFooter({ text: footer });
    if (timestamp) embed.setTimestamp();
    return embed;
}

module.exports = { NEON, panel, bar, kv, neonTitle, gameEmbed, styleOf };
