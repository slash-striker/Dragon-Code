const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const db = require('../database');
const { NEON, panel, gameEmbed } = require('../systems/games/gamenightUI');

/*
 * 💬 QOTD — "somebody in this server said this…"
 *
 * Quotes are logged when members tag a message with the watch emoji
 * (949479338275913799) or when someone pings that emoji. /qotd pulls a random
 * unlogged quote, posts it, and everyone has 60 seconds to guess the author
 * by clicking. Guessed-right players earn a small credit bonus; the round
 * then reveals the truth and the quote never repeats.
 *
 * This command is also the activities hub for the party games:
 * /activities action:bomb · math · mafia · spy — same engines as the
 * old standalone commands, just sharing one slash slot.
 */

const ROUND_MS = 60_000;
const GUESS_BONUS = 300;

function pickQuote() {
    // A random quote that has never been used as a QOTD.
    const row = db.prepare(`
        SELECT q.* FROM quote_bank q
        LEFT JOIN qotd_state s ON s.quoteId = q.id
        WHERE s.messageId IS NULL
        ORDER BY RANDOM()
        LIMIT 1
    `).get();
    return row || null;
}

function tallyRender(session) {
    const counts = {};
    for (const target of Object.values(session.votes)) {
        counts[target] = (counts[target] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return '*no guesses yet*';
    return sorted.map(([id, n]) => `<@${id}> — **${n}**`).join(' · ');
}

function roundEmbed(session, revealed = false) {
    const lines = [
        panel(
            '```\n' +
            'SOMEBODY IN THIS SERVER SAID:\n' +
            '=============================\n' +
            `“${session.quote.content.slice(0, 220)}”\n` +
            '```'
        ),
        '',
        `> 🕵️ **Who said it?** Click your suspect below (match the numbers).`
    ];
    if (!revealed) {
        lines.push(`> ⏱️ Guesses close <t:${Math.floor(session.endsAt / 1000)}:R>.`);
        lines.push(`> 📊 Current: ${tallyRender(session)}`);
    } else {
        lines.push(`> 🎯 **It was <@${session.quote.authorId}>** in <#${session.quote.channelId}>.`);
        lines.push(`> 📊 Final votes: ${tallyRender(session)}`);
        const winners = Object.entries(session.votes)
            .filter(([, target]) => target === session.quote.authorId)
            .map(([voter]) => `<@${voter}>`);
        if (winners.length) {
            lines.push(`> 🏆 Detective${winners.length > 1 ? 's' : ''} of the round: ${winners.join(' · ')} (+🪙${GUESS_BONUS})`);
        } else {
            lines.push('> 🫥 Nobody guessed right. The author keeps their secrets.');
        }
    }
    return gameEmbed({
        title: revealed ? 'QUOTE OF THE DAY — REVEALED' : 'QUOTE OF THE DAY',
        color: revealed ? NEON.green : NEON.magenta,
        lines,
        footer: revealed ? 'QOTD · quotes never repeat' : 'QOTD · tag a message with the 👀-watch emoji to log it'
    });
}

function candidateButtons(session, disabled = false) {
    const rows = [];
    for (let i = 0; i < session.candidates.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(
            session.candidates.slice(i, i + 5).map((id, idx) => new ButtonBuilder()
                .setCustomId(`qotd_${session.messageId}_${id}`)
                .setLabel(`Suspect #${i + idx + 1}`)
                .setStyle(ButtonStyle.Primary)
                .setDisabled(disabled))
        ));
    }
    return rows;
}

async function postRound(channel, session) {
    const message = await channel.send({
        embeds: [roundEmbed(session)],
        components: candidateButtons(session)
    });
    session.messageId = message.id;
    db.prepare(`INSERT INTO qotd_state (messageId, quoteId, phase, endsAt, channelId, votes, revealed)
        VALUES (?, ?, 'open', ?, ?, '{}', 0)`)
        .run(message.id, session.quote.id, session.endsAt, channel.id);

    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: ROUND_MS });
    collector.on('collect', async i => {
        try {
            if (session.phase !== 'open') {
                return i.reply({ content: '⏳ This round is already revealed.', ephemeral: true });
            }
            const author = i.customId.split('_').pop();
            session.votes[i.user.id] = author;
            db.prepare('UPDATE qotd_state SET votes = ? WHERE messageId = ?')
                .run(JSON.stringify(session.votes), session.messageId);
            await i.reply({ content: '🗳️ Guess locked in.', ephemeral: true });
        } catch (error) {
            console.error('qotd vote error', error);
        }
    });
    collector.on('end', async () => {
        session.phase = 'revealed';
        db.prepare(`UPDATE qotd_state SET phase = 'revealed', revealed = 1, votes = ? WHERE messageId = ?`)
            .run(JSON.stringify(session.votes), session.messageId);
        try {
            await message.edit({ embeds: [roundEmbed(session, true)], components: [] });
        } catch (error) {
            console.error('qotd reveal failed', error);
        }
        // Pay the winners their bonus.
        for (const [voter, target] of Object.entries(session.votes)) {
            if (target === session.quote.authorId) {
                try {
                    const casino = require('../systems/casino/casinoManager');
                    casino.creditWallet(voter, 'qotd', GUESS_BONUS, 'payout', 'qotd correct guess');
                } catch (error) {
                    console.error('qotd payout failed', error);
                }
            }
        }
    });
    return message;
}

/*
 * Party-game delegation. Each subcommand spawns the exact flow the old
 * standalone command used — the engines are untouched, only the entry point
 * moved. The subcommand name maps 1:1 to the module.
 */
const PARTY_GAMES = ['bomb', 'math', 'mafia', 'spy'];

async function runPartyGame(interaction, game) {
    const map = {
        bomb: './bomb',
        math: './math',
        mafia: './mafia',
        spy: './spy'
    };
    const target = map[game];
    if (!target) {
        return interaction.reply({ content: `❌ Unknown party game: ${game}`, ephemeral: true });
    }
    // Lazy require so the hub never loads every engine on boot.
    const mod = require(target);
    await mod.execute(interaction);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('activities')
        .setDescription('QOTD + party games: bomb · math · mafia · spy (leave empty to start a QOTD round)')
        .addStringOption(sub => sub
            .setName('action')
            .setDescription('Leave empty to start a QOTD round in this channel')
            .addChoices(
                { name: '💬 QOTD — start a guess-the-author round', value: 'start' },
                { name: '📜 Vault — how many quotes are logged', value: 'count' },
                { name: '🔍 My record — your QOTD detective stats', value: 'stats' },
                { name: '💣 Bomb Defusal — co-op party game', value: 'bomb' },
                { name: '⚡ Math Duel — fastest answer wins', value: 'math' },
                { name: '🕵️ Mafia — social deduction (5–10 players)', value: 'mafia' },
                { name: '🎯 Spy Hunters — find the spy (4–8 players)', value: 'spy' }
            ))
        .addStringOption(sub => sub
            .setName('difficulty')
            .setDescription('Math Duel only: how evil the equation should be')
            .addChoices(
                { name: '🟢 Easy — small numbers', value: 'easy' },
                { name: '🟡 Medium', value: 'medium' },
                { name: '🔴 Hard — big numbers', value: 'hard' }
            )),

    runPartyGame,

    /*
     * mafia_…/spy_… component buttons are routed here by index.js (the
     * engines no longer own their own slash slot but keep their handlers).
     */
    async handleComponent(interaction) {
        const game = interaction.customId.startsWith('mafia_') ? 'mafia' : 'spy';
        const mod = require(game === 'mafia' ? './mafia' : './spy');
        if (typeof mod.handleComponent === 'function') {
            return mod.handleComponent(interaction);
        }
        return false;
    },

    async execute(interaction) {
        const sub = interaction.options.getString('action') ?? 'start';

        if (PARTY_GAMES.includes(sub)) {
            return runPartyGame(interaction, sub);
        }

        if (sub === 'count') {
            const { total, used } = db.prepare(`
                SELECT COUNT(*) AS total,
                       (SELECT COUNT(*) FROM qotd_state) AS used
                FROM quote_bank
            `).get();
            return interaction.reply({
                embeds: [gameEmbed({
                    title: 'QUOTE VAULT',
                    lines: [`> 📜 **${total}** quotes logged · **${used}** already used as QOTD.`]
                })]
            });
        }
        if (sub === 'stats') {
            const stats = db.prepare('SELECT * FROM mini_game_stats WHERE userId = ? AND game = ?')
                .get(interaction.user.id, 'qotd');
            return interaction.reply({
                embeds: [gameEmbed({
                    userId: interaction.user.id,
                    title: 'QOTD — YOUR RECORD',
                    lines: [stats
                        ? `> Rounds played **${stats.gamesPlayed}** · correct **${stats.gamesWon}** · earned 🪙 **${Number(stats.creditsEarned).toLocaleString()}**`
                        : '> No QOTD rounds on record yet.']
                })]
            });
        }

        // start
        await interaction.deferReply();
        const quote = pickQuote();
        if (!quote) {
            return interaction.editReply({
                embeds: [gameEmbed({
                    title: 'QUOTE VAULT EMPTY',
                    color: NEON.dim,
                    lines: ['> 😢 No unused quotes. Tag messages with the watch emoji (949479338275913799) to log them, or ping that emoji on a message.']
                })]
            });
        }

        // Build the suspect list: the author plus 3–7 random recent chatterers.
        const voters = db.prepare(`
            SELECT DISTINCT authorId FROM quote_bank
            WHERE authorId != ? ORDER BY RANDOM() LIMIT 7
        `).all(quote.authorId).map(r => r.authorId);
        const suspects = [quote.authorId, ...voters.slice(0, 6)]
            .sort(() => Math.random() - 0.5);

        const session = {
            quote, candidates: suspects, votes: {}, phase: 'open',
            endsAt: Date.now() + ROUND_MS, messageId: null
        };
        await interaction.deleteReply().catch(() => {});
        await postRound(interaction.channel, session);
    }
};
