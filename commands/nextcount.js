const { SlashCommandBuilder } = require('discord.js');
const { COUNTING_CHANNEL_ID, getState } = require('../systems/counting/countingManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nextcount')
        .setDescription('Privately check the next number for the counting channel'),

    async execute(interaction) {
        if (interaction.channelId !== COUNTING_CHANNEL_ID) {
            return interaction.reply({ content: `Use this command in <#${COUNTING_CHANNEL_ID}>.` });
        }
        const state = getState();
        return interaction.reply({ content: `🔢 Next count: **${state.currentCount + 1}**` });
    }
};
