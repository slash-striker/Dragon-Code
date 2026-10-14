const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const db = require('../database');
const casino = require('../systems/casino/casinoManager');
const { NEON, panel, gameEmbed } = require('../systems/games/gamenightUI');

/*
 * 💣 BOMB DEFUSAL — one bomb, up to five engineers, ten-second questions.
 *
 * The lobby fills with volunteers; when armed, everyone shares one bomb and
 * one ticking clock. Each question flashes a 4-option panel; the first correct
 * click defuses that stage. Two wrong wires (or the clock hitting zero) and
 * 💥 everyone loses their stake. Survive all five stages and the pot plus a
 * house bonus splits evenly between the survivors.
 */

const ENTRY_FEE = 500;
const HOUSE_BONUS = 2_500;
const STAGES = 5;
const ANSWER_MS = 10_000;
const MAX_PLAYERS = 5;
const sessions = new Map(); // channelId -> session

const QUESTIONS = [
    { q: 'Which color wire is typically the "ground" in a bomb?', a: ['Green', 'Red', 'Blue', 'Yellow'], correct: 0 },
    { q: 'C4 explodes at roughly how many m/s?', a: ['1,500', '4,000', '8,000', '12,000'], correct: 2 },
    { q: 'A "dead man\'s switch" detonates when the trigger is…', a: ['Pressed', 'Released', 'Cut', 'Doubled'], correct: 1 },
    { q: 'Which tool safely neutralizes acid-based triggers?', a: ['Water', 'Baking soda', 'Salt', 'Sugar'], correct: 1 },
    { q: 'TNT stands for…', a: ['Tri-nitro toluene', 'Tetra-nitro tetrazine', 'Tungsten nitride tool', 'Titan nitro thruster'], correct: 0 },
    { q: 'Bomb squads mostly use robots because…', a: ['They are faster', 'No human risk', 'Cheaper', 'Louder'], correct: 1 },
    { q: 'What does an EOD suit weigh, roughly?', a: ['15 kg', '40 kg', '80 kg', '120 kg'], correct: 2 },
    { q: 'A "smart bomb" steers using…', a: ['GPS/laser guidance', 'Magnetism', 'Wind', 'Luck'], correct: 0 },
    { q: 'Cutting which wire is classically fatal in fiction?', a: ['Blue', 'Red', 'Green', 'All of them'], correct: 3 },
    { q: 'The first modern bomb disposal unit formed in…', a: ['WWI', 'WWII', 'Vietnam', 'Cold War'], correct: 1 }
];
const WIRES = ['🔴 Red', '🔵 Blue', '🟢 Green', '🟡 Yellow'];

function bombArt(stage) {
    // ASCII bomb with a lit fuse that shortens as stages are cleared.
    const fuse = '≪≈≈≈≈≈'.slice(0, Math.max(1, 6 - stage));
    return '```\n' +
        `        _..._      ${'✦'.repeat(stage)}\n` +
        `      .::::. \`.\n` +
        `     :::::::.   :   fuse: ${fuse || 'BURNED'}\n` +
        `     ::::::::  .'\n` +
        `      ':::::'\`.\n` +
        `        ':::.'\n` +
        '```';
}

function lobbyEmbed(session) {
    const players = [...session.players.values()];
    return gameEmbed({
        title: 'BOMB DEFUSAL — LOBBY',
        color: NEON.red,
        lines: [
            panel(
                '```\n' +
                `DEVICE: VX-9 SCHEDULER · ${STAGES} STAGE LOCK\n` +
                `ENTRY FEE: 🪙${ENTRY_FEE} · SURVIVOR POT: 🪙${(ENTRY_FEE * players.length + HOUSE_BONUS).toLocaleString()}\n` +
                '```'
            ),
            `> 👥 **Engineers (${players.length}/${MAX_PLAYERS}):** ${players.length ? players.map(id => `<@${id}>`).join(' · ') : '*none yet — be the first to strap in*'}`,
            `> 💣 **${STAGES} questions. ${ANSWER_MS / 1000}s each. Two wrong wires = 💥.**`,
            `> Survivors split the pot + a 🪙 **${HOUSE_BONUS.toLocaleString()}** house bonus.`,
            `> ⏱️ Starts automatically when **${MAX_PLAYERS}** engineers strap in, or press ARM when ready.`,
            '',
            `*Stakes are taken on start. Death is permanent (for this round).*`
        ],
        footer: 'BOMB DEFUSAL · do not feed the bomb after midnight'
    });
}

function stageEmbed(session, qIndex, wide) {
    const q = QUESTIONS[qIndex % QUESTIONS.length];
    return gameEmbed({
        title: `BOMB DEFUSAL — STAGE ${session.stage}/${STAGES}`,
        color: session.stage >= STAGES - 1 ? NEON.red : NEON.gold,
        lines: [
            bombArt(session.stage),
            `> ⚡ **${q.q}**`,
            `> ❌ Wrong wires so far: **${session.wrong}/${2}**`,
            wide ? '' : `> Click fast — first correct wire cuts it.`
        ],
        footer: `STAGE ${session.stage} · ${ANSWER_MS / 1000}s on the clock`
    });
}

function questionButtons(qIndex) {
    const q = QUESTIONS[qIndex % QUESTIONS.length];
    return [new ActionRowBuilder().addComponents(q.a.map((label, idx) =>
        new ButtonBuilder()
            .setCustomId(`bomb_${qIndex}_${idx}`)
            .setLabel(label)
            .setStyle(ButtonStyle.Secondary)
    ))];
}

async function beginRound(channel, session, message) {
    session.phase = 'active';
    session.stage = 1;
    session.wrong = 0;
    session.solved = 0;
    nextQuestion(channel, session, message);
}

async function nextQuestion(channel, session, message) {
    if (session.stage > STAGES) return endGame(channel, session, message, 'win');
    const qIndex = session.stage - 1 + Math.floor(Math.random() * QUESTIONS.length);
    session.qIndex = qIndex;
    session.solvedThisStage = false;
    session.answered = new Set();

    const embed = stageEmbed(session, qIndex);
    await message.edit({ embeds: [embed], components: questionButtons(qIndex) }).catch(() => {});
    session.deadline = Date.now() + ANSWER_MS;
    session.timer = setTimeout(() => {
        session.wrong++;
        if (session.wrong >= 2) return endGame(channel, session, message, 'explode');
        session.stage++;
        nextQuestion(channel, session, message);
    }, ANSWER_MS);
}

async function endGame(channel, session, message, outcome) {
    clearTimeout(session.timer);
    sessions.delete(channel.id);
    db.prepare('DELETE FROM gamenight_sessions WHERE id = ?').run(session.id);

    const players = [...session.players.values()];
    if (outcome === 'win') {
        const pot = ENTRY_FEE * players.length + HOUSE_BONUS;
        const share = Math.floor(pot / players.length);
        for (const id of players) {
            try { casino.creditWallet(id, 'bomb-defusal', share, 'payout', 'bomb defused'); }
            catch (error) { console.error('bomb payout failed', id, error); }
        }
        await message.edit({
            embeds: [gameEmbed({
                title: 'BOMB DEFUSAL — DEFUSED ✂️',
                color: NEON.green,
                lines: [
                    panel(
                        '```\n' +
                        'WIRE CUT — DEVICE INERT\n' +
                        '=======================\n' +
                        `ALL ${STAGES} STAGES CLEARED\n` +
                        '```'
                    ),
                    `> 🏆 **Survivors (${players.length}):** ${players.map(id => `<@${id}>`).join(' · ')}`,
                    `> 💰 Each earns 🪙 **${share.toLocaleString()}** (pot + house bonus).`
                ]
            })],
            components: []
        }).catch(() => {});
    } else {
        await message.edit({
            embeds: [gameEmbed({
                title: 'BOMB DEFUSAL — DETONATED 💥',
                color: NEON.red,
                lines: [
                    panel(
                        '```\n' +
                        '     💥💥💥\n' +
                        '   DEVICE TRIGGERED\n' +
                        '=====================\n' +
                        `FAILED AT STAGE ${session.stage}/${STAGES}\n` +
                        '```'
                    ),
                    `> ☠️ The engineers are... redecorated. The 🪙 **${(ENTRY_FEE * players.length).toLocaleString()}** pot burns with them.`,
                    `> ♻️ Another device can be armed any time with \`/bomb\`.`
                ]
            })],
            components: []
        }).catch(() => {});
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('bomb')
        .setDescription('Arm a bomb and defuse it with friends (party game, entry fee stakes)')
        .addSubcommand(sub => sub.setName('arm').setDescription('Open a bomb-defusal lobby'))
        .addSubcommand(sub => sub.setName('stats').setDescription('Your bomb-defusal record')),
    async execute(interaction) {
        // /activities delegates with action:stats instead of a subcommand.
        if (interaction.options.getSubcommand() === 'stats' || interaction.options.getString('action') === 'stats') {
            const stats = db.prepare('SELECT * FROM mini_game_stats WHERE userId = ? AND game = ?')
                .get(interaction.user.id, 'bomb-defusal');
            return interaction.reply({
                embeds: [gameEmbed({
                    userId: interaction.user.id,
                    title: 'BOMB DEFUSAL — RECORD',
                    lines: [stats
                        ? `> 🎮 Played **${stats.gamesPlayed}** · Defused **${stats.gamesWon}** · Earned 🪙 **${Number(stats.creditsEarned).toLocaleString()}**`
                        : '> No defusals on record. Volunteering is free… until it isn\'t.']
                })]
            });
        }

        const channel = interaction.channel;
        if (sessions.has(channel.id)) {
            return interaction.reply({ content: '💣 A bomb is already ticking in this channel.', ephemeral: true });
        }
        const existing = db.prepare(`SELECT * FROM gamenight_sessions WHERE channel_id = ? AND kind = 'bomb' AND phase = 'lobby'`)
            .get(channel.id);
        if (existing) db.prepare('DELETE FROM gamenight_sessions WHERE id = ?').run(existing.id);

        // Charge the host at arm time? No — fees are taken from all players
        // when the lobby arms, so joining is free until the bomb is live.
        const session = {
            id: `bomb-${channel.id}-${Date.now()}`,
            hostId: interaction.user.id,
            players: new Map([[interaction.user.id, true]]),
            stage: 0, wrong: 0, phase: 'lobby',
            startedAt: Date.now(), channelId: channel.id
        };
        sessions.set(channel.id, session);

        const embed = lobbyEmbed(session);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('bomb_join').setLabel('🧷 Strap in').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('bomb_leave').setLabel('🚪 Bail out').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('bomb_arm').setLabel('💣 ARM NOW').setStyle(ButtonStyle.Danger)
        );
        await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
        const message = await interaction.fetchReply();
        session.messageId = message.id;
        db.prepare(`INSERT INTO gamenight_sessions (id, channel_id, messageId, host_id, kind, phase, state, ends_at)
            VALUES (?, ?, ?, ?, 'bomb', 'lobby', '{}', ?)`)
            .run(session.id, channel.id, message.id, session.hostId, Date.now() + 5 * 60_000);

        const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 5 * 60_000 });
        collector.on('collect', async i => {
            try {
                if (session.phase !== 'lobby') {
                    // Active-game clicks are handled by armHandler below.
                    return;
                }
                if (i.customId === 'bomb_join') {
                    if (session.players.has(i.user.id)) {
                        return i.reply({ content: 'You are already strapped in.', ephemeral: true });
                    }
                    if (session.players.size >= MAX_PLAYERS) {
                        return i.reply({ content: `Lobby full (${MAX_PLAYERS} max).`, ephemeral: true });
                    }
                    // Wallet check at join so ARM never fails mid-charge.
                    const wallet = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(i.user.id)?.wallet || 0);
                    if (wallet < ENTRY_FEE) {
                        return i.reply({ content: `❌ You need 🪙 **${ENTRY_FEE}** in your wallet to strap in.`, ephemeral: true });
                    }
                    session.players.set(i.user.id, true);
                    await i.update({ embeds: [lobbyEmbed(session)], components: [row] });
                    if (session.players.size >= MAX_PLAYERS) {
                        // Keep the collector alive — it also grades the answers.
                        for (const id of session.players.keys()) {
                            try { casino.debitWallet(id, 'bomb-defusal', ENTRY_FEE, 'bomb entry'); }
                            catch (error) { console.error('bomb fee failed', id, error); }
                        }
                        await beginRound(channel, session, message);
                    }
                    return;
                }
                if (i.customId === 'bomb_leave') {
                    if (!session.players.has(i.user.id)) {
                        return i.reply({ content: 'You are not in this lobby.', ephemeral: true });
                    }
                    if (i.user.id === session.hostId && session.players.size === 1) {
                        collector.stop('empty');
                        sessions.delete(channel.id);
                        db.prepare('DELETE FROM gamenight_sessions WHERE id = ?').run(session.id);
                        return i.update({
                            embeds: [gameEmbed({ title: 'BOMB DEFUSAL — STOOD DOWN', color: NEON.dim, lines: ['> The host bailed. The bomb squad stands down.'] })],
                            components: []
                        });
                    }
                    session.players.delete(i.user.id);
                    return i.update({ embeds: [lobbyEmbed(session)], components: [row] });
                }
                if (i.customId === 'bomb_arm') {
                    if (i.user.id !== session.hostId) {
                        return i.reply({ content: 'Only the host can arm early.', ephemeral: true });
                    }
                    if (session.players.size < 1) {
                        return i.reply({ content: 'At least one engineer must strap in.', ephemeral: true });
                    }
                    // Collector stays live — same collector grades the wires.
                    for (const id of session.players.keys()) {
                        try { casino.debitWallet(id, 'bomb-defusal', ENTRY_FEE, 'bomb entry'); }
                        catch (error) { console.error('bomb fee failed', id, error); }
                    }
                    await i.update({ embeds: [lobbyEmbed(session)], components: [] });
                    await beginRound(channel, session, message);
                }
            } catch (error) {
                console.error('bomb lobby error', error);
                if (!i.replied && !i.deferred) {
                    await i.reply({ content: '❌ Something went wrong in the lobby.', ephemeral: true }).catch(() => {});
                }
            }
        });
        collector.on('end', async (_, reason) => {
            if (reason === 'time' && session.phase === 'lobby') {
                sessions.delete(channel.id);
                db.prepare('DELETE FROM gamenight_sessions WHERE id = ?').run(session.id);
                await message.edit({
                    embeds: [gameEmbed({ title: 'BOMB DEFUSAL — LOBBY EXPIRED', color: NEON.dim, lines: ['> Nobody armed the bomb. It times out gracefully. 💤'] })],
                    components: []
                }).catch(() => {});
            }
        });

        // Answer handler rides the SAME collector as the lobby so buttons
        // keep working after arming (stopping it would kill the wires).
        const armHandler = async i => {
            if (session.phase !== 'active') return;
            if (!i.customId.startsWith('bomb_') || session.qIndex === undefined) return;
            const [_, qIndexStr, choiceStr] = i.customId.split('_');
            if (Number(qIndexStr) !== session.qIndex) return;
            if (session.answered.has(i.user.id)) {
                return i.reply({ content: 'One wire per question!', ephemeral: true });
            }
            session.answered.add(i.user.id);
            const q = QUESTIONS[session.qIndex % QUESTIONS.length];
            const correct = Number(choiceStr) === q.correct;
            if (!correct) {
                session.wrong++;
                if (session.wrong >= 2) {
                    await i.reply({ content: `🔴💥 That was the second wrong wire, <@${i.user.id}>…`, ephemeral: true }).catch(() => {});
                    return endGame(channel, session, message, 'explode');
                }
                await i.reply({ content: `🔴 Wrong wire, <@${i.user.id}> — the fuse shortens (${session.wrong}/2).`, ephemeral: true });
                return;
            }
            session.solvedThisStage = true;
            clearTimeout(session.timer);
            await i.reply({ content: `✂️ <@${i.user.id}> cuts the right wire! Stage ${session.stage} cleared.`, ephemeral: false });
            session.stage++;
            setTimeout(() => nextQuestion(channel, session, message), 2_500);
        };
        collector.on('collect', armHandler);
    }
};
