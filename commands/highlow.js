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
const { NEON, panel, kv, neonEmbed, progressBar, ANSI } = require('../systems/games/neonUI');
const {
    getRemainingTime,
    formatRemainingTime,
    setCooldown
} = require('../systems/economy/cooldownManager');

const MAX_ROUNDS = 5;
const TIMEOUT_MS = 5 * 60 * 1000;

// Transparent multiplier probabilities, intentionally explicit and totaling 100%.
const MULTIPLIER_PROBABILITIES = { normal: 75, twoX: 15, mystery: 8, lucky: 2 };

// Shown to the player when the mystery multiplier resolves.
const MYSTERY_MULTIPLIERS = [
    { multiplier: 2, probability: 40 },
    { multiplier: 2.5, probability: 30 },
    { multiplier: 3, probability: 20 },
    { multiplier: 5, probability: 10 }
];

const ACHIEVEMENTS = {
    FIRST_WIN: 'First Win',
    TEN_WINS: '10 Wins',
    FIFTY_ROUNDS: '50 Rounds',
    LUCKY_PLAYER: 'Lucky Player',
    MYSTERY_HUNTER: 'Mystery Hunter',
    TWO_X_CLUB: '2X Club',
    HOT_STREAK: 'Hot Streak',
    BIG_WINNER: 'Big Winner',
    PVP_CHAMPION: 'PvP Champion',
    LEVEL_FIVE: 'Level 5'
};

const games = new Map();
const pvpQueue = new Map();
const locks = new Set();

function withLock(gameId, interaction, action) {
    if (locks.has(gameId)) {
        return interaction.reply({ content: 'Please wait for the previous action to finish.' });
    }
    locks.add(gameId);
    return action().finally(() => locks.delete(gameId));
}

function generateNumber() {
    return Math.floor(Math.random() * 100) + 1;
}

// The next number is an independent uniform draw from 1-100, so the win
// probabilities shown on the buttons are exact: P(higher) = (100-n)/100,
// P(lower) = (n-1)/100, P(same) = 1/100.
function guessChances(current) {
    return { higher: 100 - current, lower: current - 1, same: 1 };
}

function getStats(userId) {
    return db.prepare('SELECT * FROM high_low_stats WHERE userId = ?').get(userId) || {
        userId, roundsPlayed: 0, roundsWon: 0, gamesPlayed: 0, gamesWon: 0, totalWinnings: 0,
        highestPayout: 0, currentStreak: 0, bestStreak: 0, luckyRounds: 0, mysteryMultipliers: 0,
        twoXMultipliers: 0, pvpGames: 0, pvpWins: 0, progressionXP: 0, level: 1, achievements: '[]'
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

function saveStats(userId) {
    const stats = getStats(userId);
    db.prepare(`
        INSERT INTO high_low_stats
            (userId, roundsPlayed, roundsWon, gamesPlayed, gamesWon, totalWinnings, highestPayout,
             currentStreak, bestStreak, luckyRounds, mysteryMultipliers, twoXMultipliers, pvpGames,
             pvpWins, progressionXP, level, achievements)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(userId) DO UPDATE SET
            roundsPlayed = excluded.roundsPlayed,
            roundsWon = excluded.roundsWon,
            gamesPlayed = excluded.gamesPlayed,
            gamesWon = excluded.gamesWon,
            totalWinnings = excluded.totalWinnings,
            highestPayout = excluded.highestPayout,
            currentStreak = excluded.currentStreak,
            bestStreak = excluded.bestStreak,
            luckyRounds = excluded.luckyRounds,
            mysteryMultipliers = excluded.mysteryMultipliers,
            twoXMultipliers = excluded.twoXMultipliers,
            pvpGames = excluded.pvpGames,
            pvpWins = excluded.pvpWins,
            progressionXP = excluded.progressionXP,
            level = excluded.level,
            achievements = excluded.achievements
    `).run(
        userId, stats.roundsPlayed, stats.roundsWon, stats.gamesPlayed, stats.gamesWon,
        stats.totalWinnings, stats.highestPayout, stats.currentStreak, stats.bestStreak,
        stats.luckyRounds, stats.mysteryMultipliers, stats.twoXMultipliers, stats.pvpGames,
        stats.pvpWins, stats.progressionXP, stats.level, JSON.stringify([...parseAchievements(stats)])
    );
}

function xpRequiredForLevel(level) {
    return 100 + (level - 1) * 100;
}

function addXP(userId, amount) {
    const stats = getStats(userId);
    stats.progressionXP += amount;
    while (stats.progressionXP >= xpRequiredForLevel(stats.level + 1)) {
        stats.level++;
    }
    updateAchievements(userId);
}

function getPresetDescription(preset) {
    if (preset === 'safe') return 'Safer mode: Same pays less, but the overall round variance is reduced.';
    if (preset === 'aggressive') return 'Aggressive mode: higher Same payout and more volatile results.';
    return 'Classic High/Low balance.';
}

function getSameMultiplier(preset) {
    if (preset === 'safe') return 3;
    if (preset === 'aggressive') return 7;
    return 5;
}

function rollMysteryMultiplier() {
    const roll = Math.random() * 100;
    let cumulative = 0;
    for (const entry of MYSTERY_MULTIPLIERS) {
        cumulative += entry.probability;
        if (roll < cumulative) return entry.multiplier;
    }
    return 2;
}

function rollMultiplier() {
    const roll = Math.random() * 100;
    if (roll < MULTIPLIER_PROBABILITIES.lucky) return { type: 'lucky', multiplier: 3 };
    if (roll < MULTIPLIER_PROBABILITIES.lucky + MULTIPLIER_PROBABILITIES.mystery) {
        return { type: 'mystery', multiplier: rollMysteryMultiplier() };
    }
    if (roll < MULTIPLIER_PROBABILITIES.lucky + MULTIPLIER_PROBABILITIES.mystery + MULTIPLIER_PROBABILITIES.twoX) {
        return { type: 'two_x', multiplier: 2 };
    }
    return { type: 'normal', multiplier: 1 };
}

function getMultiplierLabel(type, multiplier) {
    if (type === 'two_x') return '⚡ **2× Multiplier**';
    if (type === 'mystery') return `❓ **Mystery Multiplier: ${multiplier}×**`;
    if (type === 'lucky') return `🍀 **LUCKY ROUND: ${multiplier}×**`;
    return `Multiplier: **${multiplier}×**`;
}

function updateAchievements(userId) {
    const stats = getStats(userId);
    const achievements = parseAchievements(stats);
    const unlock = (key, condition) => {
        if (condition) achievements.add(key);
    };
    unlock(ACHIEVEMENTS.FIRST_WIN, stats.gamesWon >= 1);
    unlock(ACHIEVEMENTS.TEN_WINS, stats.gamesWon >= 10);
    unlock(ACHIEVEMENTS.FIFTY_ROUNDS, stats.roundsPlayed >= 50);
    unlock(ACHIEVEMENTS.LUCKY_PLAYER, stats.luckyRounds >= 1);
    unlock(ACHIEVEMENTS.MYSTERY_HUNTER, stats.mysteryMultipliers >= 5);
    unlock(ACHIEVEMENTS.TWO_X_CLUB, stats.twoXMultipliers >= 5);
    unlock(ACHIEVEMENTS.HOT_STREAK, stats.bestStreak >= 5);
    unlock(ACHIEVEMENTS.BIG_WINNER, stats.highestPayout >= 5000);
    unlock(ACHIEVEMENTS.PVP_CHAMPION, stats.pvpWins >= 10);
    unlock(ACHIEVEMENTS.LEVEL_FIVE, stats.level >= 5);
    stats.achievements = JSON.stringify([...achievements]);
}

function recordRound(userId, won) {
    const stats = getStats(userId);
    stats.roundsPlayed++;
    if (won) {
        stats.roundsWon++;
        stats.currentStreak++;
        if (stats.currentStreak > stats.bestStreak) stats.bestStreak = stats.currentStreak;
        addXP(userId, 25);
    } else {
        stats.currentStreak = 0;
        addXP(userId, 5);
    }
    updateAchievements(userId);
}

function recordMultiplier(userId, type) {
    const stats = getStats(userId);
    if (type === 'lucky') stats.luckyRounds++;
    if (type === 'mystery') stats.mysteryMultipliers++;
    if (type === 'two_x') stats.twoXMultipliers++;
    updateAchievements(userId);
}

function trackWinnings(userId, amount) {
    if (amount <= 0) return;
    const stats = getStats(userId);
    stats.totalWinnings += amount;
    if (amount > stats.highestPayout) stats.highestPayout = amount;
    updateAchievements(userId);
}

function createStatsEmbed(userId) {
    const stats = getStats(userId);
    const achievements = parseAchievements(stats);
    const achievementLines = achievements.size > 0
        ? [...achievements].map(achievement => `${ANSI.YELLOW}🏆 ${achievement}${ANSI.RESET}`).join('\n')
        : `${ANSI.DIM}no achievements unlocked yet${ANSI.RESET}`;
    const nextLevelXP = xpRequiredForLevel(stats.level + 1);
    const winRate = stats.roundsPlayed > 0
        ? ((stats.roundsWon / stats.roundsPlayed) * 100).toFixed(1)
        : '0.0';

    return neonEmbed({
        userId,
        title: '📊 HIGH/LOW // OPERATIVE DOSSIER',
        color: NEON.cyan,
        lines: [
            `${ANSI.MAGENTA}◈ PROGRESSION${ANSI.RESET}`,
            kv('Level', `${stats.level}`),
            `${ANSI.DIM}XP${ANSI.RESET} ${progressBar(stats.progressionXP, nextLevelXP)} ${ANSI.DIM}${stats.progressionXP}/${nextLevelXP}${ANSI.RESET}`,
            '',
            `${ANSI.MAGENTA}◈ PERFORMANCE${ANSI.RESET}`,
            kv('Games', `${stats.gamesPlayed} (${stats.gamesWon} won)`),
            kv('Rounds', `${stats.roundsPlayed} (${stats.roundsWon} won)`),
            kv('Win rate', `${winRate}%`),
            kv('Streak', `${stats.currentStreak} (best ${stats.bestStreak})`),
            kv('Winnings', `🪙${Number(stats.totalWinnings).toLocaleString()}`),
            kv('Best payout', `🪙${Number(stats.highestPayout).toLocaleString()}`),
            '',
            `${ANSI.MAGENTA}◈ MULTIPLIER EVENTS${ANSI.RESET}`,
            kv('2×', `${stats.twoXMultipliers}`),
            kv('Mystery', `${stats.mysteryMultipliers}`),
            kv('Lucky', `${stats.luckyRounds}`),
            '',
            `${ANSI.MAGENTA}◈ PVP RECORD${ANSI.RESET}`,
            kv('Games', `${stats.pvpGames}`),
            kv('Wins', `${stats.pvpWins}`),
            '',
            `${ANSI.MAGENTA}◈ ACHIEVEMENTS${ANSI.RESET}`,
            achievementLines
        ]
    });
}

function createRulesEmbed() {
    return neonEmbed({
        title: '📋 HIGH/LOW // RULES & ODDS',
        color: NEON.gold,
        lines: [
            `${ANSI.MAGENTA}◈ FORMAT${ANSI.RESET}`,
            kv('Rounds', '5 per game'),
            '',
            `${ANSI.MAGENTA}◈ BASE PAYOUTS${ANSI.RESET}`,
            kv('Higher', '1.5×'),
            kv('Lower', '1.5×'),
            kv('Same', '5× (Classic)'),
            '',
            `${ANSI.MAGENTA}◈ MULTIPLIER EVENTS — EXACT ODDS${ANSI.RESET}`,
            kv('Normal', `${MULTIPLIER_PROBABILITIES.normal}%`),
            kv('2× Multiplier', `${MULTIPLIER_PROBABILITIES.twoX}%`),
            kv('Mystery', `${MULTIPLIER_PROBABILITIES.mystery}%`),
            kv('Lucky 3×', `${MULTIPLIER_PROBABILITIES.lucky}%`),
            '',
            `${ANSI.MAGENTA}◈ MYSTERY ROLLS${ANSI.RESET}`,
            ...MYSTERY_MULTIPLIERS.map(entry => kv(`${entry.multiplier}×`, `${entry.probability}% of mysteries`)),
            '',
            kv('Timeout', '67% of bet refunded'),
            kv('Quit', 'stake forfeited'),
            kv('PvP', 'winner takes pool +10% bonus')
        ]
    });
}

function createGameButtons(game, disabled = false) {
    const chances = guessChances(game.firstNumber);
    const guessingRow = new ActionRowBuilder().addComponents(
        // Live odds printed on every button — they track the current number.
        new ButtonBuilder().setCustomId(`hl_higher_${game.gameId}`).setLabel(`▲ HIGHER ${chances.higher}%`).setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`hl_lower_${game.gameId}`).setLabel(`▼ LOWER ${chances.lower}%`).setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`hl_same_${game.gameId}`).setLabel(`◆ SAME ${chances.same}%`).setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`hl_quit_${game.gameId}`).setLabel('✖ ABORT').setStyle(ButtonStyle.Danger).setDisabled(disabled)
    );
    const statsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`hl_stats_${game.gameId}`).setLabel('📊 DOSSIER').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`hl_rules_${game.gameId}`).setLabel('📋 ODDS').setStyle(ButtonStyle.Secondary)
    );
    return [guessingRow, statsRow];
}

function createRoundEmbed(game) {
    const modeLabel = game.mode === 'pvp' ? `⚔️ PvP vs <@${game.opponentId}>` : '🎮 Solo';
    const chances = guessChances(game.firstNumber);
    return neonEmbed({
        userId: game.userId,
        title: '📈 HIGH/LOW',
        lines: [
            modeLabel,
            `${ANSI.MAGENTA}◈ ROUND ${game.round}/${game.maxRounds}${ANSI.RESET}`,
            '',
            `${ANSI.BOLD}CORE NUMBER:${ANSI.RESET} ${ANSI.CYAN}${ANSI.BOLD}${game.firstNumber}${ANSI.RESET}`,
            '',
            `${ANSI.DIM}next draw odds:${ANSI.RESET} ▲${chances.higher}% ▼${chances.lower}% ◆${chances.same}%`,
            kv('Bet', `🪙${game.originalBet.toLocaleString()}`),
            kv('Preset', game.preset),
            `${ANSI.DIM}${getPresetDescription(game.preset)}${ANSI.RESET}`,
            '',
            `${ANSI.DIM}a dynamic multiplier may trigger on wins${ANSI.RESET}`
        ],
        footer: `NODE ${game.gameId.slice(-6).toUpperCase()}`
    });
}

function determineWin(choice, first, second) {
    return (choice === 'higher' && second > first) ||
        (choice === 'lower' && second < first) ||
        (choice === 'same' && second === first);
}

function playRound(game, choice) {
    game.secondNumber = generateNumber();
    game.lastChoice = choice;
    const won = determineWin(choice, game.firstNumber, game.secondNumber);
    game.currentRoundWon = won;
    recordRound(game.userId, won);

    if (!won) {
        game.totalPayout = 0;
        return { won, roundPayout: 0 };
    }

    const multiplierResult = rollMultiplier();
    game.lastMultiplier = multiplierResult.multiplier;
    game.lastMultiplierType = multiplierResult.type;
    recordMultiplier(game.userId, multiplierResult.type);

    const baseMultiplier = choice === 'same' ? getSameMultiplier(game.preset) : 1.5;
    const roundPayout = Math.floor(game.originalBet * baseMultiplier * multiplierResult.multiplier);
    game.totalPayout += roundPayout;
    trackWinnings(game.userId, roundPayout);

    return { won, roundPayout, multiplierResult, baseMultiplier };
}

async function fetchGameMessage(client, game) {
    const channel = await client.channels.fetch(game.channelId).catch(() => null);
    if (!channel || !channel.messages) return null;
    return channel.messages.fetch(game.messageId).catch(() => null);
}

async function handleRoundLoss(interaction, game, client, collector) {
    const isFinalRound = game.round >= game.maxRounds;
    game.round++;
    saveStats(game.userId);

    if (isFinalRound) {
        game.gameActive = false;
        const stats = getStats(game.userId);
        stats.gamesPlayed++;
        updateAchievements(game.userId);
        saveStats(game.userId);

        const embed = neonEmbed({
            userId: game.userId,
            title: '📈 HIGH/LOW // LINK SEVERED',
            color: NEON.red,
            lines: [
                kv('Second number', `${game.secondNumber}`),
                kv('Your call', game.lastChoice),
                '',
                `${ANSI.RED}≫ ROUND LOST — GAME OVER${ANSI.RESET}`,
                `${ANSI.DIM}final payout 🪙0${ANSI.RESET}`
            ],
            footer: `NODE ${game.gameId.slice(-6).toUpperCase()}`
        });
        await interaction.update({ embeds: [embed], components: createGameButtons(game, true) });
        games.delete(game.gameId);
        collector.stop('lost');
        return;
    }

    await interaction.update({
        embeds: [neonEmbed({
            userId: game.userId,
            title: `❌ ROUND ${game.round - 1} LOST`,
            color: NEON.red,
            lines: [
                kv('Second number', `${game.secondNumber}`),
                kv('Your call', game.lastChoice),
                '',
                `${ANSI.RED}≫ BUFFER RESET — PAYOUT WIPED${ANSI.RESET}`,
                `${ANSI.DIM}rebuilding for round ${game.round}/${game.maxRounds}...${ANSI.RESET}`
            ]
        })],
        components: []
    });
    collector.stop('round_lost');
    await advanceToNextRound(game, client);
}

async function handleWinningRound(interaction, game, roundPayout, multiplierResult, baseMultiplier, client, collector) {
    saveStats(game.userId);

    if (game.round >= game.maxRounds) {
        await finishGame(interaction, game);
        collector.stop('complete');
        return;
    }

    await interaction.update({
        embeds: [neonEmbed({
            userId: game.userId,
            title: `🎉 ROUND ${game.round} CLEARED`,
            color: NEON.green,
            lines: [
                kv('Second number', `${game.secondNumber}`),
                kv('Base payout', `${baseMultiplier}×`),
                getMultiplierLabel(multiplierResult.type, multiplierResult.multiplier),
                '',
                kv('Round payout', `🪙${roundPayout.toLocaleString()}`),
                kv('Accumulated', `🪙${game.totalPayout.toLocaleString()}`),
                '',
                `${ANSI.DIM}spooling round ${game.round + 1}/${game.maxRounds}...${ANSI.RESET}`
            ]
        })],
        components: []
    });
    collector.stop('round_complete');
    await advanceToNextRound(game, client);
}

async function finishGame(interaction, game) {
    game.gameActive = false;
    const payout = game.totalPayout;
    const stats = getStats(game.userId);
    stats.gamesPlayed++;
    if (payout > 0) {
        stats.gamesWon++;
        try {
            casino.creditWallet(game.userId, 'highlow', payout, 'payout', 'High/Low payout');
        } catch (error) {
            console.error('High/Low payout failed:', error);
        }
    }
    updateAchievements(game.userId);
    saveStats(game.userId);

    const embed = neonEmbed({
        userId: game.userId,
        title: '🏁 HIGH/LOW // RUN COMPLETE',
        color: payout > 0 ? NEON.green : NEON.red,
        lines: [
            `${ANSI.DIM}all ${game.maxRounds} rounds resolved${ANSI.RESET}`,
            '',
            kv('Original bet', `🪙${game.originalBet.toLocaleString()}`),
            kv('Total payout', `🪙${payout.toLocaleString()}`),
            '',
            payout > 0
                ? `${ANSI.GREEN}${ANSI.BOLD}≫ PAYOUT: 🪙${payout.toLocaleString()} <<${ANSI.RESET}`
                : `${ANSI.RED}≫ NO PAYOUT THIS RUN${ANSI.RESET}`,
            '',
            kv('Level', `${stats.level}`),
            kv('Best streak', `${stats.bestStreak}`)
        ],
        footer: `NODE ${game.gameId.slice(-6).toUpperCase()}`
    });

    await interaction.update({ embeds: [embed], components: createGameButtons(game, true) });
    games.delete(game.gameId);
}

async function advanceToNextRound(game, client) {
    game.round++;
    if (game.round > game.maxRounds) {
        game.gameActive = false;
        games.delete(game.gameId);
        return;
    }

    game.firstNumber = generateNumber();
    game.secondNumber = 0;
    game.lastChoice = undefined;
    game.lastMultiplier = undefined;
    game.lastMultiplierType = undefined;

    const message = await fetchGameMessage(client, game);
    if (!message) return;

    await message.edit({ embeds: [createRoundEmbed(game)], components: createGameButtons(game) });

    const newCollector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: TIMEOUT_MS });
    newCollector.on('collect', i => withLock(game.gameId, i, async () => {
        if (i.user.id !== game.userId) return i.reply({ content: 'This is not your game!' });
        if (i.customId === `hl_stats_${game.gameId}`) {
            return i.reply({ embeds: [createStatsEmbed(game.userId)] });
        }
        if (i.customId === `hl_rules_${game.gameId}`) {
            return i.reply({ embeds: [createRulesEmbed()] });
        }
        if (i.customId === `hl_quit_${game.gameId}`) {
            game.gameActive = false;
            saveStats(game.userId);
            const embed = neonEmbed({
                userId: game.userId,
                title: '📈 HIGH/LOW // LINK SEVERED',
                color: NEON.red,
                lines: [
                    '🚪 You aborted the run. Your bet is forfeited.',
                    '',
                    kv('Refund', '🪙0'),
                    '',
                    `${ANSI.DIM}aborts do not qualify for the timeout refund${ANSI.RESET}`
                ],
                footer: `NODE ${game.gameId.slice(-6).toUpperCase()}`
            });
            await i.update({ embeds: [embed], components: createGameButtons(game, true) });
            games.delete(game.gameId);
            newCollector.stop('quit');
            return;
        }

        let choice = null;
        if (i.customId === `hl_higher_${game.gameId}`) choice = 'higher';
        else if (i.customId === `hl_lower_${game.gameId}`) choice = 'lower';
        else if (i.customId === `hl_same_${game.gameId}`) choice = 'same';
        if (!choice) return;

        const outcome = playRound(game, choice);
        if (!outcome.won) {
            await handleRoundLoss(i, game, client, newCollector);
            return;
        }
        if (game.round >= game.maxRounds) {
            await finishGame(i, game);
            newCollector.stop('complete');
            return;
        }
        await handleWinningRound(i, game, outcome.roundPayout, outcome.multiplierResult, outcome.baseMultiplier, client, newCollector);
    }));

    // Only a naturally expiring collector is a timeout; explicit stops are not.
    newCollector.on('end', async (_collected, reason) => {
        if (reason === 'time') await handleTimeout(game, client);
    });
}

async function handleTimeout(game, client) {
    if (!game.gameActive) return;
    game.gameActive = false;

    // Timeout refund = exactly 67% of the original stake.
    const refund = Math.floor(game.originalBet * 0.67);
    if (refund > 0) {
        try {
            casino.creditWallet(game.userId, 'highlow', refund, 'refund', 'High/Low timeout refund');
        } catch (error) {
            console.error('High/Low refund failed:', error);
        }
    }
    saveStats(game.userId);

    const embed = neonEmbed({
        userId: game.userId,
        title: '⏰ HIGH/LOW // LINK TIMED OUT',
        color: NEON.red,
        lines: [
            `${ANSI.DIM}connection idle — run terminated${ANSI.RESET}`,
            '',
            kv('Original bet', `🪙${game.originalBet.toLocaleString()}`),
            kv('Refund', `🪙${refund.toLocaleString()} (67%)`),
            kv('Forfeited', `🪙${(game.originalBet - refund).toLocaleString()}`)
        ],
        footer: `NODE ${game.gameId.slice(-6).toUpperCase()}`
    });

    const message = await fetchGameMessage(client, game);
    if (message) {
        await message.edit({ embeds: [embed], components: createGameButtons(game, true) }).catch(() => {});
    }
    games.delete(game.gameId);
}

function createCollector(message, game, client) {
    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: TIMEOUT_MS });
    collector.on('collect', i => withLock(game.gameId, i, async () => {
        if (i.user.id !== game.userId) return i.reply({ content: 'This is not your game!' });

        if (i.customId === `hl_cancel_queue_${game.gameId}`) {
            game.gameActive = false;
            pvpQueue.delete(`${game.originalBet}:${game.preset}`);
            await i.update({
                embeds: [neonEmbed({
                    userId: game.userId,
                    title: '🚪 PVP MATCHMAKING CANCELLED',
                    color: NEON.red,
                    lines: [
                        kv('Forfeited', `🪙${game.originalBet.toLocaleString()}`),
                        `${ANSI.DIM}voluntary cancels receive no timeout refund${ANSI.RESET}`
                    ]
                })],
                components: []
            });
            games.delete(game.gameId);
            collector.stop('cancelled');
            return;
        }
        if (i.customId === `hl_stats_${game.gameId}`) {
            return i.reply({ embeds: [createStatsEmbed(game.userId)] });
        }
        if (i.customId === `hl_rules_${game.gameId}`) {
            return i.reply({ embeds: [createRulesEmbed()] });
        }
        if (i.customId === `hl_quit_${game.gameId}`) {
            game.gameActive = false;
            saveStats(game.userId);
            await i.update({
                embeds: [neonEmbed({
                    userId: game.userId,
                    title: '📈 HIGH/LOW // LINK SEVERED',
                    color: NEON.red,
                    lines: [
                        '🚪 You aborted the run. Your bet is forfeited.',
                        '',
                        kv('Refund', '🪙0'),
                        '',
                        `${ANSI.DIM}aborts do not qualify for the timeout refund${ANSI.RESET}`
                    ]
                })],
                components: []
            });
            games.delete(game.gameId);
            collector.stop('quit');
            return;
        }

        let choice = null;
        if (i.customId === `hl_higher_${game.gameId}`) choice = 'higher';
        else if (i.customId === `hl_lower_${game.gameId}`) choice = 'lower';
        else if (i.customId === `hl_same_${game.gameId}`) choice = 'same';
        if (!choice) return;

        const outcome = playRound(game, choice);
        if (!outcome.won) {
            await handleRoundLoss(i, game, client, collector);
            return;
        }
        if (game.round >= game.maxRounds) {
            await finishGame(i, game);
            collector.stop('complete');
            return;
        }
        await handleWinningRound(i, game, outcome.roundPayout, outcome.multiplierResult, outcome.baseMultiplier, client, collector);
    }));

    collector.on('end', async (_collected, reason) => {
        if (reason === 'time') {
            const currentGame = games.get(game.gameId);
            if (currentGame && currentGame.gameActive) await handleTimeout(currentGame, client);
        }
    });
}

function createGame(gameId, userId, interaction, bet, preset, mode, opponentId) {
    return {
        gameId,
        userId,
        channelId: interaction.channelId,
        messageId: '',
        firstNumber: generateNumber(),
        secondNumber: 0,
        bet,
        originalBet: bet,
        round: 1,
        maxRounds: MAX_ROUNDS,
        totalPayout: 0,
        currentRoundWon: false,
        gameActive: true,
        mode,
        preset,
        opponentId
    };
}

async function startPvpQueue(interaction, game, queueKey) {
    const queueEmbed = neonEmbed({
        userId,
        title: '⚔️ HIGH/LOW // PVP QUEUE',
        lines: [
            kv('Stake reserved', `🪙${game.originalBet.toLocaleString()}`),
            kv('Preset', game.preset),
            kv('Rounds', `${MAX_ROUNDS}`),
            '',
            `${ANSI.DIM}scanning for an opponent with the same stake...${ANSI.RESET}`,
            `${ANSI.DIM}timeout refunds 67% of the stake${ANSI.RESET}`
        ]
    });

    const queueMessage = await interaction.editReply({
        embeds: [queueEmbed],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`hl_cancel_queue_${game.gameId}`).setLabel('Cancel Matchmaking').setStyle(ButtonStyle.Danger)
        )]
    });

    game.messageId = queueMessage.id;
    games.set(game.gameId, game);
    pvpQueue.set(queueKey, game.gameId);
    setCooldown(interaction.user.id, 'highlow');

    setTimeout(async () => {
        const currentGame = games.get(game.gameId);
        if (currentGame && currentGame.gameActive && !currentGame.opponentId) {
            pvpQueue.delete(queueKey);
            currentGame.gameActive = false;
            const refund = Math.floor(currentGame.originalBet * 0.67);
            if (refund > 0) {
                try {
                    casino.creditWallet(currentGame.userId, 'highlow', refund, 'refund', 'High/Low PvP timeout refund');
                } catch (error) {
                    console.error('PvP timeout refund failed:', error);
                }
            }
            const message = await fetchGameMessage(interaction.client, currentGame);
            if (message) {
                await message.edit({
                    embeds: [new EmbedBuilder().setColor(0xff5577).setTitle('⏰ PvP Matchmaking Timed Out').setDescription([
                        'No opponent was found in time.',
                        '',
                        `Original stake: **🪙${currentGame.originalBet.toLocaleString()}**`,
                        `Timeout refund: **🪙${refund.toLocaleString()} (67%)**`
                    ].join('\n'))],
                    components: []
                }).catch(() => {});
            }
            games.delete(game.gameId);
        }
    }, TIMEOUT_MS);
}

async function startPvpGame(interaction, game, opponentGame) {
    game.messageId = (await interaction.fetchReply()).id;
    games.set(game.gameId, game);

    const playerStats = getStats(game.userId);
    const opponentStats = getStats(opponentGame.userId);
    playerStats.gamesPlayed++;
    playerStats.pvpGames++;
    opponentStats.gamesPlayed++;
    opponentStats.pvpGames++;
    saveStats(game.userId);
    saveStats(opponentGame.userId);

    const embed = neonEmbed({
        userId: game.userId,
        title: '⚔️ HIGH/LOW // PVP MATCH',
        lines: [
            `Opponent locked: <@${opponentGame.userId}>`,
            '',
            kv('Stake', `🪙${game.originalBet.toLocaleString()} each`),
            kv('Prize pool', `🪙${(game.originalBet * 2).toLocaleString()}`),
            kv('Rounds', `${MAX_ROUNDS}`),
            '',
            `${ANSI.GREEN}no house fee — winner takes pool +10%${ANSI.RESET}`
        ],
        footer: `NODE ${game.gameId.slice(-6).toUpperCase()}`
    });

    const message = await fetchGameMessage(interaction.client, game);
    if (!message) return;

    await message.edit({ embeds: [embed], components: createGameButtons(game) });

    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: TIMEOUT_MS });
    let playerWins = 0;
    let opponentWins = 0;

    collector.on('collect', i => withLock(game.gameId, i, async () => {
        if (i.user.id !== game.userId) return i.reply({ content: 'This is not your game!' });

        if (i.customId === `hl_stats_${game.gameId}`) {
            return i.reply({ embeds: [createStatsEmbed(game.userId)] });
        }
        if (i.customId === `hl_rules_${game.gameId}`) {
            return i.reply({ embeds: [createRulesEmbed()] });
        }
        if (i.customId === `hl_quit_${game.gameId}`) {
            game.gameActive = false;
            opponentGame.gameActive = false;
            await settlePvpWinner(game, opponentGame, opponentGame.userId, 'opponent_quit');
            await i.update({ components: [] });
            collector.stop('quit');
            return;
        }

        let choice = null;
        if (i.customId === `hl_higher_${game.gameId}`) choice = 'higher';
        else if (i.customId === `hl_lower_${game.gameId}`) choice = 'lower';
        else if (i.customId === `hl_same_${game.gameId}`) choice = 'same';
        if (!choice) return;

        const won = determineWin(choice, game.firstNumber, generateNumber());
        recordRound(game.userId, won);
        if (won) playerWins++;
        else opponentWins++;

        if (playerWins >= 3 || opponentWins >= 3 || game.round >= MAX_ROUNDS) {
            game.gameActive = false;
            opponentGame.gameActive = false;
            const winner = playerWins > opponentWins ? game.userId
                : opponentWins > playerWins ? opponentGame.userId
                    : null;

            if (winner) {
                await settlePvpWinner(game, opponentGame, winner, 'completed');
            } else {
                // Tie: return both stakes. There is no house fee.
                try {
                    casino.creditWallet(game.userId, 'highlow', game.originalBet, 'refund', 'High/Low PvP tie refund');
                    casino.creditWallet(opponentGame.userId, 'highlow', opponentGame.originalBet, 'refund', 'High/Low PvP tie refund');
                } catch (error) {
                    console.error('PvP tie refund failed:', error);
                }
            }

            await i.update({
                embeds: [neonEmbed({
                    userId: game.userId,
                    title: '⚔️ HIGH/LOW // PVP RESULT',
                    color: winner === game.userId ? NEON.green : NEON.cyan,
                    lines: [
                        kv('Your score', `${playerWins}`),
                        kv('Opponent', `${opponentWins}`),
                        '',
                        winner ? `${ANSI.GREEN}🏆 WINNER: <@${winner}>${ANSI.RESET}` : `${ANSI.YELLOW}🤝 STALEMATE — stakes refunded${ANSI.RESET}`
                    ]
                })],
                components: []
            });
            games.delete(game.gameId);
            games.delete(opponentGame.gameId);
            collector.stop('complete');
            return;
        }

        game.round++;
        game.firstNumber = generateNumber();
        await i.update({
            embeds: [createRoundEmbed({ ...game, round: game.round })],
            components: createGameButtons(game)
        });
    }));

    collector.on('end', async (_collected, reason) => {
        // Only refund for an actual timeout; manual stops are intentional.
        if (reason !== 'time') return;
        if (!game.gameActive || !opponentGame.gameActive) return;
        game.gameActive = false;
        opponentGame.gameActive = false;

        const playerRefund = Math.floor(game.originalBet * 0.67);
        const opponentRefund = Math.floor(opponentGame.originalBet * 0.67);
        try {
            casino.creditWallet(game.userId, 'highlow', playerRefund, 'refund', 'High/Low PvP timeout refund');
            casino.creditWallet(opponentGame.userId, 'highlow', opponentRefund, 'refund', 'High/Low PvP timeout refund');
        } catch (error) {
            console.error('PvP timeout refund failed:', error);
        }
        games.delete(game.gameId);
        games.delete(opponentGame.gameId);
    });
}

async function settlePvpWinner(playerGame, opponentGame, winnerId, reason) {
    const totalPool = playerGame.originalBet + opponentGame.originalBet;
    const winnerBonus = Math.floor(totalPool * 0.10);
    const winnerPayout = totalPool + winnerBonus;

    try {
        casino.creditWallet(winnerId, 'highlow', winnerPayout, 'payout', 'High/Low PvP winner payout');
    } catch (error) {
        console.error('PvP winner payout failed:', error);
    }

    const winnerStats = getStats(winnerId);
    winnerStats.pvpWins++;
    winnerStats.gamesWon++;
    trackWinnings(winnerId, winnerPayout);
    addXP(winnerId, 100);
    if (reason === 'opponent_quit') addXP(winnerId, 25);
    updateAchievements(winnerId);
    saveStats(winnerId);

    games.delete(playerGame.gameId);
    games.delete(opponentGame.gameId);
}

async function startGame(interaction, bet, preset, mode) {
    const userId = interaction.user.id;
    const remaining = getRemainingTime(userId, 'highlow');
    if (remaining > 0) {
        return interaction.editReply({ content: `You can play again ${formatRemainingTime(remaining)}.` });
    }

    // Reserve the player's stake immediately.
    try {
        casino.debitWallet(userId, 'highlow', bet, 'High/Low bet');
    } catch (error) {
        return interaction.editReply({ content: error.message });
    }

    const gameId = `${userId}-${Date.now()}`;

    if (mode === 'pvp') {
        const queueKey = `${bet}:${preset}`;
        const opponentGameId = pvpQueue.get(queueKey);
        const opponentGame = opponentGameId ? games.get(opponentGameId) : null;

        if (opponentGame && opponentGame.gameActive && !opponentGame.opponentId && opponentGame.userId !== userId) {
            pvpQueue.delete(queueKey);

            const game = createGame(gameId, userId, interaction, bet, preset, 'pvp', opponentGame.userId);
            game.opponentGameId = opponentGame.gameId;
            opponentGame.opponentId = userId;
            game.messageId = (await interaction.fetchReply()).id;

            await startPvpGame(interaction, game, opponentGame);
            setCooldown(userId, 'highlow');
            return;
        }

        const game = createGame(gameId, userId, interaction, bet, preset, 'pvp');
        await startPvpQueue(interaction, game, queueKey);
        return;
    }

    const game = createGame(gameId, userId, interaction, bet, preset, 'solo');
    const embed = createRoundEmbed(game);
    const message = await interaction.editReply({ embeds: [embed], components: createGameButtons(game) });
    game.messageId = message.id;
    games.set(game.gameId, game);

    const stats = getStats(userId);
    stats.gamesPlayed++;
    saveStats(userId);
    setCooldown(userId, 'highlow');
    createCollector(message, game, interaction.client);
}

module.exports = {
    generateNumber,
    determineWin,
    getSameMultiplier,
    rollMultiplier,
    rollMysteryMultiplier,
    xpRequiredForLevel,
    data: new SlashCommandBuilder()
        .setName('highlow')
        .setDescription('Play the multi-round High/Low guessing game')
        .addIntegerOption(option => option.setName('bet').setDescription('Amount to wager (10-1000)')
            .setRequired(true).setMinValue(10).setMaxValue(1000))
        .addStringOption(option => option.setName('mode').setDescription('Solo or PvP')
            .addChoices({ name: 'Solo', value: 'solo' }, { name: 'PvP', value: 'pvp' }))
        .addStringOption(option => option.setName('preset').setDescription('Game preset')
            .addChoices({ name: 'Safe', value: 'safe' }, { name: 'Classic', value: 'classic' }, { name: 'Aggressive', value: 'aggressive' })),
    async execute(interaction) {
        try {
            await interaction.deferReply();
            const bet = interaction.options.getInteger('bet', true);
            const userId = interaction.user.id;
            getUser(userId);
            const mode = interaction.options.getString('mode') ?? 'solo';
            const preset = interaction.options.getString('preset') ?? 'classic';
            await startGame(interaction, bet, preset, mode);
        } catch (error) {
            console.error('Error in highlow command:', error);
            await interaction.editReply({ content: 'An error occurred while starting the game.' }).catch(() => {});
        }
    }
};
