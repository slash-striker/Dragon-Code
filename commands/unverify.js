const { SlashCommandBuilder } = require('discord.js');
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

const VERIFY_ROLE_ID = '1504377329521262653';
const NEW_ROLE_ID = '1520308932130639923';

// Admin role config lives in systems/admin/adminVisibility.js (DB-backed).

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('unverify')
        .setDescription('[ADMIN ONLY] Unverify a user')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('User to unverify')
                .setRequired(true)
        ),

    async execute(interaction) {

        const member = interaction.member;

        // Staff-only check (SLASH keeps access via the adminVisibility bypass)
        const hasStaffRole = isAdminUser(interaction);

        if (!hasStaffRole) {
            return interaction.reply({
                content: '❌ This command is restricted to staff members only.' });
        }

        const targetUser = interaction.options.getUser('user');

        // Acknowledge before the member fetch — the API roundtrip can blow the
        // 3-second reply window on cold caches.
        await interaction.deferReply();
        const guildMember = await interaction.guild.members.fetch(targetUser.id)
            .catch(() => null);

        if (!guildMember) {
            return interaction.editReply({
                content: `❌ Could not resolve ${targetUser.tag} in this server.` });
        }

        // ------------------------------
        // ROLE CHANGES
        // ------------------------------
        if (guildMember.roles.cache.has(VERIFY_ROLE_ID)) {
            await guildMember.roles.remove(VERIFY_ROLE_ID).catch(() => {});
        }

        if (!guildMember.roles.cache.has(NEW_ROLE_ID)) {
            await guildMember.roles.add(NEW_ROLE_ID).catch(() => {});
        }

        return interaction.editReply({
            content: `✅ Successfully unverified **${targetUser.username}**.` });
    }
};