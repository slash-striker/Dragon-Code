const {
    SlashCommandBuilder,
    EmbedBuilder
} = require("discord.js");
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

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

// Admin role config lives in systems/admin/adminVisibility.js (DB-backed).

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName("verify")
        .setDescription("[STAFF ONLY] Creates the verification terminal."),

    async execute(interaction) {
        // Staff-only check (SLASH keeps access via the adminVisibility bypass)
        if (!isAdminUser(interaction)) {
            return interaction.reply({
                content: '❌ This command is restricted to staff members only.' });
        }

        // Acknowledge immediately — emoji fetch + terminal post below are two
        // API roundtrips that otherwise stall past Discord's 3-second window.
        await interaction.deferReply();

        try {
            // Fetch emoji reliably (cache + fetch fallback)
            let emoji = interaction.guild.emojis.cache.find(
                e => e.name === config.EMOJI_NAME
            );

            if (!emoji) {
                const fetched = await interaction.guild.emojis.fetch();
                emoji = fetched.find(e => e.name === config.EMOJI_NAME);
            }

            if (!emoji) {
                return interaction.editReply({
                    content: `❌ Emoji "${config.EMOJI_NAME}" not found in this server.` });
            }

            const embed = new EmbedBuilder()
                .setColor("#b00000")
                .setAuthor({ name: "SLASH Security Network" })
                .setTitle("🔴 ACCESS TERMINAL")
                .setDescription(`

\`\`\`ansi
[2;31m███████╗██╗      █████╗ ███████╗██╗  ██╗
██╔════╝██║     ██╔══██╗██╔════╝██║  ██║
███████╗██║     ███████║███████╗███████║
╚════██║██║     ██╔══██║╚════██║██╔══██║
███████║███████╗██║  ██║███████║██║  ██║
╚══════╝╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
\`\`\`

## SYSTEM STATUS

🟥 Identity Scan ............. ONLINE  
🟥 Security Firewall ......... ACTIVE  
🟥 Authentication ............ REQUIRED  

━━━━━━━━━━━━━━━━━━━━━━━

React with ${emoji} to authenticate yourself.

✔ Removes **Unverified**  
✔ Grants **Slashling**

━━━━━━━━━━━━━━━━━━━━━━━

Removing your reaction revokes access.

⬇️↙️⬅️⬅️⬅️👈⬅◀️◀⏪⏮⏮️
                `);

            const msg = await interaction.channel.send({
                embeds: [embed]
            });

            // Safe reaction add with error handling
            try {
                await msg.react(emoji);
            } catch (err) {
                console.error("Failed to add reaction:", err);
            }            await interaction.editReply({
                content: `✅ Verification terminal deployed.

Message ID:
\`${msg.id}\`

Paste this into config/verify.js as MESSAGE_ID.` });
        } catch (err) {
            console.error("Error in verify command:", err);

            if (!interaction.replied) {
                await interaction.editReply({
                    content: "❌ Failed to create verification terminal." }).catch(() => {});
            }
        }
    }
};