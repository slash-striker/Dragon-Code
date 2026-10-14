const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('see-users-time')
        .setDescription('View a user timezone and sleep schedule.')
        .addUserOption(option => option
            .setName('user')
            .setDescription('User to check')
            .setRequired(true)),
    async execute(interaction) {
        const target = interaction.options.getUser('user');
        const row = db.prepare('SELECT timezone, wakeTime, sleepTime FROM users WHERE userId = ?').get(target.id);
        if (!row?.timezone) {
            return interaction.reply({
                content: `${target.username} has not set a sleep schedule yet.` });
        }
        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x00d4ff)
                    .setTitle(`${target.username}'s Schedule`)
                    .addFields(
                        { name: 'Timezone', value: `UTC${Number(row.timezone) >= 0 ? '+' : ''}${row.timezone}`, inline: true },
                        { name: 'Wake time', value: row.wakeTime || 'Not set', inline: true },
                        { name: 'Sleep time', value: row.sleepTime || 'Not set', inline: true }
                    )
            ]
        });
    }
};
