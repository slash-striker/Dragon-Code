const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const {
    parseTimeInput, formatBoth, localMinutes, offsetLabel
} = require('../systems/util/timeFormat');
const { TIMEZONE_INFO } = require('./set-sleep');

const COLOR = 0x00d4ff;

/* "6h ahead of you" / "3h behind you" / "the same as yours". */
function deltaLabel(hours) {
    if (!hours) return 'the same as yours';
    const size = Math.abs(hours);
    return `${size}h ${hours > 0 ? 'ahead of' : 'behind'} you`;
}

/* Shift a clock reading by whole hours (crossing midnight wraps). */
function shiftHours(minutes, hours) {
    return (((minutes + hours * 60) % 1440) + 1440) % 1440;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('see-users-time')
        .setDescription('View a user timezone, current time and sleep schedule.')
        .addUserOption(option => option
            .setName('user')
            .setDescription('User to check')
            .setRequired(true)),
    async execute(interaction) {
        const target = interaction.options.getUser('user', true);
        const row = db.prepare('SELECT timezone, wakeTime, sleepTime FROM users WHERE userId = ?').get(target.id);
        if (!row?.timezone) {
            return interaction.reply({
                content: `${target.username} has not set a sleep schedule yet.`
            });
        }

        const offset = Number(row.timezone);
        const mine = db.prepare('SELECT timezone FROM users WHERE userId = ?').get(interaction.user.id);
        const myOffset = mine?.timezone === null || mine?.timezone === undefined ? null : Number(mine.timezone);
        const now = localMinutes(offset);
        const areas = TIMEZONE_INFO[String(offset)]?.areas ?? 'International';
        const schedule = (value) => {
            const minutes = parseTimeInput(value);
            return minutes === null ? 'Not set' : formatBoth(minutes);
        };

        const fields = [
            { name: `🌍 ${target.username}'s zone`, value: `${offsetLabel(offset)}\n_${areas}_`, inline: true },
            { name: '🕐 Their time now', value: `**${formatBoth(now)}**`, inline: true },
            { name: '\u200b', value: '\u200b', inline: true }
        ];

        if (myOffset === null || Number.isNaN(myOffset)) {
            fields.push(
                { name: '👤 Your timezone', value: 'Not set — run `/set-sleep` to compare clocks side by side.', inline: false }
            );
        } else {
            const delta = offset - myOffset;
            fields.push(
                { name: '👤 Your time now', value: `${formatBoth(localMinutes(myOffset))}\n_${offsetLabel(myOffset)}_`, inline: true },
                { name: '🔁 Their clock, your time', value: `**${formatBoth(shiftHours(now, -delta))}**\n_${deltaLabel(delta)}_`, inline: true },
                { name: '\u200b', value: '\u200b', inline: true }
            );
        }

        const wakeMinutes = parseTimeInput(row.wakeTime);
        const sleepMinutes = parseTimeInput(row.sleepTime);
        const withMine = minutes => {
            if (minutes === null) return 'Not set';
            if (myOffset === null || Number.isNaN(myOffset)) return formatBoth(minutes);
            return `${formatBoth(minutes)}\n_${formatBoth(shiftHours(minutes, myOffset - offset))} your time_`;
        };

        fields.push(
            { name: '🌅 Wake time', value: withMine(wakeMinutes), inline: true },
            { name: '🌙 Sleep time', value: withMine(sleepMinutes), inline: true }
        );

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(COLOR)
                    .setTitle(`🕐 ${target.username}'s Clock`)
                    .setThumbnail(target.displayAvatarURL({ extension: 'png', size: 128 }))
                    .addFields(fields)
                    .setFooter({
                        text: myOffset === null || Number.isNaN(myOffset)
                            ? 'Every time is shown 12-hour and 24-hour'
                            : `Every time is shown 12-hour and 24-hour · your clock ${offsetLabel(myOffset)}`
                    })
                    .setTimestamp()
            ]
        });
    }
};
