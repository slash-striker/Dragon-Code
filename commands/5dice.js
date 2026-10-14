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
const { renderDiceRow, UNICODE_FACES } = require('../systems/games/diceRenderer');
const { NEON, panel, kv, neonEmbed, progressBar, ANSI } = require('../systems/games/neonUI');
const {
    getRemainingTime,
    formatRemainingTime,
    setCooldown
} = require('../systems/economy/cooldownManager');

const DICE_COUNT = 5;
const SIDES = 6;
const TOTAL_ROLLS = 3;
const COLLECTOR_TIME = 5 * 60 * 1000;
const LUCKY_ROLL_CHANCE = 0.05;
const LUCKY_MULTIPLIER = 1.5;
const DAILY_MULTIPLIER = 2;
const DAILY_BONUS = 500;
const STREAK_MULTIPLIERS = [1, 1.05, 1.1, 1.15, 1.25];
const BASE_REWARDS = {
    'Five of a Kind': 1500,
    'Four of a Kind': 800,
    'Full House': 500,
    'Three of a Kind': 300,
    'Two Pairs': 200,
    'One Pair': 100,
    'No Match': 0
};
const SCORE_MULTIPLIERS = {
    'Five of a Kind': 2,
    'Four of a Kind': 1.25,
    'Full House': 1.15,
    'Three of a Kind': 1.05,
    'Two Pairs': 1,
    'One Pair': 1,
    'No Match': 1
};
const ACHIEVEMENTS = {
    first: '🏁 First Roll',
    lucky: '🍀 Lucky Roller',
    triple: '🎯 Triple Threat',
    full: '🏠 Full House',
    quad: '💎 Quad Master',
    yahtzee: '🎲 Yahtzee!',
    streak: '🔥 Hot Streak',
    high: '💰 High Roller'
};
const DICE_FACES = ['\u2680', '\u2681', '\u2682', '\u2683', '\u2684', '\u2685'];
const games = new Map();

function today() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
}

function rollDice() {
    return Array.from({ length: DICE_COUNT }, () => Math.floor(Math.random() * SIDES) + 1);
}

function calculateScore(dice) {
    if (!Array.isArray(dice) || dice.length !== DICE_COUNT ||
        dice.some(die => !Number.isInteger(die) || die < 1 || die > SIDES)) {
        throw new Error('Invalid dice state');
    }
    const counts = new Map();
    dice.forEach(die => counts.set(die, (counts.get(die) || 0) + 1));
    const values = [...counts.values()].sort((a, b) => b - a);
    let type = 'No Match';
    if (values[0] === 5) type = 'Five of a Kind';
    else if (values[0] === 4) type = 'Four of a Kind';
    else if (values[0] === 3 && values[1] === 2) type = 'Full House';
    else if (values[0] === 3) type = 'Three of a Kind';
    else if (values.filter(value => value === 2).length === 2) type = 'Two Pairs';
    else if (values[0] === 2) type = 'One Pair';
    return { type, baseReward: BASE_REWARDS[type], scoreMultiplier: SCORE_MULTIPLIERS[type] };
}

function streakMultiplier(streak) {
    return STREAK_MULTIPLIERS[Math.min(Math.max(streak, 1), STREAK_MULTIPLIERS.length) - 1];
}

function calculateReward(result, multipliers) {
    if (result.baseReward === 0) return 0;
    return Math.floor(result.baseReward * multipliers.score * multipliers.lucky *
        multipliers.streak * multipliers.daily);
}

function getStats(userId) {
    return db.prepare('SELECT * FROM five_dice_stats WHERE userId = ?').get(userId) || {
        userId, gamesPlayed: 0, gamesWon: 0, totalCredits: 0, highestPayout: 0,
        currentStreak: 0, bestStreak: 0, fiveOfAKind: 0, fourOfAKind: 0,
        fullHouses: 0, achievements: '[]', dailyDateKey: null, dailyCompleted: 0
    };
}

function parseAchievements(stats) {
    try {
        const achievements = JSON.parse(stats.achievements || '[]');
        return Array.isArray(achievements) ? achievements : [];
    } catch {
        return [];
    }
}

// Compact unicode line for the description (scrollback + canvas fallback).
function formatDice(dice, kept) {
    return dice.map((die, index) => `**${index + 1}:** ${UNICODE_FACES[die - 1]}${kept[index] ? ' ✅' : ''}`).join('  ');
}

const DICE_IMAGE_NAME = 'five-dice.png';

async function diceArt(dice, kept) {
    const rendered = await renderDiceRow(dice, kept, { filename: DICE_IMAGE_NAME });
    if (!rendered.attachment) return { files: [] };
    return { files: [rendered.attachment] };
}

/*
 * Discord renders loose attachments ABOVE the embed inside a single message,
 * so there is no way to place an image between an embed and its buttons.
 * Instead the dice strip travels as its own message right below the game
 * message — the strip then sits directly above the keep-button row, one die
 * per button (same 40px pitch).
 */
async function syncDiceMessage(diceMessage, dice, kept) {
    if (!diceMessage) return;
    const art = await diceArt(dice, kept);
    try {
        if (art.files.length) {
            // attachments: [] clears the previous strip so images don't stack.
            await diceMessage.edit({ attachments: [], files: art.files });
        } else {
            // Canvas unavailable: fall back to a unicode-dice text line.
            await diceMessage.edit({
                content: dice.map((die, index) => `${UNICODE_FACES[die - 1]}${kept[index] ? ' ✅' : ''}`).join('  '),
                attachments: [],
                files: []
            });
        }
    } catch (error) {
        console.error('Unable to update Five Dice strip:', error);
    }
}

// Futuristic game console panel.
function gameEmbed(game, text, color = NEON.cyan) {
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(`◢ ═══ 🎲 FIVE DICE ${game.daily ? '// DAILY' : ''} ═══ ◣`)
        .setDescription(text)
        .setFooter({ text: `NODE ${game.id.slice(-6).toUpperCase()} • LUCKY CHIP ${LUCKY_ROLL_CHANCE * 100}%` })
        .setTimestamp();
}

function gamePanel(game, stats) {
    const result = calculateScore(game.dice);
    const projectedStreak = stats.currentStreak + (result.baseReward > 0 ? 1 : 0);
    const lucky = game.luckyRoll ? LUCKY_MULTIPLIER : 1;
    const daily = game.daily ? DAILY_MULTIPLIER : 1;
    const potential = calculateReward(result, {
        score: result.scoreMultiplier, lucky,
        streak: streakMultiplier(projectedStreak), daily
    }) + (game.daily && result.baseReward > 0 ? DAILY_BONUS : 0);

    const lines = [
        `${ANSI.MAGENTA}◈ HAND SCAN${ANSI.RESET}`,
        kv('Hand', result.type, result.baseReward > 0 ? ANSI.GREEN : ANSI.DIM),
        kv('Potential', `🪙${potential.toLocaleString()}`),
        kv('Rolls left', `${game.rollsLeft}/${TOTAL_ROLLS}`),
        '',
        `${ANSI.MAGENTA}◈ MULTIPLIERS${ANSI.RESET}`,
        kv('Score', `${result.scoreMultiplier}x`),
        kv('Lucky', game.luckyRoll ? `${LUCKY_MULTIPLIER}x ACTIVE` : '—'),
        kv('Streak', `${streakMultiplier(projectedStreak)}x`),
        kv('Daily', game.daily ? `${DAILY_MULTIPLIER}x ACTIVE` : '—'),
        '',
        `${ANSI.MAGENTA}◈ STREAK${ANSI.RESET}`,
        progressBar(stats.currentStreak, 5),
        `${ANSI.DIM}win streak ${stats.currentStreak}${ANSI.RESET}`
    ];

    if (game.luckyRoll) {
        lines.unshift(`🍀 ${ANSI.GREEN}LUCKY ROLL ENGAGED — payouts boosted!${ANSI.RESET}`, '');
    }

    return panel(...lines);
}

function description(game, stats) {
    return `${formatDice(game.dice, game.kept)}\n${gamePanel(game, stats)}`;
}

function buttons(game) {
    const dice = new ActionRowBuilder().addComponents(
        ...game.dice.map((_, index) => new ButtonBuilder()
            .setCustomId(`5dice:keep:${game.id}:${index}`)
            // Uniform single-digit labels keep all five buttons the same
            // width so each one sits under its die in the strip image.
            .setLabel(`${index + 1}`)
            .setStyle(game.kept[index] ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(!game.active))
    );
    const actions = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`5dice:roll:${game.id}`).setLabel('⚡ ROLL').setStyle(ButtonStyle.Primary).setDisabled(!game.active || game.rollsLeft < 1),
        new ButtonBuilder().setCustomId(`5dice:finish:${game.id}`).setLabel('💾 LOCK IN').setStyle(ButtonStyle.Success).setDisabled(!game.active),
        new ButtonBuilder().setCustomId(`5dice:quit:${game.id}`).setLabel('✖ ABORT').setStyle(ButtonStyle.Danger).setDisabled(!game.active)
    );
    return [dice, actions];
}

function playAgainButton(gameId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`5dice:again:${gameId}`).setLabel('⟳ PLAY AGAIN').setStyle(ButtonStyle.Primary)
    );
}

function updateStats(userId, game, result, reward, won, daily) {
    const previous = getStats(userId);
    const achievements = parseAchievements(previous);
    const unlock = (key, condition) => {
        if (condition && !achievements.includes(key)) achievements.push(key);
    };
    const nextStreak = won ? previous.currentStreak + 1 : 0;
    unlock('first', previous.gamesPlayed === 0);
    unlock('lucky', game.luckyRoll);
    unlock('triple', result.type === 'Three of a Kind');
    unlock('full', result.type === 'Full House');
    unlock('quad', result.type === 'Four of a Kind');
    unlock('yahtzee', result.type === 'Five of a Kind');
    unlock('streak', nextStreak >= 5);
    unlock('high', previous.totalCredits + reward >= 5000);
    db.prepare(`
        INSERT INTO five_dice_stats
            (userId, gamesPlayed, gamesWon, totalCredits, highestPayout, currentStreak, bestStreak,
             fiveOfAKind, fourOfAKind, fullHouses, achievements, dailyDateKey, dailyCompleted)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(userId) DO UPDATE SET
            gamesPlayed = gamesPlayed + 1,
            gamesWon = gamesWon + excluded.gamesWon,
            totalCredits = totalCredits + excluded.totalCredits,
            highestPayout = MAX(highestPayout, excluded.highestPayout),
            currentStreak = excluded.currentStreak,
            bestStreak = MAX(bestStreak, excluded.bestStreak),
            fiveOfAKind = fiveOfAKind + excluded.fiveOfAKind,
            fourOfAKind = fourOfAKind + excluded.fourOfAKind,
            fullHouses = fullHouses + excluded.fullHouses,
            achievements = excluded.achievements,
            dailyDateKey = excluded.dailyDateKey,
            dailyCompleted = excluded.dailyCompleted
    `).run(
        userId, won ? 1 : 0, reward, reward, nextStreak, nextStreak,
        result.type === 'Five of a Kind' ? 1 : 0,
        result.type === 'Four of a Kind' ? 1 : 0,
        result.type === 'Full House' ? 1 : 0,
        JSON.stringify(achievements), daily ? today() : previous.dailyDateKey,
        daily ? 1 : previous.dailyCompleted
    );
    return { achievements, nextStreak };
}

async function finishGame(game, message, collector, quit = false) {
    if (!game.active) return;
    game.active = false;
    collector.stop('finished');
    const result = calculateScore(game.dice);
    const stats = getStats(game.userId);
    const won = !quit && result.baseReward > 0;
    const nextStreak = won ? stats.currentStreak + 1 : 0;
    const reward = won
        ? calculateReward(result, {
            score: result.scoreMultiplier,
            lucky: game.luckyRoll ? LUCKY_MULTIPLIER : 1,
            streak: streakMultiplier(nextStreak),
            daily: game.daily ? DAILY_MULTIPLIER : 1
        }) + (game.daily ? DAILY_BONUS : 0)
        : 0;
    if (reward > 0) {
        casino.creditWallet(game.userId, '5dice', reward, 'payout', 'Five Dice win');
    }
    const updated = updateStats(game.userId, game, result, reward, won, game.daily);
    setCooldown(game.userId, game.daily ? 'fivedice-daily' : 'fivedice');
    games.delete(game.id);
    const unlocked = updated.achievements
        .filter(key => !parseAchievements(stats).includes(key))
        .map(key => ACHIEVEMENTS[key])
        .filter(Boolean);
    await syncDiceMessage(game.diceMessage, game.dice, game.kept);
    await message.edit({
        embeds: [gameEmbed(game,
            `Final dice:\n${formatDice(game.dice, game.kept)}\n` +
            panel(
                `${ANSI.MAGENTA}◈ RESULT${ANSI.RESET}`,
                kv('Hand', result.type),
                kv('Base', `🪙${result.baseReward.toLocaleString()}`),
                kv('Lucky', game.luckyRoll ? `${LUCKY_MULTIPLIER}x` : '—'),
                kv('Score', `${result.scoreMultiplier}x`),
                kv('Streak', won ? `${streakMultiplier(updated.nextStreak)}x` : '—'),
                kv('Daily', game.daily && won ? `${DAILY_MULTIPLIER}x + 🪙${DAILY_BONUS.toLocaleString()}` : '—'),
                '',
                won
                    ? `${ANSI.GREEN}${ANSI.BOLD}≫ PAYOUT: 🪙${reward.toLocaleString()} <<${ANSI.RESET}`
                    : `${ANSI.RED}≫ NO PAYOUT THIS RUN${ANSI.RESET}`,
                `${ANSI.DIM}win streak ${updated.nextStreak}${ANSI.RESET}`,
                ...(unlocked.length ? ['', `${ANSI.YELLOW}🏆 ${unlocked.join(' · ')}${ANSI.RESET}`] : [])
            ),
            won ? NEON.green : NEON.red)],
        components: [playAgainButton(game.id)]
    });
    setupReplayCollector(message, game);
}

function setupReplayCollector(message, game) {
    const replayCollector = message.createMessageComponentCollector({
        componentType: ComponentType.Button, time: COLLECTOR_TIME
    });
    replayCollector.on('collect', async button => {
        if (button.customId !== `5dice:again:${game.id}`) return;
        if (button.user.id !== game.userId) {
            return button.reply({ content: 'This is not your game.' });
        }
        replayCollector.stop('replay');
        await startGame(button, game.daily);
    });
    replayCollector.on('end', async () => {
        try {
            await message.edit({ components: [] });
        } catch (error) {
            console.error('Unable to disable Five Dice replay button:', error);
        }
        if (game.diceMessage) {
            game.diceMessage.delete().catch(() => {});
        }
    });
}

async function startGame(interaction, daily) {
    const userId = interaction.user.id;
    if ([...games.values()].some(game => game.userId === userId && game.active)) {
        return interaction.reply({ content: 'You already have an active Five Dice game. Finish it before starting another.' });
    }
    const cooldownKey = daily ? 'fivedice-daily' : 'fivedice';
    const remaining = getRemainingTime(userId, cooldownKey);
    if (remaining > 0) return interaction.reply({ content: `You can play Five Dice again ${formatRemainingTime(remaining)}.` });
    const stats = getStats(userId);
    if (daily && stats.dailyDateKey === today() && stats.dailyCompleted) {
        return interaction.reply({ content: 'You have already completed today’s Five Dice challenge.' });
    }
    const game = {
        id: `${userId}-${Date.now()}`,
        userId,
        dice: rollDice(),
        kept: Array(DICE_COUNT).fill(false),
        rollsLeft: TOTAL_ROLLS - 1,
        active: true,
        luckyRoll: false,
        daily
    };
    const message = await interaction.reply({
        embeds: [gameEmbed(game, description(game, stats))],
        components: buttons(game),
        fetchReply: true
    });
    game.message = message;
    game.diceMessage = null;
    if (message.channel) {
        try {
            game.diceMessage = await message.channel.send({ files: (await diceArt(game.dice, game.kept)).files });
        } catch (error) {
            console.error('Unable to send Five Dice strip:', error);
        }
    }
    games.set(game.id, game);
    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: COLLECTOR_TIME });
    collector.on('collect', async button => {
        if (button.user.id !== userId) return button.reply({ content: 'This is not your game.' });
        if (!game.active) return button.reply({ content: 'This game has ended.' });
        if (button.customId.startsWith('5dice:keep:')) {
            const index = Number(button.customId.split(':').pop());
            game.kept[index] = !game.kept[index];
            await button.update({
                embeds: [gameEmbed(game, description(game, getStats(userId)))],
                components: buttons(game)
            });
            await syncDiceMessage(game.diceMessage, game.dice, game.kept);
        } else if (button.customId === `5dice:roll:${game.id}`) {
            game.dice = game.dice.map((die, index) => game.kept[index] ? die : Math.floor(Math.random() * SIDES) + 1);
            game.kept.fill(false);
            game.rollsLeft -= 1;
            if (!game.luckyRoll) game.luckyRoll = Math.random() < LUCKY_ROLL_CHANCE;
            await button.update({
                embeds: [gameEmbed(game, description(game, getStats(userId)))],
                components: buttons(game)
            });
            await syncDiceMessage(game.diceMessage, game.dice, game.kept);
        } else if (button.customId === `5dice:finish:${game.id}` || button.customId === `5dice:quit:${game.id}`) {
            await button.deferUpdate();
            await finishGame(game, message, collector, button.customId.endsWith(`:quit:${game.id}`));
        }
    });
    collector.on('end', () => {
        if (game.active) finishGame(game, message, collector).catch(error => console.error('Unable to finish Five Dice:', error));
    });
}

function buildStatsEmbed(userId) {
    const stats = getStats(userId);
    const achievements = parseAchievements(stats).map(key => ACHIEVEMENTS[key]).filter(Boolean);
    return neonEmbed({
        userId,
        title: '🎲 FIVE DICE // PLAYER DOSSIER',
        lines: [
            kv('Games', `${stats.gamesPlayed}`),
            kv('Wins', `${stats.gamesWon}`),
            kv('Earned', `🪙${Number(stats.totalCredits).toLocaleString()}`),
            kv('Best payout', `🪙${Number(stats.highestPayout).toLocaleString()}`),
            kv('Streak', `${stats.currentStreak} (best ${stats.bestStreak})`),
            '',
            `${ANSI.MAGENTA}◈ HAND FREQUENCY${ANSI.RESET}`,
            kv('Five of a Kind', `${stats.fiveOfAKind}`),
            kv('Four of a Kind', `${stats.fourOfAKind}`),
            kv('Full Houses', `${stats.fullHouses}`),
            '',
            `${ANSI.MAGENTA}◈ ACHIEVEMENTS${ANSI.RESET}`,
            achievements.length ? achievements.map(a => `${ANSI.YELLOW}🏆 ${a}${ANSI.RESET}`).join('\n') : `${ANSI.DIM}none decrypted yet${ANSI.RESET}`
        ]
    });
}

module.exports = {
    calculateScore,
    streakMultiplier,
    calculateReward,
    data: new SlashCommandBuilder()
        .setName('5dice')
        .setDescription('Play a Yahtzee-style five-dice game')
        .addStringOption(option => option.setName('mode').setDescription('What to do').addChoices(
            { name: 'Play', value: 'play' },
            { name: 'Daily', value: 'daily' },
            { name: 'Stats', value: 'stats' }
        )),
    async execute(interaction) {
        const mode = interaction.options.getString('mode') ?? 'play';
        if (mode === 'stats') return showStats(interaction);
        return startGame(interaction, mode === 'daily');
    }
};

async function showStats(interaction) {
    return interaction.reply({ embeds: [buildStatsEmbed(interaction.user.id)] });
}
