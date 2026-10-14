const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, Events } = require('discord.js');
const db = require('../database');
const { NEON, panel, gameEmbed } = require('../systems/games/gamenightUI');

/*
 * 🕵️ MAFIA: NEON PROTOCOL — social deduction for 5–10 players, one thread.
 *
 * Flow: lobby → role cards DM'd → night (mafia + doctor act in the thread)
 * → dawn report → day discussion & lynch vote → repeat until one side wins.
 *
 * Roles (14 total, scaled by player count):
 *   🗡️ Mafia        — kills one player each night. Wins at parity or killing everyone.
 *   🩺 Doctor       — shields one player each night (self ok, not twice in a row).
 *   👮 Detective    — investigates one player each night; learns MAFIA / INNOCENT.
 *   🎤 Celebrity    — if killed, identity is revealed at dawn (public proof).
 *   🔫 Vigilante    — may shoot one player, once, on any night. Hates wrong guesses.
 *   🧠 Villager     — no power, all the gossip.
 */

const NIGHT_MS = 45_000;      // night phase length
const DAY_DISCUSS_MS = 60_000; // day discussion before the vote
const VOTE_MS = 30_000;
const MIN_PLAYERS = 5;
const MAX_PLAYERS = 10;
const sessions = new Map(); // channelId -> session

function roleListFor(count) {
    const mafia = Math.max(1, Math.floor(count / 4));
    const roles = [];
    for (let i = 0; i < mafia; i++) roles.push('mafia');
    if (count >= 5) roles.push('doctor');
    if (count >= 6) roles.push('detective');
    if (count >= 7) roles.push('vigilante');
    if (count >= 8) roles.push('celebrity');
    while (roles.length < count) roles.push('villager');
    return roles.sort(() => Math.random() - 0.5);
}

const ROLE_META = {
    mafia: { emoji: '🗡️', name: 'Mafia', desc: 'Each night, choose someone to eliminate. Win when mafia ≥ everyone else.' },
    doctor: { emoji: '🩺', name: 'Doctor', desc: 'Each night, shield one player from the mafia. Can\'t shield the same person twice in a row.' },
    detective: { emoji: '👮', name: 'Detective', desc: 'Each night, investigate one player. You learn MAFIA or INNOCENT.' },
    vigilante: { emoji: '🔫', name: 'Vigilante', desc: 'One bullet. Any night, you may shoot a suspect. Choose wisely.' },
    celebrity: { emoji: '🎤', name: 'Celebrity', desc: 'When you die, your role is revealed to the whole town at dawn.' },
    villager: { emoji: '🧠', name: 'Villager', desc: 'No special power — but your vote and your voice matter.' }
};

function roleCardEmbed(role) {
    const meta = ROLE_META[role];
    return gameEmbed({
        title: 'YOUR ROLE',
        color: role === 'mafia' ? NEON.red : NEON.cyan,
        lines: [
            panel(
                '```\n' +
                `${meta.emoji} ${meta.name.toUpperCase()}\n` +
                '-------------------\n' +
                `${meta.desc}\n` +
                '```'
            ),
            '> 🤐 Tell no one. The thread is the town square.',
            role === 'mafia' ? '> 🗡️ Your partners will be named in the night thread.' : ''
        ]
    });
}

function lobbyEmbed(session) {
    const players = [...session.players.keys()];
    return gameEmbed({
        title: 'MAFIA: NEON PROTOCOL — LOBBY',
        color: NEON.purple,
        lines: [
            panel(
                '```\n' +
                `PLAYERS: ${players.length}/${MAX_PLAYERS} (min ${MIN_PLAYERS})\n` +
                `ROLES: mafia ${Math.max(1, Math.floor(Math.max(players.length, MIN_PLAYERS) / 4))} · doctor · detective\n` +
                `${players.length >= 7 ? 'vigilante · ' : ''}${players.length >= 8 ? 'celebrity · ' : ''}villagers\n` +
                '```'
            ),
            `> 👥 ${players.length ? players.map(id => `<@${id}>`).join(' · ') : '*empty lobby*'}`,
            `> 🌙 Nights = secret actions in the thread. ☀️ Days = debate + lynch vote.`,
            `> 🗡️ Mafia win at parity. 🏘️ Town wins when every mafia is gone.`,
            `> Starts automatically at **${MAX_PLAYERS} players** — or the host presses START.`
        ],
        footer: 'MAFIA · trust no one, especially the quiet ones'
    });
}

function aliveList(session) {
    // During the game, roles stay secret — names only.
    return [...session.players.entries()]
        .filter(([, p]) => p.alive)
        .map(([id]) => `<@${id}>`);
}

async function threadAnnounce(session, embed, content = null) {
    await session.thread.send({ content, embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

async function startNight(channel, session, reason = 'Night falls.') {
    session.phase = 'night';
    session.night++;
    session.nightActions = { mafia: {}, doctor: null, detective: null, vigilante: null };

    await threadAnnounce(session, gameEmbed({
        title: `NIGHT ${session.night}`,
        color: NEON.purple,
        lines: [
            panel('```\n' + '🌙 THE CITY SLEEPS\n==================\n' + reason + '\n```'),
            `> 🗡️ **Mafia** — name a target (type \`kill @player\`).`,
            `> 🩺 **Doctor** — \`shield @player\` (not the same person twice in a row).`,
            `> 👮 **Detective** — \`investigate @player\`.`,
            `> 🔫 **Vigilante** — \`shoot @player\` (one bullet, ever).`,
            `> ⏱️ Actions resolve <t:${Math.floor((Date.now() + NIGHT_MS) / 1000)}:R>.`
        ]
    }));

    // Publicly ping the roles that act tonight, without revealing who is who
    // beyond what the role list already implies.
    session.timer = setTimeout(() => resolveNight(channel, session).catch(() => {}), NIGHT_MS);
}

function parseAction(text) {
    const match = /^(kill|shield|investigate|shoot)\s+(?:<@!?)(\d{5,})(?:>)$/i.exec(text.trim());
    return match ? { action: match[1].toLowerCase(), targetId: match[2] } : null;
}

async function resolveNight(channel, session) {
    clearTimeout(session.timer);
    session.phase = 'dawn';
    const actions = session.nightActions;
    const deaths = new Set();

    // Vigilante shot.
    if (actions.vigilante?.targetId) {
        const target = session.players.get(actions.vigilante.targetId);
        if (target?.alive) deaths.add(actions.vigilante.targetId);
    }
    // Mafia kill (majority target, or first submitted).
    const killVotes = Object.values(actions.mafia || {});
    if (killVotes.length) {
        const tally = {};
        for (const t of killVotes) tally[t] = (tally[t] || 0) + 1;
        const targetId = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
        const shielded = actions.doctor === targetId;
        const target = session.players.get(targetId);
        if (!shielded && target?.alive) {
            deaths.add(targetId);
            target.diedBy = 'mafia';
        } else if (shielded) {
            session.lastSaved = targetId;
        }
    }
    // Detective result goes to the detective by DM.
    if (actions.detective?.targetId) {
        const target = session.players.get(actions.detective.targetId);
        const detective = [...session.players.entries()].find(([, p]) => p.role === 'detective' && p.alive);
        if (detective && target) {
            const isMafia = target.role === 'mafia';
            await channel.client.users.fetch(detective[0]).then(user => user.send({
                embeds: [gameEmbed({
                    title: 'DETECTIVE REPORT',
                    color: isMafia ? NEON.red : NEON.green,
                    lines: [`> 🔍 <@${actions.detective.targetId}> is **${isMafia ? '🗡️ MAFIA' : '✅ INNOCENT'}**.`]
                })]
            })).catch(() => {});
        }
    }

    for (const id of deaths) {
        const p = session.players.get(id);
        p.alive = false;
        p.revealed = p.role === 'celebrity';
    }

    // Win checks.
    const alive = [...session.players.values()].filter(p => p.alive);
    const mafiaAlive = alive.filter(p => p.role === 'mafia').length;
    if (mafiaAlive === 0) return endGame(channel, session, 'town');
    if (mafiaAlive >= alive.length - mafiaAlive) return endGame(channel, session, 'mafia');

    // Dawn report.
    const lines = [panel('```\n' + '☀️ DAWN BREAKS\n================\n' + '```')];
    if (deaths.size === 0) {
        lines.push('> 🎉 Everyone made it through the night. The doctor earns their keep.');
    } else {
        for (const id of deaths) {
            const p = session.players.get(id);
            lines.push(`> 💀 <@${id}> was eliminated${p.revealed ? ` — they were the 🎤 **${ROLE_META[p.role].name}**!` : ''}.`);
        }
        if (session.lastSaved) lines.push(`> 🩺 A life was saved overnight — the shield held.`);
    }
    lines.push('');
    lines.push(`> 🏘️ **Alive (${alive.length}):** ${alive.map(p => p.id ? '' : '').join('')}${aliveList(session).join(' · ')}`);
    lines.push(`> 💬 Day ${session.night}: debate below. Voting opens shortly.`);

    await threadAnnounce(session, gameEmbed({ title: `DAWN ${session.night}`, color: NEON.gold, lines }));
    session.discussTimer = setTimeout(() => startVote(channel, session).catch(() => {}), DAY_DISCUSS_MS);
}

async function startVote(channel, session) {
    session.phase = 'vote';
    session.votes = {};
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mafia_skip_${session.id}`).setLabel('☕ Skip lynching').setStyle(ButtonStyle.Secondary)
    );
    await threadAnnounce(session, gameEmbed({
        title: `TRIAL — DAY ${session.night}`,
        color: NEON.red,
        lines: [
            panel('```\n' + '⚖️ LYNCH VOTE\n=============\n' + '```'),
            `> Vote by clicking a name below. Majority (plurality) is lynched. Ties = no lynch.`,
            `> ⏱️ Polls close <t:${Math.floor((Date.now() + VOTE_MS) / 1000)}:R>.`
        ]
    }));
    const alive = [...session.players.entries()].filter(([, p]) => p.alive);
    const voteRow = new ActionRowBuilder().addComponents(
        alive.slice(0, 5).map(([id], idx) => new ButtonBuilder()
            .setCustomId(`mafia_vote_${session.id}_${id}`)
            .setLabel(`⚖️ Lynch #${idx + 1}`)
            .setStyle(ButtonStyle.Danger))
    );
    // Buttons can only show labels, so the embed lists the candidates.
    await threadAnnounce(session, gameEmbed({
        title: 'CANDIDATES',
        color: NEON.cyan,
        lines: alive.map(([id], idx) => `> **${idx + 1}.** <@${id}> — matches **⚖️ Lynch #${idx + 1}**`)
    }), null);
    const poll = await session.thread.send({ components: [voteRow, row] });
    session.pollId = poll.id;
    session.timer = setTimeout(() => closeVote(channel, session).catch(() => {}), VOTE_MS);
}

async function closeVote(channel, session) {
    clearTimeout(session.timer);
    const tally = {};
    for (const target of Object.values(session.votes)) tally[target] = (tally[target] || 0) + 1;
    const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    let lynched = null;
    if (entries.length && (entries.length > 1 ? entries[0][1] > entries[1][1] : true)) {
        lynched = entries[0][0];
    }
    if (lynched) {
        const p = session.players.get(lynched);
        p.alive = false;
        p.revealed = true; // lynch reveals the role
        await threadAnnounce(session, gameEmbed({
            title: 'THE TOWN HAS SPOKEN',
            color: NEON.red,
            lines: [
                panel('```\n' + '⚖️ VERDICT: GUILTY\n==================\n' + '```'),
                `> 💀 <@${lynched}> was lynched — they were ${ROLE_META[p.role].emoji} **${ROLE_META[p.role].name}**!`
            ]
        }));
    } else {
        await threadAnnounce(session, gameEmbed({
            title: 'NO CONSENSUS',
            color: NEON.dim,
            lines: ['> 🌫️ The town cannot agree. No one hangs today.']
        }));
    }

    const alive = [...session.players.values()].filter(p => p.alive);
    const mafiaAlive = alive.filter(p => p.role === 'mafia').length;
    if (mafiaAlive === 0) return endGame(channel, session, 'town');
    if (mafiaAlive >= alive.length - mafiaAlive) return endGame(channel, session, 'mafia');

    setTimeout(() => startNight(channel, session, 'The trial is over. Dusk approaches.').catch(() => {}), 5_000);
}

async function endGame(channel, session, winner) {
    clearTimeout(session.timer);
    clearTimeout(session.discussTimer);
    sessions.delete(channel.id);
    db.prepare('DELETE FROM gamenight_sessions WHERE id = ?').run(session.id);

    const roster = [...session.players.entries()].map(([id, p]) =>
        `> ${p.alive ? '🟢' : '💀'} <@${id}> — ${ROLE_META[p.role].emoji} **${ROLE_META[p.role].name}**`);
    await threadAnnounce(session, gameEmbed({
        title: winner === 'mafia' ? '🗡️ MAFIA VICTORY' : '🏘️ TOWN VICTORY',
        color: winner === 'mafia' ? NEON.red : NEON.green,
        lines: [
            panel('```\n' + (winner === 'mafia' ? 'THE CITY BELONGS TO THE MAFIA' : 'THE TOWN IS CLEAN AGAIN') + '\n=============================\n' + '```'),
            ...roster
        ]
    }));
    // Unarchive guard: keep the thread open a while so players can react.
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mafia')
        .setDescription('Mafia: Neon Protocol — social deduction with friends (5–10 players)')
        .addSubcommand(sub => sub.setName('start').setDescription('Open a Mafia lobby in this channel')),
    async execute(interaction) {
        const channel = interaction.channel;
        if (sessions.has(channel.id)) {
            return interaction.reply({ content: '🕵️ A game is already running in this channel.', ephemeral: true });
        }
        await interaction.deferReply();
        const session = {
            id: `mafia-${channel.id}-${Date.now()}`,
            hostId: interaction.user.id,
            players: new Map([[interaction.user.id, { role: null, alive: true, id: interaction.user.id }]]),
            phase: 'lobby', night: 0
        };
        sessions.set(channel.id, session);

        const message = await interaction.editReply({ embeds: [lobbyEmbed(session)], components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('mafia_join').setLabel('🚪 Join').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('mafia_leave').setLabel('👋 Leave').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('mafia_begin').setLabel('▶️ Begin').setStyle(ButtonStyle.Primary)
            )
        ], fetchReply: true });

        const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 10 * 60_000 });
        collector.on('collect', async i => {
            try {
                if (i.customId === 'mafia_join') {
                    if (session.players.has(i.user.id)) return i.reply({ content: 'You are already in.', ephemeral: true });
                    if (session.players.size >= MAX_PLAYERS) return i.reply({ content: `Lobby full (${MAX_PLAYERS}).`, ephemeral: true });
                    session.players.set(i.user.id, { role: null, alive: true, id: i.user.id });
                    return i.update({ embeds: [lobbyEmbed(session)] });
                }
                if (i.customId === 'mafia_leave') {
                    if (i.user.id === session.hostId && session.players.size === 1) {
                        sessions.delete(channel.id);
                        return i.update({ embeds: [gameEmbed({ title: 'MAFIA — LOBBY CLOSED', color: NEON.dim, lines: ['> The host closed the lobby.'] })], components: [] });
                    }
                    session.players.delete(i.user.id);
                    return i.update({ embeds: [lobbyEmbed(session)] });
                }
                if (i.customId === 'mafia_begin') {
                    if (i.user.id !== session.hostId) return i.reply({ content: 'Only the host begins the game.', ephemeral: true });
                    if (session.players.size < MIN_PLAYERS) {
                        return i.reply({ content: `Need at least **${MIN_PLAYERS}** players (you have ${session.players.size}).`, ephemeral: true });
                    }
                    await i.update({ components: [] });
                    collector.stop('started');

                    // Create the thread and deal roles.
                    const thread = await message.startThread({
                        name: `🕵️ Mafia: Neon Protocol — Night 0`,
                        autoArchiveDuration: 60
                    });
                    session.thread = thread;
                    db.prepare(`INSERT INTO gamenight_sessions (id, channel_id, messageId, host_id, kind, phase, state, ends_at)
                        VALUES (?, ?, ?, ?, 'mafia', 'night', '{}', ?)`)
                        .run(session.id, channel.id, message.id, session.hostId, Date.now() + 2 * 60 * 60_000);

                    const roles = roleListFor(session.players.size);
                    let idx = 0;
                    for (const [id, p] of session.players) {
                        p.role = roles[idx++];
                        await channel.client.users.fetch(id).then(user => user.send({ embeds: [roleCardEmbed(p.role)] })).catch(() => {});
                    }
                    const mafia = [...session.players.entries()].filter(([, p]) => p.role === 'mafia');
                    for (const [id] of mafia) {
                        await channel.client.users.fetch(id).then(user => user.send({
                            embeds: [gameEmbed({
                                title: 'YOUR MAFIA PARTNERS',
                                color: NEON.red,
                                lines: mafia.map(([mid]) => `> 🗡️ <@${mid}>`)
                            })]
                        })).catch(() => {});
                    }
                    await thread.send({
                        embeds: [gameEmbed({
                            title: 'ROLES DEALT',
                            color: NEON.purple,
                            lines: ['> 📬 Check your DMs for your role card. Mafia: you know your partners.', '> 🌙 Night 1 begins now.']
                        })]
                    }).catch(() => {});
                    return startNight(channel, session, 'Roles are dealt. The city sleeps.');
                }
            } catch (error) {
                console.error('mafia lobby error', error);
                if (!i.replied && !i.deferred) {
                    await i.reply({ content: '❌ Lobby error.', ephemeral: true }).catch(() => {});
                }
            }
        });
        collector.on('end', async (_, reason) => {
            if (reason === 'time' && session.phase === 'lobby') {
                sessions.delete(channel.id);
                await message.edit({
                    embeds: [gameEmbed({ title: 'MAFIA — LOBBY EXPIRED', color: NEON.dim, lines: ['> Not enough operatives. The city stays quiet.'] })],
                    components: []
                }).catch(() => {});
            }
        });
    },

    /* Thread message routing from index.js. */
    async handleThreadMessage(message) {
        if (!message.channel?.isThread?.()) return false;
        const session = [...sessions.values()].find(s => s.thread?.id === message.channel.id);
        if (!session || session.phase !== 'night' || message.author.bot) return false;
        const player = session.players.get(message.author.id);
        if (!player?.alive) return false;

        const parsed = parseAction(message.content);
        if (!parsed) return false;

        const targetId = parsed.targetId;
        const target = session.players.get(targetId);
        if (!target) return false;

        if (parsed.action === 'kill' && player.role === 'mafia') {
            session.nightActions.mafia[message.author.id] = targetId;
            await message.react('🗡️').catch(() => {});
        } else if (parsed.action === 'shield' && player.role === 'doctor') {
            if (targetId === session.lastShielded) {
                await message.reply({ content: '🩺 You cannot shield the same person twice in a row.', ephemeral: false }).then(r => setTimeout(() => r.delete().catch(() => {}), 8_000)).catch(() => {});
                return true;
            }
            session.nightActions.doctor = targetId;
            session.lastShielded = targetId;
            await message.react('🩺').catch(() => {});
        } else if (parsed.action === 'investigate' && player.role === 'detective') {
            session.nightActions.detective = { targetId };
            await message.react('👮').catch(() => {});
        } else if (parsed.action === 'shoot' && player.role === 'vigilante') {
            if (session.vigilanteUsed) {
                await message.reply({ content: '🔫 You already fired your only bullet.', ephemeral: false }).then(r => setTimeout(() => r.delete().catch(() => {}), 8_000)).catch(() => {});
                return true;
            }
            session.vigilanteUsed = true;
            session.nightActions.vigilante = { targetId };
            await message.react('🔫').catch(() => {});
        }
        return true;
    },

    /* Vote-button routing from index.js component collector. */
    async handleComponent(interaction) {
        if (!interaction.customId.startsWith('mafia_')) return false;
        const parts = interaction.customId.split('_');
        if (parts[1] === 'vote') {
            const session = [...sessions.values()].find(s => s.id === parts[2]);
            if (!session || session.phase !== 'vote') return true;
            session.votes[interaction.user.id] = parts[3];
            await interaction.reply({ content: `⚖️ Your vote is locked in.`, ephemeral: true });
            return true;
        }
        if (parts[1] === 'skip') {
            const session = [...sessions.values()].find(s => s.id === parts[2]);
            if (!session || session.phase !== 'vote') return true;
            session.votes[interaction.user.id] = 'skip';
            await interaction.reply({ content: '☕ You vote to skip.', ephemeral: true });
            return true;
        }
        return true;
    }
};
