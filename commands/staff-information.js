const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('staff-information')
        .setDescription('[ADMIN ONLY] View staff roles and reporting guidance.'),
    async execute(interaction) {
        // Runtime gate — non-admins cannot run it even via permission overrides.
        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ This command is restricted to administrators.' });
        }
        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x00e5ff)
                    .setTitle('Staff Information')
                    .setDescription('Contact a moderator for routine issues, Head Staff for escalations, and the server owner for final appeals.')
                    .addFields({
                        name: 'Report',
                        value: 'Rule violations, scams, harassment, suspicious links, or harmful content.'
                    })
            ]
        });
    }
};
