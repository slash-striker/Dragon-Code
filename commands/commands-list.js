const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');

const ALLOWED_CHANNEL = '1504562791967756448';

// Command categories with high-tech styling
const COMMAND_CATEGORIES = {
    economy: {
        name: '⚡ ECONOMY SYSTEMS',
        color: 0x00ff88,
        commands: [
            { name: '/work', desc: 'Complete career assignments for credits' },
            { name: '/beg', desc: 'Beg on the streets for coins' },
            { name: '/crime', desc: 'Solo breaches or escalating co-op heists with crew roles (hacker/driver/muscle)' },
            { name: '/rob', desc: 'Rob a player\'s wallet or start a bank heist (pick type)' },
            { name: '/daily', desc: 'Claim your daily cosmic reward' },
            { name: '/fish', desc: 'Opens a Fish Hub (Cast, sell, shop, view log, view tournament board)' },
            { name: '/bank', desc: 'Deposit, withdraw (pick action), or check your vault' },
            { name: '/balance', desc: 'Check your[someone else\'s] wallet and bank balance' },
            { name: '/transfer', desc: 'Send coins to another user' },
            { name: '/trade', desc: 'Trade items and credits with another player — both sides must confirm' },
            { name: '/bounty', desc: 'Put a price on someone\'s head; whoever robs them collects the pool' },
            { name: '/invest', desc: 'Contrarian market PvP — bet long or short on an ore, 5-minute rounds' },
            { name: '/remind', desc: 'Set, list or cancel a private DM reminder (e.g. /remind 2h claim the contract)' }
        ]
    },
    shop: {
        name: '🛒 NEURAL SHOP',
        color: 0x00d4ff,
        commands: [
            { name: '/shop', desc: 'Browse or buy items (action picker, autocomplete for buy)' },
            { name: '/inventory', desc: 'View your item and mining inventory' },
            { name: '/open-box', desc: 'Open mystery boxes (mode:auto toggles auto-open)' },
            { name: '/item-give', desc: 'Open the guided embed picker to give shop items or stored fish to another user' }
        ]
    },
    casino: {
        name: '🎰 CASINO ZONE',
        color: 0xff6b9d,
        commands: [
            { name: '/blackjack', desc: 'Play blackjack against the dealer: Only in Blackjack Thread in Party Games channel' },
            { name: '/games', desc: 'Every minigame in one slot — pick 5dice, hangman, highlow, lightsout, mastermind, matchpairs, rps, or tictactoe' },
            { name: '/uno-play', desc: 'Open an UNO table — wilds, +2/+4, Normal/Stack/Spicy rules (UNO channel only)' },
            { name: '/scratchcard', desc: 'Buy and scratch cards for prizes' },
            { name: '/casino', desc: 'Casino rules + your summary (pick action)' },
            { name: '/roulette', desc: 'One-shot American roulette — /roulette amount:<#> bet_type:<color/area> or number:<0-36>' },
            { name: '/guess-number', desc: '[ADMIN] Free to play — exact hit wins 🪙500,000' },
            { name: '/game-night', desc: 'Overview of every game-night module' },
            { name: '/activities', desc: 'QOTD + party games: bomb, math, mafia, spy (pick an activity)' },
        ]
    },
    career: {
        name: '💼 CAREER MATRIX',
        color: 0xffd166,
        commands: [
            { name: '/job', desc: 'Browse career paths or apply for promotion (pick action)' },
            { name: '/mine', desc: 'Mine for resources and rewards — rare dragon eggs drop here' },
            { name: '/mining-inventory', desc: 'View your stored ores, refined materials, and fleet' },
            { name: '/mining', desc: 'Mining hub: drill & location upgrades, drones, refine, boosts, crew, contracts, property, stats' },
        ]
    },
    profile: {
        name: '👤 PROFILE SYSTEMS',
        color: 0x9b5cff,
        commands: [
            { name: '/profile', desc: 'Your full profile AND the Dragon Hatchery: pets, eggs, feeding, quests, badges, titles, dragon racing' },
            { name: '/rank', desc: 'View your level and XP card' },
            { name: '/level-leaderboard', desc: 'View the top XP users' },
            { name: '/hs', desc: 'View Netquel highscores — a player dossier or the global board (pick action)' },
            { name: '/prestige', desc: 'Reset for prestige bonuses' },
            { name: '/ec-stats', desc: 'Economy, blackjack and casino statistics in one' },
            { name: '/credits-audit', desc: 'View recent coin transactions' },
            { name: '/ec-cooldowns', desc: 'Open the live cooldown dashboard with refresh controls' },
            { name: '/set-cooldown', desc: 'Configure economy cooldown durations (admin)' },
            { name: '/set-sleep', desc: 'Set your timezone and sleep schedule' },
            { name: '/see-users-time', desc: 'View another user schedule' },
            { name: '/time-at', desc: 'Convert time between user timezones' },
        ]
    },
    social: {
        name: '🌐 SOCIAL NETWORK',
        color: 0x00e5ff,
        commands: [
            { name: '/lottery', desc: 'Join the weekly lottery, or check status & odds' },
            { name: '/market', desc: 'View and trade on the market' },
            { name: '/invest', desc: 'Contrarian market rounds: bet long or short, minority side wins bigger' },
            { name: '/exchange', desc: 'Exchange currencies' },
            { name: '/birthday', desc: 'Check a registered birthday or set your own (pick action)' },
        ]
    },
    admin: {
        name: '🔧 ADMIN CONTROLS',
        color: 0xff4444,
        commands: [
            { name: '/credits-give', desc: '[ADMIN ONLY] Give coins to a user' },
            { name: '/giveaway', desc: '[ADMIN ONLY] Launch an admin-only interactive credit giveaway (staff can reroll the winner)' },
            { name: '/dragon-admin', desc: '[ADMIN ONLY] One action-picker command for dragons, economy systems, admin roles, and server configuration' },
            { name: '/admin item-give', desc: '[ADMIN ONLY] Admin grant an item; action is logged' },
            { name: '/edit', desc: '[ADMIN ONLY] Edit a user\'s economy, inventory, daily streak, or XP (pick action)' },
            { name: '/reset', desc: '[ADMIN ONLY] Reset a user\'s economy, stats, wallet, inventory, or XP (confirmation required; everyone flag for wallet/inventory/xp)' },
            { name: '/set', desc: '[ADMIN ONLY] Record a player\'s highscore (staff)' },
            { name: '/hs-admin', desc: '[ADMIN ONLY] Record or sync the Netquel highscores (pick action)' },
            { name: '/jailed', desc: '[ADMIN ONLY] Jails users' },
            { name: '/admin', desc: '[ADMIN ONLY] Manage mining and economy state' },
            { name: '/staff-information', desc: '[ADMIN ONLY] Staff Embed' },
            { name: '/ping', desc: 'Check bot and API latency' }
        ]
    },
    utility: {
        name: '⚙️ UTILITY MODULES',
        color: 0x888888,
        commands: [
            { name: '/ui-style', desc: 'Toggle between high-tech and normal UI style' },
            { name: '/server-rules', desc: '[ADMIN ONLY] View server rules' },
            { name: '/game-pings', desc: 'Ping the Game Ping role with a game invite (once per 30 min)' },
            { name: '/staff', desc: 'Ping a staff member' },
            { name: '/verify', desc: '[STAFF ONLY] Post the verification terminal for new members' }
        ]
    },
    counting: {
        name: '🔢 COUNTING GRID',
        color: 0x00ff88,
        commands: [
            { name: '/nextcount', desc: 'Check the next required number' },
            { name: '/count-leaderboard', desc: 'View the counting channel leaderboard' },
            { name: '/set-count', desc: '[ADMIN ONLY] counting grid reset' }
        ]
    }
};

/*
 * One section embed per category — shared by the interactive view's styling
 * and by /post-commands-list, so both render identical content.
 */
function buildSectionEmbed(category) {
    const cat = COMMAND_CATEGORIES[category];
    const embed = new EmbedBuilder()
        .setColor(cat.color)
        .setTitle(`📋 ${cat.name}`)
        .setDescription('Available commands in this section:');
    cat.commands.forEach(cmd => {
        embed.addFields({
            name: `\`${cmd.name}\``,
            value: cmd.desc,
            inline: false
        });
    });
    return embed.setFooter({ text: 'SlashDragon command directory' });
}

function buildSectionEmbeds() {
    return Object.keys(COMMAND_CATEGORIES).map(buildSectionEmbed);
}

module.exports = {
    /*
     * Bare /commands-list — interactive view for everyone. The admin "post"
     * action moved to /post-commands-list (hidden from non-admins), because
     * Discord cannot hide a single subcommand of a visible command.
     */
    data: new SlashCommandBuilder()
        .setName('commands-list')
        .setDescription('View all available commands'),

    async execute(interaction) {
        // View subcommand - interactive view for the user
        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ You can only use this in <#${ALLOWED_CHANNEL}>.` });
        }

        const uiStyle = 'hightech'; // Default UI style for SlashyTron

        let currentCategory = 'economy';
        let page = 0;

        const buildEmbed = (category, pageNum, uiStyle = 'hightech') => {
            const cat = COMMAND_CATEGORIES[category];
            const commands = cat.commands;
            const pageSize = 6;
            const totalPages = Math.ceil(commands.length / pageSize);
            const pageCommands = commands.slice(pageNum * pageSize, (pageNum + 1) * pageSize);

            const isHighTech = uiStyle === 'hightech';

            const embed = new EmbedBuilder()
                .setColor(isHighTech ? cat.color : 0x00d4ff)
                .setTitle(isHighTech ? '🌐 NEURAL COMMAND TERMINAL' : '📋 Commands List')
                .setDescription(isHighTech
                    ? `**[ ${cat.name} ]**\n\nAccess all available bot commands through this interface.`
                    : `**${cat.name}**\n\nBrowse all available commands.`)
                .setFooter({ text: `Page ${pageNum + 1}/${totalPages} • Total Commands: ${Object.values(COMMAND_CATEGORIES).reduce((acc, c) => acc + c.commands.length, 0)}` });

            pageCommands.forEach(cmd => {
                embed.addFields({
                    name: isHighTech ? `\`${cmd.name}\`` : cmd.name,
                    value: cmd.desc,
                    inline: false
                });
            });

            return embed;
        };

        const buildComponents = (category, pageNum, uiStyle = 'hightech') => {
            const cat = COMMAND_CATEGORIES[category];
            const totalPages = Math.ceil(cat.commands.length / 6);
            const isHighTech = uiStyle === 'hightech';

            // Category select menu
            const selectMenu = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('cmd:economy')
                    .setLabel(isHighTech ? '⚡ Economy' : 'Economy')
                    .setStyle(category === 'economy' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('cmd:shop')
                    .setLabel(isHighTech ? '🛒 Shop' : 'Shop')
                    .setStyle(category === 'shop' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('cmd:casino')
                    .setLabel(isHighTech ? '🎰 Casino' : 'Casino')
                    .setStyle(category === 'casino' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('cmd:career')
                    .setLabel(isHighTech ? '💼 Career' : 'Career')
                    .setStyle(category === 'career' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('cmd:profile')
                    .setLabel(isHighTech ? '👤 Profile' : 'Profile')
                    .setStyle(category === 'profile' ? ButtonStyle.Primary : ButtonStyle.Secondary)
            );

            const selectMenu2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('cmd:social')
                    .setLabel(isHighTech ? '🌐 Social' : 'Social')
                    .setStyle(category === 'social' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('cmd:admin')
                    .setLabel(isHighTech ? '🔧 Admin' : 'Admin')
                    .setStyle(category === 'admin' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('cmd:utility')
                    .setLabel(isHighTech ? '⚙️ Utility' : 'Utility')
                    .setStyle(category === 'utility' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('cmd:prev')
                    .setLabel('◀')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(pageNum === 0),
                new ButtonBuilder()
                    .setCustomId('cmd:next')
                    .setLabel('▶')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(pageNum >= totalPages - 1 || totalPages === 0)
            );

            return [selectMenu, selectMenu2];
        };

        const message = await interaction.reply({
            embeds: [buildEmbed(currentCategory, page, uiStyle)],
            components: buildComponents(currentCategory, page, uiStyle),
            fetchReply: true
        });

        const collector = message.createMessageComponentCollector({
            time: 300000
        });

        collector.on('collect', async (btn) => {
            if (btn.user.id !== interaction.user.id) {
                return btn.reply({ content: 'This is not your command panel.' });
            }

            const userUiStyle = 'hightech'; // Default UI style for SlashyTron

            if (btn.customId === 'cmd:prev') {
                if (page > 0) {
                    page--;
                    await btn.update({
                        embeds: [buildEmbed(currentCategory, page, userUiStyle)],
                        components: buildComponents(currentCategory, page, userUiStyle)
                    });
                }
            } else if (btn.customId === 'cmd:next') {
                const totalPages = Math.ceil(COMMAND_CATEGORIES[currentCategory].commands.length / 6);
                if (page < totalPages - 1) {
                    page++;
                    await btn.update({
                        embeds: [buildEmbed(currentCategory, page, userUiStyle)],
                        components: buildComponents(currentCategory, page, userUiStyle)
                    });
                }
            } else if (btn.customId.startsWith('cmd:')) {
                const category = btn.customId.replace('cmd:', '');
                if (COMMAND_CATEGORIES[category]) {
                    currentCategory = category;
                    page = 0;
                    await btn.update({
                        embeds: [buildEmbed(currentCategory, page, userUiStyle)],
                        components: buildComponents(currentCategory, page, userUiStyle)
                    });
                }
            }
        });

        collector.on('end', async () => {
            try {
                await message.edit({ components: [] });
            } catch {}
        });
    },

    // Section embeds for /post-commands-list (keeps one source of truth).
    buildSectionEmbeds
};
