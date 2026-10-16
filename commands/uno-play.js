const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    SlashCommandBuilder,
    StringSelectMenuBuilder
} = require('discord.js');
const uno = require('../systems/games/uno');
const { renderTable, cardLabel, COLOR_EMOJI } = require('../systems/games/unoRender');

const UNO_CHANNEL_ID = '1560441728664731709';
const TURN_MS = 60_000;
const BOT_DELAY_MS = 1_500;
const ROUND_BREAK_MS = 8_000;
const LOBBY_MS = 10 * 60_000;
const EMBED_COLORS = { red: 0xff3b5c, yellow: 0xffd23f, green: 0x2ee59d, blue: 0x3a86ff, wild: 0x9b5cff };
const BUTTON_STYLES = { red: ButtonStyle.Danger, yellow: ButtonStyle.Secondary, green: ButtonStyle.Success, blue: ButtonStyle.Primary };

// gameId -> game, and channelId -> gameId (one table per channel).
const games = new Map();
const channelGames = new Map();

function displayName(interaction) {
    return interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username;
}

function button(customId, label, style, disabled = false) {
    return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
}

function newBot(botNumber) {
    return { id: `bot-${botNumber}`, name: botNumber === 1 ? 'UNO Bot' : `UNO Bot ${botNumber}`, isBot: true };
}

function lobbyPayload(game) {
    const seats = game.lobby.map((player, index) =>
        `${index + 1}. ${player.isBot ? '🤖' : '🧑'} ${player.name}${player.id === game.hostId ? ' 👑' : ''}`);
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.yellow)
        .setTitle('🃏 UNO LOBBY')
        .setDescription([
            `Host: <@${game.hostId}> · Mode: **${game.mode === 'bot' ? 'Vs bot' : `${game.maxPlayers} players`}** · Rules: **${uno.describeRules(game.rulesMode)}**`,
            `Seats: **${game.lobby.length}/${game.maxPlayers}** — the table starts when it fills, or when the host presses Start (2+ players).`,
            '',
            seats.join('\n') || '_No players yet_'
        ].join('\n'))
        .setFooter({ text: 'Lobby closes after 10 minutes without a start' })
        .setTimestamp();
    const full = game.lobby.length >= game.maxPlayers;
    const row = new ActionRowBuilder().addComponents(
        button(`uno:join:${game.id}`, 'Join', ButtonStyle.Success, full),
        button(`uno:leave:${game.id}`, 'Leave', ButtonStyle.Secondary),
        button(`uno:bot:${game.id}`, 'Add bot', ButtonStyle.Secondary, full),
        button(`uno:start:${game.id}`, 'Start', ButtonStyle.Primary, game.lobby.length < 2),
        button(`uno:cancel:${game.id}`, 'Cancel', ButtonStyle.Danger)
    );
    return { embeds: [embed], components: [row] };
}

function tableRows(game) {
    return [
        new ActionRowBuilder().addComponents(
            button(`uno:hand:${game.id}`, '🂠 My Hand', ButtonStyle.Primary),
            button(`uno:draw:${game.id}`, '⬇ Draw', ButtonStyle.Secondary),
            button(`uno:call:${game.id}`, '📣 UNO!', ButtonStyle.Success),
            button(`uno:catch:${game.id}`, '🎯 Catch', ButtonStyle.Danger)
        ),
        new ActionRowBuilder().addComponents(
            button(`uno:quit:${game.id}`, '🚪 End table', ButtonStyle.Secondary)
        )
    ];
}

function standingsLines(engine) {
    return engine.players.map(player => {
        const cards = `${player.hand.length} card${player.hand.length === 1 ? '' : 's'}`;
        const unoTag = player.hand.length === 1 ? (player.calledUno ? ' · UNO ✅' : ' · ⚠️ no UNO') : '';
        return `${player.isBot ? '🤖' : '🧑'} **${player.name}** — ${cards} · ${player.score} pts${unoTag}`;
    }).join('\n');
}

async function gamePayload(game, note = '') {
    const engine = game.engine;
    const current = uno.currentPlayer(engine);
    const top = uno.topCard(engine);
    const png = renderTable(engine, { turnPlayerId: current?.id });
    const attachment = new AttachmentBuilder(png, { name: 'uno-table.png' });
    const turnLine = engine.status === 'playing'
        ? `Turn: **${current.name}**${current.isBot ? ' (thinking…)' : ` — <@${current.id}>, ${Math.round(TURN_MS / 1000)}s on the clock`}`
        : `Round over — next round starts shortly.`;
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS[engine.color] ?? EMBED_COLORS.wild)
        .setTitle(`🃏 UNO · Round ${engine.round}`)
        .setDescription([
            turnLine,
            `Top card: **${cardLabel(top)}** ${COLOR_EMOJI[top.color] ?? ''} · Colour: **${(engine.color ?? '').toUpperCase()}**`,
            engine.pendingDraw > 0 ? (engine.rulesMode === 'normal'
                ? `⚠️ **+${engine.pendingDraw}** pending — draw it (no stacking in Normal).`
                : engine.rulesMode === 'spicy'
                    ? `⚠️ **+${engine.pendingDraw}** pending — stack any +2/+4 or draw.`
                    : `⚠️ **+${engine.pendingDraw}** pending — stack a matching +2/+4 or draw.`) : '',
            note ? `\n${note}` : '',
            '',
            standingsLines(engine)
        ].filter(line => line !== '').join('\n'))
        .setImage('attachment://uno-table.png')
        .setFooter({ text: `First to ${engine.targetScore} points wins · ${uno.describeRules(engine.rulesMode)} · Open "My Hand" to play privately` })
        .setTimestamp();
    return { embeds: [embed], components: tableRows(game), files: [attachment], attachments: [] };
}

async function updatePublic(game, note = '') {
    if (!game.message || game.ended) return;
    const payload = game.status === 'lobby'
        ? { ...lobbyPayload(game), attachments: [] }
        : await gamePayload(game, note);
    await game.message.edit(payload).catch(error => console.error('UNO update failed:', error.message));
}

function clearTimer(game) {
    if (game.timer) clearTimeout(game.timer);
    game.timer = null;
}

function finishGame(game, note) {
    if (game.ended) return;
    game.ended = true;
    game.status = 'ended';
    game.turnToken++;
    clearTimer(game);
    channelGames.delete(game.channelId);
    games.delete(game.id);
    const engine = game.engine;
    const winner = engine?.winnerId ? engine.players.find(p => p.id === engine.winnerId) : null;
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.green)
        .setTitle('🏆 UNO · TABLE CLOSED')
        .setDescription([
            winner ? `🥇 **${winner.name}** wins the table!` : 'The table was closed before anyone reached the target.',
            note,
            '',
            engine ? standingsLines(engine) : ''
        ].filter(Boolean).join('\n'))
        .setTimestamp();
    return game.message?.edit({ embeds: [embed], components: [], files: [], attachments: [] })
        .catch(error => console.error('UNO finish failed:', error.message));
}

function closeLobby(game, text) {
    if (game.ended) return;
    game.ended = true;
    game.status = 'ended';
    clearTimer(game);
    channelGames.delete(game.channelId);
    games.delete(game.id);
    const embed = new EmbedBuilder()
        .setColor(0x555577)
        .setTitle('🃏 UNO LOBBY CLOSED')
        .setDescription(text);
    return game.message?.edit({ embeds: [embed], components: [], attachments: [] })
        .catch(error => console.error('UNO lobby close failed:', error.message));
}

function scheduleTurn(game) {
    clearTimer(game);
    const engine = game.engine;
    if (!engine || engine.status !== 'playing') return;
    const player = uno.currentPlayer(engine);
    const token = ++game.turnToken;
    if (player.isBot) {
        game.timer = setTimeout(() => runBotTurn(game, token), BOT_DELAY_MS);
    } else {
        game.timer = setTimeout(() => turnTimedOut(game, token), TURN_MS);
    }
}

async function afterAction(game, note) {
    const engine = game.engine;
    if (engine.status === 'ended') return finishGame(game, note);
    if (engine.status === 'round-over') {
        clearTimer(game);
        game.turnToken++;
        const winner = engine.players.find(p => p.id === engine.roundWinnerId);
        await updatePublic(game, `${note}\n🏁 **${winner?.name ?? 'Someone'}** went out and scored **${engine.roundPoints}**.`);
        game.timer = setTimeout(() => {
            if (game.ended) return;
            uno.startNextRound(engine);
            scheduleTurn(game);
            updatePublic(game, `🔁 Round ${engine.round} begins.`).catch(() => {});
        }, ROUND_BREAK_MS);
        return;
    }
    scheduleTurn(game);
    return updatePublic(game, note);
}

async function runBotTurn(game, token) {
    if (token !== game.turnToken || game.ended || game.engine.status !== 'playing') return;
    const engine = game.engine;
    const bot = uno.currentPlayer(engine);
    const move = uno.chooseBotMove(engine);
    try {
        if (move.action === 'draw') {
            uno.drawCard(engine, bot.id);
            return afterAction(game, `🤖 ${bot.name} drew and passed.`);
        }
        const result = uno.playCard(engine, bot.id, move.cardId, move.color);
        const colorNote = move.color ? ` and chose ${move.color}` : '';
        return afterAction(game, `🤖 ${bot.name} played **${cardLabel(result.card)}**${colorNote}.`);
    } catch (error) {
        console.error('UNO bot move failed:', error.message);
        game.turnToken++;
        scheduleTurn(game);
    }
}

async function turnTimedOut(game, token) {
    if (token !== game.turnToken || game.ended || game.engine.status !== 'playing') return;
    const engine = game.engine;
    const player = uno.currentPlayer(engine);
    try {
        uno.drawCard(engine, player.id);
        return afterAction(game, `⏰ ${player.name} ran out of time and drew.`);
    } catch (error) {
        console.error('UNO timeout failed:', error.message);
    }
}

async function startGame(game) {
    clearTimer(game);
    game.engine = uno.createGame({ players: game.lobby, rulesMode: game.rulesMode });
    game.status = 'playing';
    scheduleTurn(game);
    return updatePublic(game, '🎬 Cards are dealt. Good luck!');
}

function handColorRows(gameId, cardId) {
    const colors = ['red', 'yellow', 'green', 'blue'];
    return [new ActionRowBuilder().addComponents(
        colors.map(color => button(`uno:color:${gameId}:${cardId}:${color}`, `${COLOR_EMOJI[color]} ${color[0].toUpperCase()}${color.slice(1)}`, BUTTON_STYLES[color]))
    )];
}

async function showHand(interaction, game, player) {
    const engine = game.engine;
    const legal = new Set(uno.legalCards(engine, player.id).map(card => card.id));
    const isTurn = uno.currentPlayer(engine).id === player.id;
    const ordered = [...player.hand].sort((a, b) => Number(legal.has(b.id)) - Number(legal.has(a.id)));
    const options = ordered.slice(0, 25).map(card => ({
        label: `${COLOR_EMOJI[card.color]} ${cardLabel(card)}`.slice(0, 100),
        description: legal.has(card.id)
            ? (isTurn ? '✅ Playable now' : '✅ Playable on your turn')
            : 'Not playable right now',
        value: card.id
    }));
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`uno:play:${game.id}`)
        .setPlaceholder(isTurn ? 'Play a card…' : 'Not your turn — review your hand')
        .addOptions(options);
    const extra = player.hand.length > 25 ? ' (showing the first 25)' : '';
    const turnName = uno.currentPlayer(engine).name;
    return interaction.reply({
        content: `🂠 **Your hand** — ${player.hand.length} cards${extra}\n${isTurn ? '🟢 It is your turn.' : `⏳ Waiting for ${turnName}.`}`,
        components: [new ActionRowBuilder().addComponents(menu)],
        ephemeral: true
    });
}

async function playFromInteraction(interaction, game, player, cardId, color) {
    try {
        const result = uno.playCard(game.engine, player.id, cardId, color);
        await interaction.update({ content: `✅ You played **${cardLabel(result.card)}**.`, components: [] }).catch(() => {});
        return afterAction(game, `${player.name} played **${cardLabel(result.card)}**${color ? ` and chose ${color}` : ''}.`);
    } catch (error) {
        return interaction.update({ content: `❌ ${error.message}`, components: [] })
            .catch(() => interaction.reply({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => {}));
    }
}

async function handleLobby(interaction, game, verb) {
    const user = interaction.user;
    const isHost = user.id === game.hostId;
    const deny = content => interaction.reply({ content, ephemeral: true }).catch(() => {});

    if (verb === 'join') {
        if (game.lobby.some(p => p.id === user.id)) return deny('You are already seated.');
        if (game.lobby.length >= game.maxPlayers) return deny('This table is full.');
        game.lobby.push({ id: user.id, name: displayName(interaction), isBot: false });
    } else if (verb === 'leave') {
        if (isHost) return deny('The host cannot leave — cancel the table instead.');
        game.lobby = game.lobby.filter(p => p.id !== user.id);
    } else if (verb === 'bot' || verb === 'start' || verb === 'cancel') {
        if (!isHost) return deny('Only the host can do that.');
        if (verb === 'cancel') {
            await interaction.deferUpdate().catch(() => {});
            return closeLobby(game, 'Table cancelled by the host.');
        }
        if (verb === 'start') {
            if (game.lobby.length < 2) return deny('You need at least 2 players to start.');
            await interaction.deferUpdate().catch(() => {});
            return startGame(game);
        }
        if (game.lobby.length >= game.maxPlayers) return deny('The table is full.');
        game.lobby.push(newBot(game.lobby.filter(p => p.isBot).length + 1));
    } else {
        return deny('That action is not available.');
    }

    await interaction.deferUpdate().catch(() => {});
    if (game.lobby.length >= game.maxPlayers) return startGame(game);
    return updatePublic(game);
}

async function handleTable(interaction, game, verb, arg1, arg2) {
    const engine = game.engine;
    const player = engine.players.find(p => p.id === interaction.user.id);
    if (!player) {
        return interaction.reply({ content: 'You are not seated at this table.', ephemeral: true }).catch(() => {});
    }

    if (verb === 'hand') return showHand(interaction, game, player);

    if (verb === 'play' || verb === 'color') {
        const cardId = verb === 'play' ? interaction.values?.[0] : arg1;
        const color = verb === 'color' ? arg2 : null;
        const card = player.hand.find(c => c.id === cardId);
        if (!card) {
            return interaction.update({ content: '❌ That card is no longer in your hand.', components: [] }).catch(() => {});
        }
        if (verb === 'play' && card.color === 'wild') {
            return interaction.update({
                content: `Pick a colour for **${cardLabel(card)}**.`,
                components: handColorRows(game.id, card.id)
            }).catch(() => {});
        }
        return playFromInteraction(interaction, game, player, cardId, color);
    }

    if (verb === 'draw') {
        await interaction.deferUpdate().catch(() => {});
        try {
            uno.drawCard(engine, player.id);
        } catch (error) {
            return interaction.followUp({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => {});
        }
        return afterAction(game, `${player.name} drew and passed.`);
    }

    if (verb === 'call') {
        await interaction.deferUpdate().catch(() => {});
        try {
            uno.callUno(engine, player.id);
        } catch (error) {
            return interaction.followUp({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => {});
        }
        return updatePublic(game, `📣 **${player.name}** calls UNO!`);
    }

    if (verb === 'catch') {
        await interaction.deferUpdate().catch(() => {});
        try {
            const { targetId } = uno.catchUno(engine, player.id);
            const target = engine.players.find(p => p.id === targetId);
            return updatePublic(game, `🎯 **${player.name}** caught **${target?.name ?? 'someone'}** without UNO — two cards added.`);
        } catch (error) {
            return interaction.followUp({ content: `❌ ${error.message}`, ephemeral: true }).catch(() => {});
        }
    }

    if (verb === 'quit') {
        if (interaction.user.id !== game.hostId) {
            return interaction.reply({ content: 'Only the host can end the table.', ephemeral: true }).catch(() => {});
        }
        await interaction.deferUpdate().catch(() => {});
        return finishGame(game, `Ended by the host.`);
    }

    return interaction.reply({ content: 'That action is not available.', ephemeral: true }).catch(() => {});
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('uno-play')
        .setDescription('Open an UNO table in the UNO channel')
        .addStringOption(option => option
            .setName('mode')
            .setDescription('How many players')
            .addChoices(
                { name: 'Vs bot (you and a bot)', value: 'bot' },
                { name: '2 players', value: '2' },
                { name: '3 players', value: '3' },
                { name: '4 players', value: '4' }
            ))
        .addStringOption(option => option
            .setName('rules')
            .setDescription('Rule set: Normal, Stack or Spicy')
            .addChoices(
                { name: 'Normal (no stacking)', value: 'normal' },
                { name: 'Stack (+2/+4 stacking)', value: 'stack' },
                { name: 'Spicy (any draw stacks, free +4s)', value: 'spicy' }
            )),

    async execute(interaction) {
        if (interaction.channelId !== UNO_CHANNEL_ID) {
            return interaction.reply({ content: `🃏 UNO can only be played in <#${UNO_CHANNEL_ID}>.`, ephemeral: true });
        }
        if (channelGames.has(interaction.channelId)) {
            return interaction.reply({ content: '🃏 A UNO table is already running in this channel.', ephemeral: true });
        }

        const mode = interaction.options.getString('mode') ?? '2';
        const pickedRules = interaction.options.getString('rules');
        const rulesMode = uno.RULE_MODES.includes(pickedRules) ? pickedRules : 'stack';
        const host = { id: interaction.user.id, name: displayName(interaction), isBot: false };
        const game = {
            id: Date.now().toString(36),
            channelId: interaction.channelId,
            hostId: host.id,
            mode,
            rulesMode,
            maxPlayers: mode === 'bot' ? 2 : Number(mode),
            lobby: [host],
            engine: null,
            status: 'lobby',
            message: null,
            timer: null,
            turnToken: 0,
            ended: false
        };
        if (mode === 'bot') game.lobby.push(newBot(1));
        games.set(game.id, game);
        channelGames.set(game.channelId, game.id);

        await interaction.reply(lobbyPayload(game));
        game.message = await interaction.fetchReply();

        if (mode === 'bot') return startGame(game);
        game.timer = setTimeout(() => {
            if (game.status === 'lobby') closeLobby(game, 'Lobby expired after 10 minutes without a start.');
        }, LOBBY_MS);
        return undefined;
    },

    async handleComponent(interaction) {
        const [, verb, gameId, arg1, arg2] = interaction.customId.split(':');
        const game = games.get(gameId);
        if (!game || game.ended) {
            return interaction.reply({ content: 'That UNO table has closed.', ephemeral: true }).catch(() => {});
        }
        if (game.status === 'lobby') return handleLobby(interaction, game, verb);
        return handleTable(interaction, game, verb, arg1, arg2);
    }
};
