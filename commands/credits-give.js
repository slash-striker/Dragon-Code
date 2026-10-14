const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const db = require('../database');
const { logTransaction } = require('../systems/economy/transactionLogger');

const ALLOWED_CHANNEL = '1504562791967756448';
const ALLOWED_CHANNEL2 = '1527147135542366409';
const SLASHDRAGON_ID = '1505829367631183963';

function safe(n) {
    const num = Number(n);
    return Number.isFinite(num) ? num : 0;
}

// fake “system flavor text”
function getSystemStatus() {
    const statuses = [
        "NEURAL LINK STABLE",
        "CRYPTO LEDGER SYNCED",
        "QUANTUM FIREWALL ACTIVE",
        "BANKING GRID ONLINE",
        "SECURE CHANNEL VERIFIED"
    ];
    return statuses[Math.floor(Math.random() * statuses.length)];
}

/*
 * Shared transfer execution: processing animation, atomic debit/credit,
 * transaction log and final embed. Runs from the normal path AND from the
 * high-value confirmation button (which has already replaced the reply).
 */
async function executeTransfer(interaction, targetUser, amount) {
    const sender = interaction.user;

    // ------------------------------
    // PROCESSING "UI EFFECT"
    // ------------------------------
    await new Promise(r => setTimeout(r, 900));

    await interaction.editReply("🔐 Establishing encrypted financial tunnel...");

    await new Promise(r => setTimeout(r, 900));

    await interaction.editReply("⚡ Syncing with decentralized credit ledger...");

    await new Promise(r => setTimeout(r, 900));

    // ------------------------------
    // TRANSFER EXECUTION
    // ------------------------------
    const transfer = db.transaction(() => {
        // Ensure both accounts exist before the atomic debit/credit.
        db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(targetUser.id);
        const result = db.prepare(`
            UPDATE users
            SET wallet = wallet - ?
            WHERE userId = ? AND wallet >= ?
        `).run(amount, sender.id, amount);
        if (result.changes !== 1) throw new Error('INSUFFICIENT FUNDS IN WALLET NODE');
        db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(amount, targetUser.id);
    });
    try {
        transfer();
    } catch (error) {
        return interaction.editReply({ content: `❌ ${error.message}` });
    }
    logTransaction(sender.id, 'credits_give', -amount, `Transfer to ${targetUser.id}`);
    logTransaction(targetUser.id, 'credits_give', amount, `Transfer from ${sender.id}`);

    const systemStatus = getSystemStatus();

    // ------------------------------
    // FINAL EMBED
    // ------------------------------
    const embed = new EmbedBuilder()
        .setColor(0x00d4ff)
        .setTitle("💠 CREDIT TRANSFER COMPLETE")
        .setDescription(
            `**TRANSACTION STATUS:** SUCCESS\n` +
            `**SYSTEM:** ${systemStatus}\n\n` +
            `💸 Sender: <@${sender.id}>\n` +
            `📥 Receiver: <@${targetUser.id}>\n` +
            `💰 Amount: **${amount.toLocaleString()} credits**\n\n` +
            `🔒 Ledger updated and sealed.`
        )
        .setFooter({ text: "NEON ECONOMY CORE • SECURE NODE TRANSFER" })
        .setTimestamp();

    return interaction.editReply({ content: null, embeds: [embed] });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('credits-give')
        .setDescription('Give credits to another player from your own wallet')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Target recipient node')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('Credit transfer amount')
                .setMinValue(1)
                .setRequired(true)
        ),

    async execute(interaction) {
        // ------------------------------
        // CHANNEL LOCK
        // ------------------------------
        if (![ALLOWED_CHANNEL, ALLOWED_CHANNEL2].includes(interaction.channelId)) {
            return interaction.reply({
                content: `❌ SECURE NODE RESTRICTION: <#${ALLOWED_CHANNEL}> ONLY` });
        }

        const sender = interaction.user;
        const targetUser = interaction.options.getUser('user');
        const amount = safe(interaction.options.getInteger('amount'));

        // ------------------------------
        // VALIDATION
        // ------------------------------
        if (!targetUser || (targetUser.bot && targetUser.id !== SLASHDRAGON_ID)) {
            return interaction.reply({
                content: "❌ TARGET NODE INVALID OR UNREACHABLE" });
        }

        if (targetUser.id === sender.id) {
            return interaction.reply({
                content: "❌ SELF-TRANSFER DETECTED — OPERATION BLOCKED" });
        }

        if (amount <= 0) {
            return interaction.reply({
                content: "❌ INVALID TRANSFER VALUE" });
        }

        /*
         * 🚨 HIGH-VALUE CONFIRMATION — any transfer over 1,000,000 credits
         * requires an explicit Confirm click. The transfer does not proceed
         * until the SENDER presses Confirm; Dismiss voids it silently.
         */
        if (amount > 1_000_000) {
            const senderWallet = Number(db.prepare('SELECT COALESCE(wallet, 0) AS w FROM users WHERE userId = ?').get(sender.id)?.w ?? 0);
            if (senderWallet < amount) {
                return interaction.reply({
                    content: "❌ INSUFFICIENT FUNDS IN WALLET NODE" });
            }
            const confirmEmbed = new EmbedBuilder()
                .setColor(0xffaa00)
                .setTitle('⚠️ HIGH-VALUE TRANSFER — CONFIRM REQUIRED')
                .setDescription(
                    `You are about to transfer **${amount.toLocaleString()} credits** to <@${targetUser.id}>.\n\n` +
                    `🚨 **Be careful — this is a large transfer. Double-check the recipient.** Transfers cannot be reversed.\n\n` +
                    `Press **Confirm** to execute, or **Dismiss** to cancel.`
                )
                .setFooter({ text: 'NEON ECONOMY CORE • High-value transfer guard' })
                .setTimestamp();
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('creditgive:confirm').setLabel('✅ Confirm transfer').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('creditgive:dismiss').setLabel('✖ Dismiss').setStyle(ButtonStyle.Secondary)
            );
            await interaction.reply({ embeds: [confirmEmbed], components: [row], fetchReply: true });
            const collector = interaction.channel.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60_000
            });
            collector.on('collect', async (btn) => {
                if (btn.user.id !== sender.id) {
                    return btn.reply({ content: 'Only the sender can confirm this transfer.', ephemeral: true });
                }
                if (btn.customId === 'creditgive:dismiss') {
                    collector.stop('dismissed');
                    return btn.update({
                        content: '🛑 High-value transfer dismissed — nothing was sent.',
                        embeds: [],
                        components: []
                    });
                }
                collector.stop('confirmed');
                await btn.update({ embeds: [], components: [], content: '🧠 Initializing quantum transaction matrix...' });
                await executeTransfer(interaction, targetUser, amount);
            });
            collector.on('end', async (_collected, reason) => {
                if (reason !== 'confirmed' && reason !== 'dismissed') {
                    await interaction.editReply({
                        content: '⏰ High-value transfer timed out — nothing was sent.',
                        embeds: [],
                        components: []
                    }).catch(() => {});
                }
            });
            return;
        }

        // ------------------------------
        // FETCH USERS
        // ------------------------------
        db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(sender.id);
        const balances = db.prepare('SELECT userId, wallet FROM users WHERE userId IN (?, ?)').all(sender.id, targetUser.id);
        const giver = balances.find(user => user.userId === sender.id);
        if (!giver || Number(giver.wallet) < amount) {
            return interaction.reply({
                content: "❌ INSUFFICIENT FUNDS IN WALLET NODE" });
        }

        // ------------------------------
        // PROCESSING "UI EFFECT"
        // ------------------------------
        await interaction.reply({
            content: "🧠 Initializing quantum transaction matrix..."
        });

        return executeTransfer(interaction, targetUser, amount);
    }
};