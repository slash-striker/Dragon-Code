const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('time-at')
        .setDescription('Convert a time between user timezones.')
        .addUserOption(option => option.setName('target').setDescription('Target user').setRequired(true))
        .addStringOption(option => option.setName('time').setDescription('HH:MM in your timezone').setRequired(true)),
    async execute(interaction) {
        const input = interaction.options.getString('time');
        const match = input.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
        if (!match) return interaction.reply({ content: 'Use HH:MM format, such as 14:30.' });
        const target = interaction.options.getUser('target');
        const sourceRow = db.prepare('SELECT timezone FROM users WHERE userId = ?').get(interaction.user.id);
        const targetRow = db.prepare('SELECT timezone FROM users WHERE userId = ?').get(target.id);
        if (!sourceRow?.timezone || !targetRow?.timezone) {
            return interaction.reply({ content: 'Both users must set a timezone with /set-sleep first.' });
        }
        const [hours, minutes] = input.split(':').map(Number);
        const converted = ((hours * 60 + minutes) - Number(sourceRow.timezone) * 60 + Number(targetRow.timezone) * 60 + 1440) % 1440;
        const result = `${String(Math.floor(converted / 60)).padStart(2, '0')}:${String(converted % 60).padStart(2, '0')}`;
        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x00d4ff)
                    .setTitle('Time Conversion')
                    .setDescription(`${input} in your timezone is **${result}** for ${target}.`)
            ]
        });
    }
};
