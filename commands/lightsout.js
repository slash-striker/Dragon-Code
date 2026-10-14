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
const {
    getRemainingTime,
    formatRemainingTime,
    setCooldown
} = require('../systems/economy/cooldownManager');
const { NEON, panel, kv, neonEmbed, progressBar, ANSI } = require('../systems/games/neonUI');

const DIFFICULTIES = {
    easy: { size: 3, baseReward: 200, maxReward: 500, label: 'Easy', emoji: '🟢' },
    normal: { size: 4, baseReward: 400, maxReward: 1000, label: 'Normal', emoji: '🟡' },
    hard: { size: 5, baseReward: 700, maxReward: 1800, label: 'Hard', emoji: '🔴' }
};

const GAME_TIMEOUT = 5 * 60 * 1000;
const MAX_HISTORY = 100;

const games = new Map();

function getStats(userId) {
    return db.prepare('SELECT * FROM lights_out_stats WHERE userId = ?').get(userId) || {
        userId, gamesPlayed: 0, wins: 0, totalMoves: 0, bestMoves: null, bestTimeMs: null,
        currentStreak: 0, bestStreak: 0, hintsUsed: 0, perfectWins: 0, dailyWins: 0,
        challengesWon: 0, battlesWon: 0
    };
}

function saveStats(userId) {
    const stats = getStats(userId);
    db.prepare(`
        INSERT INTO lights_out_stats
            (userId, gamesPlayed, wins, totalMoves, bestMoves, bestTimeMs, currentStreak,
             bestStreak, hintsUsed, perfectWins, dailyWins, challengesWon, battlesWon)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(userId) DO UPDATE SET
            gamesPlayed = excluded.gamesPlayed,
            wins = excluded.wins,
            totalMoves = excluded.totalMoves,
            bestMoves = excluded.bestMoves,
            bestTimeMs = excluded.bestTimeMs,
            currentStreak = excluded.currentStreak,
            bestStreak = excluded.bestStreak,
            hintsUsed = excluded.hintsUsed,
            perfectWins = excluded.perfectWins,
            dailyWins = excluded.dailyWins,
            challengesWon = excluded.challengesWon,
            battlesWon = excluded.battlesWon
    `).run(
        userId, stats.gamesPlayed, stats.wins, stats.totalMoves, stats.bestMoves,
        stats.bestTimeMs, stats.currentStreak, stats.bestStreak, stats.hintsUsed,
        stats.perfectWins, stats.dailyWins, stats.challengesWon, stats.battlesWon
    );
}

function cloneGrid(grid) {
    return [...grid];
}

function createEmptyGrid(size) {
    return new Array(size * size).fill(false);
}

function toggleLight(grid, index, size) {
    if (!Number.isInteger(index) || index < 0 || index >= grid.length) return;
    const row = Math.floor(index / size);
    const col = index % size;
    grid[index] = !grid[index];
    if (row > 0) grid[index - size] = !grid[index - size];
    if (row < size - 1) grid[index + size] = !grid[index + size];
    if (col > 0) grid[index - 1] = !grid[index - 1];
    if (col < size - 1) grid[index + 1] = !grid[index + 1];
}

function isSolved(grid) {
    return grid.every(light => !light);
}

function countLights(grid) {
    return grid.reduce((count, light) => count + (light ? 1 : 0), 0);
}

// Deterministic pseudo-random generator for seeded daily puzzles.
function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state += 0x6D2B79F5;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomSeed() {
    return Math.floor(Math.random() * 0xFFFFFFFF);
}

// Solvable puzzle: start empty and apply random valid moves.
function createSolvableGrid(size, seed) {
    const grid = createEmptyGrid(size);
    const random = seededRandom(seed ?? randomSeed());
    const totalCells = size * size;
    const moves = Math.max(size * 2, Math.floor(totalCells * 0.55));

    for (let i = 0; i < moves; i++) {
        toggleLight(grid, Math.floor(random() * totalCells), size);
    }
    if (isSolved(grid)) {
        toggleLight(grid, Math.floor(random() * totalCells), size);
    }
    return grid;
}

// Deterministic seed per calendar day so everyone gets the same daily puzzle.
function getDailySeed(date = new Date()) {
    const value = `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}-lightsout`;
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function getDateKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

// Classic Lights Out solver: for each first-row press combination every
// subsequent row is forced. Works well for 3x3, 4x4, and 5x5 boards.
function solveLightsOut(initialGrid, size) {
    const board = cloneGrid(initialGrid);
    const moves = [];
    const firstRowCombinations = 1 << size;

    for (let firstMask = 0; firstMask < firstRowCombinations; firstMask++) {
        const trial = cloneGrid(initialGrid);
        const trialMoves = [];

        for (let col = 0; col < size; col++) {
            if ((firstMask & (1 << col)) !== 0) {
                toggleLight(trial, col, size);
                trialMoves.push(col);
            }
        }

        for (let row = 1; row < size; row++) {
            for (let col = 0; col < size; col++) {
                if (trial[(row - 1) * size + col]) {
                    const index = row * size + col;
                    toggleLight(trial, index, size);
                    trialMoves.push(index);
                }
            }
        }

        let solved = true;
        for (let col = 0; col < size; col++) {
            if (trial[(size - 1) * size + col]) {
                solved = false;
                break;
            }
        }

        if (solved && trial.every(light => !light) &&
            (moves.length === 0 || trialMoves.length < moves.length)) {
            moves.length = 0;
            moves.push(...trialMoves);
        }
    }

    return moves.length > 0 || isSolved(initialGrid) ? moves : null;
}

function getOptimalMoves(grid, size) {
    return solveLightsOut(grid, size)?.length ?? 0;
}

function getRecommendedMove(grid, size) {
    return solveLightsOut(grid, size)?.[0] ?? null;
}

function calculateEfficiency(attempts, optimalMoves) {
    if (attempts <= 0) return 0;
    if (optimalMoves <= 0) return 100;
    return Math.max(0, Math.min(100, Math.round((optimalMoves / attempts) * 100)));
}

function calculateReward(game) {
    const config = DIFFICULTIES[game.difficulty];
    const efficiency = calculateEfficiency(game.attempts, game.optimalMoves);
    let reward = config.baseReward;

    if (efficiency >= 100) reward += Math.floor(config.baseReward * 0.75);
    else if (efficiency >= 90) reward += Math.floor(config.baseReward * 0.5);
    else if (efficiency >= 75) reward += Math.floor(config.baseReward * 0.25);

    if (game.hintsUsed === 0) reward += 100;
    if (game.difficulty === 'hard') reward += 200;
    if (game.mode === 'challenge') reward = Math.floor(reward * 1.25);

    return Math.min(reward, config.maxReward);
}

function createGameId(userId) {
    return `${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createButton(game, index) {
    const isOn = game.grid[index];
    return new ButtonBuilder()
        .setCustomId(`lo_${game.gameId}_${index}`)
        .setLabel(isOn ? '💡' : '⬛')
        .setStyle(isOn ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(!game.gameActive || game.processing);
}

function createControlRows(game) {
    const controls = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`lo_hint_${game.gameId}`).setLabel('💡 Hint').setStyle(ButtonStyle.Success)
            .setDisabled(!game.gameActive || game.processing),
        new ButtonBuilder().setCustomId(`lo_undo_${game.gameId}`).setLabel('↩️ Undo').setStyle(ButtonStyle.Secondary)
            .setDisabled(!game.gameActive || game.history.length === 0 || game.undoUsed || game.processing),
        new ButtonBuilder().setCustomId(`lo_reset_${game.gameId}`).setLabel('🔄 Reset').setStyle(ButtonStyle.Secondary)
            .setDisabled(!game.gameActive || game.resetUsed || game.processing),
        new ButtonBuilder().setCustomId(`lo_quit_${game.gameId}`).setLabel('🚪 Quit').setStyle(ButtonStyle.Danger)
            .setDisabled(!game.gameActive || game.processing)
    );
    return [controls];
}

function createGameRows(game) {
    const rows = [];
    const size = game.size;

    for (let row = 0; row < size; row++) {
        const actionRow = new ActionRowBuilder();
        for (let col = 0; col < size; col++) {
            actionRow.addComponents(createButton(game, row * size + col));
        }
        rows.push(actionRow);
    }

    // Discord allows at most five ActionRows per message; sizes up to 4x4 leave room.
    if (rows.length < 5) rows.push(...createControlRows(game));

    return rows.slice(0, 5);
}

function formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    return `${minutes.toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function getGameTime(game) {
    return Math.max(0, Date.now() - game.startedAt);
}

function buildGameDescription(game) {
    const config = DIFFICULTIES[game.difficulty];
    const efficiency = game.attempts > 0 ? calculateEfficiency(game.attempts, game.optimalMoves) : 0;
    const remaining = countLights(game.grid);

    const modes = {
        daily: '📅 **Daily Puzzle** — everyone gets the same board today.',
        challenge: '🔥 **Challenge Mode** — higher rewards for efficient solves.',
        battle: '⚔️ **Battle Mode**'
    };

    return panel(
        `${ANSI.MAGENTA}◈ GRID STATE${ANSI.RESET}`,
        kv('Difficulty', `${config.emoji} ${config.label} ${config.size}×${config.size}`),
        kv('Lights', `${ANSI.CYAN}${remaining}${ANSI.RESET} remaining`),
        kv('Attempts', `${game.attempts}`),
        kv('Optimal', `${game.optimalMoves} moves`),
        kv('Time', formatTime(getGameTime(game))),
        game.attempts > 0 ? `${ANSI.DIM}efficiency${ANSI.RESET} ${progressBar(efficiency, 100, 8)} ${efficiency}%` : null,
        game.hintsUsed > 0 ? kv('Hints used', `${game.hintsUsed}`) : null,
        '',
        `${ANSI.DIM}click a cell to toggle it and its neighbors${ANSI.RESET}`
    ) + (modes[game.mode] ? `\n\n${modes[game.mode]}` : '');
}

function createGameEmbed(game) {
    const config = DIFFICULTIES[game.difficulty];
    const titles = {
        daily: '💡 LIGHTS OUT // DAILY PROTOCOL',
        challenge: '💡 LIGHTS OUT // CHALLENGE PROTOCOL',
        battle: '💡 LIGHTS OUT // BATTLE PROTOCOL'
    };

    return neonEmbed({
        userId: game.userId,
        title: titles[game.mode] ?? '💡 LIGHTS OUT',
        lines: null,
        description: buildGameDescription(game),
        footer: `NODE ${game.gameId.slice(-6).toUpperCase()} • ${config.label} ${config.size}×${config.size}`
    });
}

function pushHistory(game) {
    if (game.history.length >= MAX_HISTORY) game.history.shift();
    game.history.push(cloneGrid(game.grid));
}

function restorePreviousState(game) {
    const previous = game.history.pop();
    if (!previous) return false;
    game.grid = cloneGrid(previous);
    game.attempts = Math.max(0, game.attempts - 1);
    return true;
}

function resetGame(game) {
    game.grid = cloneGrid(game.initialGrid);
    game.attempts = 0;
    game.hintsUsed = 0;
    game.history = [];
    game.startedAt = Date.now();
}

function findActiveGameForUser(userId) {
    for (const game of games.values()) {
        if (game.userId === userId || game.opponentId === userId) return game;
    }
    return undefined;
}

function getAchievementLines(stats) {
    const achievements = [];
    if (stats.wins >= 1) achievements.push('💡 **First Light** — Win your first game');
    if (stats.bestMoves !== null && stats.bestMoves <= 15) achievements.push('⚡ **Speed Demon** — Solve in 15 moves or fewer');
    if (stats.perfectWins >= 1) achievements.push('🏆 **Perfect** — Solve optimally');
    if (stats.wins >= 100) achievements.push('👑 **Lights Out Master** — Win 100 games');
    if (stats.currentStreak >= 7 || stats.bestStreak >= 7) achievements.push('🔥 **Streak Keeper** — Reach a 7-game streak');
    if (stats.hintsUsed === 0 && stats.wins > 0) achievements.push('🧠 **No Help Needed** — You have never used a hint');
    return achievements;
}

function createStatsEmbed(user) {
    const stats = getStats(user.id);
    const averageMoves = stats.gamesPlayed > 0 ? (stats.totalMoves / stats.gamesPlayed).toFixed(1) : '0';
    const bestTime = stats.bestTimeMs !== null ? formatTime(stats.bestTimeMs) : '—';
    const achievements = getAchievementLines(stats);

    let description =
        `🎮 Games played: **${stats.gamesPlayed}**\n` +
        `🏆 Wins: **${stats.wins}**\n` +
        `🎯 Average moves: **${averageMoves}**\n` +
        `⭐ Best moves: **${stats.bestMoves ?? '—'}**\n` +
        `⏱️ Best time: **${bestTime}**\n` +
        `🔥 Current streak: **${stats.currentStreak}**\n` +
        `🔥 Best streak: **${stats.bestStreak}**\n` +
        `💡 Hints used: **${stats.hintsUsed}**\n` +
        `🏆 Perfect wins: **${stats.perfectWins}**\n` +
        `📅 Daily wins: **${stats.dailyWins}**\n` +
        `🔥 Challenges won: **${stats.challengesWon}**\n` +
        `⚔️ Battles won: **${stats.battlesWon}**`;

    if (achievements.length > 0) {
        description += `\n\n### Achievements\n${achievements.join('\n')}`;
    }

    return neonEmbed({
        userId: user.id,
        title: `💡 LIGHTS OUT // OPERATIVE DOSSIER — ${user.username}`,
        color: NEON.cyan,
        lines: [
            `${ANSI.MAGENTA}◈ RECORD${ANSI.RESET}`,
            kv('Games', `${stats.gamesPlayed}`),
            kv('Wins', `${stats.wins}`),
            kv('Avg moves', `${averageMoves}`),
            kv('Best moves', `${stats.bestMoves ?? '—'}`),
            kv('Best time', bestTime),
            kv('Streak', `${stats.currentStreak} (best ${stats.bestStreak})`),
            kv('Hints used', `${stats.hintsUsed}`),
            kv('Perfect solves', `${stats.perfectWins}`),
            kv('Daily wins', `${stats.dailyWins}`),
            kv('Challenges', `${stats.challengesWon}`),
            kv('Battles', `${stats.battlesWon}`),
            ...(achievements.length ? [
                '',
                `${ANSI.MAGENTA}◈ ACHIEVEMENTS${ANSI.RESET}`,
                ...achievements.map(line => `${ANSI.YELLOW}${line}${ANSI.RESET}`)
            ] : [])
        ]
    }).setThumbnail(user.displayAvatarURL());
}

async function createLeaderboardEmbed(userId) {
    const leaderboard = db.prepare(
        'SELECT * FROM lights_out_stats WHERE wins > 0 ORDER BY bestMoves IS NULL, bestMoves ASC, wins DESC LIMIT 10'
    ).all();

    if (leaderboard.length === 0) {
        return new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 Lights Out Leaderboard')
            .setDescription('No completed games yet.');
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines = leaderboard.map((entry, index) => {
        const prefix = medals[index] ?? `**${index + 1}.**`;
        const isYou = entry.userId === userId;
        return `${prefix} <@${entry.userId}>${isYou ? ' **(You)**' : ''} — **${entry.bestMoves ?? '—'} moves**`;
    });

    return neonEmbed({
        title: '🏆 LIGHTS OUT // HALL OF LIGHT',
        color: NEON.gold,
        lines: leaderboard.map((entry, index) => {
            const prefix = medals[index] ?? `**${index + 1}.**`;
            const isYou = entry.userId === userId;
            return `${prefix} <@${entry.userId}>${isYou ? ' **(You)**' : ''} ${ANSI.CYAN}»${ANSI.RESET} **${entry.bestMoves ?? '—'} moves**`;
        }),
        footer: 'Ranked by best move count'
    });
}

async function fetchGameMessage(client, game) {
    const channel = await client.channels.fetch(game.channelId).catch(() => null);
    if (!channel || !channel.messages) return null;
    return channel.messages.fetch(game.messageId).catch(() => null);
}

async function endGame(gameId, result, client) {
    const game = games.get(gameId);
    if (!game || !game.gameActive) return;
    game.gameActive = false;
    game.processing = false;

    const elapsed = getGameTime(game);
    const stats = getStats(game.userId);
    let description = '';
    let reward = 0;

    if (result === 'win') {
        reward = calculateReward(game);
        const efficiency = calculateEfficiency(game.attempts, game.optimalMoves);
        const perfect = game.attempts === game.optimalMoves;

        stats.wins++;
        stats.currentStreak++;
        stats.bestStreak = Math.max(stats.bestStreak, stats.currentStreak);
        if (stats.bestMoves === null || game.attempts < stats.bestMoves) stats.bestMoves = game.attempts;
        if (stats.bestTimeMs === null || elapsed < stats.bestTimeMs) stats.bestTimeMs = elapsed;
        if (perfect) stats.perfectWins++;

        if (game.mode === 'daily') {
            const dateKey = getDateKey();
            const existingDailyWin = db.prepare(
                'SELECT 1 FROM lights_out_daily_wins WHERE userId = ? AND dateKey = ?'
            ).get(game.userId, dateKey);
            if (!existingDailyWin) {
                stats.dailyWins++;
                db.prepare('INSERT INTO lights_out_daily_wins (userId, dateKey) VALUES (?, ?)').run(game.userId, dateKey);
            }
        } else if (game.mode === 'challenge') {
            stats.challengesWon++;
        } else if (game.mode === 'battle') {
            stats.battlesWon++;
        }

        try {
            casino.creditWallet(game.userId, 'lightsout', reward, 'payout', 'Lights Out win');
        } catch (error) {
            console.error('Lights Out payout failed:', error);
        }

        description =
            `🎉 **Puzzle solved!**\n\n` +
            `🎯 Attempts: **${game.attempts}**\n` +
            `⭐ Optimal: **${game.optimalMoves}**\n` +
            `📊 Efficiency: **${efficiency}%**\n` +
            `⏱️ Time: **${formatTime(elapsed)}**\n\n` +
            `💰 Reward: **🪙${reward.toLocaleString()}**\n`;
        if (perfect) description += '\n🏆 **Perfect solve!**';
        if (game.hintsUsed === 0) description += '\n💡 **No-hint bonus included!**';
        description += `\n🔥 Win streak: **${stats.currentStreak}**`;
    } else {
        stats.currentStreak = 0;
        description = result === 'timeout'
            ? `⏰ **Game timed out!**\n\nYou made **${game.attempts}** attempts.\nLights remaining: **${countLights(game.grid)}**`
            : `🚪 **You quit the game.**\n\nYou made **${game.attempts}** attempts.`;
    }

    stats.totalMoves += game.attempts;
    saveStats(game.userId);

    const title = result === 'win' ? '💡 LIGHTS OUT // GRID CLEARED' : result === 'timeout' ? '💡 LIGHTS OUT // LINK TIMED OUT' : '💡 LIGHTS OUT // RUN TERMINATED';
    const embed = neonEmbed({
        userId: game.userId,
        title,
        color: result === 'win' ? NEON.green : NEON.red,
        lines: null,
        description,
        footer: `NODE ${game.gameId.slice(-6).toUpperCase()}`
    });

    const message = await fetchGameMessage(client, game);
    if (message) {
        const rows = createGameRows(game);
        rows.forEach(row => row.components.forEach(component => component.setDisabled(true)));
        await message.edit({ embeds: [embed], components: rows }).catch(() => {});
    }

    games.delete(gameId);
}

async function startGame(interaction, difficulty, mode) {
    const userId = interaction.user.id;
    const config = DIFFICULTIES[difficulty];

    const existingGame = findActiveGameForUser(userId);
    if (existingGame) {
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xff5577).setTitle('Game Already Active')
            .setDescription('You already have an active Lights Out game. Finish it before starting another.')] });
    }

    let seed;
    if (mode === 'daily') seed = getDailySeed();

    const grid = createSolvableGrid(config.size, seed);
    const optimalMoves = getOptimalMoves(grid, config.size);
    const gameId = createGameId(userId);

    const game = {
        gameId,
        userId,
        channelId: interaction.channelId,
        messageId: '',
        grid,
        initialGrid: cloneGrid(grid),
        size: config.size,
        difficulty,
        mode,
        attempts: 0,
        hintsUsed: 0,
        startedAt: Date.now(),
        gameActive: true,
        processing: false,
        history: [],
        undoUsed: false,
        resetUsed: false,
        optimalMoves,
        seed
    };

    const message = await interaction.editReply({ embeds: [createGameEmbed(game)], components: createGameRows(game) });
    game.messageId = message.id;
    games.set(gameId, game);

    const stats = getStats(userId);
    stats.gamesPlayed++;
    saveStats(userId);
    setCooldown(userId, 'lightsout');

    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: GAME_TIMEOUT });

    collector.on('collect', async i => {
        const currentGame = games.get(gameId);
        if (!currentGame || !currentGame.gameActive) {
            return i.reply({ content: 'This game has ended.' });
        }
        if (i.user.id !== userId) return i.reply({ content: 'This is not your game!' });
        if (currentGame.processing) {
            return i.reply({ content: 'Please wait for the previous move to finish.' });
        }
        currentGame.processing = true;

        try {
            const customId = i.customId;

            if (customId === `lo_quit_${gameId}`) {
                await i.deferUpdate();
                await endGame(gameId, 'quit', i.client);
                collector.stop('quit');
                return;
            }

            if (customId === `lo_hint_${gameId}`) {
                const recommendedMove = getRecommendedMove(currentGame.grid, currentGame.size);
                if (recommendedMove === null) {
                    await i.reply({ content: 'I could not calculate a hint for this board.' });
                    return;
                }
                currentGame.hintsUsed++;
                getStats(userId).hintsUsed++;
                saveStats(userId);
                const row = Math.floor(recommendedMove / currentGame.size) + 1;
                const col = (recommendedMove % currentGame.size) + 1;
                await i.reply({ content: `💡 Try pressing **Row ${row}, Column ${col}**.` });
                return;
            }

            if (customId === `lo_undo_${gameId}`) {
                if (currentGame.undoUsed) {
                    await i.reply({ content: 'Undo can only be used once per game.' });
                    return;
                }
                if (!restorePreviousState(currentGame)) {
                    await i.reply({ content: 'There are no moves to undo.' });
                    return;
                }
                currentGame.undoUsed = true;
                currentGame.processing = false;
                await i.update({ embeds: [createGameEmbed(currentGame)], components: createGameRows(currentGame) });
                return;
            }

            if (customId === `lo_reset_${gameId}`) {
                if (currentGame.resetUsed) {
                    await i.reply({ content: 'Reset can only be used once per game.' });
                    return;
                }
                resetGame(currentGame);
                currentGame.resetUsed = true;
                currentGame.processing = false;
                await i.update({ embeds: [createGameEmbed(currentGame)], components: createGameRows(currentGame) });
                return;
            }

            const prefix = `lo_${gameId}_`;
            if (!customId.startsWith(prefix)) {
                await i.deferUpdate();
                return;
            }
            const index = Number.parseInt(customId.slice(prefix.length), 10);
            if (!Number.isInteger(index) || index < 0 || index >= currentGame.grid.length) {
                await i.reply({ content: 'Invalid move.' });
                return;
            }

            pushHistory(currentGame);
            toggleLight(currentGame.grid, index, currentGame.size);
            currentGame.attempts++;

            if (isSolved(currentGame.grid)) {
                await i.deferUpdate();
                await endGame(gameId, 'win', i.client);
                collector.stop('win');
                return;
            }

            currentGame.processing = false;
            await i.update({ embeds: [createGameEmbed(currentGame)], components: createGameRows(currentGame) });
        } catch (error) {
            console.error('Error processing Lights Out interaction:', error);
            if (!i.replied && !i.deferred) {
                await i.reply({ content: 'An error occurred while processing that move.' });
            }
        } finally {
            const game = games.get(gameId);
            if (game) game.processing = false;
        }
    });

    collector.on('end', async (_collected, reason) => {
        if (reason === 'time') {
            const currentGame = games.get(gameId);
            if (currentGame && currentGame.gameActive) {
                await endGame(gameId, 'timeout', interaction.client);
            }
        }
    });
}

async function handleStats(interaction) {
    return interaction.editReply({ embeds: [createStatsEmbed(interaction.user)] });
}

async function handleLeaderboard(interaction) {
    return interaction.editReply({ embeds: [await createLeaderboardEmbed(interaction.user.id)] });
}

async function handleDaily(interaction) {
    const existingWin = db.prepare(
        'SELECT 1 FROM lights_out_daily_wins WHERE userId = ? AND dateKey = ?'
    ).get(interaction.user.id, getDateKey());
    if (existingWin) {
        return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(0x00d4ff).setTitle('Daily Puzzle Complete')
                .setDescription('You have already completed today’s Lights Out puzzle. Come back tomorrow for a new one.')]
        });
    }
    const existingGame = findActiveGameForUser(interaction.user.id);
    if (existingGame) {
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xff5577).setTitle('Game Already Active')
            .setDescription('Finish your current Lights Out game before starting another one.')] });
    }
    await startGame(interaction, 'normal', 'daily');
}

module.exports = {
    createSolvableGrid,
    solveLightsOut,
    getOptimalMoves,
    getRecommendedMove,
    calculateEfficiency,
    calculateReward,
    getDailySeed,
    toggleLight,
    isSolved,
    countLights,
    data: new SlashCommandBuilder()
        .setName('lightsout')
        .setDescription('Play the classic Lights Out puzzle game')
        .addStringOption(option => option
            .setName('action')
            .setDescription('Leave empty for a normal puzzle')
            .addChoices(
                { name: '🎮 Play — puzzle with a difficulty choice', value: 'play' },
                { name: '📅 Daily — today’s seeded puzzle', value: 'daily' },
                { name: '⚡ Challenge — high-reward puzzle', value: 'challenge' },
                { name: '💡 Hint — hint for your active game', value: 'hint' },
                { name: '↩️ Undo — undo your last move', value: 'undo' },
                { name: '🔄 Reset — reset your active board', value: 'reset' },
                { name: '🚪 Quit — end your active game', value: 'quit' },
                { name: '📊 Stats — your record', value: 'stats' },
                { name: '🏆 Leaderboard — top solvers', value: 'leaderboard' }
            ))
        .addStringOption(option => option.setName('difficulty').setDescription('Play/challenge: choose your difficulty')
            .addChoices(
                { name: '🟢 Easy — 3×3', value: 'easy' },
                { name: '🟡 Normal — 4×4', value: 'normal' },
                { name: '🔴 Hard — 5×5', value: 'hard' }
            )),
    async execute(interaction) {
        try {
            await interaction.deferReply();
            const userId = interaction.user.id;
            const subcommand = interaction.options.getString('action') ?? 'play';

            if (subcommand === 'stats') return handleStats(interaction);
            if (subcommand === 'leaderboard') return handleLeaderboard(interaction);

            // Slash-command hints/undo/reset/quit operate on an active game directly.
            const activeGame = findActiveGameForUser(userId);
            if (subcommand === 'hint' || subcommand === 'undo' || subcommand === 'reset' || subcommand === 'quit') {
                if (!activeGame || activeGame.userId !== userId) {
                    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xff5577).setTitle('No Active Game')
                        .setDescription('You do not have an active Lights Out game.')] });
                }
                if (subcommand === 'quit') {
                    await endGame(activeGame.gameId, 'quit', interaction.client);
                    return interaction.editReply({
                        embeds: [new EmbedBuilder().setColor(0x00d4ff).setTitle('Game Ended')
                            .setDescription('Your Lights Out game has been ended.')]
                    });
                }
                if (subcommand === 'hint') {
                    const move = getRecommendedMove(activeGame.grid, activeGame.size);
                    if (move === null) {
                        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xff5577).setTitle('No Hint Available')
                            .setDescription('I could not calculate a hint for this board.')] });
                    }
                    activeGame.hintsUsed++;
                    getStats(userId).hintsUsed++;
                    saveStats(userId);
                    const row = Math.floor(move / activeGame.size) + 1;
                    const column = (move % activeGame.size) + 1;
                    return interaction.editReply({
                        embeds: [new EmbedBuilder().setColor(0x00d4ff).setTitle('💡 Hint')
                            .setDescription(`Try pressing **Row ${row}, Column ${column}**.`)]
                    });
                }
                if (subcommand === 'undo') {
                    if (activeGame.undoUsed) {
                        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xffcc66).setTitle('Undo Already Used')
                            .setDescription('Undo can only be used once per game.')] });
                    }
                    if (!restorePreviousState(activeGame)) {
                        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xffcc66).setTitle('Nothing to Undo')
                            .setDescription('There are no moves to undo.')] });
                    }
                    activeGame.undoUsed = true;
                }
                if (subcommand === 'reset') {
                    if (activeGame.resetUsed) {
                        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xffcc66).setTitle('Reset Already Used')
                            .setDescription('Reset can only be used once per game.')] });
                    }
                    resetGame(activeGame);
                    activeGame.resetUsed = true;
                }
                const message = await fetchGameMessage(interaction.client, activeGame);
                if (message) {
                    await message.edit({ embeds: [createGameEmbed(activeGame)], components: createGameRows(activeGame) }).catch(() => {});
                }
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setColor(0x00e5a8).setTitle('Lights Out Updated')
                        .setDescription(subcommand === 'undo' ? 'Your last move was undone.' : 'Your board was reset.')]
                });
            }

            if (activeGame) {
                return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xff5577).setTitle('Game Already Active')
                    .setDescription('You already have an active Lights Out game. Finish it before starting another.')] });
            }

            const remaining = getRemainingTime(userId, 'lightsout');
            if (remaining > 0) {
                return interaction.editReply({ content: `You can play Lights Out again ${formatRemainingTime(remaining)}.` });
            }

            if (subcommand === 'play') {
                return startGame(interaction, interaction.options.getString('difficulty') ?? 'normal', 'classic');
            }
            if (subcommand === 'daily') return handleDaily(interaction);
            if (subcommand === 'challenge') {
                return startGame(interaction, interaction.options.getString('difficulty') ?? 'normal', 'challenge');
            }
        } catch (error) {
            console.error('Error in Lights Out command:', error);
            const embed = new EmbedBuilder().setColor(0xff5577).setTitle('Error')
                .setDescription('An error occurred while running Lights Out.');
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
            } else {
                await interaction.reply({ embeds: [embed] });
            }
        }
    }
};
