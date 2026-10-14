const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} = require('discord.js');
const db = require('../database');
const casino = require('../systems/casino/casinoManager');
const { NEON, panel, kv, neonEmbed, ANSI } = require('../systems/games/neonUI');
const {
    getRemainingTime,
    formatRemainingTime,
    setCooldown
} = require('../systems/economy/cooldownManager');

const GAME_KEY = 'matchpairs';
const COLLECTOR_TIME = 5 * 60 * 1000;
const MISS_PENALTY_MS = 900;

// 5×4 board = 20 cells. Discord caps a message at 5 ActionRows, so the board
// is split across two cohesive messages: the top half on the first message,
// the bottom half + HUD/controls on the follow-up.
const COLS = 5;
const ROWS = 4;
const CELLS = COLS * ROWS;
const PAIRS = CELLS / 2;
const SPLIT_ROW = 2; // rows 0-1 on message one, rows 2-3 on message two

const SYMBOLS = ['🐉', '🌙', '💎', '🔥', '⚡', '❄️', '🌟', '🍀', '🔮', '🧿'];

const games = new Map();

function shuffle(values) {
    const copy = [...values];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

// 20 cells holding 10 shuffled pairs.
function createDeck() {
    return shuffle(SYMBOLS.flatMap(symbol => [symbol, symbol]));
}

function rewardForMoves(moves) {
    // Perfect memory (10 moves) tops out at 900; every wasted pair erodes it.
    return Math.max(200, 900 - (moves - PAIRS) * 40);
}

function recordStats(userId, won, reward) {
    db.prepare(`
        INSERT INTO mini_game_stats (userId, game, gamesPlayed, gamesWon, creditsEarned, bestPayout)
        VALUES (?, ?, 1, ?, ?, ?)
        ON CONFLICT(userId, game) DO UPDATE SET
            gamesPlayed = gamesPlayed + 1,
            gamesWon = gamesWon + excluded.gamesWon,
            creditsEarned = creditsEarned + excluded.creditsEarned,
            bestPayout = MAX(bestPayout, excluded.bestPayout)
    `).run(userId, GAME_KEY, won ? 1 : 0, reward, reward);
}

function cellButton(state, index) {
    const revealed = state.found.includes(index) || state.open.includes(index);
    const matched = state.found.includes(index);
    return new ButtonBuilder()
        .setCustomId(`mp:${state.id}:${index}`)
        .setLabel(revealed ? state.values[index] : '❔')
        .setStyle(matched ? ButtonStyle.Success : revealed ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(matched || state.ended);
}

// Rows of buttons for cells [fromRow * COLS, toRow * COLS).
function boardRows(state, fromRow, toRow) {
    const rows = [];
    for (let row = fromRow; row < toRow; row++) {
        rows.push(new ActionRowBuilder().addComponents(
            ...Array.from({ length: COLS }, (_, col) => cellButton(state, row * COLS + col))
        ));
    }
    return rows;
}

// One line per board row so each message's description mirrors its buttons.
function boardLines(state, fromRow, toRow) {
    const lines = [];
    for (let row = fromRow; row < toRow; row++) {
        const cells = [];
        for (let col = 0; col < COLS; col++) {
            const index = row * COLS + col;
            cells.push(state.found.includes(index) || state.open.includes(index)
                ? state.values[index]
                : '❔');
        }
        lines.push(cells.join(' '));
    }
    return lines;
}

function hudLines(state, extra = '') {
    const pairsFound = state.found.length / 2;
    const movesLeft = Math.max(0, state.moveLimit - state.moves);
    return panel(
        `${ANSI.MAGENTA}◈ SECTOR SCAN${ANSI.RESET}`,
        kv('Pairs', `${pairsFound}/${PAIRS}`),
        kv('Moves', `${state.moves}/${state.moveLimit}`),
        kv('Buffer', `${movesLeft} moves left`),
        '',
        `${ANSI.DIM}${'▰'.repeat(pairsFound)}${'▱'.repeat(PAIRS - pairsFound)} signal pairs${ANSI.RESET}`,
        // Win/loss/timeout banners go INSIDE the ```ansi``` panel — raw ANSI
        // in the plain description renders in Discord as "[0;31m" garbage.
        ...(extra ? ['', extra] : [])
    );
}

function topEmbed(state) {
    return new EmbedBuilder()
        .setColor(state.ended ? (state.won ? NEON.green : NEON.red) : NEON.cyan)
        .setTitle(`◢ ═══ 🧩 MATCH PAIRS // GRID A ═══ ◣`)
        .setDescription(
            `${boardLines(state, 0, SPLIT_ROW).join('\n')}\n${hudLines(state)}`
        )
        .setFooter({ text: `NODE ${state.id.slice(-6).toUpperCase()} • MEMORY PROTOCOL` })
        .setTimestamp();
}

function bottomEmbed(state, extra = '') {
    return new EmbedBuilder()
        .setColor(state.ended ? (state.won ? NEON.green : NEON.red) : NEON.cyan)
        .setTitle(`◢ ═══ 🧩 MATCH PAIRS // GRID B ═══ ◣`)
        .setDescription(
            `${boardLines(state, SPLIT_ROW, ROWS).join('\n')}\n${hudLines(state, extra)}`
        )
        .setFooter({ text: `NODE ${state.id.slice(-6).toUpperCase()} • MEMORY PROTOCOL` })
        .setTimestamp();
}

function controlRow(state) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mp:${state.id}:resign`).setLabel('✖ ABORT').setStyle(ButtonStyle.Danger)
    );
}

function againRow(state) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mp:${state.id}:again`).setLabel('⟳ NEW GRID').setStyle(ButtonStyle.Primary)
    );
}

async function refresh(messages, state, extra = '') {
    const [top, bottom] = messages;
    await top.edit({ embeds: [topEmbed(state)], components: state.ended ? [] : boardRows(state, 0, SPLIT_ROW) });
    await bottom.edit({
        embeds: [bottomEmbed(state, extra)],
        components: state.ended ? [againRow(state)] : [...boardRows(state, SPLIT_ROW, ROWS), controlRow(state)]
    });
}

async function finish(messages, state, won) {
    if (state.ended) return;
    state.ended = true;
    state.won = won;
    const reward = won ? rewardForMoves(state.moves) : 0;
    recordStats(state.userId, won, reward);
    if (reward > 0) {
        casino.creditWallet(state.userId, GAME_KEY, reward, 'payout', 'Match Pairs win');
    }
    setCooldown(state.userId, GAME_KEY);
    games.delete(state.id);

    const result = won
        ? `${ANSI.GREEN}${ANSI.BOLD}≫ GRID CLEARED — PAYOUT 🪙${reward.toLocaleString()} <<${ANSI.RESET}`
        : `${ANSI.RED}≫ MOVE BUFFER EXHAUSTED — SIGNAL LOST${ANSI.RESET}`;
    await refresh(messages, state, result);
    state.collectors.forEach(collector => collector.stop('finished'));
}

async function handleCell(messages, state, index, interaction) {
    // Acknowledge immediately — edits below go through message.edit.
    await interaction.deferUpdate();
    if (state.ended || state.locked) return;
    if (state.open.includes(index) || state.found.includes(index)) return;

    state.open.push(index);

    if (state.open.length < 2) {
        return refresh(messages, state);
    }

    // Second card: lock the board while the pair resolves.
    state.locked = true;
    state.moves++;
    const [first, second] = state.open;
    const matched = state.values[first] === state.values[second];

    if (matched) {
        state.found.push(first, second);
        state.open = [];
        state.locked = false;

        if (state.found.length === CELLS) {
            await refresh(messages, state);
            return finish(messages, state, true);
        }
        if (state.moves >= state.moveLimit) {
            await refresh(messages, state);
            return finish(messages, state, false);
        }
        return refresh(messages, state);
    }

    // Miss: show both cards briefly, then flip them back.
    await refresh(messages, state);
    await new Promise(resolve => setTimeout(resolve, MISS_PENALTY_MS));

    state.open = [];
    state.locked = false;
    if (state.moves >= state.moveLimit) {
        await refresh(messages, state);
        return finish(messages, state, false);
    }
    return refresh(messages, state);
}

function setupCollectors(top, bottom, state, userId) {
    state.collectors = [];
    for (const message of [top, bottom]) {
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button, time: COLLECTOR_TIME
        });
        state.collectors.push(collector);
        collector.on('collect', async interaction => {
            if (interaction.user.id !== userId) {
                return interaction.reply({ content: 'This is not your grid.' });
            }
            const parts = interaction.customId.split(':');
            const action = parts[2];
            if (action === 'again') {
                if (state.ended) {
                    state.collectors.forEach(c => c.stop('again'));
                    return startGame(interaction);
                }
                return interaction.deferUpdate();
            }
            if (action === 'resign') {
                if (state.ended) return interaction.deferUpdate();
                await interaction.deferUpdate();
                return finish([top, bottom], state, false);
            }
            const index = Number(action);
            if (!Number.isInteger(index)) return interaction.deferUpdate();
            await handleCell([top, bottom], state, index, interaction);
        });
        collector.on('end', async (_, reason) => {
            if (reason !== 'time' || state.ended) return;
            state.ended = true;
            setCooldown(state.userId, GAME_KEY);
            games.delete(state.id);
            try {
                await refresh([top, bottom], state, `${ANSI.RED}≫ LINK TIMED OUT — SIGNAL LOST${ANSI.RESET}`);
            } catch (error) {
                console.error('Match Pairs timeout render failed:', error);
            }
        });
    }
}

async function startGame(interaction) {
    const userId = interaction.user.id;
    for (const active of games.values()) {
        if (active.userId === userId && !active.ended) {
            return interaction.reply({ content: 'You already have an active Match Pairs grid. Finish it first.' });
        }
    }
    const remaining = getRemainingTime(userId, GAME_KEY);
    if (remaining > 0) {
        return interaction.reply({ content: `You can play Match Pairs again ${formatRemainingTime(remaining)}.` });
    }

    const state = {
        id: `${userId}-${Date.now()}`,
        userId,
        values: createDeck(),
        open: [],
        found: [],
        moves: 0,
        // 20 cells need at least 10 moves; 24 gives a little slack.
        moveLimit: 24,
        locked: false,
        ended: false,
        won: false,
        collectors: []
    };
    games.set(state.id, state);

    await interaction.reply({
        embeds: [topEmbed(state)],
        components: boardRows(state, 0, SPLIT_ROW)
    });
    const top = await interaction.fetchReply();
    const bottom = await interaction.followUp({
        embeds: [bottomEmbed(state)],
        components: [...boardRows(state, SPLIT_ROW, ROWS), controlRow(state)]
    });

    setupCollectors(top, bottom, state, userId);
    setCooldown(userId, GAME_KEY);
}

module.exports = {
    createDeck,
    rewardForMoves,
    PAIRS,
    data: new SlashCommandBuilder()
        .setName('matchpairs')
        .setDescription('Match hidden signal pairs on a 5×4 grid')
        .addStringOption(option => option.setName('mode').setDescription('What to do').addChoices(
            { name: 'Play', value: 'play' },
            { name: 'Stats', value: 'stats' }
        )),
    async execute(interaction) {
        if (interaction.options.getString('mode') === 'stats') {
            const stats = db.prepare('SELECT * FROM mini_game_stats WHERE userId = ? AND game = ?')
                .get(interaction.user.id, GAME_KEY);
            return interaction.reply({
                embeds: [neonEmbed({
                    userId: interaction.user.id,
                    title: '🧩 MATCH PAIRS // PLAYER DOSSIER',
                    lines: stats ? [
                        kv('Games', `${stats.gamesPlayed}`),
                        kv('Wins', `${stats.gamesWon}`),
                        kv('Earned', `🪙${Number(stats.creditsEarned).toLocaleString()}`),
                        kv('Best payout', `🪙${Number(stats.bestPayout).toLocaleString()}`)
                    ] : [`${ANSI.DIM}no grids decoded yet${ANSI.RESET}`]
                })]
            });
        }
        return startGame(interaction);
    }
};
