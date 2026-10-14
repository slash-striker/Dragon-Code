const { SlashCommandBuilder } = require('discord.js');
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

/*
 * [ADMIN ONLY] Posts the full commands list as section embeds.
 * Split out of /commands-list because Discord cannot hide a single
 * subcommand — the visible /commands-list stays member-facing.
 */
module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('post-commands-list')
        .setDescription('[ADMIN ONLY] Post the full commands list in this channel'),

    async execute(interaction) {
        // Runtime gate — non-admins cannot run it even via permission overrides.
        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ This command is restricted to administrators.' });
        }

        await interaction.deferReply();
        const channel = interaction.channel;
        if (!channel) {
            return interaction.editReply({ content: '❌ Commands channel not found.' });
        }

        try {
            const { buildSectionEmbeds } = require('./commands-list');
            for (const embed of buildSectionEmbeds()) {
                await channel.send({ embeds: [embed] });
            }
            return interaction.editReply({ content: '✅ Commands list posted in this channel.' });
        } catch (error) {
            console.error('Error posting commands list:', error);
            return interaction.editReply({ content: '❌ Failed to post commands list.' });
        }
    }
};
