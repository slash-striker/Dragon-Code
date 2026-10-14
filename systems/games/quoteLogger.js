const db = require('../../database');

/*
 * 📼 QUOTE LOGGER — feeds the QOTD vault.
 *
 * A quote enters the bank when someone reacts to a message with the watch
 * emoji (949479338275913799) or pings that emoji as a reply to the message.
 * We store WHAT was said, WHO said it, and WHERE — never who logged it.
 */

const WATCH_EMOJI_ID = '949479338275913799';
const MIN_LENGTH = 8;
const MAX_LENGTH = 400;

async function logQuote(sourceMessage, client) {
    try {
        const content = (sourceMessage.content || '').trim();
        if (content.length < MIN_LENGTH) return false;
        if (sourceMessage.author?.bot) return false;

        // Deduplicate: each source message is archived once.
        const existing = db.prepare('SELECT 1 FROM quote_bank WHERE messageId = ?')
            .get(sourceMessage.id);
        if (existing) return false;

        db.prepare(`
            INSERT INTO quote_bank (content, authorId, channelId, messageId, loggedAt)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            content.slice(0, MAX_LENGTH),
            sourceMessage.author.id,
            sourceMessage.channelId,
            sourceMessage.id,
            Date.now()
        );
        return true;
    } catch (error) {
        console.error('quoteLogger error:', error);
        return false;
    }
}

/* Emoji id can appear as <a?:name:ID> in message content. */
function messagePingsWatchEmoji(message) {
    return (message.content || '').includes(`<:${WATCH_EMOJI_ID}>`) ||
           (message.content || '').includes(`<a:${WATCH_EMOJI_ID}>`) ||
           (message.content || '').includes(WATCH_EMOJI_ID);
}

/*
 * Returns true when this reaction is the watch emoji. Reaction may be partial;
 * the caller is expected to have fetched it already.
 */
function isWatchReaction(reaction) {
    const id = reaction?.id ?? reaction?.emoji?.id;
    return id === WATCH_EMOJI_ID;
}

async function confirmLog(channel, sourceMessage, loggerId) {
    try {
        await channel.send({
            embeds: [{
                color: 0x334455,
                description: `📼 Quote archived from ${sourceMessage.url} — it may appear in a future **QOTD** round.`
            }],
            allowedMentions: { parse: [] }
        }).then(m => setTimeout(() => m.delete().catch(() => {}), 8_000));
    } catch { /* non-fatal */ }
}

module.exports = { WATCH_EMOJI_ID, logQuote, messagePingsWatchEmoji, isWatchReaction, confirmLog };
