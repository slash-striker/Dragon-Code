/*
 * /remind — delayed personal alerts.
 *
 * The data layer (systems/economy/reminders.js) writes the row; the economy
 * scheduler polls it every minute and DMs the owner when it comes due, then
 * marks it delivered. This command is only the interface: schedule, list and
 * cancel.
 *
 * Everything here replies ephemerally — reminders are private, and nobody else
 * needs to see a player's to-do list.
 */
const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const reminders = require('../systems/economy/reminders');

const PREFIX = 'remind:';
const COLOR = 0x00d4ff;

function parseId(customId) {
    return String(customId).split(':').slice(1);
}

function buildList(userId) {
    const pending = reminders.listPending(userId);
    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('⏰ YOUR REMINDERS')
        .setDescription(pending.length
            ? pending.map(reminder => [
                `**#${reminder.reminderId}** — <t:${Math.floor(Number(reminder.dueAt) / 1000)}:R>`,
                `> ${String(reminder.message).slice(0, 200)}`
            ].join('\n')).join('\n\n')
            : [
                'You have no reminders waiting.',
                '',
                'Set one with **/remind time:** and **message:** — for example',
                '**/remind time:2h message:claim the contract**',
                '',
                'Durations accept 45m, 2h, 1d or 2h30m. The shortest is 1 minute and the longest is 30 days.'
            ].join('\n'))
        .setFooter({ text: `Pending: ${pending.length}/${reminders.MAX_PENDING} · the bot DMs you when one fires` });

    const components = [];
    if (pending.length) {
        const row = new ActionRowBuilder();
        for (const reminder of pending.slice(0, 5)) {
            row.addComponents(new ButtonBuilder()
                .setCustomId(`${PREFIX}cancel:${reminder.reminderId}`)
                .setLabel(`Cancel #${reminder.reminderId}`)
                .setEmoji('🗑️')
                .setStyle(ButtonStyle.Danger));
        }
        components.push(row);
    }
    return { embeds: [embed], components };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('remind')
        .setDescription('Get a private DM reminder later — e.g. remind me in 2h to claim the contract')
        .addStringOption(option => option
            .setName('time')
            .setDescription('How far ahead — 45m, 2h, 1d, 2h30m (a bare number is minutes)'))
        .addStringOption(option => option
            .setName('message')
            .setDescription('What to remind you about')
            .setMaxLength(400))
        .addStringOption(option => option
            .setName('action')
            .setDescription('Set a reminder, list yours, or cancel one')
            .addChoices(
                { name: 'Set — schedule a new reminder', value: 'set' },
                { name: 'List — show what is pending', value: 'list' },
                { name: 'Cancel — remove one by id', value: 'cancel' }
            ))
        .addIntegerOption(option => option
            .setName('id')
            .setDescription('Reminder id to cancel (see action:list)')
            .setMinValue(1)),

    async execute(interaction) {
        await interaction.deferReply({ flags: 64 });

        const action = interaction.options.getString('action') ?? 'set';
        const userId = interaction.user.id;

        if (action === 'list') {
            return interaction.editReply(buildList(userId));
        }

        if (action === 'cancel') {
            const reminderId = interaction.options.getInteger('id');
            if (!reminderId) {
                const body = buildList(userId);
                body.embeds[0].setDescription(`Give me the id to cancel — check **action:list**.\n\n${body.embeds[0].data.description}`);
                return interaction.editReply(body);
            }
            const result = reminders.cancelReminder(userId, reminderId);
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(result.ok ? 0x57f287 : 0xff5577)
                    .setTitle(result.ok ? '🗑️ REMINDER CANCELLED' : '⚠️ COULD NOT CANCEL')
                    .setDescription(result.message)]
            });
        }

        // ---- action: set ----
        const time = interaction.options.getString('time');
        const message = interaction.options.getString('message');

        if (!time || !message) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(0xffa640)
                    .setTitle('⏰ REMIND ME WHEN?')
                    .setDescription([
                        'I need both a delay and a message.',
                        '',
                        '**/remind time:2h message:claim the guild contract**',
                        '',
                        'Durations: 45m · 2h · 1d · 2h30m (a bare number counts as minutes).'
                    ].join('\n'))]
            });
        }

        const parsed = reminders.parseDuration(time);
        if (!parsed.ok) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(0xff5577)
                    .setTitle('⚠️ I COULD NOT READ THAT DELAY')
                    .setDescription(parsed.message)]
            });
        }

        const created = reminders.createReminder({
            userId,
            channelId: interaction.channelId,
            message,
            dueInMs: parsed.ms
        });

        if (!created.ok) {
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(0xff5577)
                    .setTitle('⚠️ REMINDER NOT SET')
                    .setDescription(created.message)]
            });
        }

        const reminder = created.reminder;
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(0x57f287)
                .setTitle('⏰ REMINDER SET')
                .setDescription([
                    `**${reminder.message}**`,
                    '',
                    `Fires <t:${Math.floor(Number(reminder.dueAt) / 1000)}:R> — that is **${parsed.label}** from now.`,
                    '',
                    `Reminder id **#${reminder.reminderId}**. The bot DMs you when it fires, so keep your DMs open for this server.`,
                    created.message ? `\n_${created.message}_` : null
                ].filter(Boolean).join('\n'))
                .setFooter({ text: `Pending: ${reminders.countPending(userId)}/${reminders.MAX_PENDING} · cancel with /remind action:cancel` })
                .setTimestamp()]
        });
    },

    // ---------------------------------------------------------------
    // Component router — index.js routes every `remind:` id here.
    // ---------------------------------------------------------------
    async handleComponent(interaction) {
        const pieces = parseId(interaction.customId);
        const action = pieces[0];
        const reminderId = Number(pieces[1]);

        if (action !== 'cancel' || !Number.isInteger(reminderId)) {
            return interaction.reply({ content: '❌ That reminder button is no longer valid — run /remind action:list.', flags: 64 });
        }

        // The row may belong to a public message, but the list is private: if a
        // stale button is clicked we can still answer ephemerally because the
        // message itself was ephemeral.
        const result = reminders.cancelReminder(interaction.user.id, reminderId);
        const body = buildList(interaction.user.id);
        body.embeds[0]
            .setColor(result.ok ? 0x57f287 : 0xff5577)
            .setDescription(`${result.ok ? '🗑️' : '⚠️'} ${result.message}\n\n${body.embeds[0].data.description}`);

        if (interaction.deferred || interaction.replied) return interaction.editReply(body);
        return interaction.update(body);
    }
};
