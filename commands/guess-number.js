const { SlashCommandBuilder } = require('discord.js');
const db = require('../database');
const casino = require('../systems/casino/casinoManager');
const { NEON, panel, gameEmbed } = require('../systems/games/gamenightUI');

/*
 * 🔢 GUESS THE NUMBER — channel-wide free-to-play vault.
 *
 * The bot thinks of a number between 1 and 1000. Anyone types a guess in the
 * channel; reactions grade it instantly:
 *
 *   ✅ exact hit      — wins 🪙 500,000 (flat, every round)
 *   ❌ wrong          — miss
 *   🔁 already tried  — that exact number was guessed this round
 *   ⏳ cooldown       — 5s between guesses per user (anti-spam).
 *                        If your throttled guess WAS the vault number, the
 *                        bot still pays out — you'll see ✅ instead of ⏳
 *                        and just need to resend on a plain miss.
 *
 * Playing is completely FREE and UNLIMITED — everyone guesses as much as they
 * want until someone lands the exact number. The embed never shows hints or a
 * narrowed band — it only tells players to type any number between 1 and
 * 1000, so the guesser gets no help. Exactly one round embed exists at a
 * time; the round never times out. When the vault is cracked the old embed
 * is deleted, the winner is announced, and a brand-new round (new number,
 * new embed) starts immediately.
 */

const CHANNEL_ID = '1550990382072991804';
const PRIZE = 500_000; // flat payout for the exact hit — no fees ever
const GUESS_COOLDOWN_MS = 5_000; // 5s between guesses per user (anti-spam)

/*
 * In-memory per-user guess cooldown. 5 seconds is short enough that a restart
 * wiping it costs nothing — the round state itself lives in the database.
 */
const lastGuessAt = new Map();

function loadRound() {
    const row = db.prepare('SELECT * FROM gamenight_guess WHERE channel_id = ?').get(CHANNEL_ID);
    if (!row) return null;
    return {
        ...row,
        guesses: JSON.parse(row.guesses || '{}')
    };
}

function persist(row) {
    db.prepare(
        'UPDATE gamenight_guess SET guesses = ?, range_min = ?, range_max = ?, phase = ? WHERE message_id = ?'
    ).run(JSON.stringify(row.guesses), row.range_min, row.range_max, row.phase, row.message_id);
}

function render(row) {
    const guessCount = Object.values(row.guesses).reduce((a, b) => a + b, 0);
    // No hints, no narrowed band — the embed only states the rules so the
    // guesser gets zero help from it.
    const lines = [
        panel(
            '```\n' +
            `ROUND #${row.round} — VAULT LOCKED\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `PRIZE: 🪙 ${PRIZE.toLocaleString()} · FREE ENTRY · UNLIMITED GUESSES\n` +
            '```'
        ),
        `> 🎯 Type any number between **1** and **1000** in this channel.`,
        `> 🧮 Guesses so far: **${guessCount}**`
    ];
    return gameEmbed({
        title: 'GUESS THE NUMBER',
        color: NEON.gold,
        lines,
        footer: 'GUESS THE NUMBER · free entry · 5s cooldown between guesses · new round starts the moment the vault is cracked'
    });
}

/*
 * Launch a fresh round. Deletes any previous round row, posts the new round
 * embed, and (when a previous round was solved) shows who cracked it.
 */
async function freshRound(channel) {
    const prev = db.prepare('SELECT * FROM gamenight_guess WHERE channel_id = ?').get(CHANNEL_ID);
    // channel_id is UNIQUE — clear the previous round before inserting.
    db.prepare('DELETE FROM gamenight_guess WHERE channel_id = ?').run(CHANNEL_ID);

    const row = {
        message_id: null,
        channel_id: CHANNEL_ID,
        phase: 'active',
        number: 1 + Math.floor(Math.random() * 1000),
        range_min: 1,
        range_max: 1000,
        pot: 0,
        guesses: {},
        round: (prev?.round || 0) + 1,
        last_winner_id: prev?.last_winner_id || null,
        last_number: prev?.last_number || null
    };

    const msg = await channel.send({
        embeds: [render(row)],
        allowedMentions: { parse: [] }
    });
    row.message_id = msg.id;
    db.prepare(`
        INSERT INTO gamenight_guess (message_id, channel_id, phase, number, range_min, range_max, pot, guesses, round, last_winner_id, last_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(msg.id, CHANNEL_ID, row.phase, row.number, row.range_min, row.range_max,
        row.pot, JSON.stringify(row.guesses), row.round, row.last_winner_id, row.last_number);
    return msg;
}

/*
 * Someone landed the exact number:
 *   1. pay the winner
 *   2. announce the win
 *   3. delete the old round embed ("everything is deleted")
 *   4. start a new round immediately (new number, new embed)
 */
async function handleSolve(channel, row, winnerId, guessCount) {
    try {
        casino.creditWallet(winnerId, 'guess-the-number', PRIZE, 'payout',
            `guessed ${row.number} on round #${row.round}`);
    } catch (error) {
        console.error('guess payout failed', winnerId, error);
    }

    const crackedNumber = row.number;
    const crackedRound = row.round;

    // Store the result so the next round's embed can show it, then wipe the
    // solved round row ("everything is deleted").
    db.prepare(
        'UPDATE gamenight_guess SET phase = ?, last_winner_id = ?, last_number = ? WHERE message_id = ?'
    ).run('solved', winnerId, crackedNumber, row.message_id);

    const msg = await channel.messages.fetch(row.message_id).catch(() => null);
    if (msg) await msg.delete().catch(() => {});

    // Winner flash — the one permanent record of the round.
    await channel.send({
        content:
            `🏆 <@${winnerId}> **CRACKED THE VAULT!**\n` +
            `> 🎯 Round #${crackedRound} — the number was **${crackedNumber}**, found after **${guessCount}** guesses.\n` +
            `> 💰 Payout: 🪙 **${PRIZE.toLocaleString()}**\n` +
            `> ♻️ Vault restocked — a fresh number is live below. Good luck!`,
        allowedMentions: { users: [winnerId] }
    }).catch(() => {});

    // Brand-new round, brand-new embed.
    await freshRound(channel).catch(error => {
        console.error('guess auto-restart failed', error);
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('guess-number')
        .setDescription(`Start or check the Guess the Number round — exact hit wins 🪙${PRIZE.toLocaleString()}`),
    CHANNEL_ID,
    PRIZE,
    freshRound,
    async execute(interaction) {
        if (interaction.channelId !== CHANNEL_ID) {
            return interaction.reply({
                content: `🔢 The number vault lives in <#${CHANNEL_ID}> — run this there to start a round, or just type a guess!`
            });
        }
        const row = loadRound();
        if (row && row.phase === 'active') {
            // One live round — just surface its current state, no new embed.
            return interaction.reply({
                embeds: [render(row)],
                allowedMentions: { parse: [] }
            });
        }
        await interaction.reply({
            content: `🔢 **ROUND #${(row?.round || 0) + 1}** launching — new number locked in. Free to play; exact hit takes 🪙 **${PRIZE.toLocaleString()}**.`,
            allowedMentions: { parse: [] }
        });
        await freshRound(interaction.channel).catch(error => {
            console.error('guess fresh round failed', error);
        });
    },

    /* Called from index.js messageCreate routing for the game channel. */
    async handleMessage(message) {
        if (message.channelId !== CHANNEL_ID || message.author.bot) return false;
        const text = message.content.trim().replace(/^["']|["']$/g, '');
        if (!/^\d{1,4}$/.test(text)) return false;
        const guess = Number(text);
        if (guess < 1 || guess > 1000) return false;

        const row = loadRound();
        if (!row || row.phase !== 'active') return false;

        // ⏳ 5s cooldown per user — but grade a throttled guess BEFORE rejecting
        // it. Otherwise the winning number could land inside the cooldown
        // window, get swallowed by ⏳, and become permanently unguessable
        // (every resend would hit 🔁 "already tried" without ever paying).
        const now = Date.now();
        if (now - (lastGuessAt.get(message.author.id) || 0) < GUESS_COOLDOWN_MS) {
            if (guess === row.number) {
                // ✅ The cooldown caught the WINNING number — pay out anyway.
                lastGuessAt.set(message.author.id, now);
                const guessCount = Object.values(row.guesses).reduce((a, b) => a + b, 0);
                await handleSolve(message.channel, row, message.author.id, guessCount);
                return true;
            }
            message.react('⏳').catch(() => {});
            return true;
        }

        // Duplicate number → 🔁.
        if (row.guesses[guess]) {
            message.react('🔁').catch(() => {});
            return true;
        }
        lastGuessAt.set(message.author.id, now);

        row.guesses[guess] = (row.guesses[guess] || 0) + 1;
        const guessCount = Object.values(row.guesses).reduce((a, b) => a + b, 0);

        if (guess === row.number) {
            // ✅ solved — pay, delete the old embed, auto-start the next round.
            await handleSolve(message.channel, row, message.author.id, guessCount);
            return true;
        }

        // ❌ wrong — track it. (The band stays hidden; no hints are shown.)
        if (guess < row.number) row.range_min = Math.max(row.range_min, guess + 1);
        else row.range_max = Math.min(row.range_max, guess - 1);
        persist(row);
        message.react('❌').catch(() => {});
        // Update the shared embed at most every 10 guesses to stay rate-limit safe.
        if (guessCount % 10 === 0) {
            const msg = await message.channel.messages.fetch(row.message_id).catch(() => null);
            if (msg) await msg.edit({ embeds: [render(row)] }).catch(() => {});
        }
        return true;
    },

    async bootstrap(client) {
        try {
            const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
            if (!channel) {
                console.warn(`Guess channel ${CHANNEL_ID} not found — game idle until /guess-number.`);
                return;
            }
            /*
             * The round NEVER ends on its own — not even across restarts.
             * Grading is fully DB-backed, so an active round simply continues
             * where it left off: re-sync the round embed with the stored band
             * and keep accepting guesses.
             */
            const row = loadRound();
            if (row && row.phase === 'active') {
                const msg = await channel.messages.fetch(row.message_id).catch(() => null);
                if (msg) await msg.edit({ embeds: [render(row)] }).catch(() => {});
                console.log(`🔢 Guess the Number resumed round #${row.round} in #${channel.name ?? CHANNEL_ID} — the vault stays locked until someone cracks it`);
                return;
            }
            if (row) {
                // Stale void/solved row (e.g. a crash mid-payout): clear it so
                // /guess-number can open a clean round. A solved row already
                // paid out, so nothing is lost — the fresh round completes its
                // cycle on the next command.
                db.prepare('DELETE FROM gamenight_guess WHERE channel_id = ?').run(CHANNEL_ID);
            }
            console.log(`🔢 Guess the Number armed in #${channel.name ?? CHANNEL_ID} — waiting for /guess-number to start a round`);
        } catch (error) {
            console.error('Guess the Number bootstrap failed:', error);
        }
    }
};
