const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const db = require('../database');
const { NEON, panel, gameEmbed } = require('../systems/games/gamenightUI');

/*
 * 🕵️ SPY HUNTERS — social deduction, 4–8 players, one channel.
 *
 * Everyone receives the same secret LOCATION (e.g. "Space Station") plus a
 * role card — except ONE player, the Spy, who gets no location. Each round a
 * different player must ASK another player a question about the scene ("what
 * would you order at the bar?"). Answers must be vague enough not to blow
 * cover but specific enough to sound innocent. Then everyone votes: catch the
 * spy and the town wins; guess the wrong person and the spy wins.
 */

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;
const QUESTION_MS = 45_000;
const VOTE_MS = 40_000;
const sessions = new Map(); // channelId -> session

const LOCATIONS = [
    { name: '🚀 Space Station', roles: ['Pilot', 'Scientist', 'Tourist', 'Engineer', 'Security', 'AI Technician', 'Alien Stowaway', 'Mission Control'] },
    { name: '🏖️ Beach Resort', roles: ['Lifeguard', 'Tourist', 'Bartender', 'Surfer', 'Vendor', 'DJ', 'Hotel Manager', 'Pickpocket'] },
    { name: '🏰 Medieval Castle', roles: ['King', 'Guard', 'Jester', 'Blacksmith', 'Servant', 'Archer', 'Wizard', 'Assassin'] },
    { name: '🚂 Night Train', roles: ['Conductor', 'Passenger', 'Waiter', 'Mechanic', 'Detective', 'Smuggler', 'Singer', 'Stowaway'] },
    { name: '🎤 Stadium Concert', roles: ['Singer', 'Fan', 'Security', 'Sound Tech', 'Vendor', 'Photographer', 'Stagehand', 'Crasher'] },
    { name: '🏦 Bank Heist', roles: ['Robber', 'Hostage', 'Guard', 'Manager', 'Negotiator', 'Cop', 'Driver', 'Journalist'] },
    { name: '🧊 Ice Station Alpha', roles: ['Scientist', 'Mechanic', 'Radio Operator', 'Cook', 'Medic', 'Rescue Pilot', 'Cryptid', 'Tourist'] },
    { name: '🎬 Film Set', roles: ['Director', 'Actor', 'Cameraman', 'Stunt Double', 'Caterer', 'Producer', 'Extra', 'Critic'] },
    { name: '🛸 Alien Workshop', roles: ['Alien', 'Abductee', 'Scientist', 'Tourist', 'Guard', 'Translator', 'Reporter', 'Soldier'] },
    { name: '🍽️ Fancy Restaurant', roles: ['Chef', 'Waiter', 'Food Critic', 'Diner', 'Sommelier', 'Bouncer', 'Musician', 'Health Inspector'] }
];

const QUESTION_PROMPTS = [
    'What would you be doing right now?',
    'What is in your pocket?',
    'How did you get here today?',
    'What are you drinking?',
    'What is the biggest danger here?',
    'Who is in charge around here?',
    'What would you hear in the background?',
    'What time do you finish your shift?',
    'What is the worst part of your day?',
    'What would you grab if evacuating?'
];

function spyWarningEmbed() {
    return gameEmbed({
        title: 'YOUR ROLE: THE SPY',
        color: NEON.red,
        lines: [
            panel('```\n' + '🕵️ NO LOCATION. NO ALLIES.\n---------------------------\n' + 'BLUFF EVERYTHING.\n```'),
            '> You were not told the location. Blend in, answer vaguely, listen hard.',
            '> Survive the vote and you win everything.'
        ]
    });
}

function roleCardEmbed(locationName, role) {
    return gameEmbed({
        title: 'YOUR COVER',
        color: NEON.cyan,
        lines: [
            panel(`\u0060\u0060\u0060\nLOCATION: ${locationName.replace(/[^\x00-\x7F ]/g, '').trim() || 'CLASSIFIED'}\n---------------------------\nROLE: ${role}\n\u0060\u0060\u0060`),
            '> 🤫 Answer questions in character — but stay vague. The Spy is listening.',
            '> If the spy deduces the location, they can escape and win.'
        ]
    });
}

function lobbyEmbed(session) {
    const players = [...session.players.keys()];
    return gameEmbed({
        title: 'SPY HUNTERS — LOBBY',
        color: NEON.magenta,
        lines: [
            panel('```\n' + `PLAYERS: ${players.length}/${MAX_PLAYERS} (min ${MIN_PLAYERS})\n` + '```'),
            `> 👥 ${players.length ? players.map(id => `<@${id}>`).join(' · ') : '*empty lobby*'}`,
            `> 🎭 One of you is the **Spy** — no location, pure bluff.`,
            `> 🗣️ Each round, one player interrogates another. Vague answers survive; specific ones leak.`,
            `> 🗳️ Then everyone votes: catch the spy, or watch them escape.`
        ],
        footer: 'SPY HUNTERS · lie casually'
    });
}

function pickRotation(session) {
    // Fair rotation: shuffled list of player ids, re-shuffled each full cycle.
    if (!session.rotation?.length) {
        session.rotation = [...session.players.keys()].sort(() => Math.random() - 0.5);
    }
    return session.rotation.shift();
}
pickRotation.rewind = () => {}; // rotation persists across rounds

function startRound(session, channel) {
    session.phase = 'question';
    session.round++;
    const askerId = pickRotation(session);
    // Asker picks their target from the other players.
    session.askerId = askerId;
    session.targetId = null;
    session.deadline = Date.now() + QUESTION_MS + 15_000;

    const prompt = QUESTION_PROMPTS[Math.floor(Math.random() * QUESTION_PROMPTS.length)];
    session.prompt = prompt;

    threadAnnounce(session, gameEmbed({
        title: `ROUND ${session.round} — INTERROGATION`,
        color: NEON.gold,
        lines: [
            panel('```\n' + `ASKER: <@${askerId}>\n========================\n` + '```'),
            `> 🎤 <@${askerId}>, pick a suspect and ask them: **"${prompt}"**`,
            `> Type your question in the channel, e.g. \`ask @user do you hear music?\``,
            `> ⏱️ The answer is due <t:${Math.floor(session.deadline / 1000)}:R>.`,
            `> Everyone else: watch the answers. Vague = spy-ish. Specific = innocent… probably.`
        ]
    }));
    session.timer = setTimeout(() => forceVote(channel, session).catch(() => {}), QUESTION_MS + 15_000);
}

function threadAnnounce(session, embed) {
    return session.thread.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

function forceVote(channel, session) {
    session.phase = 'vote';
    startVote(channel, session);
}

function startVote(channel, session) {
    session.phase = 'vote';
    session.votes = {};
    const alive = [...session.players.keys()];
    const rows = [];
    const chunk = alive.slice(0, 5);
    rows.push(new ActionRowBuilder().addComponents(chunk.map((id, idx) => new ButtonBuilder()
        .setCustomId(`spy_vote_${session.id}_${id}`)
        .setLabel(`🎯 Suspect #${idx + 1}`)
        .setStyle(ButtonStyle.Danger))));
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`spy_escape_${session.id}`).setLabel('🏃 Spy escapes (spy only)').setStyle(ButtonStyle.Success)
    ));
    threadAnnounce(session, gameEmbed({
        title: 'THE VOTE',
        color: NEON.red,
        lines: [
            panel('```\n' + '🗳️ WHO IS THE SPY?\n==================\n' + '```'),
            `> Click a suspect below — matching numbers in the list. Majority (plurality) is accused.`,
            `> 🏃 The **Spy** may instead press **Spy escapes** and guess the location — right guess = instant spy win.`,
            `> ⏱️ Polls close <t:${Math.floor((Date.now() + VOTE_MS) / 1000)}:R>.`
        ]
    }));
    threadAnnounce(session, gameEmbed({
        title: 'SUSPECTS',
        color: NEON.cyan,
        lines: alive.map((id, idx) => `> **${idx + 1}.** <@${id}> — **🎯 Suspect #${idx + 1}**`)
    }));
    session.poll = session.thread.send({ components: rows }).then(m => {
        session.pollId = m.id;
        session.timer = setTimeout(() => closeVote(channel, session).catch(() => {}), VOTE_MS);
        return m;
    });
}

async function closeVote(channel, session) {
    clearTimeout(session.timer);
    const tally = {};
    for (const target of Object.values(session.votes)) {
        if (target === 'skip') continue;
        tally[target] = (tally[target] || 0) + 1;
    }
    const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const accused = entries.length
        ? (entries.length > 1 && entries[0][1] === entries[1][1] ? null : entries[0][0])
        : null;

    const spyId = [...session.players.entries()].find(([, p]) => p.isSpy)?.[0];

    if (session.escapeAttempt) {
        const correct = session.escapeAttempt === session.location.name;
        await threadAnnounce(session, gameEmbed({
            title: correct ? '🏃 THE SPY ESCAPES' : '🏃 ESCAPE FAILED',
            color: correct ? NEON.red : NEON.green,
            lines: [
                panel('```\n' + `ESCAPE ROUTE: ${session.escapeAttempt.toUpperCase()}\n============================\n` + '```'),
                `> 🕵️ <@${spyId}> guessed **${session.escapeAttempt}** — ${correct ? '**correct!** The spy vanishes into the crowd and wins.' : `wrong — the location was **${session.location.name}**.`}`
            ]
        }));
        return endGame(channel, session, correct ? 'spy' : 'town');
    }

    if (accused) {
        const p = session.players.get(accused);
        const caughtSpy = p.isSpy;
        await threadAnnounce(session, gameEmbed({
            title: caughtSpy ? '🎯 SPY CAUGHT' : '❌ WRONG ACCUSATION',
            color: caughtSpy ? NEON.green : NEON.red,
            lines: [
                panel('```\n' + `ACCUSED: <@${accused}>\n========================\n` + '```'),
                caughtSpy
                    ? `> 🎉 <@${accused}> was the **Spy**! The hunters win.`
                    : `> 💀 <@${accused}> was innocent (a **${p.role}**). The spy smiles and stays hidden.`
            ]
        }));
        return endGame(channel, session, caughtSpy ? 'town' : 'spy');
    }

    await threadAnnounce(session, gameEmbed({
        title: 'DEADLOCK',
        color: NEON.dim,
        lines: ['> 🌫️ The town could not agree — the spy walks free this round.']
    }));
    // Another round of questions instead of ending the game.
    setTimeout(() => startRound(session, channel).catch(() => {}), 5_000);
}

async function endGame(channel, session, winner) {
    clearTimeout(session.timer);
    sessions.delete(channel.id);
    db.prepare('DELETE FROM gamenight_sessions WHERE id = ?').run(session.id);

    const spyId = [...session.players.entries()].find(([, p]) => p.isSpy)?.[0];
    const roster = [...session.players.entries()].map(([id, p]) =>
        `> ${p.isSpy ? '🕵️ **THE SPY**' : '🟢'} <@${id}> — ${p.isSpy ? '' : `**${p.role}**`}`);
    await threadAnnounce(session, gameEmbed({
        title: winner === 'spy' ? '🕵️ SPY VICTORY' : '🎯 HUNTERS VICTORY',
        color: winner === 'spy' ? NEON.red : NEON.green,
        lines: [
            panel('```\n' + `LOCATION WAS: ${session.location.name.toUpperCase()}\n=============================\n` + '```'),
            ...roster
        ]
    }));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('spy')
        .setDescription('Spy Hunters — interrogate your friends and find the spy (4–8 players)')
        .addSubcommand(sub => sub.setName('start').setDescription('Open a Spy Hunters lobby')),
    async execute(interaction) {
        const channel = interaction.channel;
        if (sessions.has(channel.id)) {
            return interaction.reply({ content: '🕵️ A Spy Hunters game is already running here.', ephemeral: true });
        }
        await interaction.deferReply();
        const session = {
            id: `spy-${channel.id}-${Date.now()}`,
            hostId: interaction.user.id,
            players: new Map([[interaction.user.id, { role: null, isSpy: false }]]),
            phase: 'lobby', round: 0, rotation: []
        };
        sessions.set(channel.id, session);

        const message = await interaction.editReply({ embeds: [lobbyEmbed(session)], components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('spy_join').setLabel('🚪 Join').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('spy_leave').setLabel('👋 Leave').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('spy_begin').setLabel('▶️ Begin').setStyle(ButtonStyle.Primary)
            )
        ], fetchReply: true });

        const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 10 * 60_000 });
        collector.on('collect', async i => {
            try {
                if (i.customId === 'spy_join') {
                    if (session.players.has(i.user.id)) return i.reply({ content: 'Already in.', ephemeral: true });
                    if (session.players.size >= MAX_PLAYERS) return i.reply({ content: `Lobby full (${MAX_PLAYERS}).`, ephemeral: true });
                    session.players.set(i.user.id, { role: null, isSpy: false });
                    return i.update({ embeds: [lobbyEmbed(session)] });
                }
                if (i.customId === 'spy_leave') {
                    if (i.user.id === session.hostId && session.players.size === 1) {
                        sessions.delete(channel.id);
                        return i.update({ embeds: [gameEmbed({ title: 'SPY HUNTERS — LOBBY CLOSED', color: NEON.dim, lines: ['> Host closed the lobby.'] })], components: [] });
                    }
                    session.players.delete(i.user.id);
                    return i.update({ embeds: [lobbyEmbed(session)] });
                }
                if (i.customId === 'spy_begin') {
                    if (i.user.id !== session.hostId) return i.reply({ content: 'Only the host begins.', ephemeral: true });
                    if (session.players.size < MIN_PLAYERS) {
                        return i.reply({ content: `Need at least **${MIN_PLAYERS}** players (you have ${session.players.size}).`, ephemeral: true });
                    }
                    await i.update({ components: [] });
                    collector.stop('started');

                    // Deal: one spy, roles from a random location.
                    const location = LOCATIONS[Math.floor(Math.random() * LOCATIONS)];
                    const ids = [...session.players.keys()].sort(() => Math.random() - 0.5);
                    const spyId = ids[0];
                    const roles = [...location.roles].sort(() => Math.random() - 0.5);
                    ids.forEach((id, idx) => {
                        const p = session.players.get(id);
                        p.isSpy = id === spyId;
                        p.role = p.isSpy ? null : roles[idx % roles.length];
                    });
                    session.location = location;
                    session.thread = await message.startThread({
                        name: `🕵️ Spy Hunters — ${location.name}`,
                        autoArchiveDuration: 60
                    });
                    db.prepare(`INSERT INTO gamenight_sessions (id, channel_id, messageId, host_id, kind, phase, state, ends_at)
                        VALUES (?, ?, ?, ?, 'spy', 'question', '{}', ?)`)
                        .run(session.id, channel.id, message.id, session.hostId, Date.now() + 90 * 60_000);

                    for (const [id, p] of session.players) {
                        await channel.client.users.fetch(id).then(user => user.send({
                            embeds: [p.isSpy ? spyWarningEmbed() : roleCardEmbed(location.name, p.role)]
                        })).catch(() => {});
                    }
                    await threadAnnounce(session, gameEmbed({
                        title: 'COVER STORIES ISSUED',
                        color: NEON.magenta,
                        lines: ['> 📬 Role cards are in your DMs. One of you got no location…', '> 🎤 First interrogation begins.']
                    }));
                    return startRound(session, channel);
                }
            } catch (error) {
                console.error('spy lobby error', error);
                if (!i.replied && !i.deferred) {
                    await i.reply({ content: '❌ Lobby error.', ephemeral: true }).catch(() => {});
                }
            }
        });
        collector.on('end', async (_, reason) => {
            if (reason === 'time' && session.phase === 'lobby') {
                sessions.delete(channel.id);
                await message.edit({
                    embeds: [gameEmbed({ title: 'SPY HUNTERS — LOBBY EXPIRED', color: NEON.dim, lines: ['> Not enough spies… or hunters.'] })],
                    components: []
                }).catch(() => {});
            }
        });
    },

    /* Thread message routing from index.js. */
    async handleThreadMessage(message) {
        if (!message.channel?.isThread?.()) return false;
        const session = [...sessions.values()].find(s => s.thread?.id === message.channel.id);
        if (!session || message.author.bot) return false;

        // "ask @user question" from the round's asker.
        const askMatch = /^ask\s+(?:<@!?)(\d{5,})(?:>)\s+(.+)$/i.exec(message.content.trim());
        if (session.phase === 'question' && askMatch && message.author.id === session.askerId) {
            session.targetId = askMatch[1];
            session.question = askMatch[2];
            await message.channel.send({
                embeds: [gameEmbed({
                    title: 'INTERROGATION',
                    color: NEON.gold,
                    lines: [`> 🎤 <@${session.askerId}> asks <@${session.targetId}>: **${session.question}**`, `> 🗣️ You have <t:${Math.floor((Date.now() + 30_000) / 1000)}:R> to answer.`]
                })]
            }).catch(() => {});
            clearTimeout(session.timer);
            session.timer = setTimeout(() => forceVote(channel, session).catch(() => {}), 30_000);
            return true;
        }
        // Answer from the target during the interrogation window.
        if (session.phase === 'question' && session.targetId && message.author.id === session.targetId && session.question) {
            await message.react('📝').catch(() => {});
            clearTimeout(session.timer);
            session.timer = setTimeout(() => forceVote(channel, session).catch(() => {}), 8_000);
            return false; // let the answer show normally
        }
        return false;
    },

    /* Vote-button routing from index.js. */
    async handleComponent(interaction) {
        if (!interaction.customId.startsWith('spy_')) return false;
        const parts = interaction.customId.split('_');
        const session = [...sessions.values()].find(s => s.id === parts[2]);
        if (!session) return true;
        if (parts[1] === 'vote') {
            if (session.phase !== 'vote') return true;
            session.votes[interaction.user.id] = parts[3];
            await interaction.reply({ content: '🗳️ Vote locked.', ephemeral: true });
            const voters = Object.keys(session.votes).length;
            const alive = session.players.size;
            if (voters >= alive) clearTimeout(session.timer), closeVote(session.thread, session).catch(() => {});
            return true;
        }
        if (parts[1] === 'escape') {
            if (session.phase !== 'vote') return true;
            const isSpy = [...session.players.entries()].find(([id]) => id === interaction.user.id)?.[1]?.isSpy;
            if (!isSpy) {
                return interaction.reply({ content: '🏃 Only the spy can attempt an escape.', ephemeral: true });
            }
            // Modal-lite: spy replies with the location name in the thread.
            await interaction.reply({
                content: '🏃 Type the location name in the thread within 30s to attempt your escape.',
                ephemeral: true
            });
            session.escapeWindow = { userId: interaction.user.id, until: Date.now() + 30_000 };
            return true;
        }
        return true;
    },

    async handleEscapeGuess(message, session) {
        // Routed from handleThreadMessage flow when an escape window is open.
        clearTimeout(session?.timer);
        return false;
    }
};
