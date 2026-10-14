const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUser } = require('../systems/economy/userManager');
const { getColor, formatTitle, formatFieldName, isHighTech } = require('../systems/economy/uiStyleHelper');

const MILLIONAIRE_ROLE_ID = '1515807057251668119';
const MILLIONAIRE_THRESHOLD = 1_000_000;
const ALLOWED_CHANNEL = '1504562791967756448';
const ALLOWED_CHANNEL2 = '1527147135542366409';
const ALLOWED_CHANNEL3 = '1527148726634942614';
function safe(n) {
    return typeof n === 'number' && !isNaN(n) ? n : 0;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('balance')
        .setDescription('Scan a financial identity')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('User to inspect')
                .setRequired(false)
        ),

    async execute(interaction) {

        if (![ALLOWED_CHANNEL, ALLOWED_CHANNEL2, ALLOWED_CHANNEL3].includes(interaction.channelId)) {
            return interaction.reply({
                content: `❌ Access denied. Terminal locked to <#${ALLOWED_CHANNEL}>.` });
        }

        const targetUser =
            interaction.options.getUser('user') || interaction.user;

        const user = await getUser(targetUser.id);

        const wallet = safe(user.wallet);
        const bank = safe(user.bank);
        const total = wallet + bank;

        // Millionaire-role sync hits the Discord API twice (member + role
        // fetch) — run it AFTER the reply is dispatched so the balance never
        // waits on it. Errors are swallowed as before.
        const syncMillionaireRole = (async () => {
            if (interaction.guild && !targetUser.bot) {
                try {
                    const member = await interaction.guild.members.fetch({ user: targetUser.id, force: true });
                    const role = await interaction.guild.roles.fetch(MILLIONAIRE_ROLE_ID);
                    const botMember = interaction.guild.members.me;
                    if (role && botMember?.permissions.has('ManageRoles') && role.editable && member.manageable) {
                        if (total >= MILLIONAIRE_THRESHOLD) {
                            if (!member.roles.cache.has(role.id)) {
                                await member.roles.add(role);
                            }
                        } else {
                            await member.roles.remove(role);
                        }
                    }
                } catch (error) {
                    console.error(`Unable to synchronize millionaire role for ${targetUser.id}: ${error.message}`);
                }
            }
        })();

        // ------------------------------
        // DISPLAY NAME RESOLUTION
        // ------------------------------
        let displayName = targetUser.username;

        try {
            const member = await interaction.guild.members.fetch(targetUser.id);
            displayName =
                member?.nickname ||
                member?.user?.globalName ||
                member?.user?.username ||
                displayName;
        } catch {}

        // ------------------------------
        // FAKE SCAN SEQUENCE (UI EFFECT)
        // ------------------------------
        const useHighTech = isHighTech(interaction.user.id);

        if (useHighTech) {
            const msg = await interaction.reply({
                content:
                    `🧠 Initializing neural scan for **${displayName}**...\n` +
                    "📡 Connecting to economy grid...\n" +
                    "🔐 Verifying identity signature...",
            });

            await new Promise(r => setTimeout(r, 500));

            await interaction.editReply(
                "⚙️ Parsing financial records...\n" +
                "💾 Decrypting wallet nodes...\n" +
                "📊 Compiling balance matrix..."
            );

            await new Promise(r => setTimeout(r, 400));

            await interaction.editReply("✅ Scan complete. Rendering results...");

            await new Promise(r => setTimeout(r, 300));
        }

        // ------------------------------
        // EMBED OUTPUT
        // ------------------------------
        const embed = new EmbedBuilder()
            .setColor(getColor(interaction.user.id))
            .setTitle(formatTitle(interaction.user.id, '💳 NEURAL WALLET SCAN', 'Balance'))
            .setDescription(useHighTech
                ? [
                    "```yaml",
                    `identity: ${displayName}`,
                    `status: VERIFIED`,
                    `security: ENCRYPTED`,
                    "```"
                ].join("\n")
                : `Balance for **${displayName}**`
            )
            .addFields(
                {
                    name: formatFieldName(interaction.user.id, "💰 Wallet Node", "Wallet"),
                    value: `\`🪙 ${wallet.toLocaleString()}\``,
                    inline: true
                },
                {
                    name: formatFieldName(interaction.user.id, "🏦 Vault Node", "Bank"),
                    value: `\`🧊 ${bank.toLocaleString()}\``,
                    inline: true
                },
                {
                    name: formatFieldName(interaction.user.id, "💳 Total Net Value", "Total"),
                    value: `\`⚡ ${total.toLocaleString()}\``,
                    inline: true
                },
                {
                    name: formatFieldName(interaction.user.id, "📡 System Status", "Status"),
                    value: useHighTech ? "`ONLINE • SYNCED • STABLE`" : "`Active`",
                    inline: false
                }
            )
            .setFooter({ text: useHighTech ? "Neural Economy Grid v4.1" : "Economy System" })
            .setTimestamp();

        if (useHighTech) {
            return interaction.editReply({
                content: null,
                embeds: [embed]
            });
        } else {
            return interaction.reply({
                embeds: [embed]
            });
        }
    }
};