const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Display bot and API latency.'),
    async execute(interaction) {
        const sent = await interaction.reply({
            content: 'Checking connection...',
            fetchReply: true
        });
        const botLatency = sent.createdTimestamp - interaction.createdTimestamp;
        const apiLatency = Math.round(interaction.client.ws.ping);
        return interaction.editReply({
            content: '',
            embeds: [
                new EmbedBuilder()
                    .setColor(0x00f5ff)
                    .setTitle('System Diagnostics')
                    .addFields(
                        { name: 'Bot latency', value: `${botLatency}ms`, inline: true },
                        { name: 'API latency', value: `${apiLatency}ms`, inline: true },
                        { name: 'Status', value: 'Online', inline: true }
                    )
                    .setTimestamp()
            ]
        });
    }
};
