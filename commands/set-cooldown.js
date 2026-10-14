const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { setCooldownDuration, getCooldownDuration } = require('../systems/economy/cooldownManager');

// Admin role config lives in systems/admin/adminVisibility.js (DB-backed).

const COMMANDS = [
    ['work', '💼 Work'], ['fish', '🎣 Fish'], ['mine', '⛏️ Mine (base — tiers shift too)'],
    ['crime', '🔪 Crime'],
    ['beg', '🙏 Beg'], ['rob_player', '🔫 Rob'], ['rob_bank', '🏦 Bank Robbery'],
    ['scratchcard', '🎫 Scratchcard'], ['games', '🎮 Games (All)'],
    ['fivedice', '🎲 Five Dice'],
    ['blackjack', '🃏 Blackjack'], ['matchpairs', '🧩 Match Pairs'],
    ['lightsout', '💡 Lights Out'], ['mastermind', '🧠 Mastermind'],
    ['hangman', '☠️ Hangman'], ['highlow', '📈 High/Low'],
    ['rps', '✂️ Rock Paper Scissors'], ['tictactoe', '⭕ Tic-Tac-Toe']
];

const PING_COMMANDS = [
    ['ping:staff', '📢 Staff Ping (/staff)'], ['ping:game-pings', '🎮 Game Ping (/game-pings)']
];

const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

function isAdmin(interaction) {
    return isAdminUser(interaction);
}

const ALL_CHOICES = [...COMMANDS, ...PING_COMMANDS];

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('set-cooldown')
        .setDescription('[ADMIN ONLY] Configure an economy command cooldown')
        .addStringOption(option => option
            .setName('command')
            .setDescription('Command to configure')
            .setRequired(true)
            .addChoices(...ALL_CHOICES.map(([value, name]) => ({ name, value }))))
        .addIntegerOption(option => option
            .setName('minutes')
            .setDescription('Duration in minutes; 0 disables the cooldown')
            .setMinValue(0)
            .setMaxValue(10080)
            .setRequired(true)),

    async execute(interaction) {
        if (!isAdmin(interaction)) {
            return interaction.reply({ content: '❌ Administrator access required.' });
        }

        const command = interaction.options.getString('command', true);
        const minutes = interaction.options.getInteger('minutes', true);
        const durationMs = minutes * 60 * 1000;

        // ---- Ping cooldowns (/staff, /game-pings) ---------------------------
        if (command.startsWith('ping:')) {
            const pingCommand = command.slice(5);
            const db = require('../database');
            const previousRow = db.prepare(
                'SELECT durationMs FROM cooldown_settings WHERE command = ?'
            ).get(command);
            const previousDurationMs = previousRow ? Number(previousRow.durationMs) : null;
            // Raw upsert — ping:* keys are not economy COOLDOWNS keys.
            db.prepare(`
                INSERT INTO cooldown_settings (command, durationMs) VALUES (?, ?)
                ON CONFLICT(command) DO UPDATE SET durationMs = excluded.durationMs
            `).run(command, durationMs); // pingCooldowns reads the pin live

            // Setting a cooldown RESETS it for everyone — old stamps are
            // cleared no matter which way the window moved.
            db.prepare('DELETE FROM ping_cooldowns WHERE commandName = ?').run(pingCommand);

            interaction.cooldownChange = {
                command,
                previousDurationMs,
                newDurationMs: durationMs
            };
            const label = PING_COMMANDS.find(([value]) => value === command)?.[1] || command;
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0x00d4ff)
                    .setTitle('⚙️ Cooldown Updated')
                    .setDescription(`${label}\n\nNew duration: **${minutes === 0 ? 'No cooldown' : `${minutes} minute(s)`}**\n♻️ All active cooldowns for this ping were reset.`)
                    .setFooter({ text: `Changed by ${interaction.user.tag}` })
                    .setTimestamp()]
            });
        }

        // ---- /mine pinned base ----------------------------------------------
        if (command === 'mine') {
            const db = require('../database');
            const previousRow = db.prepare(
                'SELECT durationMs FROM cooldown_settings WHERE command = ?'
            ).get('mine_base');
            const previousDurationMs = previousRow ? Number(previousRow.durationMs) : null;
            if (minutes === 0) {
                // Reset: drop the pin so the MINE_TIERS ladder applies again.
                db.prepare('DELETE FROM cooldown_settings WHERE command = ?').run('mine_base');
            } else {
                // Raw upsert — mine_base is not an economy COOLDOWNS key.
                db.prepare(`
                    INSERT INTO cooldown_settings (command, durationMs) VALUES (?, ?)
                    ON CONFLICT(command) DO UPDATE SET durationMs = excluded.durationMs
                `).run('mine_base', durationMs);
            }
            // Changing the mine cadence RESETS everyone's active mine wait —
            // the new base applies to the very next run, not in 3 hours.
            db.prepare('UPDATE mining_profile SET mineCooldown = 0').run();

            interaction.cooldownChange = {
                command,
                previousDurationMs,
                newDurationMs: minutes === 0 ? null : durationMs
            };

            const fmtMin = m => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);
            const tier0Base = minutes === 0
                ? 'the built-in ladder (3h → 3h15m → 3h30m → 3h45m → 4h by lifetime mines)'
                : `${fmtMin(minutes)} at tier 0 — climbs ${fmtMin(minutes + 15)} → ${fmtMin(minutes + 30)} … as lifetime mines cross each tier (+15 min/tier)`;
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0x00d4ff)
                    .setTitle('⚙️ Mine Cooldown Updated')
                    .setDescription(`⛏️ Mine\n\nNew base: **${tier0Base}**\nBoosts and drills still cut the final cooldown.\n♻️ Every miner's active cooldown was reset.`)
                    .setFooter({ text: `Changed by ${interaction.user.tag}` })
                    .setTimestamp()]
            });
        }

        // ---- Standard economy cooldowns --------------------------------------
        const previousDurationMs = getCooldownDuration(command);
        setCooldownDuration(command, durationMs);
        interaction.cooldownChange = {
            command,
            previousDurationMs,
            newDurationMs: durationMs
        };

        // Existing rows use the command key; clearing them makes changes
        // immediate — for EVERYONE. Setting a cooldown resets that command's
        // active cooldowns server-wide (matches the ping-window behaviour).
        const db = require('../database');
        db.prepare('DELETE FROM command_cooldowns WHERE command = ?').run(command);

        const label = COMMANDS.find(([value]) => value === command)?.[1] || command;
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor(0x00d4ff)
                .setTitle('⚙️ Cooldown Updated')
                .setDescription(`${label}\n\nNew duration: **${minutes === 0 ? 'No cooldown' : `${minutes} minute(s)`}**\n♻️ All active cooldowns for this command were reset for everyone.`)
                .setFooter({ text: `Changed by ${interaction.user.tag}` })
                .setTimestamp()]
        });
    }
};
