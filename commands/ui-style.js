const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, SlashCommandBuilder } = require('discord.js');
const db = require('../database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ui-style')
        .setDescription('Choose high-tech or normal command styling.'),
    async execute(interaction) {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ui:hightech').setLabel('High-Tech').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('ui:normal').setLabel('Normal').setStyle(ButtonStyle.Secondary)
        );
        const message = await interaction.reply({
            content: 'Choose your preferred interface style.',
            components: [row],
            fetchReply: true
        });
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
            filter: button => button.user.id === interaction.user.id
        });
        collector.on('collect', async button => {
            const style = button.customId.split(':')[1];
            db.prepare('INSERT INTO users (userId, uiStyle) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET uiStyle = excluded.uiStyle')
                .run(interaction.user.id, style);
            await button.update({ content: `Interface style set to **${style}**.`, components: [] });
            collector.stop();
        });
    }
};
