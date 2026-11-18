const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { parseTimeInput, format12, format24, formatBoth, offsetLabel } = require('../systems/util/timeFormat');

/*
 * /time-at target:@user time:3:30pm [clock:you|them]
 *
 * Converts a typed time between two saved timezones. `clock` says WHOSE clock
 * the typed time belongs to, so both directions work:
 *   clock:you  (default) → "3:30pm my time is what time for them?"
 *   clock:them           → "3:30pm their time is what time for me?"
 * The time accepts 12-hour ("3:30 pm", "3pm") or 24-hour ("15:30") input, and
 * every result is printed BOTH ways because people read different clocks.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('time-at')
        .setDescription('Convert a time between your timezone and another user\'s.')
        .addUserOption(option => option
            .setName('target')
            .setDescription('The other user')
            .setRequired(true))
        .addStringOption(option => option
            .setName('time')
            .setDescription('The time to convert — "3:30pm", "15:30", "3 pm"')
            .setRequired(true))
        .addStringOption(option => option
            .setName('clock')
            .setDescription('Whose clock is that time on? Defaults to yours.')
            .addChoices(
                { name: 'Mine — show it in their timezone', value: 'you' },
                { name: 'Theirs — show it in my timezone', value: 'them' }
            )),

    async execute(interaction) {
        const input = interaction.options.getString('time', true);
        const minutes = parseTimeInput(input);
        if (minutes === null) {
            return interaction.reply({
                content: '❌ That is not a time I can read. Try **3:30pm**, **15:30** or **3 pm**.',
                flags: 64
            });
        }

        const target = interaction.options.getUser('target', true);
        const clock = interaction.options.getString('clock') || 'you';

        const sourceRow = db.prepare('SELECT timezone FROM users WHERE userId = ?').get(interaction.user.id);
        const targetRow = db.prepare('SELECT timezone FROM users WHERE userId = ?').get(target.id);
        if (!sourceRow?.timezone || !targetRow?.timezone) {
            return interaction.reply({
                content: '❌ Both users must set a timezone with `/set-sleep` first.'
            });
        }

        const ownerOffset = Number(sourceRow.timezone);
        const targetOffset = Number(targetRow.timezone);

        // `clock` picks which end of the conversion the typed time belongs to.
        const typedOnOwnerClock = clock !== 'them';
        const typedOffset = typedOnOwnerClock ? ownerOffset : targetOffset;
        const outputOffset = typedOnOwnerClock ? targetOffset : ownerOffset;
        const typedUser = typedOnOwnerClock ? interaction.user : target;
        const outputUser = typedOnOwnerClock ? target : interaction.user;
        const outputName = typedOnOwnerClock ? `<@${target.id}>` : 'you';

        // Unclamped shift first, so a day rollover can be reported rather than
        // silently wrapped away by the modulo.
        const shifted = minutes + (outputOffset - typedOffset) * 60;
        const dayShift = Math.floor(shifted / 1440);
        const converted = ((shifted % 1440) + 1440) % 1440;

        const dayNote = dayShift > 0
            ? ` _(the next day)_`
            : dayShift < 0
                ? ` _(the previous day)_`
                : '';

        const scheduleRow = db.prepare('SELECT wakeTime, sleepTime FROM users WHERE userId = ?').get(target.id);
        const targetSchedule = [];
        if (scheduleRow?.wakeTime) {
            const wake = parseTimeInput(scheduleRow.wakeTime);
            if (wake !== null) targetSchedule.push(`🌅 Wakes **${formatBoth(wake)}**`);
        }
        if (scheduleRow?.sleepTime) {
            const sleep = parseTimeInput(scheduleRow.sleepTime);
            if (sleep !== null) targetSchedule.push(`🌙 Sleeps **${formatBoth(sleep)}**`);
        }

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x00d4ff)
                    .setTitle('🕐 Time Conversion')
                    .setDescription([
                        `**${formatBoth(minutes)}** on ${typedUser === interaction.user ? 'your' : `${target}'s`} clock` +
                            ` · ${offsetLabel(typedOffset)}`,
                        '',
                        `➜ **${formatBoth(converted)}** for ${outputName}${dayNote} · ${offsetLabel(outputOffset)}`,
                        '',
                        `_24-hour: ${format24(minutes)} → ${format24(converted)} · 12-hour: ${format12(minutes)} → ${format12(converted)}_`
                    ].join('\n'))
                    .addFields(...(targetSchedule.length
                        ? [{ name: `${target.displayName || target.username}'s schedule`, value: targetSchedule.join('\n') }]
                        : []))
                    .setFooter({ text: '🕐 Times are shown 12-hour and 24-hour' })
                    .setTimestamp()
            ]
        });
    }
};
