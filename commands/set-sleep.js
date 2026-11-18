const {
    ActionRowBuilder,
    ComponentType,
    ModalBuilder,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const { localMinutes, format12, offsetLabel } = require('../systems/util/timeFormat');

/*
 * Every offset carries two pieces of help, because "which UTC am I?" is the
 * question most people get wrong:
 *   places — the reference city in the label, next to the LIVE local time there
 *   areas  — the countries/states in that offset, in the option description
 * The time is computed when the menu is built, so it is the real clock reading
 * for that offset right now — pick the row whose time matches your wall clock.
 *
 * Signs still matter (Eastern is UTC-5 in winter, UTC-4 in summer), which is
 * why the label prints the time instead of only the offset.
 */
const TIMEZONE_INFO = {
    '-12': { places: 'Baker Island', areas: 'US Minor Outlying Islands (uninhabited)' },
    '-11': { places: 'Pago Pago', areas: 'American Samoa, Niue' },
    '-10': { places: 'Honolulu', areas: 'Hawaii, Tahiti, Cook Islands' },
    '-9': { places: 'Anchorage', areas: 'Alaska, Marquesas Islands' },
    '-8': { places: 'Los Angeles', areas: 'California, Oregon, Washington, Nevada, British Columbia' },
    '-7': { places: 'Denver', areas: 'Colorado, Arizona, Utah, Alberta' },
    '-6': { places: 'Chicago', areas: 'Illinois, Texas, Mexico City, Manitoba' },
    '-5': { places: 'New York', areas: 'New York, Florida, Toronto, Lima, Bogotá' },
    '-4': { places: 'Halifax', areas: 'Nova Scotia, Santiago, Caracas, La Paz' },
    '-3': { places: 'São Paulo', areas: 'Brazil, Argentina, Uruguay, Greenland' },
    '-2': { places: 'Fernando de Noronha', areas: 'South Georgia, Mid-Atlantic islands' },
    '-1': { places: 'Azores', areas: 'Azores, Cape Verde' },
    '0': { places: 'London', areas: 'UK, Ireland, Portugal, Iceland, Ghana' },
    '1': { places: 'Berlin', areas: 'Germany, France, Italy, Spain, Poland, Nigeria' },
    '2': { places: 'Cairo', areas: 'Egypt, Greece, South Africa, Finland, Israel' },
    '3': { places: 'Moscow', areas: 'Russia (west), Turkey, Saudi Arabia, Kenya' },
    '4': { places: 'Dubai', areas: 'UAE, Oman, Azerbaijan, Georgia' },
    '5': { places: 'Karachi', areas: 'Pakistan, Uzbekistan, Turkmenistan' },
    '6': { places: 'Dhaka', areas: 'Bangladesh, Kyrgyzstan, Bhutan' },
    '7': { places: 'Bangkok', areas: 'Thailand, Vietnam, Indonesia (west)' },
    '8': { places: 'Singapore', areas: 'Singapore, China, Hong Kong, Philippines, Australia (west)' },
    '9': { places: 'Tokyo', areas: 'Japan, South Korea, North Korea' },
    '10': { places: 'Sydney', areas: 'Australia (east), Guam, Papua New Guinea' },
    '11': { places: 'Honiara', areas: 'Solomon Islands, New Caledonia, Vanuatu' },
    '12': { places: 'Auckland', areas: 'New Zealand, Fiji, Kiribati (east)' }
};

function buildTimezoneOptions(now = Date.now()) {
    return Array.from({ length: 25 }, (_, index) => {
        const offset = index - 12;
        const key = String(offset);
        const info = TIMEZONE_INFO[key] ?? { places: 'International', areas: 'No reference city' };
        const clock = format12(localMinutes(offset, now));
        return {
            label: `${offsetLabel(offset)} · ${clock} — ${info.places}`.slice(0, 100),
            description: info.areas.slice(0, 100),
            value: key
        };
    });
}

const TIMEZONES = buildTimezoneOptions();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set-sleep')
        .setDescription('Set your timezone and sleep schedule.'),
    async execute(interaction) {
        const menu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('sleep:timezone')
                .setPlaceholder('Pick the UTC row whose time matches your clock')
                .addOptions(buildTimezoneOptions())
        );
        const message = await interaction.reply({
            content: '**Select your timezone** — every row shows the **current time** in that offset, ' +
                'and the countries/states it covers, so you can just find your own clock.\n' +
                '> 💡 Daylight saving still matters: Eastern Time is **UTC-5 in winter**, **UTC-4 in summer**. ' +
                'Pick whichever row currently matches your wall clock.',
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
                            .setLabel('Wake time (e.g. 07:00 or 7:00am)')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('07:00')
                            .setRequired(true)
                            .setMaxLength(12)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('sleepTime')
                            .setLabel('Sleep time (e.g. 23:00, 24:00 or 11pm)')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('23:00')
                            .setRequired(true)
                            .setMaxLength(12)
                    )
                );
            await component.showModal(modal);
            collector.stop();
        });
    },
    buildTimezoneOptions,
    TIMEZONE_INFO
};
