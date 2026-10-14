const {
    PermissionFlagsBits,
    SlashCommandBuilder
} = require('discord.js');
const db = require('../database');
const { getUser, updateUser } = require('../systems/economy/userManager');
const { addOre } = require('../systems/mining/inventoryManager');
const { getOrePool } = require('../systems/mining/oreTables');
const { getItemByName, getItemQuantity } = require('../systems/economy/shopItems');
const { addItem } = require('../systems/economy/inventoryh');
const { confirmAction } = require('../systems/admin/confirmAction');
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');
const { locations: miningLocations } = require('../systems/mining/drillTables');

// Admin role config lives in systems/admin/adminVisibility.js (DB-backed).

function isAdministrator(interaction) {
    return isAdminUser(interaction);
}

function findOre(oreId) {
    for (const locationId of Object.keys(miningLocations)) {
        const ore = getOrePool(locationId).find(candidate => candidate.id === oreId);
        if (ore) return ore;
    }
    return null;
}

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('admin')
        .setDescription('[ADMIN ONLY] Manage bot economy and mining systems')
        .addSubcommand(sub => sub
            .setName('mining-reset')
            .setDescription('Reset a user mining profile and ore inventory')
            .addUserOption(option => option
                .setName('user')
                .setDescription('User to reset')
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('mining-grant')
            .setDescription('Grant mined ore to a user')
            .addUserOption(option => option
                .setName('user')
                .setDescription('Recipient')
                .setRequired(true))
            .addStringOption(option => option
                .setName('ore')
                .setDescription('Ore ID, such as raw_crystal')
                .setRequired(true))
            .addIntegerOption(option => option
                .setName('quantity')
                .setDescription('Positive quantity')
                .setMinValue(1)
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('set-balance')
            .setDescription('Set a user wallet or bank balance')
            .addUserOption(option => option
                .setName('user')
                .setDescription('User to update')
                .setRequired(true))
            .addStringOption(option => option
                .setName('account')
                .setDescription('Account to update')
                .addChoices(
                    { name: 'Wallet', value: 'wallet' },
                    { name: 'Bank', value: 'bank' }
                )
                .setRequired(true))
            .addIntegerOption(option => option
                .setName('amount')
                .setDescription('Non-negative balance')
                .setMinValue(0)
                .setRequired(true)))
        .addSubcommand(sub => sub
                .setName('item-give')
                .setDescription('Give an item to a user and log the grant')
                .addUserOption(option => option.setName('user').setDescription('Recipient').setRequired(true))
                .addStringOption(option => option.setName('item').setDescription('Item name or ID').setRequired(true))
                .addIntegerOption(option => option.setName('quantity').setDescription('Quantity').setMinValue(1).setRequired(true))),

    async execute(interaction) {
        if (!isAdministrator(interaction)) {
            return interaction.reply({
                content: '❌ This command is restricted to administrators and configured staff roles.' });
        }

        const subcommand = interaction.options.getSubcommand();
        const target = interaction.options.getUser('user');

        if (subcommand === 'mining-reset') {
            if (!await confirmAction(interaction, `Reset ${target.tag}'s mining profile and ore inventory?`, 'mining-user')) return;
            db.prepare('DELETE FROM mining_profile WHERE userId = ?').run(target.id);
            db.prepare('DELETE FROM mining_inventory WHERE userId = ?').run(target.id);
            db.prepare('DELETE FROM mining_progress WHERE userId = ?').run(target.id);
            return interaction.editReply({
                content: `✅ Reset mining profile, ore inventory, and saved progress for ${target.tag}.` });
        }

        if (subcommand === 'item-give') {
            const itemInput = interaction.options.getString('item');
            const quantity = interaction.options.getInteger('quantity');
            const item = getItemByName(itemInput);
            if (!item) return interaction.reply({ content: `❌ Unknown item: ${itemInput}` });
            const current = getItemQuantity(target.id, item.id, db);
            if (current + quantity > item.limit) return interaction.reply({ content: `❌ Quantity exceeds ${item.name}'s limit (${item.limit}).` });
            addItem(target.id, item.id, quantity);
            interaction.adminCommandDetails = `Target: ${target.tag} (${target.id})\nItem: ${item.name} (${item.id})\nQuantity: ${quantity}`;
            return interaction.reply({ content: `✅ Admin granted ${quantity}x ${item.name} to ${target.tag}.` });
        }

        if (subcommand === 'mining-grant') {
            const oreId = interaction.options.getString('ore').trim().toLowerCase();
            const quantity = interaction.options.getInteger('quantity');
            const ore = findOre(oreId);
            if (!ore) {
                return interaction.reply({
                    content: `❌ Unknown ore ID: \`${oreId}\`.` });
            }

            addOre(target.id, ore.id, quantity);
            return interaction.reply({
                content: `✅ Granted ${quantity}x ${ore.name} to ${target.tag}.` });
        }

        const account = interaction.options.getString('account');
        const amount = interaction.options.getInteger('amount');
        const user = getUser(target.id);

        /* Capture the full before-state so the audit log can show the change
           (increase/decrease and the exact difference) for BOTH accounts. */
        const balanceChange = {
            targetTag: target.tag,
            targetId: target.id,
            walletBefore: Number(user.wallet) || 0,
            bankBefore: Number(user.bank) || 0
        };
        user[account] = amount;
        updateUser(user);
        interaction.balanceChange = {
            ...balanceChange,
            walletAfter: Number(user.wallet) || 0,
            bankAfter: Number(user.bank) || 0,
            account,
            amount
        };

        return interaction.reply({
            content: `✅ Set ${target.tag}'s ${account} to ${amount.toLocaleString()} credits.` });
    }
};
