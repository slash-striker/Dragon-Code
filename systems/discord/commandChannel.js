const serverConfig = require('./serverConfig');

function configuredChannelId(guildId, setting, fallback) {
    return serverConfig.getChannelId(guildId, setting, fallback);
}

function isConfiguredChannel(interaction, fallback, setting = 'economy') {
    return interaction.channelId === configuredChannelId(interaction.guildId, setting, fallback);
}

module.exports = { configuredChannelId, isConfiguredChannel };
