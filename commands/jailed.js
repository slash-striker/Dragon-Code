const {
    SlashCommandBuilder,
    EmbedBuilder
} = require("discord.js");
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

const JAIL_ROLE_ID = "1520308409621282816";

// Admin role config lives in systems/admin/adminVisibility.js (DB-backed).

const SLASHLING_ROLE_ID = "1504377329521262653";
const EXTRA_ROLE_ID = "1515807579819737169";

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName("jailed")
        .setDescription("[STAFF ONLY] Jail a user with a reason")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("User to jail")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("reason")
                .setDescription("Reason for jailing")
                .setRequired(true)
        ),

    async execute(interaction) {
        const target = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason");

        // Staff-only check first, then acknowledge BEFORE the member fetch —
        // the API roundtrip can blow the 3-second reply window on cold caches.
        if (!isAdminUser(interaction)) {
            return interaction.reply({
                content: "❌ This command is restricted to staff members only." });
        }

        await interaction.deferReply();

        try {
            const member = await interaction.guild.members.fetch(target.id)
                .catch(() => null);

            if (!member) {
                return interaction.editReply({
                    content: "❌ Could not resolve that user in this server." });
            }

            // Remove roles if they exist
            await member.roles.remove(SLASHLING_ROLE_ID).catch(() => {});
            await member.roles.remove(EXTRA_ROLE_ID).catch(() => {});

            // Add jailed role
            await member.roles.add(JAIL_ROLE_ID).catch(() => {});

            const embed = new EmbedBuilder()
                .setColor("Red")
                .setTitle("⛓️ User Jailed")
                .setDescription(
                    `**User:** ${target}\n` +
                    `**Reason:** ${reason}\n` +
                    `**By:** ${interaction.user}`
                )
                .setTimestamp();

            await interaction.editReply({
                embeds: [embed]
            });

        } catch (err) {
            console.error("Error in /jailed command:", err);

            await interaction.editReply({
                content: "❌ Failed to jail user." }).catch(() => {});
        }
    }
};