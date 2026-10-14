const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { getColor, formatTitle, formatDescription, isHighTech } = require('../systems/economy/uiStyleHelper');

/*
 * /birthday [user]  — check anyone's registered birthday.
 * /birthday set     — register your own (absorbs the old /set-birthday).
 *
 * The scheduler announces birthdays in the birthday channel and grants the
 * birthday role for the day.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

function formatBirthday(row) {
    if (!row) return null;
    // Stored as YYYY-MM-DD; only month/day are meaningful.
    const [, month, day] = row.birthday.split('-').map(Number);
    const nice = `${MONTHS[month - 1]} ${day}`;
    return { nice, year: row.year };
}

function daysUntilThisYear(month, day) {
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let target = Date.UTC(now.getUTCFullYear(), month - 1, day);
    if (target < todayUtc) target = Date.UTC(now.getUTCFullYear() + 1, month - 1, day);
    return Math.round((target - todayUtc) / 86400000);
}

function parseBirthdayInput(input) {
    const match = input.trim().match(/^(\d{1,2})[/\-](\d{1,2})(?:[/\-](\d{4}))?$/);
    if (!match) return { error: '❌ Invalid format. Use **MM/DD** or **MM/DD/YYYY** — e.g. `07/14` or `07/14/2008`.' };

    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);
    const year = match[3] ? parseInt(match[3], 10) : null;
    const thisYear = new Date().getUTCFullYear();

    if (month < 1 || month > 12) return { error: '❌ Month must be 1–12.' };
    const daysInMonth = new Date(Date.UTC(thisYear, month, 0)).getUTCDate();
    if (day < 1 || day > daysInMonth) return { error: `❌ ${month}/${day} is not a real date.` };
    if (year && (year < 1900 || year > thisYear)) {
        return { error: `❌ Year must be between 1900 and ${thisYear}.` };
    }
    return { month, day, year };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('birthday')
        .setDescription("Check someone's registered birthday — or set your own")
        .addStringOption(option => option
            .setName('action')
            .setDescription('Check a birthday, or set your own (default: check)')
            .addChoices(
                { name: 'Check a registered birthday', value: 'check' },
                { name: 'Set your birthday', value: 'set' }
            ))
        .addUserOption(option => option
            .setName('user')
            .setDescription('Whose birthday to check (default: you)')
            .setRequired(false))
        .addStringOption(option => option
            .setName('date')
            .setDescription('Your birthday — MM/DD or MM/DD/YYYY (for action:set)')
            .setRequired(false))
        .addStringOption(option => option
            .setName('note')
            .setDescription('Optional note shown on your birthday announcement (e.g. gift ideas, timezone)')
            .setRequired(false)
            .setMaxLength(150)),

    async execute(interaction) {
        const sub = interaction.options.getString('action') ?? 'check';
        if (sub === 'set') {
            const dateInput = interaction.options.getString('date');
            if (!dateInput) {
                return interaction.reply({ content: '❌ Setting your birthday needs a `date` — e.g. `07/14` or `07/14/2008`.', ephemeral: true });
            }
            const parsed = parseBirthdayInput(dateInput);
            if (parsed.error) return interaction.reply({ content: parsed.error, ephemeral: true });

            const { month, day, year } = parsed;
            const note = interaction.options.getString('note')?.trim() || null;
            const stored = `${new Date().getUTCFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            db.prepare(`
                INSERT INTO birthdays (userId, birthday, year, setAt, note)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(userId) DO UPDATE SET
                    birthday = excluded.birthday,
                    year = excluded.year,
                    setAt = excluded.setAt,
                    note = COALESCE(excluded.note, birthdays.note)
            `).run(interaction.user.id, stored, year, new Date().toISOString(), note);

            const embed = new EmbedBuilder()
                .setColor(getColor(interaction.user.id))
                .setTitle(formatTitle(interaction.user.id, '🎂 BIRTHDAY REGISTERED', 'Birthday Set'))
                .setDescription(formatDescription(interaction.user.id,
                    [
                        `Your birthday is set to **${month}/${day}${year ? `/${year}` : ''}**.`,
                        '',
                        'On the day, the server announces it in the birthday channel and you get the birthday role for 24 hours. 🎉',
                        note ? `📝 Your note: _${note}_` : null
                    ].filter(Boolean).join('\n'),
                    [
                        `Birthday set: ${month}/${day}${year ? `/${year}` : ''}`,
                        'You will be announced and get the birthday role on the day.'
                    ].join('\n')));
            return interaction.reply({ embeds: [embed] });
        }

        const target = interaction.options.getUser('user') ?? interaction.user;
        const row = db.prepare('SELECT birthday, year, note FROM birthdays WHERE userId = ?').get(target.id);
        const useHighTech = isHighTech(interaction.user.id);

        if (!row) {
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0xffa726)
                    .setTitle('🎂 No Birthday On File')
                    .setDescription(target.id === interaction.user.id
                        ? 'You have not set your birthday yet — use **/birthday set date:MM/DD** so the server can celebrate you!'
                        : `**${target.username}** has not registered a birthday.`)]
            });
        }

        const info = formatBirthday(row);
        const month = Number(row.birthday.split('-')[1]);
        const day = Number(row.birthday.split('-')[2]);
        const days = daysUntilThisYear(month, day);
        const when = days === 0
            ? "🎉 **IT'S TODAY!**"
            : `in **${days} day${days === 1 ? '' : 's'}**`;

        const embed = new EmbedBuilder()
            .setColor(getColor(interaction.user.id))
            .setTitle(formatTitle(useHighTech ? '🎂 BIRTHDAY RECORD LOCATED' : '🎂 Birthday', 'Birthday'))
            .setDescription(formatDescription(interaction.user.id,
                [
                    `**${target.username}**'s birthday: **${info.nice}**${info.year ? ` (${info.year})` : ''}`,
                    `Next celebration: ${when}`,
                    row.note ? `📝 Note: _${row.note}_` : null
                ].filter(Boolean).join('\n'),
                [
                    `**${target.username}**'s birthday: ${info.nice}${info.year ? ` (${info.year})` : ''}`,
                    `Next celebration: ${when}`,
                    row.note ? `Note: ${row.note}` : null
                ].filter(Boolean).join('\n')));

        return interaction.reply({ embeds: [embed] });
    }
};
