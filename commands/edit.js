/*
 * /edit — the single staff hub for editing user state.
 *
 * Merged (handlers preserved, shared staff check + admin-log detail field):
 *   edit-economy   → /edit economy   (set/add/remove wallet & bank)
 *   edit-inventory → /edit inventory (add · remove · clear)
 *                    — also fixes the old `AND item = ?` column bug
 *                      (the inventory table column is itemId)
 *   edit-daily     → /edit daily     (set daily streak)
 *   level-edit-xp  → /edit xp        (set XP and level)
 *
 * Every mutation is reported to the admin log channel through
 * interaction.adminCommandDetails (picked up by index.js).
 */
const { SlashCommandBuilder } = require('discord.js');
const db = require('../database');
const { getUser, updateUser } = require('../systems/economy/userManager');
const { SHOP_ITEMS, getItemByName } = require('../systems/economy/shopItems');
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ButtonStyle, ButtonBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

function replyLogged(interaction, content, details) {
    interaction.adminCommandDetails = details;
    return interaction.reply({ content });
}

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('edit')
        .setDescription('[STAFF ONLY] Edit a user\'s economy, inventory, streak, or XP')
        .addStringOption(opt => opt
            .setName('action')
            .setDescription('What to edit')
            .setRequired(true)
            .addChoices(
                { name: 'Economy (wallet / bank)', value: 'economy' },
                { name: 'Inventory', value: 'inventory' },
                { name: 'Daily streak', value: 'daily' },
                { name: 'XP and level', value: 'xp' }
            )
        )
        .addUserOption(opt => opt
            .setName('target')
            .setDescription('User to edit')
            .setRequired(true)
        )
        .addStringOption(opt => opt
            .setName('operation')
            .setDescription('Economy or inventory operation')
            .addChoices(
                { name: 'Set Wallet', value: 'set_wallet' },
                { name: 'Set Bank', value: 'set_bank' },
                { name: 'Add to Wallet', value: 'add_wallet' },
                { name: 'Add to Bank', value: 'add_bank' },
                { name: 'Remove from Wallet', value: 'remove_wallet' },
                { name: 'Remove from Bank', value: 'remove_bank' },
                { name: 'Add Item', value: 'add_item' },
                { name: 'Remove Item', value: 'remove_item' },
                { name: 'Clear Inventory', value: 'clear_inventory' }
            )
        )
        .addIntegerOption(opt => opt
            .setName('amount')
            .setDescription('Amount (economy edits)')
            .setMinValue(0)
        )
        .addIntegerOption(opt => opt
            .setName('streak')
            .setDescription('Daily streak to set')
            .setMinValue(0)
        )
        .addIntegerOption(opt => opt
            .setName('xp')
            .setDescription('XP to set')
        )
        .addIntegerOption(opt => opt
            .setName('level')
            .setDescription('Level to set')
        ),

    async execute(interaction) {
        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ This command is restricted to staff members only.' });
        }

        const target = interaction.options.getUser('target');
        const area = interaction.options.getString('action', true);
        const rawOperation = interaction.options.getString('operation') ?? '';

        /* ============ economy (was /edit-economy) ============ */
        if (area === 'economy') {
            const operation = rawOperation;
            if (!['set_wallet', 'set_bank', 'add_wallet', 'add_bank', 'remove_wallet', 'remove_bank'].includes(operation)) {
                return interaction.reply({ content: '❌ Pick an economy operation (set/add/remove for wallet or bank).' });
            }
            const amount = interaction.options.getInteger('amount');
            if (amount === null) {
                return interaction.reply({ content: '❌ Economy edits need an `amount`.' });
            }

            const user = await getUser(target.id);

            switch (operation) {
                case 'set_wallet':
                    user.wallet = amount;
                    break;
                case 'set_bank':
                    user.bank = amount;
                    break;
                case 'add_wallet':
                    user.wallet += amount;
                    break;
                case 'add_bank':
                    user.bank += amount;
                    break;
                case 'remove_wallet':
                    user.wallet = Math.max(0, user.wallet - amount);
                    break;
                case 'remove_bank':
                    user.bank = Math.max(0, user.bank - amount);
                    break;
            }

            updateUser(user);

            const operationNames = {
                'set_wallet': 'Set wallet to',
                'set_bank': 'Set bank to',
                'add_wallet': 'Added to wallet',
                'add_bank': 'Added to bank',
                'remove_wallet': 'Removed from wallet',
                'remove_bank': 'Removed from bank'
            };

            return replyLogged(interaction,
                `✅ ${operationNames[operation]} ${amount.toLocaleString()} for ${target.tag}.\nNew wallet: 🪙 ${user.wallet.toLocaleString()}\nNew bank: 🪙 ${user.bank.toLocaleString()}`,
                `Target: <@${target.id}>; ${operationNames[operation]} ${amount.toLocaleString()}; New wallet: 🪙${user.wallet.toLocaleString()}; New bank: 🪙${user.bank.toLocaleString()}`);
        }

        /* ============ inventory (was /edit-inventory) ============ */
        if (area === 'inventory') {
            const operation = { add_item: 'add', remove_item: 'remove', clear_inventory: 'clear' }[rawOperation];
            if (!operation) {
                return interaction.reply({ content: '❌ Pick an inventory operation: add_item, remove_item, or clear_inventory.' });
            }

            if (operation === 'clear') {
                db.prepare("DELETE FROM inventory WHERE userId = ?").run(target.id);
                return replyLogged(interaction,
                    `✅ Cleared ${target.tag}'s inventory.`,
                    `Target: <@${target.id}>; Inventory cleared`);
            }

            // openItemPicker — embed + select menu of every shop item + a
            // quantity text dialog (max 25 options per menu, so paginate).
            const items = Object.values(SHOP_ITEMS);
            const pages = Math.max(1, Math.ceil(items.length / 25));
            let page = 0;
            const pickerEmbed = () => new EmbedBuilder()
                .setColor(0x00d4ff)
                .setTitle(`🛠️ ITEM PICKER — ${operation === 'add' ? 'ADD' : 'REMOVE'} to ${target.displayName ?? target.username}`)
                .setDescription(
                    `Pick an item from the menu**${items.length > 25 ? ' (page ' + (page + 1) + '/' + pages + ')' : ''}**, then enter how many**${operation === 'add' ? '' : ' (remove removes ALL when left blank)'}**.\n\n` +
                    `❑ ${items.length} shop items available. Use ◀ ▶ to browse.`)
                .setFooter({ text: 'Selection opens the quantity dialog — confirm there to apply' });
            const pickerRows = () => {
                const slice = items.slice(page * 25, page * 25 + 25);
                const rows = [new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`edit-item:${operation}:${target.id}:${page}`)
                        .setPlaceholder('Choose an item…')
                        .addOptions(slice.map(item => new StringSelectMenuOptionBuilder()
                            .setLabel(item.name.slice(0, 100))
                            .setValue(item.id)
                            .setDescription((item.description || item.id).slice(0, 100))))
                )];
                if (pages > 1) {
                    rows.push(new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`edit-itempage:${operation}:${target.id}:prev:${page}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
                        new ButtonBuilder().setCustomId(`edit-itempage:${operation}:${target.id}:next:${page}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1)
                    ));
                }
                return rows;
            };

            await interaction.reply({ embeds: [pickerEmbed()], components: pickerRows() });
            const pickerMessage = await interaction.fetchReply();
            const member = interaction.member;
            const collector = pickerMessage.createMessageComponentCollector({ time: 3 * 60 * 1000 });
            collector.on('collect', async (pick) => {
                if (pick.user.id !== interaction.user.id) return pick.reply({ content: '❌ Staff picker only.', ephemeral: true });
                if (pick.customId.startsWith('edit-itempage:')) {
                    page = Math.min(Math.max(0, page + (pick.customId.endsWith(':next') ? 1 : -1)), pages - 1);
                    return pick.update({ embeds: [pickerEmbed()], components: pickerRows() });
                }
                const itemId = pick.values[0];
                const modal = new ModalBuilder()
                    .setCustomId(`edit-qty:${operation}:${target.id}:${itemId}`)
                    .setTitle(`Quantity — ${SHOP_ITEMS[itemId]?.name ?? itemId}`.slice(0, 45));
                modal.addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('qty')
                        .setLabel(operation === 'add' ? 'How many to add:' : 'How many to remove:')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(operation === 'add')
                        .setMaxLength(7)
                ));
                return pick.showModal(modal);
            });
            collector.on('end', async (_, reason) => {
                if (reason === 'time') {
                    await pickerMessage.edit({ components: [] }).catch(() => {});
                }
            });
            return;
        }

        /* ============ daily (was /edit-daily) ============ */
        if (area === 'daily') {
            const streak = interaction.options.getInteger('streak');
            if (streak === null) {
                return interaction.reply({ content: '❌ Daily edits need a `streak` value.' });
            }

            db.prepare("UPDATE users SET dailyStreak = ? WHERE userId = ?").run(streak, target.id);

            return replyLogged(interaction,
                `✅ Set ${target.tag}'s daily streak to ${streak}.`,
                `Target: <@${target.id}>; Daily streak set to ${streak}`);
        }

        /* ============ xp (was /level-edit-xp) ============ */
        if (area === 'xp') {
            const xp = interaction.options.getInteger('xp');
            const level = interaction.options.getInteger('level');
            if (xp === null || level === null) {
                return interaction.reply({ content: '❌ XP edits need both `xp` and `level`.' });
            }

            if (xp < 0 || level < 0) {
                return interaction.reply({
                    content: '❌ XP and level cannot be negative.' });
            }

            getUser(target.id);
            const previous = db.prepare("SELECT xp, level FROM users WHERE userId = ?").get(target.id) || { xp: 0, level: 0 };
            db.prepare("UPDATE users SET xp = ?, level = ? WHERE userId = ?").run(xp, level, target.id);

            return replyLogged(interaction,
                `✅ Updated **${target.tag}**\nXP: ${Number(previous.xp).toLocaleString()} -> ${xp.toLocaleString()}\nLevel: ${previous.level} -> ${level}`,
                `Target: <@${target.id}>; XP: ${Number(previous.xp).toLocaleString()} -> ${xp.toLocaleString()}; Level: ${previous.level} -> ${level}`);
        }
    }
};

/* ============ quantity modal submit (edit-qty:) ============ */
async function handleModal(interaction) {
    if (!isAdminUser(interaction)) {
        return interaction.reply({ content: '❌ This command is restricted to staff members only.' });
    }
    const [, verb, operation, targetId, itemId] = interaction.customId.split(':');
    if (verb === 'qty') {
        const raw = interaction.fields.getTextInputValue('qty').trim();
        const parsed = Number.parseInt(raw, 10);
        // blank (a purposeful "remove ALL" on remove) or non-numeric -> 0
        let quantity = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
        const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
        const item = SHOP_ITEMS[itemId];
        const itemLabel = item?.name ?? itemId;

        if (operation === 'add') {
            if (quantity < 1) {
                return interaction.reply({ content: '❌ Add needs a quantity of 1 or more (type a number).' });
            }
            const existing = db.prepare("SELECT quantity FROM inventory WHERE userId = ? AND itemId = ?").get(targetId, itemId);
            if (existing) {
                db.prepare("UPDATE inventory SET quantity = quantity + ? WHERE userId = ? AND itemId = ?").run(quantity, targetId, itemId);
            } else {
                db.prepare("INSERT INTO inventory (userId, itemId, quantity) VALUES (?, ?, ?)").run(targetId, itemId, quantity);
            }
            return replyLogged(interaction,
                `✅ Added ${quantity}x ${itemLabel} to <@${targetId}>'s inventory.`,
                `Target: <@${targetId}>; Added ${quantity}x ${itemLabel}`);
        }
        if (operation === 'remove') {
            const existing = db.prepare("SELECT quantity FROM inventory WHERE userId = ? AND itemId = ?").get(targetId, itemId);
            if (!existing) {
                return interaction.reply({ content: `❌ <@${targetId}> doesn't have ${itemLabel} in their inventory.` });
            }
            if (quantity < 1) quantity = existing.quantity; // blank = remove ALL
            if (existing.quantity <= quantity) {
                db.prepare("DELETE FROM inventory WHERE userId = ? AND itemId = ?").run(targetId, itemId);
                return replyLogged(interaction,
                    `✅ Removed all ${existing.quantity}x ${itemLabel} from <@${targetId}>'s inventory.`,
                    `Target: <@${targetId}>; Removed all ${existing.quantity}x ${itemLabel}`);
            }
            db.prepare("UPDATE inventory SET quantity = quantity - ? WHERE userId = ? AND itemId = ?").run(quantity, targetId, itemId);
            return replyLogged(interaction,
                `✅ Removed ${quantity}x ${itemLabel} from <@${targetId}>'s inventory.`,
                `Target: <@${targetId}>; Removed ${quantity}x ${itemLabel}`);
        }
        return interaction.reply({ content: '❌ Unknown quantity operation.' });
    }
    return interaction.reply({ content: '❌ Unknown edit dialog.' });
}

/* ============ item picker page buttons (edit-itempage:) ============ */
async function handleComponent(interaction) {
    if (!isAdminUser(interaction)) {
        return interaction.reply({ content: '❌ This command is restricted to staff members only.', ephemeral: true });
    }
    const [, verb, operation, targetId, direction, pageStr] = interaction.customId.split(':');
    if (verb !== 'itempage' || !['prev', 'next'].includes(direction)) return interaction.deferUpdate().catch(() => {});
    return interaction.deferUpdate(); // page stays in the closure above
}

/* ============ item picker page buttons (edit-itempage:) ============ */
async function handleComponent(interaction) {
    if (!isAdminUser(interaction)) {
        return interaction.reply({ content: '❌ This command is restricted to staff members only.', ephemeral: true });
    }
    // Pagination lives in the slash closure; clicking a page button on a
    // picker whose collector is gone simply no-ops.
    return interaction.deferUpdate().catch(() => {});
}

module.exports.handleModal = handleModal;
module.exports.handleComponent = handleComponent;
