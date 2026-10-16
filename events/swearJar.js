const { Events } = require('discord.js');
const { SWEAR_JAR_CHANNEL_ID, countSwears, addSwears } = require('../systems/economy/swearJar');

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        try {
            if (!message.guild || message.author?.bot) return;

            const found = countSwears(message.content);
            if (!found) return;

            const lifetime = addSwears(message.author.id, found);
            const channel = await message.client.channels.fetch(SWEAR_JAR_CHANNEL_ID).catch(() => null);
            if (!channel?.isTextBased?.()) return;

            await channel.send({
                content: `🫙 **Swear jar** — <@${message.author.id}> swore **${found}** time${found === 1 ? '' : 's'} in <#${message.channelId}>. Lifetime total: **${lifetime.toLocaleString()}**`,
                allowedMentions: { parse: [] }
            });
        } catch (error) {
            console.error('swear jar error:', error);
        }
    }
};
