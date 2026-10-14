const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const db = require('../database');
const casino = require('../systems/casino/casinoManager');
const { NEON, panel, gameEmbed } = require('../systems/games/gamenightUI');

/*
 * ⚡ MATH DUEL — open challenge, first correct answer takes the pot.
 *
 * /math opens a duel with a procedurally generated equation. The first
 * player to click the correct answer wins the pot (entry fees + house seed).
 * Every wrong click burns that player's fee into the pot and fattens the
 * prize for whoever is faster.
 */

const ENTRY_FEE = 200;
const HOUSE_SEED = 1_000;
const ANSWER_MS = 20_000;
const active = new Map(); // channelId -> session

function makeProblem(difficulty) {
    const ops = ['+', '−', '×'];
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const config = {
        easy: { max: 20, ops: ['+', '−'] },
        medium: { max: 60, ops: ['+', '−', '×'] },
        hard: { max: 150, ops: ['+', '−', '×'] }
    }[difficulty];
    const a = 2 + Math.floor(Math.random() * config.max);
    const b = 2 + Math.floor(Math.random() * config.max);
    const op = pick(config.ops);
    const answer = op === '+' ? a + b : op === '−' ? a - b : a * b;
    const shownOp = op === '−' ? '−' : op === '×' ? '×' : '+';
    return { text: `${a} ${shownOp} ${b}`, answer };
}

function buildChoices(answer) {
    // Correct answer + three near-misses that look plausible.
    const set = new Set([answer]);
    while (set.size < 4) {
        const delta = Math.max(1, Math.round(Math.abs(answer) * 0.12)) + Math.floor(Math.random() * 9);
        const candidate = answer + (Math.random() < 0.5 ? delta : -delta);
        if (candidate !== answer && candidate > -999) set.add(candidate);
    }
    return [...set].sort(() => Math.random() - 0.5);
}

function render(session) {
    const { problem } = session;
    return gameEmbed({
        title: 'MATH DUEL',
        color: NEON.cyan,
        lines: [
            panel(
                '```\n' +
                `DIFFICULTY: ${session.difficulty.toUpperCase()}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `\n` +
                `        ${problem.text} = ?\n` +
                `\n` +
                '```'
            ),
            `> 💰 **Pot:** 🪙 **${(HOUSE_SEED + session.pot).toLocaleString()}** (house seed + fees)`,
            `> ⚡ First correct click wins it all — wrong clicks only fatten the pot.`,
            `> ⏱️ <t:${Math.floor(session.deadline / 1000)}:R> on the clock.`
        ],
        footer: 'MATH DUEL · calculators are for the weak'
    });
}

function answerButtons(session) {
    return [new ActionRowBuilder().addComponents(
        session.choices.map((value, idx) => new ButtonBuilder()
            .setCustomId(`math_${session.id}_${idx}`)
            .setLabel(String(value))
            .setStyle(ButtonStyle.Primary))
    )];
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('math')
        .setDescription('Open a Math Duel — first correct answer takes the pot')
        .addStringOption(option => option.setName('difficulty')
            .setDescription('How evil the equation should be')
            .addChoices(
                { name: '🟢 Easy — small numbers', value: 'easy' },
                { name: '🟡 Medium', value: 'medium' },
                { name: '🔴 Hard — big numbers', value: 'hard' }
            )),
    ENTRY_FEE,
    async execute(interaction) {
        const channel = interaction.channel;
        if (active.has(channel.id)) {
            return interaction.reply({ content: '⚡ A duel is already running here — answer it!', ephemeral: true });
        }
        await interaction.deferReply();
        const wallet = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(interaction.user.id)?.wallet || 0);
        if (wallet < ENTRY_FEE) {
            return interaction.editReply({ content: `❌ You need 🪙 **${ENTRY_FEE}** in your wallet to open a duel.` });
        }

        const difficulty = interaction.options.getString('difficulty') ?? 'medium';
        const problem = makeProblem(difficulty);
        const session = {
            id: `${Date.now()}`,
            hostId: interaction.user.id,
            difficulty,
            problem,
            choices: buildChoices(problem.answer),
            pot: 0,
            wrong: new Set(),
            answered: false,
            deadline: Date.now() + ANSWER_MS
        };

        try { casino.debitWallet(interaction.user.id, 'math-duel', ENTRY_FEE, 'math duel entry'); }
        catch (error) {
            console.error('math fee failed', error);
            return interaction.editReply({ content: '❌ Could not take the entry fee — try again.' });
        }

        const message = await interaction.editReply({ embeds: [render(session)], components: answerButtons(session) });
        active.set(channel.id, session);

        const timer = setTimeout(async () => {
            if (session.answered) return;
            active.delete(channel.id);
            await message.edit({
                embeds: [gameEmbed({
                    title: 'MATH DUEL — TIMEOUT',
                    color: NEON.dim,
                    lines: [
                        panel(`\u0060\u0060\u0060\nNOBODY SOLVED IT\n===============\n${problem.text} = ${problem.answer}\n\u0060\u0060\u0060`),
                        `> 🪙 **${(HOUSE_SEED + session.pot).toLocaleString()}** burns with the equation.`
                    ]
                })],
                components: []
            }).catch(() => {});
        }, ANSWER_MS);

        const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: ANSWER_MS });
        collector.on('collect', async i => {
            try {
                if (session.answered) {
                    return i.reply({ content: '⚡ The duel is already decided.', ephemeral: true });
                }
                const idx = Number(i.customId.split('_').pop());
                const picked = session.choices[idx];
                if (picked === problem.answer) {
                    session.answered = true;
                    clearTimeout(timer);
                    active.delete(channel.id);
                    const prize = HOUSE_SEED + session.pot;
                    try { casino.creditWallet(i.user.id, 'math-duel', prize, 'payout', `solved ${problem.text}`); }
                    catch (error) { console.error('math payout failed', error); }
                    await i.update({
                        embeds: [gameEmbed({
                            title: 'MATH DUEL — SOLVED ⚡',
                            color: NEON.green,
                            lines: [
                                panel(`\u0060\u0060\u0060\n${problem.text} = ${problem.answer}\n=================\nSOLVED IN ${((Date.now() - (session.deadline - ANSWER_MS)) / 1000).toFixed(1)}s\n\u0060\u0060\u0060`),
                                `> 🏆 <@${i.user.id}> out-computed everyone and takes 🪙 **${prize.toLocaleString()}**.`
                            ]
                        })],
                        components: []
                    });
                    collector.stop('solved');
                    return;
                }
                // Wrong: burn the fee into the pot once per player.
                if (!session.wrong.has(i.user.id)) {
                    try {
                        casino.debitWallet(i.user.id, 'math-duel', ENTRY_FEE, 'math duel wrong answer');
                        session.pot += ENTRY_FEE;
                        session.wrong.add(i.user.id);
                    } catch { /* no wallet — let them keep clicking harmlessly */ }
                }
                await i.reply({ content: `❌ ${picked} is not it. The pot grows…`, ephemeral: true });
                const msg = await channel.messages.fetch(message.id).catch(() => null);
                if (msg) await msg.edit({ embeds: [render(session)], components: answerButtons(session) }).catch(() => {});
            } catch (error) {
                console.error('math duel error', error);
            }
        });
        collector.on('end', () => clearTimeout(timer));
    }
};
