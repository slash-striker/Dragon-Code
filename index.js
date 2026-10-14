require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('./database');

const cron = require("node-cron");

const lottery = require("./systems/lottery/lotteryManager");
const { getUser, updateUser } = require("./systems/economy/userManager");
const { initTransactionsTable } = require("./systems/economy/transactionLogger");
const { initCooldownsTable, rollbackExpiredCommand } = require("./systems/economy/cooldownManager");
const { initBankAutomation, runSlashDragonBankCycle } = require("./systems/economy/slashDragonBank");
const { handleXP, createLevelCard, sendLevelUpCard, giveLevelRole, checkLevel } = require("./systems/leveling/levelingSystem");
const {
    COUNTING_CHANNEL_ID,
    getState,
    recordValidCount,
    wasCountedMessage,
    recordInvalidCount
} = require('./systems/counting/countingManager');

const {
    REST,
    Routes,
    Client,
    GatewayIntentBits,
    Partials,
    Collection,
    EmbedBuilder,
    ActivityType,
    PresenceUpdateStatus,
    Events
} = require('discord.js');



const deployCommands = async () => {
    try {
        if (!process.env.BOT_TOKEN || !process.env.CLIENT_ID) {
            console.warn('Discord command deployment skipped: BOT_TOKEN or CLIENT_ID is missing.');
            return;
        }

        const commands = [];
        const commandSources = new Map();

        /*
         * Discord caps applications at 100 slash commands (code 30032).
         * These files still load (their engines/flows are reachable through
         * other commands) but no longer get their own slash slot:
         *  - set-birthday/reset-inv/ec-reset/miningguide merged into
         *    /birthday, /reset, and /mining help
         *  - bomb/math/mafia/spy merged into /activities (party-game hub)
         *  - 5dice/hangman/highlow/lightsout/mastermind/matchpairs/rps/
         *    tictactoe merged into /games (minigame hub; files stay as engines)
         * Remove a name from this list to give it its own command again.
         */
        const HIDDEN_COMMAND_FILES = new Set([
            'set-birthday.js', 'reset-inv.js', 'ec-reset.js', 'miningguide.js',
            'bomb.js', 'math.js', 'mafia.js', 'spy.js',
            '5dice.js', 'hangman.js', 'highlow.js', 'lightsout.js',
            'mastermind.js', 'matchpairs.js', 'rps.js', 'tictactoe.js',
            'casino-admin.js'
        ]);

        const commandFiles = fs
            .readdirSync(path.join(__dirname, 'commands'))
            .filter(file => file.endsWith('.js') && !HIDDEN_COMMAND_FILES.has(file));

        for (const file of commandFiles) {
            const command = require(`./commands/${file}`);

            if (!command?.data) continue;

            const commandName = String(command.data.name || '').trim().toLowerCase();
            if (!commandName) {
                console.warn(`Skipping ${file}: command has no name.`);
                continue;
            }
            if (commandSources.has(commandName)) {
                console.warn(
                    `Skipping duplicate slash command "${commandName}" from ${file}; ` +
                    `already provided by ${commandSources.get(commandName)}.`
                );
                continue;
            }

            if (typeof command.data.toJSON === 'function') {
                commands.push(command.data.toJSON());
            } else {
                commands.push(command.data);
            }
            commandSources.set(commandName, file);
        }


        const rest = new REST().setToken(process.env.BOT_TOKEN);
        const deploymentRoute = process.env.GUILD_ID
            ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
            : Routes.applicationCommands(process.env.CLIENT_ID);

        console.log('Refreshing slash commands...');

        if (process.env.GUILD_ID) {
            const globalCommands = await rest.get(
                Routes.applicationCommands(process.env.CLIENT_ID)
            );
            await Promise.all(
                globalCommands.map(command =>
                    rest.delete(Routes.applicationCommand(
                        process.env.CLIENT_ID,
                        command.id
                    ))
                )
            );
            console.log(`Removed ${globalCommands.length} global commands.`);
        }

        await rest.put(
            deploymentRoute,
            { body: commands }
        );

        console.log(`Slash commands loaded${process.env.GUILD_ID ? ` for guild ${process.env.GUILD_ID}` : ' globally'}.`);

    } catch (err) {
        console.error(err);
    }
};



/* =========================
   CLIENT
========================= */

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
    ],
    partials: [
        Partials.Channel,
        Partials.User,
        Partials.GuildMember,
        Partials.Message,
        Partials.Reaction
    ]
});

/* =========================
   CRASH GUARDS
   An unhandled rejection (e.g. a button interaction replying after its
   3-second window -> DiscordAPIError 10062) must never take the whole
   process down. Log it and keep serving.
========================= */
process.on('unhandledRejection', error => {
    if (error?.code === 10062) {
        console.warn('Unhandled interaction-expired error (10062) — ignored, bot continues.');
        return;
    }
    console.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});

client.commands = new Collection();

// Load events
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
    try {
        const event = require(path.join(eventsPath, file));
        if (event.once) {
            client.once(event.name, (...args) => event.execute(...args));
        } else {
            client.on(event.name, (...args) => event.execute(...args));
        }
    } catch (err) {
        // One broken event file must not silently abort boot.
        console.error(`Failed to load event ${file}:`, err.message);
    }
}
console.log(`Loaded ${eventFiles.length} event listeners.`);


/* =========================
   LOAD COMMANDS
========================= */

const commandsPath = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsPath)) {
    if (!file.endsWith('.js')) continue;

    try {
        const command = require(`./commands/${file}`);

        if (command.data && command.execute) {
            const commandName = String(command.data.name || '').trim().toLowerCase();
            if (client.commands.has(commandName)) {
                console.warn(`Skipping duplicate runtime command "${commandName}" from ${file}.`);
                continue;
            }
            client.commands.set(commandName, command);
        }
    } catch (err) {
        // A single broken command file must not abort the whole boot loop —
        // previously that left the process alive without ever calling login.
        console.error(`Failed to load command ${file}:`, err.message);
    }
}
console.log(`Loaded ${client.commands.size} slash commands.`);


/* =========================
   READY
========================= */

client.once(Events.ClientReady, async () => {

    console.log(`Logged in as ${client.user.tag}`);

    if (!client.user) {
        console.warn('Client user missing after login.');
        return;
    }

    // Initialize transaction logger
    initTransactionsTable();

    // Initialize cooldown manager
    initCooldownsTable();
    initBankAutomation();

    // Timed role ticker: strips expired XP/Mega boost roles and announces expiries.
    require('./systems/economy/timedRoles').startTimedRoleTicker(client);

    // Economy scheduler: nightly interest + auto-deposit, monthly taxes,
    // cooldown pings, and birthday announcements (all minute-ticked).
    require('./systems/economy/economyScheduler').startEconomyScheduler(client);

    // Live voice-channel counters (Total Users / All Members / All Bots /
    // Goal) — slow refresh ticker; joins/leaves schedule a debounced refresh.
    require('./systems/discord/liveCounters').startLiveCounters(client);

    // Casino self-heal: any blackjack session left 'active' by a restart or
    // crash would permanently block that player from opening a new table
    // ("You already have an active Blackjack table"). Close them on boot.
    try {
        const swept = db.prepare(
            "UPDATE casino_sessions SET state = 'closed', updatedAt = ? WHERE state = 'active'"
        ).run(new Date().toISOString());
        if (swept.changes > 0) {
            console.log(`♠ Casino boot sweep: closed ${swept.changes} orphaned session(s) from the previous run`);
        }
    } catch (error) {
        console.error('Casino boot sweep failed:', error);
    }

    // Game Night suite: guess-the-number round (roulette is now an on-demand
    // /roulette command — no channel loop).
    require('./commands/guess-number').bootstrap(client);

    await deployCommands();
    const statusMap = {
        online: PresenceUpdateStatus.Online,
        idle: PresenceUpdateStatus.Idle,
        dnd: PresenceUpdateStatus.DoNotDisturb,
        invisible: PresenceUpdateStatus.Invisible
    };

    const activityMap = {
        PLAYING: ActivityType.Playing,
        WATCHING: ActivityType.Watching,
        LISTENING: ActivityType.Listening,
        STREAMING: ActivityType.Streaming,
        COMPETING: ActivityType.Competing
    };

    client.user.setPresence({
        status: statusMap[process.env.BOT_STATUS || 'online'],
        activities: [{
            name: process.env.ACTIVITY_NAME || 'Netquel',
            type: activityMap[process.env.ACTIVITY_TYPE] || ActivityType.Playing
        }]
    });
    cron.schedule("*/15 * * * *", () => runSlashDragonBankCycle(client.user.id));
    function sendLotteryLog(message) {
        const channel = client.channels.cache.get("1504562791967756448");
        if (channel) channel.send(message);
    }
    

    cron.schedule("0 12 * * 0", async () => {
        try {

            const entries = lottery.getEntries();

            if (!entries.length) {
                sendLotteryLog("❌ No entries this week. Lottery skipped.");
                lottery.resetLottery();
                return;
            }

            // ----------------------------
            // ANIMATION START MESSAGE
            // ----------------------------
            await sendLotteryLog(
    `⚡ NEURAL LOTTERY GRID INITIATED...

    Scanning ${entries.length} participants...
    Decrypting quantum randomness...
    Selecting winner...`
            );

            await new Promise(r => setTimeout(r, 3000));

            // ----------------------------
            // PICK WINNER
            // ----------------------------
            const winnerEntry = lottery.pickWinner();

            if (!winnerEntry) return;

            const winnerUser = await getUser(winnerEntry.userId);

            const pool = lottery.getPool();
            const prize = lottery.getPrize();

            // PAY WINNER
            winnerUser.wallet += prize;
            updateUser(winnerUser);

            // ----------------------------
            // ANNOUNCEMENT
            // ----------------------------
            await sendLotteryLog(
    `╔════════════════════════════╗
        🏆 JACKPOT CLAIMED
    ╚════════════════════════════╝

    Winner: <@${winnerEntry.userId}>

    💰 Entry: ${winnerEntry.amount.toLocaleString()}
    🪙 Pool: ${pool.toLocaleString()}
    ⚡ System Match: ${pool.toLocaleString()}
    🏆 Total Prize: ${prize.toLocaleString()}

    Transaction: COMPLETE
    `
            );

            // ----------------------------
            // RESET LOTTERY
            // ----------------------------
            lottery.resetLottery();

            await sendLotteryLog(
    `🔄 New Neural Lottery Cycle Started
    Next Draw: Sunday 12PM EST`
            );

        } catch (err) {
            console.error("Lottery draw error:", err);
        }
    });
});


/* =========================
   INTERACTIONS
========================= */

// Admin/audit role config lives in systems/admin/adminVisibility.js (DB-backed).
const { isAuditUser, isAdminLogEnabled } = require('./systems/admin/adminVisibility');

client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    if (!message.guild) return;

    if (message.channelId === COUNTING_CHANNEL_ID) {
        const content = message.content.trim();
        const count = /^\d+$/.test(content) ? Number(content) : null;
        const result = count !== null && Number.isSafeInteger(count)
            ? recordValidCount(message.author.id, count, message.id)
            : { valid: false, expected: null };

        if (result.valid) {
            await message.react('✅').catch(error => console.error('Counting success reaction failed:', error));
        } else {
            const consecutiveInvalid = recordInvalidCount(message.author.id);
            await message.react('❌').catch(error => console.error('Counting failure reaction failed:', error));
            await message.delete().catch(error => console.error('Counting invalid message deletion failed:', error));
            let timedOut = false;
            if (consecutiveInvalid >= 3 && message.member?.moderatable) {
                try {
                    await message.member.timeout(60 * 1000, 'Repeated invalid counting attempts');
                    timedOut = true;
                } catch (error) {
                    console.error(`Unable to timeout counting spammer ${message.author.id}:`, error);
                }
            }
            const warning = result.reason === 'same-user'
                ? '⚠️ Two consecutive counts by the same user are not allowed. Wait for someone else to count.'
                : result.expected
                    ? `⚠️ Wrong number. Use **/nextcount** to check the expected number: **${result.expected}**.`
                : '⚠️ No chatting in the counting grid. Send only the next number, or use **/nextcount** privately.';
            // Warnings PERSIST — no auto-delete — so everyone sees why a
            // count was rejected (matches the edit/delete alerts below).
            await message.channel.send(
                timedOut
                    ? `${warning}\n⏱️ You have been timed out for 1 minute after 3 consecutive invalid attempts.`
                    : warning
            ).catch(error => console.error('Counting warning failed:', error));
        }
        return;
    }

    try {
        await handleXP(message, db, client);
    } catch (error) {
        console.error('Unable to process message XP:', error);
    }

    /* =========================
       GAME NIGHT ROUTING
    ========================= */
    try {
        // 1. Guess the Number: numeric messages in the vault channel.
        await require('./commands/guess-number').handleMessage(message);

        // 2. Mafia / Spy threads: night actions and interrogation commands.
        if (message.channel?.isThread?.()) {
            const mafiaHandled = await require('./commands/mafia').handleThreadMessage(message);
            if (!mafiaHandled) await require('./commands/spy').handleThreadMessage(message);
        }
    } catch (error) {
        console.error('Game night routing error:', error);
    }
});

/*
 * Counting edits/deletes — AWARENESS ONLY, no rollback. Once a number is
 * counted it stays counted (users can always /nextcount the expected value);
 * this just alerts the channel so the edit/delete doesn't slip by unnoticed.
 * The alert is a persistent channel message — everyone sees it, nothing
 * auto-deletes it.
 */
async function announceCountingCorrection(message, action) {
    const channelId = message.channelId || message.channel?.id;
    if (channelId !== COUNTING_CHANNEL_ID) return;
    // Only ACCEPTED counts alert — the bot deleting a rejected chat message
    // must not also post a "deleted their counted number" alert.
    if (!wasCountedMessage(channelId, message.id)) return;
    const state = getState(message.channelId);
    const channel = message.channel || await client.channels.fetch(channelId).catch(error => {
        console.error('Counting channel fetch failed:', error);
        return null;
    });
    if (!channel?.isTextBased()) return;
    await channel.send(
        `⚠️ **COUNTING GRID ALERT:** <@${message.author?.id ?? '?'}> ${action} ` +
        `their counted number. The sequence keeps going — the next number is still **${state.currentCount + 1}**.`
    ).catch(error => console.error('Counting correction warning failed:', error));
}

client.on(Events.MessageDelete, async message => {
    if (message.author?.bot) return;
    await announceCountingCorrection(message, 'deleted');
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    if (newMessage.author?.bot) return;
    if (!newMessage.channelId && newMessage.partial) {
        newMessage = await newMessage.fetch().catch(error => {
            console.error('Counting edited message fetch failed:', error);
            return newMessage;
        });
    }
    if (oldMessage.content === newMessage.content) return;
    await announceCountingCorrection(newMessage, 'edited');
});

client.on(Events.InteractionCreate, async interaction => {
    let handler;

    if (interaction.isAutocomplete()) {
        handler = client.commands.get(interaction.commandName)?.autocomplete;
    } else if (interaction.isChatInputCommand()) {
        handler = client.commands.get(interaction.commandName)?.execute;
    } else if (interaction.isModalSubmit() && interaction.customId === 'job-apply:submission') {
        // Legacy modal hook — the unified /job command uses a select menu.
        handler = client.commands.get('job')?.handleModal;
    } else if (interaction.isModalSubmit() && interaction.customId === 'sleep:schedule') {
        // Handle sleep schedule modal
        const userId = interaction.user.id;
        const wakeTime = interaction.fields.getTextInputValue('wakeTime');
        const sleepTime = interaction.fields.getTextInputValue('sleepTime');
        
        const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
        
        if (!timeRegex.test(wakeTime) || !timeRegex.test(sleepTime)) {
            return interaction.reply({
                content: 'Invalid time format. Please use HH:MM format (e.g., 07:00). Try again with /set-sleep.',
                ephemeral: true
            });
        }
        
        const timezone = interaction.client.tempSleepData?.[userId]?.timezone;
        if (!timezone) {
            return interaction.reply({
                content: 'Session expired. Please start over with /set-sleep.',
                ephemeral: true
            });
        }
        
        db.prepare(`
            UPDATE users
            SET timezone = ?, wakeTime = ?, sleepTime = ?
            WHERE userId = ?
        `).run(timezone, wakeTime, sleepTime, userId);
        
        delete interaction.client.tempSleepData[userId];
        
        return interaction.reply({
            content: `✅ **Sleep schedule saved!**\n\nTimezone: UTC${timezone >= 0 ? '+' : ''}${timezone}\nWake up: ${wakeTime}\nBedtime: ${sleepTime}\n\nYou can view other users' schedules with /see-users-time.`,
            ephemeral: true
        });
    } else if (interaction.isButton() && interaction.customId.startsWith('job-list:')) {
        handler = client.commands.get('job')?.handleComponent;
    } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('item-give-component:')) {
        // /item-give fish picker (ephemeral select menu).
        handler = client.commands.get('item-give')?.handleComponent;
    } else if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('fish:hub:')) {
        // /fish main-hub menu + cast button — restart-safe, routed through
        // the hub's own component router.
        handler = client.commands.get('fish')?.handleComponent;
    } else if ((interaction.isButton() || interaction.isStringSelectMenu()) && (
        interaction.customId.startsWith('edit-itempage:') ||
        interaction.customId.startsWith('edit-item:')
    )) {
        // /edit inventory item-picker pages + selection.
        handler = client.commands.get('edit')?.handleComponent;
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith('edit-qty:')) {
        // /edit inventory quantity dialog.
        handler = client.commands.get('edit')?.handleModal;
    } else if ((interaction.isButton() || interaction.isStringSelectMenu()) && (
        interaction.customId.startsWith('mining-op:') ||
        interaction.customId.startsWith('mining-hub:') ||
        interaction.customId.startsWith('mining-back:') ||
        interaction.customId.startsWith('mining-drill-select:') ||
        interaction.customId.startsWith('mining-location-select:') ||
        interaction.customId.startsWith('mining-drone-station:') ||
        interaction.customId.startsWith('mining-drone-recall:')
    )) {
        // Guided /mining hub panels (buttons + section pick-lists).
        handler = client.commands.get('mining')?.handleComponent;
    } else if (interaction.isModalSubmit() && (
        interaction.customId.startsWith('mining-guild:') || interaction.customId.startsWith('mining-hire:')
    )) {
        // Guided /mining hub dialogs (guild name, worker name).
        handler = client.commands.get('mining')?.handleModal;
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith('games:')) {
        // /games setup-panel dialogs (custom difficulty/bet/category).
        handler = client.commands.get('games')?.handleModal;
    } else if (interaction.isButton() && (
        interaction.customId.startsWith('mafia_') || interaction.customId.startsWith('spy_')
    )) {
        // Mafia / Spy vote buttons are proxied through the /activities hub, which
        // lazy-loads the matching engine module.
        await client.commands.get('activities')?.handleComponent?.(interaction);
        return;
    } else if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('games:')) {
        // Game lounge / setup-panel buttons — restart-safe: routed through the
        // /games hub, which opens panels or lazy-loads the chosen engine.
        await client.commands.get('games')?.handleComponent?.(interaction);
        return;
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith('dragon|')) {
        // /profile rename dialog.
        await client.commands.get('profile')?.handleModal?.(interaction);
        return;
    } else if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('dragon|')) {
        // /profile — the whole Dragon Hatchery surface (dragons, incubators,
        // feeding, quests, badges, titles, racing). State lives in the id, so
        // it survives restarts like /games and the /fish hub.
        await client.commands.get('profile')?.handleComponent?.(interaction);
        return;
    } else if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('invest:')) {
        // /invest contrarian market panel.
        await client.commands.get('invest')?.handleComponent?.(interaction);
        return;
    } else if (interaction.isButton() && interaction.customId.startsWith('bounty:')) {
        // /bounty board buttons.
        await client.commands.get('bounty')?.handleComponent?.(interaction);
        return;
    } else if (interaction.isButton() && interaction.customId.startsWith('remind:')) {
        // /remind cancel buttons.
        await client.commands.get('remind')?.handleComponent?.(interaction);
        return;
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith('trade:')) {
        // /trade offer dialog.
        await client.commands.get('trade')?.handleModal?.(interaction);
        return;
    } else if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('trade:')) {
        // /trade panel: confirm / offer / clear / cancel / item picker.
        await client.commands.get('trade')?.handleComponent?.(interaction);
        return;
    } else if (interaction.isButton() && interaction.customId.startsWith('giveaway:reroll:')) {
        // Staff reroll on a finished giveaway announcement.
        await client.commands.get('giveaway')?.handleComponent?.(interaction);
        return;
    } else if (interaction.isButton() && interaction.customId.startsWith('mainhub:')) {
        // /main-hub compact / full view toggle.
        await client.commands.get('main-hub')?.handleComponent?.(interaction);
        return;
    } else if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('ttt:')) {
        // Rated player-vs-player Tic-Tac-Toe ladder (lives inside /games).
        await client.commands.get('games')?.handleComponent?.(interaction);
        return;
    } else if (interaction.isButton() && interaction.customId.startsWith('capsule:claim:')) {
        // Random-drop credit capsule: first click wins, no collector needed.
        const capsuleDrops = require('./systems/economy/capsuleDrops');
        const capsuleId = Number(interaction.customId.split(':')[2]);
        const result = capsuleDrops.claimCapsule(capsuleId, interaction.user.id);
        if (!result.ok) {
            await interaction.reply({ content: `❌ ${result.message}`, flags: 64 }).catch(() => {});
            return;
        }
        await interaction.reply({
            content: `💠 Capsule cracked — **🪙${Number(result.amount).toLocaleString()}** just landed in your wallet!`
        }).catch(() => {});
        try {
            await interaction.message.edit({ components: [] });
        } catch (error) {
            /* the capsule message may already be gone */
        }
        return;
    } else {
        return;
    }

    if (!handler) return;

    // Check if user has admin role for logging
    const isAdmin = isAuditUser(interaction);

    // Commands that should NOT be logged (user-facing economy commands)
    const NON_LOGGABLE_COMMANDS = [
        'balance', 'bank', 'wallet',
        'blackjack', 'fish', 'beg', 'scratchcard', 'lottery', 'sell', 'transfer',
        'work', 'crime', 'rob', 'daily',
        'weekly', 'mine', 'pickaxe', 'shop',
        'inventory', 'main-hub', 'market', 'rank', 'level-leaderboard',
        'ec-stats', 'ec-leaderboard', 'daily-leaderboard', 'profile',
        'prestige', 'ping', 'locations', 'job',
        'invest', 'casino', 'auto-open-boxes',
        'ec-cooldowns', 'open-box', 'item-give'
        , 'mining'
        , 'nextcount', 'count-leaderboard'
        , 'roulette', 'guess-number', 'bomb', 'math', 'mafia', 'spy', 'activities', 'game-night'
        , 'games'
        , 'birthday'
        , 'mining-inventory'
    ];

    let slowNotice = null;
    let settleSlowNotice = null;
    let noticeKeep = false; // set when the notice became a terminal message
    try {
        /* Discord rejects every response after 3 seconds, if the handler must
           at least acknowledge in time. If a command is still silent at 2.5s,
           warn the user IN DISCORD (the console-only warning told nobody),
           then settle that notice based on the outcome:
             • acknowledged in time  -> delete the notice silently
             • acknowledged late     -> delete it, the real response follows
             • expired (10062)       -> edit it to “please run it again”         */
        if (interaction.isChatInputCommand()) {
            settleSlowNotice = async (editText) => {
                try {
                    if (editText) await slowNotice?.edit(editText);
                    else await slowNotice?.delete();
                } catch {
                    /* notice already gone (or never sent) — nothing to do */
                }
            };
            const expiryTimer = setTimeout(() => {
                if (interaction.replied || interaction.deferred) return;
                console.warn(
                    `/${interaction.commandName} from ${interaction.user?.tag ?? interaction.user?.id ?? 'unknown user'} ` +
                    'has not acknowledged after 2.5s — Discord will reject the response (3s limit).'
                );
                // Best-effort user-facing notice. Do NOT await inside a timer;
                // fire and forget so the handler keeps its lead over the 3s wall.
                interaction
                    .channel?.send?.({
                        embeds: [new EmbedBuilder()
                            .setColor(0xffa640)
                            .setTitle('⏳ Command overloaded — please wait')
                            .setDescription(
                                `\`/${interaction.commandName}\` for ${interaction.user} is taking a moment to respond…\n` +
                                `Hang tight — this notice updates itself shortly.`
                            )]
                    })
                    .then(message => {
                        slowNotice = message;
                        // Auto-retract if the command acks right after the
                        // notice was sent but before the handler finished.
                        if (interaction.replied || interaction.deferred) settleSlowNotice();
                    })
                    .catch(() => { /* channel unavailable — notice skipped */ });
            }, 2500);
            try {
                await handler(interaction);
            } finally {
                clearTimeout(expiryTimer);
                // Never leave the “please wait” notice dangling on screen —
                // unless the 10062 path turned it into the final notice.
                setTimeout(() => { if (!noticeKeep) settleSlowNotice(); }, 3000);
            }
        } else {
            await handler(interaction);
        }

        // Log admin command usage (excluding user-facing commands)
        const commandName = interaction.isChatInputCommand()
            ? interaction.commandName.trim().toLowerCase()
            : '';
        const shouldLogCommand = isAdmin &&
            isAdminLogEnabled() &&
            interaction.isChatInputCommand() &&
            !NON_LOGGABLE_COMMANDS.includes(commandName) &&
            commandName !== 'ec-cooldowns' &&
            commandName !== 'auto-open-boxes';

        if (shouldLogCommand) {
            // Skip logging for SMI purchases
            let shouldSkipLog = false;
            if (interaction.commandName === 'shop' &&
                interaction.options.getString('action') === 'buy') {
                const itemInput = interaction.options.getString('item');
                if (itemInput && (itemInput.toLowerCase().includes('smi') || itemInput.toLowerCase().includes('secret money intelligence'))) {
                    shouldSkipLog = true;
                }
            }
            if (interaction.commandName === 'blackjack' &&
                interaction.options.getSubcommand(false) === 'max-bet') {
                shouldSkipLog = true;
            }
            // /casino maxbet sends its own dedicated audit embed to the
            // log channel — skip the generic "command used" entry.
            if (interaction.commandName === 'casino' &&
                interaction.options.getSubcommand(false) === 'maxbet') {
                shouldSkipLog = true;
            }

            if (!shouldSkipLog) {
                const logChannel = interaction.guild.channels.cache.get('1504365033637806134');
                if (logChannel) {
                    const profileName = interaction.member?.displayName ||
                        interaction.user.globalName ||
                        interaction.user.username ||
                        interaction.user.tag;
                    const serverName = interaction.guild.name;
                    const executedAt = new Date().toLocaleString('en-US', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false
                    });
                    const subcommand = interaction.isChatInputCommand()
                        ? interaction.options.getSubcommand(false)
                        : null;
                    const fullCommand = subcommand
                        ? `/${interaction.commandName} ${subcommand}`
                        : `/${interaction.commandName}`;
                    const logFields = [
                        { name: 'Command', value: `\`${fullCommand}\``, inline: true },
                        { name: 'Executed by', value: `${profileName}\n<@${interaction.user.id}>`, inline: true },
                        { name: 'Executed at', value: executedAt, inline: true }
                    ];

                    if (interaction.commandName === 'admin' &&
                        interaction.options.getSubcommand(false) === 'set-balance') {
                        const target = interaction.options.getUser('user');
                        const account = interaction.options.getString('account');
                        const amount = interaction.options.getInteger('amount');
                        logFields.push({
                            name: 'Balance update',
                            value: `Target: <@${target?.id || '0'}>\nAmount set: 🪙${Number(amount || 0).toLocaleString()}\nAccount: ${account === 'wallet' ? 'Wallet' : 'Bank'}`
                        });

                        /* Before/after breakdown across BOTH accounts, with the
                           direction and exact difference of every movement. */
                        const change = interaction.balanceChange;
                        if (change) {
                            const fmtLine = (label, before, after) => {
                                const diff = after - before;
                                const arrow = diff > 0 ? '📈 +' : diff < 0 ? '📉 −' : '➖ ';
                                return `${label}: 🪙${before.toLocaleString()} → 🪙${after.toLocaleString()}\n` +
                                       `　↳ ${arrow}${Math.abs(diff).toLocaleString()}`;
                            };
                            logFields.push({
                                name: 'Balance change details',
                                value: `Target: ${change.targetTag}\n` +
                                       fmtLine('💰 Wallet', change.walletBefore, change.walletAfter) + '\n' +
                                       fmtLine('🏦 Bank', change.bankBefore, change.bankAfter) + '\n' +
                                       `Account modified: ${change.account === 'wallet' ? '💰 Wallet' : '🏦 Bank'}`
                            });
                        }
                    }
                    if (interaction.adminCommandDetails) {
                        logFields.push({ name: 'Action details', value: interaction.adminCommandDetails });
                    }
                    if (interaction.commandName === 'credits-give') {
                        const target = interaction.options.getUser('user');
                        const amount = interaction.options.getInteger('amount');
                        logFields.push({
                            name: 'Credit transfer',
                            value: `Given: 🪙${Number(amount || 0).toLocaleString()}\nRecipient: <@${target?.id || '0'}>`
                        });
                    }
                    if (interaction.commandName === 'set-cooldown' && interaction.cooldownChange) {
                        const formatDuration = durationMs => {
                            if (durationMs === 0) return 'No cooldown';
                            const minutes = durationMs / 60000;
                            return `${minutes.toLocaleString()} minute(s)`;
                        };
                        const change = interaction.cooldownChange;
                        logFields.push({
                            name: 'Cooldown change',
                            value: `Command: \`${change.command}\`\nBefore: **${formatDuration(change.previousDurationMs)}**\nAfter: **${formatDuration(change.newDurationMs)}**`
                        });
                    }

                    await logChannel.send({
                        embeds: [new EmbedBuilder()
                            .setColor(0x00d4ff)
                            .setTitle('🔐 ADMIN ACTION AUDIT')
                            .setDescription(`A privileged command was executed in **${serverName}**.`)
                            .addFields(logFields)
                            .setFooter({ text: 'NEON ECONOMY CORE • Audit ledger' })
                            .setTimestamp()]
                    });
                }
            }
        }
    } catch (err) {
        if (err?.code === 10062) {
            console.warn(
                `Interaction expired (code 10062) — /${interaction.commandName ?? 'unknown'} from ` +
                `${interaction.user?.tag ?? 'unknown user'} took longer than 3s to acknowledge.`
            );
            // A slash command that never got its first reply was void: nothing
            // was paid out or revealed, so any cooldown it stamped mid-flight
            // is a false lockout. Roll it back so the retry works immediately.
            if (interaction.isChatInputCommand() && interaction.user?.id) {
                rollbackExpiredCommand(interaction.commandName, interaction.user.id);
            }
            // The “please wait” notice becomes the failure message.
            noticeKeep = true;
            settleSlowNotice?.({
                    embeds: [new EmbedBuilder()
                        .setColor(0xff5577)
                        .setTitle('❌ Command expired — please run it again')
                        .setDescription(
                            `\`/${interaction.commandName ?? 'command'}\` for ${interaction.user ?? 'you'} did not respond in Discord's 3-second window, so it was cancelled.\n\n` +
                            `⭐ Good news: any cooldown or cost from the failed attempt has been refunded. Please run the command again.\n` +
                            `If this keeps happening, give the bot a minute to catch up before retrying.`
                        )],
                    components: []
                });
            return;
        }
        console.error(err);

        const msg = {
            content: '❌ Command error occurred.'
        };

        if (interaction.replied || interaction.deferred) {
            try {
                await interaction.followUp(msg);
            } catch (responseError) {
                if (responseError.code !== 10062) {
                    console.error('Failed to send command error response:', responseError);
                }
            }
        } else {
            try {
                await interaction.reply(msg);
            } catch (responseError) {
                if (responseError.code !== 10062) {
                    console.error('Failed to send command error response:', responseError);
                }
            }
        }
    }
});

if (!process.env.BOT_TOKEN) {
    console.warn('Bot startup skipped: BOT_TOKEN is not configured.');
} else {
    console.log('Connecting to Discord...');

    /* Network diagnostics — discord.com (HTTPS REST) and gateway.discord.gg
       (WebSocket) are different hosts; a hosting network can allow one and
       block the other, so both are probed explicitly. */
    let restOk = null;
    let gatewayWsOk = null;

    const probeRest = async () => {
        try {
            const res = await fetch('https://discord.com/api/v10/users/@me', {
                headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` },
                signal: AbortSignal.timeout(10000)
            });
            if (res.status === 401) {
                console.error('FATAL: BOT_TOKEN is invalid (Discord API returned 401). Fix the token and restart.');
                process.exit(1);
            }
            const body = await res.json().catch(() => ({}));
            restOk = true;
            console.log(`REST probe OK: discord.com reachable (HTTP ${res.status}${body.username ? `, bot: ${body.username}` : ''}).`);
        } catch (err) {
            restOk = false;
            const reason = err?.cause?.code || err?.name || 'unknown';
            console.error(`REST probe FAILED (${reason}): this machine cannot reach discord.com over HTTPS.`);
            console.error('>>> Outbound egress is blocked — contact the host to allow TCP 443 to discord.com. Nothing in the code can fix this.');
        }
    };

    const probeGatewayWs = async () => {
        const { WebSocket } = require('ws');
        await new Promise(resolve => {
            let settled = false;
            let ws;
            const finish = () => {
                if (settled) return;
                settled = true;
                try { ws.close(); } catch {}
                clearTimeout(failTimer);
                resolve();
            };
            const failTimer = setTimeout(() => {
                gatewayWsOk = false;
                console.error('Gateway probe TIMED OUT (10s): wss://gateway.discord.gg did not accept a connection.');
                finish();
            }, 10000);
            ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
            ws.once('open', () => {
                gatewayWsOk = true;
                console.log('Gateway probe OK: wss://gateway.discord.gg connection established.');
                finish();
            });
            ws.once('error', err => {
                gatewayWsOk = false;
                console.error(`Gateway probe FAILED (${err?.message || 'unknown'}): WebSocket to gateway.discord.gg cannot connect.`);
                console.error('>>> HTTPS works but the Discord gateway WebSocket is blocked or filtered — exactly why the bot cannot come online. Contact the host.');
                finish();
            });
        });
    };

    // Probe BEFORE login so results are known when the 30s watchdog fires.
    (async () => {
    await probeRest();
    await probeGatewayWs();

    client.login(process.env.BOT_TOKEN).catch(err => {
        // Fatal login failures must exit so the panel restarts the container —
        // a swallowed rejection leaves a zombie process that never comes online.
        if (err?.code === 'TokenInvalid') {
            console.error('FATAL: BOT_TOKEN is invalid. Fix the token and restart.');
            process.exit(1);
        }
        if (String(err?.message || '').includes('disallowed intents')) {
            console.error('FATAL: disallowed gateway intents — enable them in the Discord Developer Portal.');
            process.exit(1);
        }
        console.error('Login failed:', err);
    });

    // Slow-connect watchdog — explains WHERE the handshake is stuck.
    // (probeRest/probeGatewayWs already ran, so these verdicts are exact.)
    setTimeout(() => {
        if (client.isReady()) return;
        if (gatewayWsOk === true) {
            console.error('Not READY after 30s: REST and the gateway WebSocket both connect, but the session never completes.');
            console.error('>>> Watch for Discord close codes: 4004 bad token, 4013/4014 disabled or disallowed intents. Otherwise the host IP is likely being rate-limited by Discord.');
        } else if (gatewayWsOk === false) {
            console.error('Not READY after 30s: the gateway WebSocket is unreachable — this host blocks wss://gateway.discord.gg.');
            console.error('>>> Ask the host to allow WebSocket egress to gateway.discord.gg (TCP 443). Hosting/network issue, not a code issue.');
        } else {
            console.error('Not READY after 30s: gateway probe never finished — outbound connections are heavily throttled.');
        }
        if (restOk === false) {
            console.error('Note: even plain HTTPS to discord.com failed — egress is broadly blocked on this machine.');
        }
    }, 30000).unref();
    setTimeout(() => {
        if (!client.isReady()) console.warn('Still not READY after 90s — bot keeps retrying; check host egress to discord.com and gateway.discord.gg.');
    }, 90000).unref();
    })();
}
