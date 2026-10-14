const { 
    SlashCommandBuilder, 
    EmbedBuilder 
} = require('discord.js');
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('auto-embeds')
        .setDescription('[ADMIN ONLY] Displays a complete guide for all Chat Rewards commands.'),

    async execute(interaction) {
        // Runtime gate — keeps non-admins out even if a server admin re-shares
        // the command through channel overrides.
        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ This command is restricted to administrators.' });
        }

        // Defer reply since sending multiple embeds might take a split second
        await interaction.deferReply();

        // --- ALL CATEGORIZED EMBEDS ---
        const embeds = [
            // 1. General & User Commands
            new EmbedBuilder()
                .setTitle('👤 General & User Commands')
                .setDescription('Commands available to all members for checking stats, balances, and preferences.')
                .setColor(0x5865F2)
                .addFields(
                    { name: '/credits balance', value: 'Shows the amount of credits a user has.\n*Permissions: All members*', inline: false },
                    { name: '/daily-credits', value: 'Displays remaining Daily Credits available to claim.\n*Permissions: All members*', inline: false },
                    { name: '/credits transfer', value: 'Transfers credits to another user.\n*Example:* `/credits transfer @Xonestly 500`\n*Permissions: All members*', inline: false },
                    { name: '/multiplier', value: 'Displays your current credit multiplier.\n*Permissions: All members*', inline: false },
                    { name: '/streak', value: 'Displays your chat streak, wait status, and next milestone.\n*Permissions: All members*', inline: false },
                    { name: '/special-rewards view / open', value: 'View and open rare Special Rewards for multipliers.\n*Permissions: All members*', inline: false },
                    { name: '/quests', value: 'View active daily and weekly quests & track progress.\n*Permissions: All members*', inline: false },
                    { name: '/leaderboard', value: 'Displays credit balances or Chat Drop leaderboards.\n*Permissions: All members*', inline: false }
                ),

            new EmbedBuilder()
                .setColor(0x5865F2)
                .addFields(
                    { name: '/stats', value: 'Shows user, server, or global stats.\n*Example:* `/stats @Xonestly Global Stats`\n*Permissions: All members*', inline: false },
                    { name: '/opt-out', value: 'Opt in or out of participating in Chat Rewards.\n*Permissions: All members*', inline: false },
                    { name: '/vote / invite / info / help / ping', value: 'Utility commands for voting, invites, info, and latency.\n*Permissions: All members*', inline: false }
                ),

            // 2. Economy, Shop & Goals
            new EmbedBuilder()
                .setTitle('🛒 Economy, Shop & Goals')
                .setDescription('Commands for spending credits, managing the shop, cases, and community goals.')
                .setColor(0xFEE75C)
                .addFields(
                    { name: '/shop view', value: 'Displays the server shop to buy items.\n*Permissions: All members*', inline: false },
                    { name: '/shop manage', value: 'Add, edit, or remove shop items and stock.\n*Permissions: Manage Server / Mod Role*', inline: false },
                    { name: '/cases manage', value: 'Create and manage role loot boxes/cases.\n*Permissions: Manage Server / Mod Role*', inline: false },
                    { name: '/cases item add / edit / remove', value: 'Manage weighted roles inside specific cases.\n*Permissions: Manage Server / Mod Role*', inline: false },
                    { name: '/goals view', value: 'View active community goals and donate credits.\n*Permissions: All members*', inline: false },
                    { name: '/goals manage', value: 'Create, edit, and post community donation goals.\n*Permissions: Manage Server / Mod Role*', inline: false },
                    { name: '/rates view', value: 'Shows odds for receiving reward types.\n*Permissions: All members*', inline: false },
                    { name: '/rates manage', value: 'Interactive interface to adjust reward drop rates.\n*Permissions: Manage Server / Mod Role*', inline: false }
                ),

            // 3. Server Management & Setup
            new EmbedBuilder()
                .setTitle('⚙️ Server Management & Setup (Part 1)')
                .setDescription('Configure how Chat Rewards operates within your server.')
                .setColor(0xED4245)
                .addFields(
                    { name: '/setup', value: 'Guided onboarding setup wizard.\n*Permissions: Server Administrators*', inline: false },
                    { name: '/active-channels view / add / remove', value: 'Manage channels where chat rewards can trigger.\n*Permissions: Manage Server / Mod Role*', inline: false },
                    { name: '/credits settings', value: 'Customize server currency name and emoji.\n*Example:* `/credits settings "SuperCoins" "💎"`\n*Permissions: Manage Server / Mod Role*', inline: false },
                    { name: '/daily-credits-limit', value: 'Adjust guaranteed daily credit limit (Default: 500).\n*Permissions: All members*', inline: false },
                    { name: '/transfer-limits', value: 'View or update daily transfer limits and taxes.\n*Permissions: Mixed (View: All | Edit: Mod+)*', inline: false },
                    { name: '/credits purge', value: 'Resets ALL users credits in the server back to 0.\n*Permissions: Server Administrators*', inline: false }
                ),

            new EmbedBuilder()
                .setTitle('⚙️ Server Management & Setup (Part 2)')
                .setColor(0xED4245)
                .addFields(
                    { name: '/mod-role', value: 'Sets the designated moderator role for bot configuration.\n*Permissions: Server Administrators*', inline: false },
                    { name: '/blacklist', value: 'Blacklist users from earning or spending rewards.\n*Permissions: Manage Server / Mod Role*', inline: false },
                    { name: '/reward-messages', value: 'Configure reward message destinations and auto-delete timers.\n*Permissions: Manage Server / Mod Role*', inline: false },
                    { name: '/logging', value: 'Configure log channels and alert pings.\n*Permissions: Manage Server / Mod Role*', inline: false },
                    { name: '/whitelabel', value: 'Customize bot avatar, banner, name, and bio.\n*Permissions: Server Administrators*', inline: false },
                    { name: '/premium', value: 'View and activate server premium subscriptions.\n*Permissions: Manage Server / Mod Role*', inline: false }
                ),

            // 4. Spawns & Events
            new EmbedBuilder()
                .setTitle('🎉 Spawns & Events')
                .setDescription('Force-spawn rewards, custom chat trivia, and active flurries.')
                .setColor(0x57F287)
                .addFields(
                    { name: '/spawn reward', value: 'Instantly spawn a Common, Epic, Legendary, or Special reward.\n*Example:* `/spawn reward legendary @Xonestly`\n*Permissions: Manage Server / Mod Role*', inline: false },
                    { name: '/spawn chat-drop', value: 'Instantly send a custom trivia drop.\n*Example:* `/spawn chat-drop "Q" "A" #general 500`\n*Permissions: Manage Server / Mod Role*', inline: false },
                    { name: '/spawn chat-flurry', value: 'Start a high-intensity drop event with multiplier settings.\n*Example:* `/spawn chat-flurry 120 2 3`\n*Permissions: Manage Server / Mod Role*', inline: false },
                    { name: '/chat-drops manage', value: 'Manage custom server chat drop questions pool.\n*Permissions: Manage Server / Mod Role*', inline: false },
                    { name: '/boost-rewards', value: 'Configure bonus credits for server boosters.\n*Permissions: Manage Server / Mod Role*', inline: false }
                ),

            // 5. Games & Mini-Games
            new EmbedBuilder()
                .setTitle('🎮 Games & Mini-Games')
                .setDescription('Wager credits against other members in minigames.')
                .setColor(0xEB459E)
                .addFields(
                    { name: '/games manage', value: 'Enable/disable games and configure shared tax.\n*Permissions: Manage Server / Mod Role*', inline: false },
                    { name: '/games rps', value: 'Challenge players to Rock Paper Scissors.\n*Example:* `/games rps challenge:Open wager:500 rounds:3`\n*Permissions: All members*', inline: false },
                    { name: '/games coin-flip', value: 'Challenge players to a coin flip wager.\n*Example:* `/games coin-flip challenge:Specific wager:250 opponent:@Xonestly`\n*Permissions: All members*', inline: false },
                    { name: '/games guess-number', value: 'Challenge players to guess a secret number (1-1,000).\n*Example:* `/games guess-number challenge:Open wager:500 rounds:3`\n*Permissions: All members*', inline: false }
                )
        ];

        // Discord allows a maximum of 10 embeds per single message response. 
        // We have 7 total, so we can send them all together safely in a single message!
        await interaction.editReply({ embeds: embeds });
    }
};