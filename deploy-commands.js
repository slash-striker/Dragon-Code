require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

const commands = [];
const commandSources = new Map();
const commandsPath = path.join(__dirname, 'commands');

/*
 * Discord caps applications at 100 slash commands (code 30032). These files
 * still load (their engines/flows are reachable through other commands) but
 * no longer get their own slash slot:
 *  - set-birthday/reset-inv/ec-reset/miningguide merged into
 *    /birthday, /reset, and /mining action:help
 *  - bomb/math/mafia/spy merged into /activities (party-game hub;
 *    /qotd was renamed to /activities)
 *  - 5dice/hangman/highlow/lightsout/mastermind/matchpairs/rps/tictactoe
 *    merged into /games (minigame hub) — the files stay as engines and are
 *    invoked through commands/games.js
 * This set MUST match HIDDEN_COMMAND_FILES in index.js.
 * Remove a name from this list to give it its own command again.
 */
const HIDDEN_COMMAND_FILES = new Set([
    'set-birthday.js', 'reset-inv.js', 'ec-reset.js', 'miningguide.js',
    'bomb.js', 'math.js', 'mafia.js', 'spy.js',
    '5dice.js', 'hangman.js', 'highlow.js', 'lightsout.js',
    'mastermind.js', 'matchpairs.js', 'rps.js', 'tictactoe.js',
    'casino-admin.js'
]);

for (const file of fs.readdirSync(commandsPath)) {
    if (!file.endsWith('.js') || HIDDEN_COMMAND_FILES.has(file)) continue;

    const command = require(`./commands/${file}`);

    // ONLY include slash commands that actually have "data"
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

    // handle both possible formats safely
    if (typeof command.data.toJSON === 'function') {
        commands.push(command.data.toJSON());
    } else {
        commands.push(command.data);
    }
    commandSources.set(commandName, file);
}

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
const deploymentRoute = process.env.GUILD_ID
    ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
    : Routes.applicationCommands(process.env.CLIENT_ID);

(async () => {
    try {
        console.log('🚀 Deploying slash commands...');

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
            console.log(`🧹 Removed ${globalCommands.length} global commands.`);
        }

        await rest.put(
            deploymentRoute,
            { body: commands }
        );

        console.log(`✅ Deployed ${commands.length} commands${process.env.GUILD_ID ? ` to guild ${process.env.GUILD_ID}` : ' globally'}`);
    } catch (err) {
        console.error(err);
    }
})();