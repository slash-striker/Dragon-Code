const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getTransactions } = require('../systems/economy/transactionLogger');
const { isAdminUser } = require('../systems/admin/adminVisibility');

const ALLOWED_CHANNEL = '1504562791967756448';

function formatTimestamp(timestamp) {
    // Compact MM/DD — keeps rows narrow enough to never wrap or truncate.
    return new Date(timestamp).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });
}

function formatTransactionType(type) {
    const typeNames = {
        poker: 'POKER',
        coins: 'COINS',
        scratchcard: 'SCRATCH',
        daily: 'DAILY',
        crime: 'CRIME',
        rob_player: 'FROM',
        rob_bank: 'BANK',
        shop: 'SHOP',
        work: 'WORK',
        beg: 'BEG',
        fish: 'FISH',
        tax: 'TAX'
    };
    return typeNames[type] || String(type || 'OTHER').toUpperCase().slice(0, 12);
}

function shorten(value, maxLength) {
    const text = String(value || 'No reason').replace(/[\r\n|]/g, ' ');
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('credits-audit')
        .setDescription('View your recent coin transactions')
        .addUserOption(opt =>
            opt.setName('target')
                .setDescription('View another user\'s transactions (staff only)')
                .setRequired(false)
        ),

    async execute(interaction) {
        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ You can only use this in <#${ALLOWED_CHANNEL}>.` });
        }

        const target = interaction.options.getUser('target') || interaction.user;
        const isOwnAudit = target.id === interaction.user.id;

        // Staff check for viewing others (admin roles configured in
        // systems/admin/adminVisibility.js, DB-backed).
        if (!isOwnAudit) {
            if (!isAdminUser(interaction)) {
                return interaction.reply({
                    content: '❌ You can only view your own transaction history.' });
            }
        }

        const transactions = getTransactions(target.id, 20);
        const totalPages = Math.ceil(transactions.length / 10);
        let page = 0;

        const buildEmbed = () => {
            const startIdx = page * 10;
            const endIdx = Math.min(startIdx + 10, transactions.length);
            const pageTransactions = transactions.slice(startIdx, endIdx);

            const amountCell = t => `${t.amount >= 0 ? '+' : '-'}${Math.abs(t.amount).toLocaleString()}`;
            // Compact columns: MM/DD, 6-char type, right-aligned amount, short reason.
            const dateWidth = 5;
            const typeWidth = Math.max(4, ...transactions.map(t => formatTransactionType(t.type).length));
            const amountWidth = Math.max(
                5,
                ...transactions.map(t => amountCell(t).length)
            );
            const reasonWidth = 24;
            const joinRow = (date, type, amount, reason) =>
                `${date.padEnd(dateWidth)} ${type.padEnd(typeWidth)} ${amount.padStart(amountWidth)}  ${reason}`;
            const header = joinRow('Date', 'Type', 'Amount', 'Reason');

            const lines = pageTransactions.length
                ? pageTransactions.map(t => {
                    const color = t.amount >= 0 ? '\u001b[0;32m' : '\u001b[0;31m';
                    return `${formatTimestamp(t.timestamp).padEnd(dateWidth)} ${formatTransactionType(t.type).padEnd(typeWidth)} ${color}${amountCell(t).padStart(amountWidth)}\u001b[0m  ${shorten(t.description, reasonWidth)}`;
                })
                : ['No transactions found.'];

            return new EmbedBuilder()
                .setColor(0x00d4ff)
                .setTitle('💳 CREDIT AUDIT LOG')
                .setDescription(
                    [
                        `**${target.tag || target.username}** — ${transactions.length} txns — page ${page + 1}/${totalPages || 1}`,
                        '```ansi',
                        header,
                        ...lines,
                        '```'
                    ].join('\n')
                )
                .setFooter({ text: 'Green = credit • Red = debit' });
        };

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('prev')
                .setLabel('⬅ Back')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId('next')
                .setLabel('Forward ➡')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page >= totalPages - 1),
            new ButtonBuilder()
                .setCustomId('close')
                .setLabel('Shutdown')
                .setStyle(ButtonStyle.Danger)
        );

        const message = await interaction.reply({
            embeds: [buildEmbed()],
            components: [row]
        });

        const collector = message.createMessageComponentCollector({
            time: 60000
        });

        collector.on('collect', async (btn) => {
            if (btn.user.id !== interaction.user.id) {
                return btn.reply({
                    content: '❌ This is not your audit log.' });
            }

            if (btn.customId === 'prev') {
                page = page > 0 ? page - 1 : 0;
            }

            if (btn.customId === 'next') {
                page = page < totalPages - 1 ? page + 1 : totalPages - 1;
            }

            if (btn.customId === 'close') {
                await btn.update({
                    content: '🛑 Audit log closed.',
                    embeds: [],
                    components: []
                });
                collector.stop();
                return;
            }

            row.components[0].setDisabled(page === 0);
            row.components[1].setDisabled(page >= totalPages - 1);

            await btn.update({
                embeds: [buildEmbed()],
                components: [row]
            });
        });

        collector.on('end', async () => {
            try {
                await message.edit({ components: [] });
            } catch {}
        });
    }
};
