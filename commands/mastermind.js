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
const { getUser } = require('../systems/economy/userManager');
const { NEON, panel, kv, neonEmbed, ANSI } = require('../systems/games/neonUI');
const {
    getRemainingTime,
    formatRemainingTime,
    setCooldown
} = require('../systems/economy/cooldownManager');

const DIFFICULTY = {
    // easy is the DEFAULT: 4 colors in 3 slots with 12 tries keeps the opening
    // friendly (24 possible codes) while normal+ stay as the step-up ladder.
    easy: { length: 3, colors: 4, attempts: 12, reward: 300 },
    normal: { length: 4, colors: 6, attempts: 8, reward: 600 },
    hard: { length: 5, colors: 8, attempts: 8, reward: 1000 },
    expert: { length: 6, colors: 8, attempts: 7, reward: 2000 }
};

const COLORS = ['🔴', '🟢', '🔵', '🟡', '🟣', '🟠', '⚫', '⚪'];
const ENTRY_FEE = 25;
const HINT_COST = 100;
const MAX_HINTS = 2;
const SPEEDRUN_TIME_MS = 2 * 60 * 1000;
const GAME_TIME_MS = 10 * 60 * 1000;

const games = new Map();
const activeByUser = new Map();

function createSecret(difficulty, allowDuplicates, seed) {
    const { length, colors } = DIFFICULTY[difficulty];
    const secret = [];
    let state = seed
        ? [...seed].reduce((hash, char) => ((hash * 31 + char.charCodeAt(0)) >>> 0), 7)
        : 0;
    while (secret.length < length) {
        state = seed
            ? ((state * 1664525 + 1013904223) >>> 0)
            : Math.floor(Math.random() * 0xffffffff);
        const color = COLORS[state % colors];
        if (allowDuplicates || !secret.includes(color)) secret.push(color);
    }
    return secret;
}

function evaluateGuess(secret, guess) {
    let correctPosition = 0;
    let correctColor = 0;

    const secretCopy = [...secret];
    const guessCopy = [...guess];

    // Correct position first.
    for (let i = 0; i < secret.length; i++) {
        if (guessCopy[i] === secretCopy[i]) {
            correctPosition++;
            secretCopy[i] = '';
            guessCopy[i] = '';
        }
    }

    // Then correct color in the wrong position.
    for (let i = 0; i < secret.length; i++) {
        if (guessCopy[i] !== '') {
            const index = secretCopy.indexOf(guessCopy[i]);
            if (index !== -1) {
                correctColor++;
                secretCopy[index] = '';
            }
        }
    }

    return { correctPosition, correctColor };
}

function getStats(userId) {
    return db.prepare('SELECT * FROM mastermind_stats WHERE userId = ?').get(userId) || {
        userId, gamesPlayed: 0, gamesWon: 0, losses: 0, timeouts: 0, quits: 0, totalAttempts: 0,
        bestAttempts: null, fastestTimeMs: null, perfectWins: 0, dailyWins: 0, speedrunWins: 0,
        totalRewards: 0, creditsSpent: 0, hintsUsed: 0, currentStreak: 0, bestStreak: 0,
        achievements: '[]'
    };
}

function parseAchievements(stats) {
    try {
        const parsed = JSON.parse(stats.achievements || '[]');
        return Array.isArray(parsed) ? new Set(parsed) : new Set();
    } catch {
        return new Set();
    }
}

function saveStats(userId, updates) {
    db.prepare(`
        INSERT INTO mastermind_stats (userId) VALUES (?)
        ON CONFLICT(userId) DO NOTHING
    `).run(userId);
    const keys = Object.keys(updates);
    if (keys.length === 0) return;
    const assignments = keys.map(key => `${key} = excluded.${key}`).join(', ');
    db.prepare(`
        INSERT INTO mastermind_stats (${['userId', ...keys].join(', ')})
        VALUES (${['?', ...keys].map(() => '?').join(', ')})
        ON CONFLICT(userId) DO UPDATE SET ${assignments}
    `).run(userId, ...keys.map(key => updates[key]));
}

function ensureStats(userId) {
    db.prepare('INSERT OR IGNORE INTO mastermind_stats (userId) VALUES (?)').run(userId);
}

function updateAchievements(userId) {
    const stats = getStats(userId);
    const achievements = parseAchievements(stats);
    if (stats.gamesWon >= 1) achievements.add('First Crack');
    if (stats.gamesWon >= 10) achievements.add('Codebreaker');
    if (stats.gamesWon >= 100) achievements.add('Mastermind');
    if (stats.bestStreak >= 10) achievements.add('Unstoppable');
    if (stats.perfectWins >= 1) achievements.add('Perfect Game');
    if (stats.dailyWins >= 5) achievements.add('Daily Devotee');
    if (stats.speedrunWins >= 1) achievements.add('Speedrunner');
    if (stats.hintsUsed === 0 && stats.gamesWon >= 1) achievements.add('Hintless');
    saveStats(userId, { achievements: JSON.stringify([...achievements]) });
    return achievements;
}

function createButtonRows(game, disabled = false) {
    const gameId = game.gameId;
    const rows = [];

    // Color buttons, five per row.
    const colorCount = DIFFICULTY[game.difficulty].colors;
    for (let start = 0; start < colorCount; start += 5) {
        const colorRow = new ActionRowBuilder();
        for (let i = start; i < Math.min(start + 5, colorCount); i++) {
            colorRow.addComponents(
                new ButtonBuilder().setCustomId(`mm_color_${gameId}_${i}`).setLabel(COLORS[i])
                    .setStyle(ButtonStyle.Primary).setDisabled(disabled)
            );
        }
        rows.push(colorRow);
    }

    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mm_reverse_${gameId}`).setLabel('↩️ Undo').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`mm_clear_${gameId}`).setLabel('🧹 Clear').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`mm_submit_${gameId}`).setLabel('✅ Submit Guess').setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`mm_hint_${gameId}`).setLabel(`💡 Hint (${HINT_COST})`).setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`mm_quit_${gameId}`).setLabel('🚪 Quit').setStyle(ButtonStyle.Danger).setDisabled(disabled)
    );
    rows.push(actionRow);

    return rows;
}

function buildGameDescription(game) {
    const header = panel(
        `${ANSI.MAGENTA}◈ CODE PROTOCOL${ANSI.RESET}`,
        kv('Code length', `${game.secret.length} colors`),
        kv('Attempts', `${game.attempts}/${game.maxAttempts}`),
        kv('Buffer', game.currentGuess.length ? game.currentGuess.join(' ') : `${ANSI.DIM}empty${ANSI.RESET}`),
        '',
        `${ANSI.DIM}🟢 locked position${ANSI.RESET} ${ANSI.DIM}🟡 wrong slot${ANSI.RESET}`
    );
    // The log must render inside its own ```ansi``` panel — raw ANSI outside
    // a code block shows up in Discord as literal "[0;35m" garbage.
    const logLines = game.guesses.length === 0
        ? [`${ANSI.DIM}no transmissions decoded yet${ANSI.RESET}`]
        : game.guesses.map((g, i) =>
            `${ANSI.DIM}${String(i + 1).padStart(2, '0')}.${ANSI.RESET} ${g.guess.join('')} ${ANSI.GREEN}🟢${g.correctPosition}${ANSI.RESET} ${ANSI.YELLOW}🟡${g.correctColor}${ANSI.RESET}`
        );
    const logPanel = panel(`${ANSI.MAGENTA}◈ DECRYPTION LOG${ANSI.RESET}`, ...logLines);
    const banners = [];
    if (game.daily) banners.push('📅 **Daily Puzzle** — everyone gets the same code today.');
    if (game.speedrun) banners.push('⚡ **Speedrun** — solve within 2 minutes for a bonus reward.');
    return `${banners.join('\n')}${banners.length ? '\n\n' : ''}${header}\n\n${logPanel}`;
}

async function fetchGameMessage(client, game) {
    const channel = await client.channels.fetch(game.channelId).catch(() => null);
    if (!channel || !channel.messages) return null;
    return channel.messages.fetch(game.messageId).catch(() => null);
}

async function updateGameDisplay(gameId, client) {
    const game = games.get(gameId);
    if (!game) return;
    const embed = neonEmbed({
        userId: game.userId,
        title: '🧠 MASTERMIND',
        lines: null,
        description: buildGameDescription(game),
        footer: `NODE ${gameId.slice(-6).toUpperCase()}`
    });
    const message = await fetchGameMessage(client, game);
    if (message) {
        await message.edit({ embeds: [embed], components: createButtonRows(game) }).catch(() => {});
    }
}

async function endGame(gameId, result, client) {
    const game = games.get(gameId);
    if (!game || !game.gameActive) return;
    game.gameActive = false;

    const stats = getStats(game.userId);
    let reward = 0;
    let description = '';

    if (result === 'win') {
        const efficiencyMultiplier = game.attempts <= 2 ? 1.5 : game.attempts <= 4 ? 1.25 : game.attempts >= 7 ? 0.75 : 1;
        const baseReward = Math.max(0, Math.floor(DIFFICULTY[game.difficulty].reward * efficiencyMultiplier));
        const perfectBonus = game.attempts === 1 ? 500 : 0;
        const speedrunBonus = game.speedrun && (Date.now() - game.startedAt) <= SPEEDRUN_TIME_MS ? 250 : 0;
        reward = baseReward + perfectBonus + speedrunBonus;

        const elapsed = Date.now() - game.startedAt;
        const streak = stats.currentStreak + 1;

        stats.gamesPlayed++;
        stats.gamesWon++;
        stats.totalAttempts += game.attempts;
        if (stats.bestAttempts === null || game.attempts < stats.bestAttempts) stats.bestAttempts = game.attempts;
        if (game.speedrun && (stats.fastestTimeMs === null || elapsed < stats.fastestTimeMs)) stats.fastestTimeMs = elapsed;
        if (game.attempts === 1) stats.perfectWins++;
        if (game.daily) stats.dailyWins++;
        if (game.speedrun) stats.speedrunWins++;
        stats.totalRewards += reward;
        stats.creditsSpent += game.fee + game.hintsUsed * HINT_COST;
        stats.hintsUsed += game.hintsUsed;
        stats.currentStreak = streak;
        stats.bestStreak = Math.max(stats.bestStreak, streak);
        saveStats(game.userId, {
            gamesPlayed: stats.gamesPlayed, gamesWon: stats.gamesWon, totalAttempts: stats.totalAttempts,
            bestAttempts: stats.bestAttempts, fastestTimeMs: stats.fastestTimeMs, perfectWins: stats.perfectWins,
            dailyWins: stats.dailyWins, speedrunWins: stats.speedrunWins, totalRewards: stats.totalRewards,
            creditsSpent: stats.creditsSpent, hintsUsed: stats.hintsUsed, currentStreak: stats.currentStreak,
            bestStreak: stats.bestStreak
        });
        updateAchievements(game.userId);

        try {
            casino.creditWallet(game.userId, 'mastermind', reward, 'payout', 'Mastermind win');
        } catch (error) {
            console.error('Mastermind payout failed:', error);
        }

        description = `🎉 You cracked the code! The secret was **${game.secret.join('')}**.\n\n` +
            `🎯 Attempts: **${game.attempts}**\n` +
            `💰 Reward: **🪙${reward.toLocaleString()}**\n` +
            (perfectBonus ? '🏆 **Perfect game bonus!**\n' : '') +
            (speedrunBonus ? '⚡ **Speedrun bonus included!**\n' : '') +
            `🔥 Win streak: **${stats.currentStreak}**`;
    } else {
        stats.gamesPlayed++;
        stats.totalAttempts += game.attempts;
        stats.creditsSpent += game.fee + game.hintsUsed * HINT_COST;
        stats.hintsUsed += game.hintsUsed;
        stats.currentStreak = 0;
        if (result === 'lose') stats.losses++;
        if (result === 'timeout') stats.timeouts++;
        if (result === 'quit') stats.quits++;
        saveStats(game.userId, {
            gamesPlayed: stats.gamesPlayed, totalAttempts: stats.totalAttempts,
            creditsSpent: stats.creditsSpent, hintsUsed: stats.hintsUsed, currentStreak: 0,
            losses: stats.losses, timeouts: stats.timeouts, quits: stats.quits
        });
        updateAchievements(game.userId);

        if (result === 'lose') {
            description = `😢 You ran out of attempts! The secret was **${game.secret.join('')}**. Better luck next time!`;
        } else if (result === 'timeout') {
            description = `⏰ Game timed out! The secret was **${game.secret.join('')}**.`;
        } else {
            description = `🚪 You quit the game. The secret was **${game.secret.join('')}**.`;
        }
    }

    const embed = neonEmbed({
        userId: game.userId,
        title: `🧠 MASTERMIND // ${result === 'win' ? 'CODE CRACKED' : 'RUN TERMINATED'}`,
        color: result === 'win' ? NEON.green : NEON.red,
        lines: null,
        description,
        footer: `NODE ${gameId.slice(-6).toUpperCase()}`
    });

    const message = await fetchGameMessage(client, game);
    if (message) {
        const rows = createButtonRows(game, true);
        await message.edit({ embeds: [embed], components: rows }).catch(() => {});
    }

    games.delete(gameId);
    activeByUser.delete(game.userId);
}

function runCollector(message, game, interaction) {
    const userId = game.userId;
    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: game.speedrun ? SPEEDRUN_TIME_MS : GAME_TIME_MS
    });

    collector.on('collect', async i => {
        if (i.user.id !== userId) {
            return i.reply({ content: 'This is not your game!' });
        }
        const currentGame = games.get(game.gameId);
        if (!currentGame || !currentGame.gameActive) {
            return i.reply({ content: 'This game has ended.' });
        }

        try {
            if (i.customId.startsWith(`mm_color_${game.gameId}_`)) {
                const colorIndex = Number.parseInt(i.customId.split('_')[3], 10);
                const color = COLORS[colorIndex];
                if (currentGame.currentGuess.length < currentGame.secret.length) {
                    currentGame.currentGuess.push(color);
                }
                await i.deferUpdate();
                await updateGameDisplay(game.gameId, i.client);
            } else if (i.customId === `mm_submit_${game.gameId}`) {
                if (currentGame.currentGuess.length !== currentGame.secret.length) {
                    await i.reply({ content: `You must select exactly ${currentGame.secret.length} colors!` });
                    return;
                }
                await i.deferUpdate();
                const result = evaluateGuess(currentGame.secret, currentGame.currentGuess);
                currentGame.guesses.push({ guess: [...currentGame.currentGuess], ...result });
                currentGame.attempts++;
                currentGame.currentGuess = [];

                if (result.correctPosition === currentGame.secret.length) {
                    await endGame(game.gameId, 'win', i.client);
                    collector.stop('win');
                } else if (currentGame.attempts >= currentGame.maxAttempts) {
                    await endGame(game.gameId, 'lose', i.client);
                    collector.stop('lose');
                } else {
                    await updateGameDisplay(game.gameId, i.client);
                }
            } else if (i.customId === `mm_clear_${game.gameId}`) {
                currentGame.currentGuess = [];
                await i.deferUpdate();
                await updateGameDisplay(game.gameId, i.client);
            } else if (i.customId === `mm_reverse_${game.gameId}`) {
                currentGame.currentGuess.pop();
                await i.deferUpdate();
                await updateGameDisplay(game.gameId, i.client);
            } else if (i.customId === `mm_hint_${game.gameId}`) {
                if (currentGame.hintsUsed >= MAX_HINTS) {
                    await i.reply({ content: `You can use at most ${MAX_HINTS} hints per game.` });
                    return;
                }
                const user = getUser(userId);
                if (user.wallet < HINT_COST) {
                    await i.reply({ content: `You need 🪙${HINT_COST} in your wallet for a hint.` });
                    return;
                }
                casino.debitWallet(userId, 'mastermind', HINT_COST, 'Mastermind hint');
                currentGame.hintsUsed++;
                const position = currentGame.hintsUsed - 1;
                const color = currentGame.secret[position];
                await i.reply({
                    content: `💡 Hint: position ${position + 1} contains ${color}. (−🪙${HINT_COST})` });
                await updateGameDisplay(game.gameId, i.client);
            } else if (i.customId === `mm_quit_${game.gameId}`) {
                await i.deferUpdate();
                await endGame(game.gameId, 'quit', i.client);
                collector.stop('quit');
            }
        } catch (error) {
            console.error('Error processing Mastermind interaction:', error);
            if (!i.replied && !i.deferred) {
                await i.reply({ content: 'Something went wrong processing that action.' });
            }
        }
    });

    collector.on('end', async (_collected, reason) => {
        if (reason === 'time') {
            const currentGame = games.get(game.gameId);
            if (currentGame && currentGame.gameActive) {
                await endGame(game.gameId, 'timeout', interaction.client);
            }
        }
    });

    return collector;
}

async function startGame(interaction, { difficulty, allowDuplicates, daily, speedrun }) {
    const userId = interaction.user.id;

    if (activeByUser.has(userId)) {
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xff5577).setTitle('Game Already Active')
            .setDescription('Finish your current Mastermind game first.')] });
    }

    const remaining = getRemainingTime(userId, 'mastermind');
    if (remaining > 0) {
        return interaction.editReply({ content: `You can play Mastermind again ${formatRemainingTime(remaining)}.` });
    }

    const user = getUser(userId);
    if (user.wallet < ENTRY_FEE) {
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xff5577).setTitle('Insufficient Funds')
            .setDescription(`Mastermind requires a 🪙${ENTRY_FEE} entry fee.`)] });
    }
    casino.debitWallet(userId, 'mastermind', ENTRY_FEE, 'Mastermind entry fee');

    ensureStats(userId);

    const gameId = `${userId}-${Date.now()}`;
    const game = {
        gameId,
        userId,
        channelId: interaction.channelId,
        messageId: '',
        secret: createSecret(difficulty, allowDuplicates, daily ? new Date().toISOString().slice(0, 10) : undefined),
        attempts: 0,
        maxAttempts: DIFFICULTY[difficulty].attempts,
        guesses: [],
        currentGuess: [],
        gameActive: true,
        difficulty,
        allowDuplicates,
        daily,
        speedrun,
        fee: ENTRY_FEE,
        startedAt: Date.now(),
        hintsUsed: 0
    };
    activeByUser.set(userId, gameId);

    const embed = neonEmbed({
        userId,
        title: '🧠 MASTERMIND',
        lines: null,
        description: buildGameDescription(game),
        footer: `NODE ${gameId.slice(-6).toUpperCase()}`
    });

    const message = await interaction.editReply({ embeds: [embed], components: createButtonRows(game) });
    game.messageId = message.id;
    games.set(gameId, game);
    setCooldown(userId, 'mastermind');

    runCollector(message, game, interaction);
}

async function showStats(interaction) {
    const userId = interaction.user.id;
    ensureStats(userId);
    const s = getStats(userId);
    const achievements = [...parseAchievements(s)];
    return interaction.editReply({
        embeds: [neonEmbed({
            userId,
            title: '🧠 MASTERMIND // OPERATIVE DOSSIER',
            lines: [
                `${ANSI.MAGENTA}◈ RECORD${ANSI.RESET}`,
                kv('Games', `${s.gamesPlayed}`),
                kv('Wins', `${s.gamesWon}`),
                kv('Losses', `${s.losses} • ${s.timeouts} timed out • ${s.quits} aborted`),
                kv('Best solve', `${s.bestAttempts ?? '—'} attempts`),
                kv('Streak', `${s.currentStreak} (best ${s.bestStreak})`),
                '',
                `${ANSI.MAGENTA}◈ SPECIALTIES${ANSI.RESET}`,
                kv('Perfect games', `${s.perfectWins}`),
                kv('Daily codes', `${s.dailyWins}`),
                kv('Speedruns', `${s.speedrunWins}`),
                kv('Rewards', `🪙${Number(s.totalRewards).toLocaleString()}`),
                kv('Spent', `🪙${Number(s.creditsSpent).toLocaleString()}`),
                '',
                `${ANSI.MAGENTA}◈ ACHIEVEMENTS${ANSI.RESET}`,
                achievements.length
                    ? achievements.map(a => `${ANSI.YELLOW}🏆 ${a}${ANSI.RESET}`).join('\n')
                    : `${ANSI.DIM}no codes cracked yet${ANSI.RESET}`
            ]
        })]
    });
}

async function showLeaderboard(interaction) {
    const rows = db.prepare(
        'SELECT * FROM mastermind_stats WHERE gamesWon > 0 ORDER BY gamesWon DESC, bestAttempts IS NULL, bestAttempts ASC LIMIT 10'
    ).all();
    return interaction.editReply({
        embeds: [neonEmbed({
            userId: interaction.user.id,
            title: '🏆 MASTERMIND // TOP CODEBREAKERS',
            color: NEON.gold,
            lines: rows.length
                ? rows.map((s, i) => `${ANSI.DIM}${String(i + 1).padStart(2, '0')}.${ANSI.RESET} <@${s.userId}> ${ANSI.CYAN}»${ANSI.RESET} ${s.gamesWon} wins (best ${s.bestAttempts ?? '—'})`)
                : [`${ANSI.DIM}no codes cracked yet${ANSI.RESET}`]
        })]
    });
}

module.exports = {
    createSecret,
    evaluateGuess,
    DIFFICULTY,
    COLORS,
    data: new SlashCommandBuilder()
        .setName('mastermind')
        .setDescription('Play the Mastermind code-breaking game')
        .addStringOption(o => o.setName('mode').setDescription('What to do').addChoices(
            { name: 'Play', value: 'play' },
            { name: 'Daily', value: 'daily' },
            { name: 'Speedrun', value: 'speedrun' },
            { name: 'Stats', value: 'stats' },
            { name: 'Leaderboard', value: 'leaderboard' },
            { name: 'Help', value: 'help' }
        ))
        .addStringOption(o => o.setName('difficulty').setDescription('Puzzle difficulty (Easy by default)').addChoices(
            { name: 'Easy — 3 slots, 4 colors (default)', value: 'easy' },
            { name: 'Normal', value: 'normal' },
            { name: 'Hard', value: 'hard' },
            { name: 'Expert', value: 'expert' }
        ))
        .addBooleanOption(o => o.setName('duplicates').setDescription('Allow duplicate colors')),
    async execute(interaction) {
        try {
            await interaction.deferReply();
            const mode = interaction.options.getString('mode') ?? 'play';

            if (mode === 'help') {
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setColor(0x00d4ff).setTitle('Mastermind Help').setDescription(
                        'Build a code, then submit it. 🟢 means correct color in the correct position and 🟡 means correct color in the wrong position. ' +
                        'Use Undo or Clear to edit your guess. Difficulty changes code length, colors, attempts, and rewards. ' +
                        `Entry fee: 🪙${ENTRY_FEE}. Hints cost 🪙${HINT_COST} each (max ${MAX_HINTS}).`
                    )]
                });
            }
            if (mode === 'stats') return showStats(interaction);
            if (mode === 'leaderboard') return showLeaderboard(interaction);

            const daily = mode === 'daily';
            const speedrun = mode === 'speedrun';
            // Daily puzzles have a fixed ruleset so everyone solves the same challenge.
            // Daily stays locked to normal (everyone solves the same challenge);
            // casual play defaults to easy so the game opens gentle.
            const difficulty = daily ? 'normal' : interaction.options.getString('difficulty') ?? 'easy';
            const allowDuplicates = daily ? true : interaction.options.getBoolean('duplicates') ?? false;

            return startGame(interaction, { difficulty, allowDuplicates, daily, speedrun });
        } catch (error) {
            console.error('Error in mastermind command:', error);
            const embed = new EmbedBuilder().setColor(0xff5577).setTitle('Error')
                .setDescription('An error occurred while starting the game.');
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
            } else {
                await interaction.reply({ embeds: [embed] });
            }
        }
    }
};
