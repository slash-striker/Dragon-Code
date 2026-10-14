const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUser, updateUser } = require('../systems/economy/userManager');
const { getColor, formatTitle, formatFieldName, isHighTech } = require('../systems/economy/uiStyleHelper');
const { runCyberProgress } = require('../systems/economy/cyberProgress');
const { logTransaction } = require('../systems/economy/transactionLogger');

const ALLOWED_CHANNEL = '1504562791967756448';
const ALLOWED_CHANNEL2 = '1527147135542366409';
const ALLOWED_CHANNEL3 = '1527148726634942614';

function safe(n) {
    return typeof n === 'number' && !isNaN(n) ? n : 0;
}

/*
 * /bank — unified vault command (formerly /deposit + /withdraw).
 *
 *   /bank action:deposit amount:<n>   → wallet → bank (omitted/0 = everything)
 *   /bank action:withdraw amount:<n>  → bank → wallet (0 = everything)
 *   /bank (no action chosen)          → balance overview of wallet + vault
 *
 * Uses a choice option instead of subcommands so Discord shows a single
 * "/bank" entry with a deposit/withdraw selector. Channel locks, cyber
 * progress animation, transaction logs and the high-tech styling are all
 * unchanged from the originals.
 */

module.exports = {
    data: new SlashCommandBuilder()
        .setName('bank')
        .setDescription('Vault access: deposit, withdraw, or check your balances')
        .addStringOption(option => option
            .setName('action')
            .setDescription('Deposit or withdraw (leave empty for balances)')
            .addChoices(
                { name: 'Deposit — wallet ➜ vault', value: 'deposit' },
                { name: 'Withdraw — vault ➜ wallet', value: 'withdraw' }
            ))
        .addIntegerOption(option => option
            .setName('amount')
            .setDescription('Amount to move (0 or omitted = everything)')
            .setMinValue(0)
            .setRequired(false)),

    async execute(interaction) {
        if (![ALLOWED_CHANNEL, ALLOWED_CHANNEL2, ALLOWED_CHANNEL3].includes(interaction.channelId)) {
            return interaction.reply({
                content: `❌ Access denied. Vault locked to <#${ALLOWED_CHANNEL}>.` });
        }

        const action = interaction.options.getString('action') ?? 'balance';
        if (action === 'withdraw') return runWithdraw(interaction);
        if (action === 'balance') return runBankBalance(interaction);
        return runDeposit(interaction);
    }
};

/* =========================
   /bank action:deposit
========================= */

async function runDeposit(interaction) {
    const userId = interaction.user.id;
    const useHighTech = isHighTech(userId);
    const user = await getUser(userId);

    user.wallet = safe(user.wallet);
    user.bank = safe(user.bank);

    if (user.wallet <= 0) {
        return interaction.reply({
            content: useHighTech
                ? '🚫 No credits detected in wallet node.'
                : '🚫 You have no credits in your wallet.' });
    }

    let amount = interaction.options.getInteger('amount');
    if (!amount || amount <= 0) amount = user.wallet;
    if (amount > user.wallet) amount = user.wallet;

    await runCyberProgress(interaction, {
        title: 'DEPOSIT PROTOCOL // VAULT LINK',
        stages: [
            { percent: 12, message: 'Initializing deposit protocol...' },
            { percent: 38, message: 'Syncing with vault network...', delay: 360 },
            { percent: 71, message: 'Verifying encrypted transaction...', delay: 520 },
            { percent: 100, message: 'Credits secured. Finalizing transfer...', delay: 420 }
        ]
    });

    user.wallet -= amount;
    user.bank += amount;

    updateUser({
        ...user,
        wallet: user.wallet,
        bank: user.bank,
        userId: user.userId
    });
    logTransaction(userId, 'deposit', 0, `Wallet to bank: ${amount}`);

    const embed = new EmbedBuilder()
        .setColor(getColor(userId))
        .setTitle(formatTitle(userId, '🏦 VAULT DEPOSIT COMPLETE', 'Deposit Complete'))
        .setDescription(useHighTech
            ? [
                '```diff',
                `+ SUCCESS: ${amount.toLocaleString()} credits secured`,
                '- STATUS: LOCKED & ENCRYPTED',
                '```'
            ].join('\n')
            : `Deposited **🪙 ${amount.toLocaleString()}** from your wallet to your bank.`
        )
        .addFields(
            { name: formatFieldName(userId, '💰 Wallet', 'Wallet'), value: `🪙 ${user.wallet.toLocaleString()}`, inline: true },
            { name: formatFieldName(userId, '🏦 Vault', 'Vault'), value: `🧊 ${user.bank.toLocaleString()}`, inline: true }
        )
        .setFooter({ text: useHighTech ? 'Neural Banking Grid v3.4' : 'Economy System' })
        .setTimestamp();

    return interaction.editReply({
        content: null,
        embeds: [embed]
    });
}

/* =========================
   /bank action:withdraw
========================= */

async function runWithdraw(interaction) {
    const userId = interaction.user.id;
    const useHighTech = isHighTech(userId);
    const amountInput = interaction.options.getInteger('amount');
    const user = await getUser(userId);

    user.wallet = safe(user.wallet);
    user.bank = safe(user.bank);

    if (user.bank <= 0) {
        return interaction.reply({
            content: useHighTech
                ? '🚫 No funds detected in secured vault.'
                : '🚫 You have no funds in your bank.' });
    }

    let amount = amountInput;
    if (!amount || amount === 0) amount = user.bank;

    if (amount <= 0) {
        return interaction.reply({
            content: useHighTech ? '⚠️ Invalid transaction request.' : '⚠️ Invalid amount.' });
    }

    if (amount > user.bank) {
        return interaction.reply({
            content: useHighTech ? '🚫 Insufficient vault balance.' : '🚫 Insufficient bank balance.' });
    }

    await runCyberProgress(interaction, {
        title: 'WITHDRAWAL PROTOCOL // VAULT LINK',
        stages: [
            { percent: 10, message: 'Connecting to secure vault...' },
            { percent: 34, message: 'Verifying identity and access key...', delay: 380 },
            { percent: 68, message: 'Accessing encrypted funds...', delay: 540 },
            { percent: 100, message: 'Withdrawal approved. Routing credits...', delay: 440 }
        ]
    });

    user.bank -= amount;
    user.wallet += amount;

    updateUser({
        ...user,
        wallet: user.wallet,
        bank: user.bank,
        userId: user.userId
    });
    logTransaction(userId, 'withdraw', 0, `Bank to wallet: ${amount}`);

    if (useHighTech) {
        await interaction.editReply('✅ Transaction approved. Finalizing transfer...');
        await new Promise(r => setTimeout(r, 800));
    }

    const embed = new EmbedBuilder()
        .setColor(getColor(userId))
        .setTitle(formatTitle(userId, '💳 VAULT WITHDRAWAL COMPLETE', 'Withdrawal Complete'))
        .setDescription(useHighTech
            ? [
                '```diff',
                `+ SUCCESS: ${amount.toLocaleString()} credits transferred`,
                '- STATUS: SECURE',
                '- ENCRYPTION: ACTIVE',
                '```'
            ].join('\n')
            : `Withdrew **🪙 ${amount.toLocaleString()}** from your bank to your wallet.`
        )
        .addFields(
            {
                name: formatFieldName(userId, '💰 Wallet Balance', 'Wallet'),
                value: `\`🪙 ${user.wallet.toLocaleString()}\``,
                inline: true
            },
            {
                name: formatFieldName(userId, '🏦 Vault Balance', 'Bank'),
                value: `\`🧊 ${user.bank.toLocaleString()}\``,
                inline: true
            },
            ...(useHighTech ? [{
                name: formatFieldName(userId, '📡 System Status', 'Status'),
                value: '`ONLINE - SYNCHRONIZED`',
                inline: false
            }] : [])
        )
        .setFooter({ text: useHighTech ? 'Neural Banking Network v3.2' : 'Economy System' })
        .setTimestamp();

    return interaction.editReply({
        content: null,
        embeds: [embed]
    });
}

/* =========================
   /bank balance — quick overview
========================= */

async function runBankBalance(interaction) {
    const userId = interaction.user.id;
    const useHighTech = isHighTech(userId);
    const user = await getUser(userId);
    const wallet = safe(user.wallet);
    const bank = safe(user.bank);

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(getColor(userId))
            .setTitle(formatTitle(userId, '🏦 VAULT STATUS // ACCOUNT OVERVIEW', 'Bank'))
            .setDescription(useHighTech
                ? [
                    '```diff',
                    `+ WALLET: ${wallet.toLocaleString()} credits`,
                    `+ VAULT:  ${bank.toLocaleString()} credits (secured)`,
                    '```'
                ].join('\n')
                : `💰 Wallet: **🪙 ${wallet.toLocaleString()}**\n🏦 Vault: **🪙 ${bank.toLocaleString()}**`)
            .addFields(
                { name: formatFieldName(userId, '💡 Tip', 'Tip'), value: 'Deposit with `/bank action:deposit` • Withdraw with `/bank action:withdraw`', inline: false }
            )
            .setFooter({ text: useHighTech ? 'Neural Banking Grid v3.4' : 'Economy System' })
            .setTimestamp()]
    });
}
