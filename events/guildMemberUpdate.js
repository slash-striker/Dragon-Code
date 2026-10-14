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
    name: Events.GuildMemberUpdate,

    async execute(oldMember, newMember) {
        try {
            const hadSlashling = oldMember.roles.cache.has(config.ROLES.SLASHLING);
            const hasSlashling = newMember.roles.cache.has(config.ROLES.SLASHLING);

            // Only run when SLASHLING is REMOVED
            if (hadSlashling && !hasSlashling) {

                // 1. Restore Unverified role
                await newMember.roles.add(config.ROLES.UNVERIFIED).catch(() => {});

                // 2. Remove their reaction (cleanup)
                const channel = await newMember.guild.channels
                    .fetch(config.CHANNEL_ID)
                    .catch(() => null);

                if (!channel) return;

                const message = await channel.messages
                    .fetch(config.MESSAGE_ID)
                    .catch(() => null);

                if (!message) return;

                const reaction = message.reactions.cache.find(
                    r => r.emoji.name === config.EMOJI_NAME
                );

                if (!reaction) return;

                const users = await reaction.users.fetch().catch(() => null);
                if (!users) return;

                if (users.has(newMember.id)) {
                    await reaction.users.remove(newMember.id);
                }

                return;
            }

        } catch (err) {
            console.error("GuildMemberUpdate error:", err);
        }
    }
};