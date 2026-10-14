const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getUser, updateUser } = require('../systems/economy/userManager');
const { addItem, hasItem } = require('../systems/economy/inventoryh');
const { getItemQuantity, removeItem } = require('../systems/economy/shopItems');
const { logTransaction } = require('../systems/economy/transactionLogger');
const { setCooldown, getRemainingTime, formatRemainingTime } = require('../systems/economy/cooldownManager');
const { getColor, formatTitle, formatFieldName, isHighTech } = require('../systems/economy/uiStyleHelper');
const db = require('../database');
const ALLOWED_CHANNEL = '1504562791967756448';

function safe(n) {
    return typeof n === 'number' && !isNaN(n) ? n : 0;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('beg')
        .setDescription('Beg for spare change on the streets'),

    async execute(interaction) {

        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ Street access restricted to <#${ALLOWED_CHANNEL}>.` });
        }

        const user = await getUser(interaction.user.id);

        user.wallet = safe(user.wallet);
        await interaction.deferReply();

        // Check cooldown
        const remainingTime = getRemainingTime(interaction.user.id, 'beg');
        if (remainingTime > 0) {
            return interaction.editReply({
                content: `❌ You are on cooldown for beg. Please wait ${formatRemainingTime(remainingTime)}.`,
            });
        }

        // Check for Lucky Dice
        const hasLuckyDice = getItemQuantity(interaction.user.id, 'lucky_dice', db) > 0;
        let luckyDiceUsed = false;

        if (hasLuckyDice) {
            luckyDiceUsed = true;
            removeItem(interaction.user.id, 'lucky_dice', 1);
        }

        const useHighTech = isHighTech(interaction.user.id);

        if (useHighTech) {
            await interaction.editReply({
                content: "🧠 Connecting to Street Economy Network...\n📡 Locating generous NPCs...\n💸 Calculating pity probability..."
            });
        }

        // ------------------------------
        // COINS (25–500, increased to 50–750 with Lucky Dice)
        // ------------------------------
        const minAmount = luckyDiceUsed ? 50 : 25;
        const maxAmount = luckyDiceUsed ? 750 : 500;
        const amount = Math.floor(Math.random() * (maxAmount - minAmount + 1)) + minAmount;
        user.wallet += amount;

        // ------------------------------
        // ITEM SYSTEM (SQL BASED)
        // ------------------------------

        // 1% chance
        const roll = Math.random() < 0.01;

        const alreadyHasShoe = hasItem(user.userId, "old_shoe");

        let gotShoe = false;

        if (roll && !alreadyHasShoe) {
            addItem(user.userId, "old_shoe", 1);
            gotShoe = true;
        }

        // ------------------------------
        // SAVE USER
        // ------------------------------
        updateUser({
            ...user,
            wallet: user.wallet,
            userId: user.userId
        });
        require('../database').prepare('UPDATE users SET begCount = COALESCE(begCount, 0) + 1 WHERE userId = ?').run(user.userId);

        // Log transaction
        logTransaction(interaction.user.id, 'beg', amount, luckyDiceUsed ? 'Lucky Dice used' : '');

        // Set cooldown
        setCooldown(interaction.user.id, 'beg');
        // 📋 Quest board hook.
        try {
            require('../systems/economy/questManager').recordQuestEvent(interaction.user.id, 'beg', 1, {});
        } catch (error) {
            console.error('Beg quest hook failed:', error.message);
        }

        // ------------------------------
        // EMBED RESULT
        // ------------------------------
        const embed = new EmbedBuilder()
            .setColor(getColor(interaction.user.id, gotShoe ? 0xffd700 : 0x00d4ff))
            .setTitle(formatTitle(interaction.user.id, '📡 STREET ECONOMY OUTPUT', 'Begging Results'))
            .setDescription(useHighTech
                ? "```diff\n" +
                  `+ Collected: ${amount} coins\n` +
                  (gotShoe ? "+ RARE DROP: 👞 An Old Shoe\n" : "- No items detected\n") +
                  "```"
                : `You collected **${amount} coins**${gotShoe ? ' and found a rare item!' : ''}`
            )
            .addFields(
                {
                    name: formatFieldName(interaction.user.id, "💰 Wallet", "Wallet"),
                    value: `🪙 ${user.wallet.toLocaleString()}`,
                    inline: true
                },
                {
                    name: formatFieldName(interaction.user.id, "🎒 Inventory Status", "Inventory"),
                    value: gotShoe ? "`NEW ITEM ACQUIRED`" : "`NO CHANGE`",
                    inline: true
                },
                {
                    name: formatFieldName(interaction.user.id, "🧠 System", "Status"),
                    value: useHighTech ? "`NPC generosity: unstable`" : "`Success`",
                    inline: false
                }
            )
            .setTimestamp();

        if (useHighTech) {
            return interaction.editReply({
                embeds: [embed],
                content: null
            });
        } else {
            return interaction.editReply({
                embeds: [embed]
            });
        }
    }
};
