const { Events } = require("discord.js");

// Embedded config to avoid disk space issues
const config = {
    CHANNEL_ID: "1504576508231024770",
    MESSAGE_ID: "1520516438551691406",
    EMOJI_NAME: "Sassy_Slashy",
    ROLES: {
        SLASHLING: "1504377329521262653",
        UNVERIFIED: "1520308932130639923"
    }
};

module.exports = {
    name: Events.MessageReactionRemove,

    async execute(reaction, user) {
        try {
            if (user.bot) return;

            // Handle partial reactions safely
            if (reaction.partial) {
                await reaction.fetch();
            }

            const message = reaction.message;

            if (!message.guild) return;
            if (message.channel.id !== config.CHANNEL_ID) return;
            const member = await message.guild.members.fetch(user.id);
            const slashlingRole = await message.guild.roles.fetch(config.ROLES.SLASHLING);
            const unverifiedRole = await message.guild.roles.fetch(config.ROLES.UNVERIFIED);
            const results = await Promise.allSettled([
                slashlingRole ? member.roles.remove(slashlingRole) : Promise.resolve(),
                unverifiedRole ? member.roles.add(unverifiedRole) : Promise.resolve()
            ]);
            for (const result of results) {
                if (result.status === 'rejected') {
                    console.error(`Unverification role update failed for ${user.id}: ${result.reason?.message || result.reason}`);
                }
            }

        } catch (err) {
            console.error("MessageReactionRemove error:", err);
        }
    }
};