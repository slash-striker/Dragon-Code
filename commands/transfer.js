const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');

const db = require('../database');
const { ensureUser } = require('../systems/utils/ensureUser');
const { logTransaction } = require('../systems/economy/transactionLogger');

const ALLOWED_CHANNEL = '1504562791967756448';

// ==================================================
// MAIN COMMAND
// ==================================================
module.exports = {
    data: new SlashCommandBuilder()
        .setName('transfer')
        .setDescription('Transfer credits from mining bank or wallet to your main bank')
        .addStringOption(option =>
            option
                .setName('source')
                .setDescription('Account to transfer credits from')
                .setRequired(true)
                .addChoices(
                    { name: 'Mining bank', value: 'mining_bank' },
                    { name: 'Wallet', value: 'wallet' }
                )
        )
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription('Amount to transfer (or -1 for all)')
                .setRequired(true)
        ),

    async execute(interaction) {
        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ Transfer restricted to <#${ALLOWED_CHANNEL}>` });
        }

        ensureUser(interaction.user.id);
        const source = interaction.options.getString('source', true);
        const amountInput = interaction.options.getInteger('amount');
        
        const user = db.prepare("SELECT wallet, bank, mining_bank FROM users WHERE userId = ?").get(interaction.user.id);
        
        if (!user) {
            return interaction.reply({
                content: '❌ Account not found. Please use economy commands first.' });
        }

        let amount = amountInput;
        
        if (amount === -1) {
            amount = user[source];
        }
        
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            return interaction.reply({
                content: '❌ Amount must be a positive whole number (or -1 for all).' });
        }

        if (amount > user[source]) {
            return interaction.reply({
                content: `❌ Insufficient ${source === 'mining_bank' ? 'mining bank' : 'wallet'} balance.` });
        }

        const sourceLabel = source === 'mining_bank' ? 'Mining bank' : 'Wallet';
        const transfer = db.prepare(
            `UPDATE users SET ${source} = ${source} - ?, bank = bank + ? WHERE userId = ? AND ${source} >= ?`
        ).run(amount, amount, interaction.user.id, amount);
        if (transfer.changes !== 1) {
            return interaction.reply({ content: `❌ Insufficient ${sourceLabel.toLowerCase()} balance.` });
        }
        logTransaction(interaction.user.id, 'transfer', -amount, `${sourceLabel} to main bank`);
        
        const updatedUser = db.prepare("SELECT wallet, bank, mining_bank FROM users WHERE userId = ?").get(interaction.user.id);
        // Read-back audit trail — nothing is ever "vaporized" silently.
        logTransaction(interaction.user.id, 'transfer_credit', amount, `Credited ${sourceLabel} → main bank`);
        
        const embed = new EmbedBuilder()
            .setColor(0x00ffff)
            .setTitle('💵 TRANSFER COMPLETE')
            .setDescription(`**NEURAL BANK TRANSFER**\n\nCredits transferred from **${sourceLabel}** to Main Bank Account.`)
            .addFields(
                {
                    name: '💵 TRANSFERRED',
                    value: `🪙 ${amount.toLocaleString()}\nFrom: ${sourceLabel}`,
                    inline: true
                },
                {
                    name: '🏦 MAIN BANK ACCOUNT',
                    value: `🪙 ${updatedUser.bank.toLocaleString()}`,
                    inline: true
                },
                {
                    name: '💳 MINING BANK',
                    value: `🪙 ${updatedUser.mining_bank.toLocaleString()}`,
                    inline: true
                }
            )
            .setFooter({ text: 'NEURAL BANKING SYSTEM v2.0 // TRANSFER COMPLETE' });

        await interaction.reply({ embeds: [embed] });
    }
};
