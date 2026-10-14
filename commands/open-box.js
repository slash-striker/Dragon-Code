const { SlashCommandBuilder, EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder, ComponentType } = require('discord.js');
const { SHOP_ITEMS, getItemQuantity } = require('../systems/economy/shopItems');
const { getUser, updateUser } = require('../systems/economy/userManager');
const { addItem, removeItem } = require('../systems/economy/inventoryh');
const db = require('../database');

const ALLOWED_CHANNEL = '1504562791967756448';

// Items that can be obtained from boxes (excluding boxes and premium items)
const BOX_ITEMS = [
    'coffee', 'mobile_phone', 'watchdog', 'lucky_dice', 'energy_drink',
    'magic_fishing_hook', 'rob_insurance', 'xp_boost', 'mega_xp_boost'
];

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function openMysteryBox(userId, isLucky) {
    const user = getUser(userId);
    const results = [];
    
    const roll = Math.random();
    
    if (isLucky) {
        // Lucky Mystery Box: Better rewards
        if (roll < 0.15) {
            // 15% chance for item
            const availableItems = BOX_ITEMS.filter(itemId => {
                const item = SHOP_ITEMS[itemId];
                const currentQty = getItemQuantity(userId, itemId, db);
                return currentQty < item.limit;
            });
            
            if (availableItems.length > 0) {
                const randomItem = availableItems[rand(0, availableItems.length - 1)];
                addItem(userId, randomItem, 1);
                results.push({ type: 'item', value: SHOP_ITEMS[randomItem].name });
            }
        } else if (roll < 0.25) {
            // 10% chance for XP boost
            const xpAmount = rand(500, 2000);
            db.prepare("UPDATE users SET xp = xp + ? WHERE userId = ?").run(xpAmount, userId);
            results.push({ type: 'xp', value: xpAmount });
        } else if (roll < 0.60) {
            // 35% chance for money gain
            const moneyAmount = rand(1000, 10000);
            user.wallet += moneyAmount;
            updateUser(user);
            results.push({ type: 'money', value: moneyAmount, positive: true });
        } else if (roll < 0.85) {
            // 25% chance for money loss
            const lossAmount = Math.min(rand(500, 5000), user.wallet);
            user.wallet -= lossAmount;
            updateUser(user);
            results.push({ type: 'money', value: lossAmount, positive: false });
        } else {
            // 15% chance for nothing
            results.push({ type: 'nothing', value: 0 });
        }
    } else {
        // Regular Mystery Box: Lower rewards
        if (roll < 0.05) {
            // 5% chance for item
            const availableItems = BOX_ITEMS.filter(itemId => {
                const item = SHOP_ITEMS[itemId];
                const currentQty = getItemQuantity(userId, itemId, db);
                return currentQty < item.limit;
            });
            
            if (availableItems.length > 0) {
                const randomItem = availableItems[rand(0, availableItems.length - 1)];
                addItem(userId, randomItem, 1);
                results.push({ type: 'item', value: SHOP_ITEMS[randomItem].name });
            }
        } else if (roll < 0.20) {
            // 15% chance for money gain
            const moneyAmount = rand(200, 2000);
            user.wallet += moneyAmount;
            updateUser(user);
            results.push({ type: 'money', value: moneyAmount, positive: true });
        } else if (roll < 0.50) {
            // 30% chance for money loss
            const lossAmount = Math.min(rand(100, 1000), user.wallet);
            user.wallet -= lossAmount;
            updateUser(user);
            results.push({ type: 'money', value: lossAmount, positive: false });
        } else {
            // 50% chance for nothing
            results.push({ type: 'nothing', value: 0 });
        }
    }
    
    return results;
}

/*
 * mode:auto — absorbs the old /auto-open-boxes toggle.
 */
async function executeAutoOpen(interaction) {
    const enabled = interaction.options.getBoolean('enabled');
    if (enabled === null) {
        return interaction.reply({
            content: '❌ Pick **enabled:true** or **enabled:false** to set auto-open.',
            ephemeral: true
        });
    }

    // Ensure column exists
    try {
        db.prepare("ALTER TABLE users ADD COLUMN autoOpenBoxes INTEGER DEFAULT 0").run();
    } catch (e) {
        // Column already exists
    }

    db.prepare("UPDATE users SET autoOpenBoxes = ? WHERE userId = ?")
        .run(enabled ? 1 : 0, interaction.user.id);

    const embed = new EmbedBuilder()
        .setColor(enabled ? 0x00ff00 : 0xff9900)
        .setTitle('🎁 AUTO-OPEN BOXES SETTING')
        .setDescription(enabled
            ? '✅ Mystery boxes will now open automatically when purchased.'
            : '⏸️ Mystery boxes will be stored in inventory when purchased.')
        .addFields(
            { name: 'Status', value: enabled ? 'Enabled' : 'Disabled', inline: true }
        );

    return interaction.reply({ embeds: [embed] });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('open-box')
        .setDescription('Open your mystery boxes (mode:auto toggles auto-open on purchase)')
        .addStringOption(opt =>
            opt.setName('mode')
                .setDescription('Open boxes now, or toggle auto-open when purchased')
                .addChoices(
                    { name: '🎁 Open boxes', value: 'open' },
                    { name: '⚙️ Toggle auto-open on purchase', value: 'auto' }
                ))
        .addStringOption(opt =>
            opt.setName('box_type')
                .setDescription('Type of box to open')
                .setRequired(false)
                .addChoices(
                    { name: 'Mystery Box', value: 'mystery_box' },
                    { name: 'Lucky Mystery Box', value: 'lucky_mystery' }
                ))
        .addIntegerOption(opt =>
            opt.setName('amount')
                .setDescription('Amount to open (default: 1)')
                .setMinValue(1)
                .setMaxValue(10))
        .addBooleanOption(opt =>
            opt.setName('enabled')
                .setDescription('Auto-open enabled (mode:auto only)')),

    async execute(interaction) {
        const mode = interaction.options.getString('mode') ?? 'open';
        if (mode === 'auto') {
            return executeAutoOpen(interaction);
        }

        const boxType = interaction.options.getString('box_type');
        if (!boxType) {
            return interaction.reply({
                content: '❌ Pick a **box_type** to open — or use **mode:auto** to toggle auto-open.',
                ephemeral: true
            });
        }

        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ You can only use this in <#${ALLOWED_CHANNEL}>.` });
        }

        const amount = interaction.options.getInteger('amount') || 1;

        const currentQty = getItemQuantity(interaction.user.id, boxType, db);

        if (currentQty < amount) {
            return interaction.reply({
                content: `❌ You only have ${currentQty} ${SHOP_ITEMS[boxType].name}.` });
        }

        await interaction.deferReply();
        await interaction.editReply({
            content: `🔐 Unlocking ${amount}x ${SHOP_ITEMS[boxType].name}...\n▰░░░░░░░░░░ 10%`,
            embeds: [],
            components: []
        });
        await new Promise(resolve => setTimeout(resolve, 700));
        await interaction.editReply({
            content: `⚡ Cracking reward seal...\n██████░░░░ 60%`,
            embeds: [],
            components: []
        });
        await new Promise(resolve => setTimeout(resolve, 700));

        // Remove boxes from inventory
        removeItem(interaction.user.id, boxType, amount);

        // Open boxes
        const allResults = [];
        for (let i = 0; i < amount; i++) {
            const results = openMysteryBox(interaction.user.id, boxType === 'lucky_mystery');
            allResults.push(...results);
        }

        // Build results embed
        const embed = new EmbedBuilder()
            .setColor(0x00d4ff)
            .setTitle(`🎁 OPENED ${amount}x ${SHOP_ITEMS[boxType].name}`)
            .setDescription('Here are your results:');

        const itemResults = allResults.filter(r => r.type === 'item');
        const xpResults = allResults.filter(r => r.type === 'xp');
        const moneyGainResults = allResults.filter(r => r.type === 'money' && r.positive);
        const moneyLossResults = allResults.filter(r => r.type === 'money' && !r.positive);
        const nothingResults = allResults.filter(r => r.type === 'nothing');

        if (itemResults.length > 0) {
            embed.addFields({
                name: '🎁 Items',
                value: itemResults.map(r => r.value).join(', '),
                inline: false
            });
        }

        if (xpResults.length > 0) {
            const totalXP = xpResults.reduce((sum, r) => sum + r.value, 0);
            embed.addFields({
                name: '⬆️ XP Gained',
                value: totalXP.toLocaleString(),
                inline: true
            });
        }

        if (moneyGainResults.length > 0) {
            const totalGain = moneyGainResults.reduce((sum, r) => sum + r.value, 0);
            embed.addFields({
                name: '💰 Money Gained',
                value: `🪙 ${totalGain.toLocaleString()}`,
                inline: true
            });
        }

        if (moneyLossResults.length > 0) {
            const totalLoss = moneyLossResults.reduce((sum, r) => sum + r.value, 0);
            embed.addFields({
                name: '💸 Money Lost',
                value: `🪙 ${totalLoss.toLocaleString()}`,
                inline: true
            });
        }

        if (nothingResults.length > 0) {
            embed.addFields({
                name: '😔 Nothing',
                value: nothingResults.length.toString(),
                inline: true
            });
        }

        embed.setFooter({ text: `Remaining ${SHOP_ITEMS[boxType].name}: ${currentQty - amount}` });

        embed.setDescription('✨ Reward seal broken. The vault has revealed its contents.');
        return interaction.editReply({ content: null, embeds: [embed] });
    }
};

module.exports.openMysteryBox = openMysteryBox;
module.exports.executeAutoOpen = executeAutoOpen;
