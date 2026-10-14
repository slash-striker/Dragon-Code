const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ComponentType
} = require('discord.js');
const casino = require('../systems/casino/casinoManager');
const {
    getRemainingTime,
    formatRemainingTime,
    setCooldown
} = require('../systems/economy/cooldownManager');

const MAX_HINTS = 2;
const GAME_TIMEOUT = 10 * 60 * 1000;
const HANGMAN_CHANNEL = '1504562791967756448'; // games channel

const CATEGORIES = {
    general: {
        name: 'General',
        words: [
            'APPLE', 'BANANA', 'CHERRY', 'DRAGON', 'ELEPHANT', 'FLOWER', 'GUITAR', 'HOUSE',
            'ISLAND', 'JUNGLE', 'LEMON', 'LUNAR', 'MOUNTAIN', 'NEBULA', 'OCEAN', 'PIZZA',
            'QUANTUM', 'RAINBOW', 'SUNSET', 'UMBRELLA', 'VOLCANO', 'WATER', 'XYLOPHONE',
            'YACHT', 'ZEBRA', 'MARKET', 'MIRROR', 'MORNING', 'PENCIL', 'PILLOW', 'ROCKET',
            'SILVER', 'THUNDER', 'VILLAGE', 'WEEKEND', 'WHISPER'
        ]
    },
    animals: {
        name: 'Animals',
        words: [
            'ALLIGATOR', 'BEAR', 'CHEETAH', 'DOLPHIN', 'ELEPHANT', 'FALCON', 'GIRAFFE',
            'HAMSTER', 'JAGUAR', 'KANGAROO', 'LION', 'MONKEY', 'OCTOPUS', 'PENGUIN',
            'RABBIT', 'SHARK', 'TIGER', 'TURTLE', 'WHALE', 'ZEBRA'
        ]
    },
    food: {
        name: 'Food',
        words: [
            'APPLE', 'BACON', 'BREAD', 'CAKE', 'CANDY', 'CHEESE', 'COOKIE', 'CORN', 'CREAM',
            'DONUT', 'EGG', 'FRIES', 'GRAPE', 'HONEY', 'LEMON', 'MANGO', 'MILK', 'ONION',
            'PEACH', 'PEAR', 'PIZZA', 'RICE', 'SOUP', 'TOAST', 'TOMATO', 'AVOCADO', 'BANANA',
            'BURGER', 'BURRITO', 'CARROT', 'CHICKEN', 'COCONUT', 'GARLIC', 'LASAGNA',
            'LETTUCE', 'MEATBALL', 'MUSHROOM', 'NOODLES', 'ORANGE',
            'PANCAKE', 'PASTA', 'POPCORN', 'PRETZEL', 'SANDWICH', 'SAUSAGE', 'SPINACH',
            'STRAWBERRY', 'TACO', 'WAFFLE', 'WATERMELON', 'ARTICHOKE', 'ASPARAGUS',
            'BLUEBERRY', 'BROCCOLI', 'CASSEROLE', 'CHOCOLATE', 'CINNAMON', 'CRANBERRY',
            'GUACAMOLE', 'JALAPENO', 'MOZZARELLA', 'PINEAPPLE', 'PISTACHIO', 'POMEGRANATE',
            'RASPBERRY', 'SPAGHETTI', 'TORTELLINI', 'ZUCCHINI', 'QUESADILLA', 'MACARONI',
            'CHEESEBURGER'
        ]
    },
    nature: {
        name: 'Nature',
        words: [
            'BEACH', 'BUSH', 'CLOUD', 'DUST', 'FIRE', 'GRASS', 'HILL', 'LAKE', 'LEAF', 'MOON',
            'OCEAN', 'PLANT', 'RAIN', 'ROCK', 'SAND', 'SKY', 'SNOW', 'STAR', 'SUN', 'TREE',
            'WAVE', 'WIND', 'WOOD', 'CANYON', 'DESERT', 'FOREST', 'GLACIER', 'ISLAND',
            'JUNGLE', 'MEADOW', 'MOUNTAIN', 'RAINBOW', 'RIVER', 'SUNSET', 'THUNDER', 'VALLEY',
            'VOLCANO', 'WATERFALL', 'WILDFLOWER', 'EARTHQUAKE', 'HURRICANE', 'LIGHTNING',
            'TORNADO', 'AVALANCHE', 'ATMOSPHERE', 'CONSTELLATION', 'ECOSYSTEM', 'HABITAT',
            'PHOTOSYNTHESIS', 'POLLINATION', 'STALACTITE', 'SUBTERRANEAN', 'WILDERNESS',
            'BIOLUMINESCENCE'
        ]
    },
    technology: {
        name: 'Technology',
        words: [
            'APP', 'BYTE', 'CHIP', 'CODE', 'DATA', 'DISK', 'EMAIL', 'FILE', 'GAMES', 'LINK',
            'LOGIN', 'MOUSE', 'PHONE', 'SCREEN', 'SERVER', 'SOFTWARE', 'TABLET', 'WEB',
            'WIFI', 'WINDOW', 'COMPUTER', 'DATABASE', 'KEYBOARD', 'MONITOR', 'NETWORK',
            'PROCESSOR', 'PROGRAM', 'ROUTER', 'SMARTPHONE', 'STORAGE', 'TERMINAL', 'WEBSITE',
            'WIRELESS', 'BLUETOOTH', 'INTERNET', 'JAVASCRIPT', 'TYPESCRIPT', 'ALGORITHM',
            'FIREWALL', 'HARDWARE', 'BLOCKCHAIN', 'CYBERSECURITY', 'CRYPTOGRAPHY',
            'ENCRYPTION', 'INFRASTRUCTURE', 'MICROPROCESSOR', 'PROGRAMMING', 'QUANTUM',
            'RECURSION', 'SUPERCOMPUTER', 'OPTIMIZATION', 'POLYMORPHISM', 'ASYNCHRONOUS'
        ]
    },
    complex: {
        name: 'Complex',
        words: [
            'QUANTUM', 'ABERRATION', 'ACCELERATION', 'ALGORITHM', 'AMBIGUOUS', 'ANOMALOUS',
            'ARCHAEOLOGY', 'ASTRONOMICAL', 'ASYMMETRICAL', 'BUREAUCRACY', 'CATASTROPHE',
            'CHRONOLOGICAL', 'CONFLAGRATION', 'CONSCIOUSNESS', 'CRYPTOGRAPHY',
            'DECONSTRUCTION', 'DELIBERATION', 'DIMENSIONAL', 'DYSFUNCTIONAL', 'ECCENTRICITY',
            'ELECTROMAGNETIC', 'ENCRYPTION', 'ENTANGLEMENT', 'EQUILIBRIUM',
            'EXTRATERRESTRIAL', 'FLUCTUATION', 'GEOMETRICAL', 'HYPOTHESIS', 'ILLUMINATION',
            'IMPOSSIBILITY', 'INCONSISTENCY', 'JUXTAPOSITION', 'LABYRINTHINE',
            'METAMORPHOSIS', 'NEUROLOGICAL', 'OMNIPOTENT', 'PARADOXICAL', 'PHENOMENON',
            'POLYMORPHISM', 'PROCRASTINATION', 'PSYCHOLOGICAL', 'QUINTESSENTIAL',
            'RECONNAISSANCE', 'RELATIVITY', 'SPECTROSCOPY', 'SUBCONSCIOUS', 'SUPERPOSITION',
            'SYNCHRONIZATION', 'TELEPORTATION', 'THEORETICAL', 'TRANSFORMATION',
            'TRANSCENDENCE', 'VULNERABILITY', 'ZEPHYR'
        ]
    }
};

const DIFFICULTIES = {
    easy: { name: 'Easy', maxWrongGuesses: 10, reward: 200, hintPenalty: 25 },
    medium: { name: 'Medium', maxWrongGuesses: 7, reward: 300, hintPenalty: 50 },
    hard: { name: 'Hard', maxWrongGuesses: 6, reward: 500, hintPenalty: 100 },
    extreme: { name: 'Extreme', maxWrongGuesses: 4, reward: 2000, hintPenalty: 150 }
};

const hangmanGames = new Map();
const activeUserGames = new Map();

// In-memory leaderboard (session scope).
const hangmanLeaderboard = new Map();

function getRandomWord(category) {
    const categoryData = CATEGORIES[category] ?? CATEGORIES.general;
    const words = categoryData.words;
    return words[Math.floor(Math.random() * words.length)];
}

function getDisplayWord(word, guessed) {
    return word.split('').map(letter => guessed.has(letter) ? letter : '＿').join(' ');
}

function isWordGuessed(word, guessed) {
    return word.split('').every(letter => guessed.has(letter));
}

function getRemainingLetters(word, guessed) {
    return [...new Set(word.split('').filter(letter => !guessed.has(letter)))];
}

function getFinalReward(game) {
    return Math.max(25, game.reward - game.hintsUsed * game.hintPenalty);
}

function getLeaderboardEntry(userId) {
    let entry = hangmanLeaderboard.get(userId);
    if (!entry) {
        entry = { userId, wins: 0, losses: 0, quits: 0, timeouts: 0, hintsUsed: 0, creditsEarned: 0 };
        hangmanLeaderboard.set(userId, entry);
    }
    return entry;
}

function recordResult(game, result) {
    const entry = getLeaderboardEntry(game.userId);
    entry.hintsUsed += game.hintsUsed;
    if (result === 'win') {
        entry.wins++;
        entry.creditsEarned += getFinalReward(game);
    } else if (result === 'lose') {
        entry.losses++;
    } else if (result === 'quit') {
        entry.quits++;
    } else if (result === 'timeout') {
        entry.timeouts++;
    }
}

function getHangmanVisual(wrongGuesses) {
    const stages = [
        `
  +---+
      |
      |
      |
      |
      |
=========
`,
        `
  +---+
  |   |
      |
      |
      |
      |
=========
`,
        `
  +---+
  |   |
  O   |
      |
      |
      |
=========
`,
        `
  +---+
  |   |
  O   |
  |   |
      |
      |
=========
`,
        `
  +---+
  |   |
  O   |
 /|   |
      |
      |
=========
`,
        `
  +---+
  |   |
  O   |
 /|\\  |
      |
      |
=========
`,
        `
  +---+
  |   |
  O   |
 /|\\  |
 /    |
      |
=========
`,
        `
  +---+
  |   |
  O   |
 /|\\  |
 / \\  |
      |
=========
`
    ];
    return `\`\`\`${stages[Math.min(wrongGuesses, stages.length - 1)]}\`\`\``;
}

function createComponents(gameId, game, disabled = false) {
    const firstHalf = 'ABCDEFGHIJKLM'.split('');
    const secondHalf = 'NOPQRSTUVWXYZ'.split('');

    const createLetterMenu = (letters, id) => new StringSelectMenuBuilder()
        .setCustomId(`hm:${gameId}:letter:${id}`)
        .setPlaceholder('Choose a letter')
        .setDisabled(disabled)
        .addOptions(letters.map(letter => new StringSelectMenuOptionBuilder()
            .setLabel(letter)
            .setValue(letter)
            .setDescription(game.guessed.has(letter) ? 'Already guessed' : `Guess the letter ${letter}`)));

    const letterRow1 = new ActionRowBuilder().addComponents(createLetterMenu(firstHalf, '1'));
    const letterRow2 = new ActionRowBuilder().addComponents(createLetterMenu(secondHalf, '2'));

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`hm:${gameId}:HINT`)
            .setLabel(`💡 Hint (${Math.max(0, game.maxHints - game.hintsUsed)})`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || game.hintsUsed >= game.maxHints),
        new ButtonBuilder().setCustomId(`hm:${gameId}:GUESS`).setLabel('📝 Guess Word').setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`hm:${gameId}:LEADERBOARD`).setLabel('🏆 Leaderboard').setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`hm:${gameId}:QUIT`).setLabel('🚪 Quit').setStyle(ButtonStyle.Danger).setDisabled(disabled)
    );

    return [letterRow1, letterRow2, buttonRow];
}

function createGameEmbed(gameId, game, gameOver = false, result) {
    let title = '🎯 Hangman';
    let description = '';

    if (!gameOver) {
        const remaining = game.maxWrongGuesses - game.wrongGuesses;
        description =
            `Guess the word!\n\n` +
            `${getHangmanVisual(game.wrongGuesses)}\n` +
            `**Word:** ${getDisplayWord(game.word, game.guessed)}\n\n` +
            `📚 **Category:** ${game.category}\n` +
            `⚔️ **Difficulty:** ${game.difficulty}\n` +
            `❤️ **Wrong guesses:** ${game.wrongGuesses}/${game.maxWrongGuesses}\n` +
            `🎯 **Remaining:** ${remaining}\n` +
            `💡 **Hints:** ${game.hintsUsed}/${game.maxHints}\n` +
            `💰 **Reward:** ${getFinalReward(game)} credits`;
    } else {
        title = '🎯 Hangman — Game Over';
        if (result === 'win') {
            description =
                `🎉 **You won!**\n\n` +
                `The word was **${game.word}**.\n\n` +
                `📚 **Category:** ${game.category}\n` +
                `⚔️ **Difficulty:** ${game.difficulty}\n` +
                `💡 **Hints used:** ${game.hintsUsed}\n` +
                `💰 You earned **${getFinalReward(game)} credits**!\n\n` +
                getHangmanVisual(game.wrongGuesses);
        } else if (result === 'lose') {
            description =
                `😢 **You lost!**\n\n` +
                `The word was **${game.word}**.\n\n` +
                `📚 **Category:** ${game.category}\n` +
                `⚔️ **Difficulty:** ${game.difficulty}\n\n` +
                getHangmanVisual(game.wrongGuesses);
        } else if (result === 'quit') {
            description =
                `🚪 **You quit the game.**\n\n` +
                `The word was **${game.word}**.\n\n` +
                `📚 **Category:** ${game.category}\n` +
                `⚔️ **Difficulty:** ${game.difficulty}`;
        } else {
            description =
                `⏰ **Game timed out.**\n\n` +
                `The word was **${game.word}**.\n\n` +
                `📚 **Category:** ${game.category}\n` +
                `⚔️ **Difficulty:** ${game.difficulty}`;
        }
    }

    return new EmbedBuilder()
        .setColor(gameOver ? (result === 'win' ? 0x00e5a8 : 0xff5577) : 0x00d4ff)
        .setTitle(title)
        .setDescription(description)
        .setFooter({ text: `Game ID: ${gameId}` })
        .setTimestamp();
}

function createLeaderboardEmbed() {
    const entries = [...hangmanLeaderboard.values()]
        .sort((a, b) => b.creditsEarned - a.creditsEarned)
        .slice(0, 10);

    if (entries.length === 0) {
        return new EmbedBuilder().setColor(0x00d4ff).setTitle('🏆 Hangman Leaderboard')
            .setDescription('No Hangman games have been completed yet.');
    }

    const lines = entries.map((entry, index) => {
        const totalGames = entry.wins + entry.losses + entry.quits + entry.timeouts;
        const winRate = totalGames > 0 ? ((entry.wins / totalGames) * 100).toFixed(1) : '0.0';
        return `**${index + 1}.** <@${entry.userId}>\n` +
            `🏆 ${entry.wins} wins • ❌ ${entry.losses} losses • 📊 ${winRate}% win rate\n` +
            `💰 ${entry.creditsEarned} credits`;
    });

    return new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 Hangman Leaderboard')
        .setDescription(lines.join('\n\n')).setTimestamp();
}

function createWordGuessModal(gameId) {
    const input = new TextInputBuilder()
        .setCustomId('word')
        .setLabel('What is the word?')
        .setPlaceholder('Enter your full word guess')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(30);

    return new ModalBuilder()
        .setCustomId(`hm:${gameId}:WORD_MODAL`)
        .setTitle('📝 Guess the Word')
        .addComponents(new ActionRowBuilder().addComponents(input));
}

async function endGame(gameId, result, collector, message) {
    const game = hangmanGames.get(gameId);
    if (!game || !game.gameActive) return;
    game.gameActive = false;
    if (activeUserGames.get(game.userId) === gameId) activeUserGames.delete(game.userId);
    collector.stop(result);
    recordResult(game, result);
    if (result === 'win') {
        try {
            casino.creditWallet(game.userId, 'hangman', getFinalReward(game), 'payout', 'Hangman win');
        } catch (error) {
            console.error('Error rewarding Hangman winner:', error);
        }
    }
    const embed = createGameEmbed(gameId, game, true, result);
    try {
        await message.edit({ embeds: [embed], components: createComponents(gameId, game, true) });
    } catch (error) {
        console.error('Error updating Hangman end display:', error);
    } finally {
        hangmanGames.delete(gameId);
    }
}

async function startGame(interaction) {
    const userId = interaction.user.id;

    const existingGameId = activeUserGames.get(userId);
    if (existingGameId) {
        const existingGame = hangmanGames.get(existingGameId);
        if (existingGame && existingGame.gameActive) {
            return interaction.editReply({
                embeds: [new EmbedBuilder().setColor(0xff5577).setTitle('Game Already Active')
                    .setDescription(`You already have an active Hangman game.\n\n🎯 **Game ID:** \`${existingGameId}\`\n📚 **Category:** ${existingGame.category}\n⚔️ **Difficulty:** ${existingGame.difficulty}`)]
            });
        }
        activeUserGames.delete(userId);
    }

    const remaining = getRemainingTime(userId, 'hangman');
    if (remaining > 0) {
        return interaction.editReply({ content: `You can play Hangman again ${formatRemainingTime(remaining)}.` });
    }

    const category = interaction.options.getString('category') ?? 'general';
    const difficulty = interaction.options.getString('difficulty') ?? 'medium';
    const difficultyData = DIFFICULTIES[difficulty];
    const categoryData = CATEGORIES[category];

    if (!difficultyData || !categoryData) {
        return interaction.editReply({ content: '❌ The selected category or difficulty is invalid.' });
    }

    const gameId = `${userId}-${Date.now()}`;
    const game = {
        userId,
        channelId: interaction.channelId,
        messageId: '',
        word: getRandomWord(category),
        category: categoryData.name,
        difficulty: difficultyData.name,
        guessed: new Set(),
        wrongGuesses: 0,
        maxWrongGuesses: difficultyData.maxWrongGuesses,
        hintsUsed: 0,
        maxHints: MAX_HINTS,
        reward: difficultyData.reward,
        hintPenalty: difficultyData.hintPenalty,
        gameActive: true,
        processing: false
    };

    const message = await interaction.editReply({
        embeds: [createGameEmbed(gameId, game)],
        components: createComponents(gameId, game)
    });
    game.messageId = message.id;
    hangmanGames.set(gameId, game);
    activeUserGames.set(userId, gameId);
    setCooldown(userId, 'hangman');

    const collector = message.createMessageComponentCollector({ time: GAME_TIMEOUT });

    collector.on('collect', async componentInteraction => {
        const currentGame = hangmanGames.get(gameId);
        if (!currentGame || !currentGame.gameActive) {
            if (!componentInteraction.replied && !componentInteraction.deferred) {
                await componentInteraction.reply({ content: '❌ This game has ended.' });
            }
            return;
        }
        if (currentGame.processing) {
            await componentInteraction.reply({ content: '⏳ Processing your previous action...' });
            return;
        }
        currentGame.processing = true;

        try {
            if (componentInteraction.isButton() && componentInteraction.customId === `hm:${gameId}:QUIT`) {
                await componentInteraction.deferUpdate();
                await endGame(gameId, 'quit', collector, message);
                return;
            }

            if (componentInteraction.isButton() && componentInteraction.customId === `hm:${gameId}:LEADERBOARD`) {
                await componentInteraction.reply({ embeds: [createLeaderboardEmbed()] });
                return;
            }

            if (componentInteraction.isButton() && componentInteraction.customId === `hm:${gameId}:HINT`) {
                await componentInteraction.deferUpdate();
                if (currentGame.hintsUsed >= currentGame.maxHints) {
                    await componentInteraction.followUp({ content: '💡 You have already used all of your hints.' });
                    return;
                }
                const remainingLetters = getRemainingLetters(currentGame.word, currentGame.guessed);
                if (remainingLetters.length === 0) return;
                const hintedLetter = remainingLetters[Math.floor(Math.random() * remainingLetters.length)];
                currentGame.guessed.add(hintedLetter);
                currentGame.hintsUsed++;
                await message.edit({
                    embeds: [createGameEmbed(gameId, currentGame)],
                    components: createComponents(gameId, currentGame)
                });
                await componentInteraction.followUp({
                    content: `💡 **Hint:** The letter **${hintedLetter}** has been revealed!\n💰 Each hint reduces your reward by **${currentGame.hintPenalty} credits**.` });
                if (isWordGuessed(currentGame.word, currentGame.guessed)) {
                    await endGame(gameId, 'win', collector, message);
                }
                return;
            }

            if (componentInteraction.isButton() && componentInteraction.customId === `hm:${gameId}:GUESS`) {
                await componentInteraction.showModal(createWordGuessModal(gameId));
                let modal;
                try {
                    modal = await componentInteraction.awaitModalSubmit({
                        time: 60000,
                        filter: modalInteraction => modalInteraction.user.id === userId &&
                            modalInteraction.customId === `hm:${gameId}:WORD_MODAL`
                    });
                } catch {
                    return; // Modal timed out.
                }

                const latestGame = hangmanGames.get(gameId);
                if (!latestGame || !latestGame.gameActive) {
                    if (!modal.replied && !modal.deferred) {
                        await modal.reply({ content: '❌ This game has ended.' });
                    }
                    return;
                }

                const guess = modal.fields.getTextInputValue('word').trim().toUpperCase();
                if (!guess) {
                    await modal.reply({ content: '❌ Please enter a word.' });
                    return;
                }

                if (guess === latestGame.word) {
                    await modal.deferUpdate();
                    for (const letter of latestGame.word) latestGame.guessed.add(letter);
                    await endGame(gameId, 'win', collector, message);
                    return;
                }

                // Incorrect full-word guesses count as TWO wrong guesses.
                latestGame.wrongGuesses += 2;
                if (latestGame.wrongGuesses >= latestGame.maxWrongGuesses) {
                    await modal.deferUpdate();
                    await endGame(gameId, 'lose', collector, message);
                    return;
                }

                await modal.deferUpdate();
                await message.edit({
                    embeds: [createGameEmbed(gameId, latestGame)],
                    components: createComponents(gameId, latestGame)
                });
                await modal.followUp({ content: '❌ Incorrect word guess! You lost **2 wrong guesses**.' });
                return;
            }

            if (!componentInteraction.isStringSelectMenu()) {
                await componentInteraction.reply({ content: '❌ Invalid game interaction.' });
                return;
            }
            if (componentInteraction.customId !== `hm:${gameId}:letter:1` &&
                componentInteraction.customId !== `hm:${gameId}:letter:2`) {
                await componentInteraction.reply({ content: '❌ Invalid Hangman interaction.' });
                return;
            }

            const letter = componentInteraction.values[0]?.toUpperCase();
            if (!letter) {
                await componentInteraction.reply({ content: '❌ Invalid letter.' });
                return;
            }
            if (currentGame.guessed.has(letter)) {
                await componentInteraction.reply({ content: '⚠️ You already guessed that letter!' });
                return;
            }

            currentGame.guessed.add(letter);
            if (!currentGame.word.includes(letter)) currentGame.wrongGuesses++;

            if (isWordGuessed(currentGame.word, currentGame.guessed)) {
                await componentInteraction.deferUpdate();
                await endGame(gameId, 'win', collector, message);
                return;
            }
            if (currentGame.wrongGuesses >= currentGame.maxWrongGuesses) {
                await componentInteraction.deferUpdate();
                await endGame(gameId, 'lose', collector, message);
                return;
            }

            await componentInteraction.update({
                embeds: [createGameEmbed(gameId, currentGame)],
                components: createComponents(gameId, currentGame)
            });
        } catch (error) {
            console.error('Error processing Hangman interaction:', error);
            if (!componentInteraction.replied && !componentInteraction.deferred) {
                await componentInteraction.reply({ content: '❌ Something went wrong processing your action.' });
            }
        } finally {
            const game = hangmanGames.get(gameId);
            if (game) game.processing = false;
        }
    });

    collector.on('end', async () => {
        const currentGame = hangmanGames.get(gameId);
        if (currentGame && currentGame.gameActive) {
            await endGame(gameId, 'timeout', collector, message);
        }
    });
}

async function showStats(interaction) {
    const entry = getLeaderboardEntry(interaction.user.id);
    const totalGames = entry.wins + entry.losses + entry.quits + entry.timeouts;
    const winRate = totalGames > 0 ? ((entry.wins / totalGames) * 100).toFixed(1) : '0.0';
    return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x00d4ff).setTitle('🎯 Hangman Statistics')
            .setDescription(`Wins: **${entry.wins}**\nLosses: **${entry.losses}**\nQuits: **${entry.quits}**\nTimeouts: **${entry.timeouts}**\nWin rate: **${winRate}%**\nHints used: **${entry.hintsUsed}**\nCredits earned: **🪙${entry.creditsEarned.toLocaleString()}**`)] });
}

module.exports = {
    getRandomWord,
    getDisplayWord,
    isWordGuessed,
    getRemainingLetters,
    getFinalReward,
    data: new SlashCommandBuilder()
        .setName('hangman')
        .setDescription('Play a game of Hangman')
        .addStringOption(option => option.setName('mode').setDescription('What to do')
            .addChoices({ name: 'Play', value: 'play' }, { name: 'Stats', value: 'stats' }))
        .addStringOption(option => option.setName('category').setDescription('Choose a word category')
            .setRequired(false)
            .addChoices(
                { name: '📚 General', value: 'general' },
                { name: '🐾 Animals', value: 'animals' },
                { name: '🍕 Food', value: 'food' },
                { name: '🌿 Nature', value: 'nature' },
                { name: '💻 Technology', value: 'technology' },
                { name: '🧠 Complex', value: 'complex' }
            ))
        .addStringOption(option => option.setName('difficulty').setDescription('Choose the difficulty')
            .setRequired(false)
            .addChoices(
                { name: '🟢 Easy — 200 credits', value: 'easy' },
                { name: '🟡 Medium — 300 credits', value: 'medium' },
                { name: '🔴 Hard — 500 credits', value: 'hard' },
                { name: '💀 Extreme — 2000 credits', value: 'extreme' }
            )),
    async execute(interaction) {
        try {
            if (interaction.options.getString('mode') === 'stats') return showStats(interaction);
            await interaction.deferReply();
            await startGame(interaction);
        } catch (error) {
            console.error('Error in hangman command:', error);
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



