const { Events } = require("discord.js");
const quoteLogger = require("../systems/games/quoteLogger");

// Embedded config to avoid disk space issues
const config = {
    CHANNEL_ID: "1504576508231024770",
    MESSAGE_ID: "1520516438551691406",
    EMOJI_NAME: "Sassy_Slashy",
    // Every verification reaction is mirrored here for the audit trail.
    VERIFY_LOG_CHANNEL_ID: "1504365033637806134",
    ROLES: {
        SLASHLING: "1504377329521262653",
        UNVERIFIED: "1520308932130639923"
    }
};

module.exports = {
    name: Events.MessageReactionAdd,

    async execute(reaction, user) {
        try {
            if (user.bot) return;

            // 📼 Quote logging: reacting with the watch emoji archives the
            // message for QOTD. Runs before the verification-channel gate.
            if (reaction.partial) {
                await reaction.fetch().catch(() => null);
            }
            if (quoteLogger.isWatchReaction(reaction) && reaction.message?.author) {
                const saved = await quoteLogger.logQuote(reaction.message, reaction.client);
                if (saved) {
                    await quoteLogger.confirmLog(reaction.message.channel, reaction.message, user.id);
                }
            }

            // Handle partial reactions safely
            if (reaction.partial) {
                await reaction.fetch();
            }

            const message = reaction.message;

            if (!message.guild) return;

            if (message.channel.id !== config.CHANNEL_ID) return;
            const member = await message.guild.members.fetch(user.id);
            console.log(`Verification reaction received from ${user.id} in #${message.channel.id} on ${message.id}`);

            /*
             * Audit trail: every verify reaction (including re-verifies)
             * gets a plain line in the admin log channel — a text ping is
             * visible at a glance, unlike any mention inside an embed.
             */
            try {
                const logChannel = message.guild.channels.cache.get(config.VERIFY_LOG_CHANNEL_ID) ||
                    await message.guild.channels.fetch(config.VERIFY_LOG_CHANNEL_ID).catch(() => null);
                if (logChannel) {
                    const emojiText = reaction.emoji?.name
                        ? `:${reaction.emoji.name}:`
                        : (reaction.emoji?.toString() || 'the verification emoji');
                    await logChannel.send({
                        content: `✅ User **${user.tag}** (${user.id}) reacted ${emojiText} in <#${config.CHANNEL_ID}> to get verified.`
                    });
                }
            } catch (logErr) {
                console.error('Verification log send failed:', logErr);
            }
            const slashlingRole = await message.guild.roles.fetch(config.ROLES.SLASHLING);
            const unverifiedRole = await message.guild.roles.fetch(config.ROLES.UNVERIFIED);
            const botMember = message.guild.members.me;
            if (!slashlingRole || slashlingRole.managed) {
                console.error(`Slashling role ${config.ROLES.SLASHLING} is missing or managed and cannot be assigned.`);
                return;
            }
            if (!botMember?.permissions.has('ManageRoles') || !slashlingRole.editable || !member.manageable) {
                console.error(`Cannot assign Slashling role: ManageRoles=${Boolean(botMember?.permissions.has('ManageRoles'))}, editable=${slashlingRole.editable}, memberManageable=${member.manageable}. Move the role below the bot's highest role.`);
                return;
            }
            const results = await Promise.allSettled([
                member.roles.add(slashlingRole),
                unverifiedRole ? member.roles.remove(unverifiedRole) : Promise.resolve()
            ]);
            for (const result of results) {
                if (result.status === 'rejected') {
                    console.error(`Verification role update failed for ${user.id}: ${result.reason?.message || result.reason}`);
                }
            }

        } catch (err) {
            console.error("MessageReactionAdd error:", err);
        }
    }
};