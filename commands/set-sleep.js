const {
    ActionRowBuilder,
    ComponentType,
    ModalBuilder,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const db = require('../database');

// Labels include reference cities so UTC± signs can't be misread — the
// classic failure is Eastern Time users picking UTC+5 instead of UTC-5.
const TIMEZONE_LABELS = {
    '-12': 'Baker Island', '-11': 'American Samoa', '-10': 'Hawaii',
    '-9': 'Alaska', '-8': 'Los Angeles (Pacific)', '-7': 'Denver (Mountain)',
    '-6': 'Mexico City (Central)', '-5': 'New York, Toronto (Eastern)',
    '-4': 'Santiago, Halifax', '-3': 'São Paulo, Buenos Aires',
    '-2': 'South Georgia', '-1': 'Azores', '0': 'London, Lisbon (GMT)',
    '1': 'Berlin, Paris (Central Europe)', '2': 'Cairo, Athens',
    '3': 'Moscow, Istanbul', '4': 'Dubai', '5': 'Karachi', '6': 'Dhaka',
    '7': 'Bangkok, Jakarta', '8': 'Singapore, Beijing',
    '9': 'Tokyo, Seoul', '10': 'Sydney, Guam', '11': 'Solomon Islands',
    '12': 'Auckland (NZ)'
};

const TIMEZONES = Array.from({ length: 25 }, (_, index) => {
    const offset = index - 12;
    const key = String(offset);
    const city = TIMEZONE_LABELS[key] ? ` — ${TIMEZONE_LABELS[key]}` : '';
    return {
        label: `UTC${offset >= 0 ? '+' : ''}${offset}${city}`.slice(0, 100),
        value: String(offset)
    };
});

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set-sleep')
        .setDescription('Set your timezone and sleep schedule.'),
    async execute(interaction) {
        const menu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('sleep:timezone')
                .setPlaceholder('Select your timezone')
                .addOptions(TIMEZONES)
        );
        const message = await interaction.reply({
            content: '**Select your timezone** — pick the offset you are in RIGHT NOW.\n' +
                '> 💡 Daylight saving matters: Eastern Time is **UTC-5 in winter**, **UTC-4 in summer**. If the sign is wrong, the bot will think you are asleep at the wrong hours.',
            components: [menu],
            fetchReply: true
        });
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.StringSelect,
            time: 60000,
            filter: component => component.user.id === interaction.user.id
        });
        collector.on('collect', async component => {
            interaction.client.tempSleepData ??= {};
            interaction.client.tempSleepData[interaction.user.id] = {
                timezone: component.values[0]
            };
            const modal = new ModalBuilder()
                .setCustomId('sleep:schedule')
                .setTitle('Sleep Schedule')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('wakeTime')
                            .setLabel('Wake time (HH:MM)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setMaxLength(5)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('sleepTime')
                            .setLabel('Sleep time (HH:MM)')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setMaxLength(5)
                    )
                );
            await component.showModal(modal);
            collector.stop();
        });
    }
};
