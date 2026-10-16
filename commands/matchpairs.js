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
const MISS_PENALTY_MS = 1000;
// Every wrong pair costs a life; running out ends the grid.
const STARTING_LIVES = 12;
const WIN_REWARD = 500;

// A 4-row × 5-column board fits in one Discord message, leaving the fifth
// ActionRow for controls.
const COLS = 5;
const ROWS = 4;
const CELLS = COLS * ROWS;
const PAIRS = CELLS / 2;

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

// Clearing the grid pays a flat reward regardless of how many moves it took.
function rewardForWin() {
    return WIN_REWARD;
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

// Four rows of five buttons: the complete board stays together in one message.
function boardRows(state) {
    const rows = [];
    for (let row = 0; row < ROWS; row++) {
        rows.push(new ActionRowBuilder().addComponents(
            ...Array.from({ length: COLS }, (_, col) => cellButton(state, row * COLS + col))
        ));
    }
    return rows;
}

// One line per board row so the embed mirrors the four button rows.
function boardLines(state) {
    const lines = [];
    for (let row = 0; row < ROWS; row++) {
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
    return panel(
        `${ANSI.MAGENTA}◈ SECTOR SCAN${ANSI.RESET}`,
        kv('Pairs', `${pairsFound}/${PAIRS}`),
        kv('Lives', `${state.lives}/${STARTING_LIVES}`),
        '',
        `${ANSI.DIM}${'▰'.repeat(pairsFound)}${'▱'.repeat(PAIRS - pairsFound)} signal pairs${ANSI.RESET}`,
        // Win/loss/timeout banners go INSIDE the ```ansi``` panel — raw ANSI
        // in the plain description renders in Discord as "[0;31m" garbage.
        ...(extra ? ['', extra] : [])
    );
}

function gameEmbed(state, extra = '') {
    return new EmbedBuilder()
        .setColor(state.ended ? (state.won ? NEON.green : NEON.red) : NEON.cyan)
        .setTitle('◢ ═══ 🧩 MATCH PAIRS // 4×5 GRID ═══ ◣')
        .setDescription(`${boardLines(state).join('\n')}\n${hudLines(state, extra)}`)
        .setFooter({ text: `NODE ${state.id.slice(-6).toUpperCase()} • MEMORY PROTOCOL` })
        .setTimestamp();
}

function controlRow(state) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mp:${state.id}:resign`).setLabel('🚪 Quit').setStyle(ButtonStyle.Danger)
    );
}

function againRow(state) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mp:${state.id}:again`).setLabel('⟳ NEW GRID').setStyle(ButtonStyle.Primary)
    );
}

async function refresh(message, state, extra = '') {
    await message.edit({
        embeds: [gameEmbed(state, extra)],
        components: state.ended ? [againRow(state)] : [...boardRows(state), controlRow(state)]
    });
}

async function finish(message, state, won) {
    if (state.ended) return;
    state.ended = true;
    state.won = won;
    const reward = won ? rewardForWin() : 0;
    recordStats(state.userId, won, reward);
    if (reward > 0) {
        casino.creditWallet(state.userId, GAME_KEY, reward, 'payout', 'Match Pairs win');
    }
    setCooldown(state.userId, GAME_KEY);
    games.delete(state.id);

    const result = won
        ? `${ANSI.GREEN}${ANSI.BOLD}≫ GRID CLEARED — PAYOUT 🪙${reward.toLocaleString()} <<${ANSI.RESET}`
        : `${ANSI.RED}≫ OUT OF LIVES — SIGNAL LOST${ANSI.RESET}`;
    await refresh(message, state, result);
    state.collectors.forEach(collector => collector.stop('finished'));
}

async function handleCell(message, state, index, interaction) {
    // Acknowledge immediately — edits below go through message.edit.
    await interaction.deferUpdate();
    if (state.ended || state.locked) return;
    if (state.open.includes(index) || state.found.includes(index)) return;

    state.open.push(index);

    if (state.open.length < 2) {
        return refresh(message, state);
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
            await refresh(message, state);
            return finish(message, state, true);
        }
        return refresh(message, state);
    }

    // Miss: show both cards briefly, then flip them back.
    await refresh(message, state);
    await new Promise(resolve => setTimeout(resolve, MISS_PENALTY_MS));

    state.open = [];
    state.locked = false;
    state.lives--;
    if (state.lives <= 0) {
        await refresh(message, state);
        return finish(message, state, false);
    }
    return refresh(message, state);
}

function setupCollector(message, state, userId) {
    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button, time: COLLECTOR_TIME
    });
    state.collectors = [collector];
    collector.on('collect', async interaction => {
        if (interaction.user.id !== userId) {
            return interaction.reply({ content: 'This is not your grid.' });
        }
        const parts = interaction.customId.split(':');
        const action = parts[2];
        if (action === 'again') {
            if (state.ended) {
                collector.stop('again');
                return startGame(interaction);
            }
            return interaction.deferUpdate();
        }
        if (action === 'resign') {
            if (state.ended) return interaction.deferUpdate();
            await interaction.deferUpdate();
            return finish(message, state, false);
        }
        const index = Number(action);
        if (!Number.isInteger(index)) return interaction.deferUpdate();
        await handleCell(message, state, index, interaction);
    });
    collector.on('end', async (_, reason) => {
        if (reason !== 'time' || state.ended) return;
        state.ended = true;
        setCooldown(state.userId, GAME_KEY);
        games.delete(state.id);
        try {
            await refresh(message, state, `${ANSI.RED}≫ LINK TIMED OUT — SIGNAL LOST${ANSI.RESET}`);
        } catch (error) {
            console.error('Match Pairs timeout render failed:', error);
        }
    });
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
        lives: STARTING_LIVES,
        locked: false,
        ended: false,
        won: false,
        collectors: []
    };
    games.set(state.id, state);

    await interaction.reply({
        embeds: [gameEmbed(state)],
        components: [...boardRows(state), controlRow(state)]
    });
    const message = await interaction.fetchReply();

    setupCollector(message, state, userId);
    setCooldown(userId, GAME_KEY);
}

module.exports = {
    createDeck,
    rewardForWin,
    PAIRS,
    COLS,
    ROWS,
    boardRows,
    data: new SlashCommandBuilder()
        .setName('matchpairs')
        .setDescription('Match hidden signal pairs on a 4-row × 5-column grid')
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
