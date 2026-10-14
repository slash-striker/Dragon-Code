const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} = require('discord.js');

const {
    removeOre,
    getInventory,
    getOreQuantity
} = require('../systems/mining/inventoryManager');

const {
    getOrePool
} = require('../systems/mining/oreTables');

const {
    getMarketInfo,
    getOrePrice
} = require('../systems/mining/marketEngine');
const {
    getRefinedInventory,
    RECIPES,
    getArtifacts,
    recordCredits
} = require('../systems/mining/expansionManager');

const db = require('../database');
const { ensureUser } = require('../systems/utils/ensureUser');
const { logTransaction } = require('../systems/economy/transactionLogger');

const ALLOWED_CHANNEL = '1504562791967756448';

// ==================================================
// GET ORE INFO
// ==================================================
function getOreInfo(oreId) {
    const allLocations = Object.keys(require('../systems/mining/drillTables').locations);
    
    for (const locationId of allLocations) {
        const pool = getOrePool(locationId);
        const ore = pool.find(o => o.id === oreId);
        if (ore) return ore;
    }
    
    return null;
}

// ==================================================
// MAIN COMMAND
// ==================================================
module.exports = {
    data: new SlashCommandBuilder()
        .setName('sell')
        .setDescription('Sell your mined ores for credits'),

    async execute(interaction) {
        ensureUser(interaction.user.id);

        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ Trading restricted to <#${ALLOWED_CHANNEL}>` });
        }

        /* 10062 fix — acknowledge before the multi-query inventory aggregation.
           The gate above is a fast reply; everything after the defer answers
           via editReply. */
        await interaction.deferReply();

        const inventory = getInventory(interaction.user.id);
        const refinedInventory = getRefinedInventory(interaction.user.id);
        const artifacts = getArtifacts(interaction.user.id);
        const marketInfo = getMarketInfo();
        
        if (inventory.length === 0 && refinedInventory.length === 0 && artifacts.length === 0) {
            return interaction.editReply({
                content: '❌ Your mining inventory is empty. Use `/mine` to collect ores!' });
        }

        // Calculate total value using dynamic market prices
        let totalValue = 0;
        const oreList = [];
        
        for (const item of inventory) {
            const oreInfo = getOreInfo(item.oreId);
            const value = marketInfo.prices[item.oreId] || getOrePrice(item.oreId);
            const itemTotal = value * item.quantity;
            totalValue += itemTotal;
            
            oreList.push({
                name: oreInfo ? oreInfo.name : item.oreId,
                quantity: item.quantity,
                value: value,
                total: itemTotal,
                rarity: oreInfo ? oreInfo.rarity : 'common'
            });
        }

        for (const item of refinedInventory) {
            const recipe = RECIPES[item.materialId];
            const value = Math.floor((recipe?.value || 0) * (
                marketInfo.event === 'Refinery Rush' ? marketInfo.multiplier : 1
            ));
            const itemTotal = value * item.quantity;
            totalValue += itemTotal;
            oreList.push({
                name: recipe?.name || item.materialId,
                quantity: item.quantity,
                value,
                total: itemTotal,
                rarity: 'refined'
            });
        }

        for (const artifact of artifacts) {
            const itemTotal = artifact.value * artifact.quantity;
            totalValue += itemTotal;
            oreList.push({
                name: artifact.name,
                quantity: artifact.quantity,
                value: artifact.value,
                total: itemTotal,
                rarity: artifact.rarity
            });
        }

        // Sort by value (highest first)
        oreList.sort((a, b) => b.total - a.total);

        const embed = new EmbedBuilder()
            .setColor(marketInfo.event ? 0xff6600 : 0x00ff00)
            .setTitle('💰 ORE TRADING TERMINAL')
            .setDescription(
                `**NEURAL MARKETPLACE**\n\n` +
                (marketInfo.event 
                    ? `🔥 **${marketInfo.event}**\n${marketInfo.eventDescription}\nMultiplier: x${marketInfo.multiplier.toFixed(2)}\n\n`
                    : '✅ **Stable Market**\nNo active events\n\n') +
                'Select ores to sell for credits.'
            )
            .addFields(
                {
                    name: '💰 TOTAL VALUE',
                    value: `🪙 ${totalValue.toLocaleString()}`,
                    inline: true
                },
                {
                    name: '📦 ITEMS',
                    value: `${inventory.length}`,
                    inline: true
                }
            )
            .setFooter({ text: 'NEURAL MINING SYSTEM v2.0 // TRADING TERMINAL' });

        // Add ore list
        for (const ore of oreList.slice(0, 10)) {
            embed.addFields({
                name: `${ore.name} x${ore.quantity}`,
                value: `🪙 ${ore.total.toLocaleString()} (${ore.rarity})`,
                inline: true
            });
        }

        if (oreList.length > 10) {
            embed.addFields({
                name: '...',
                value: `And ${oreList.length - 10} more items`,
                inline: false
            });
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('sell:all')
                .setLabel('💰 SELL ALL')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('sell:cancel')
                .setLabel('⛔ CANCEL')
                .setStyle(ButtonStyle.Secondary)
        );

        const message = await interaction.editReply({
            embeds: [embed],
            components: [row],
            fetchReply: true
        });

        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000
        });

        collector.on('collect', async (i) => {
            if (i.user.id !== interaction.user.id) {
                return i.reply({ content: 'Not your transaction!' });
            }

            if (i.customId === 'sell:cancel') {
                await i.update({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0xff0000)
                            .setTitle('⛔ TRANSACTION CANCELLED')
                            .setDescription('No ores were sold.')
                            .setFooter({ text: 'NEURAL MINING SYSTEM v2.0' })
                    ],
                    components: []
                });
                collector.stop();
                return;
            }

            if (i.customId === 'sell:all') {
                // Sell all ores using dynamic market prices
                let soldTotal = 0;
                let soldItems = 0;
                
                const settlement = db.transaction(() => {
                    // Re-read every holding inside the settlement transaction.
                    // The preview is informational; only this snapshot is
                    // allowed to determine the debit and payout.
                    const currentInventory = getInventory(interaction.user.id);
                    const currentRefined = getRefinedInventory(interaction.user.id);
                    const currentArtifacts = getArtifacts(interaction.user.id);
                    for (const item of currentInventory) {
                        const value = marketInfo.prices[item.oreId] || getOrePrice(item.oreId);
                        soldTotal += value * item.quantity;
                        soldItems += item.quantity;
                        if (!removeOre(interaction.user.id, item.oreId, item.quantity)) {
                            throw new Error('Inventory changed before the sale completed.');
                        }
                    }
                    for (const item of currentRefined) {
                        const recipe = RECIPES[item.materialId];
                        const value = Math.floor((recipe?.value || 0) * (
                            marketInfo.event === 'Refinery Rush' ? marketInfo.multiplier : 1
                        ));
                        soldTotal += value * item.quantity;
                        soldItems += item.quantity;
                        db.prepare('DELETE FROM mining_refined_inventory WHERE userId = ? AND materialId = ?')
                            .run(interaction.user.id, item.materialId);
                    }
                    for (const artifact of currentArtifacts) {
                        soldTotal += artifact.value * artifact.quantity;
                        soldItems += artifact.quantity;
                        db.prepare('DELETE FROM mining_artifacts WHERE userId = ? AND artifactId = ?')
                            .run(interaction.user.id, artifact.artifactId);
                    }
                    // Add to mining bank (separate from main bank).
                    db.prepare("UPDATE users SET mining_bank = COALESCE(mining_bank, 0) + ? WHERE userId = ?")
                        .run(soldTotal, interaction.user.id);
                    return { soldTotal, soldItems };
                })();
                soldTotal = settlement.soldTotal;
                soldItems = settlement.soldItems;
                recordCredits(interaction.user.id, soldTotal);
                logTransaction(interaction.user.id, 'mining_sell', soldTotal, 'Ore and mining materials sold to mining bank');
                // 📋 Quest board hooks — selling ore counts for both quest lines.
                try {
                    const questManager = require('../systems/economy/questManager');
                    questManager.recordQuestEvent(interaction.user.id, 'sell_ore', 1, { total: soldTotal });
                    questManager.recordQuestEvent(interaction.user.id, 'market_sell', 1, { total: soldTotal });
                } catch (error) {
                    console.error('Sell quest hook failed:', error.message);
                }

                const user = db.prepare("SELECT mining_bank FROM users WHERE userId = ?").get(interaction.user.id);

                await i.update({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x00ff00)
                            .setTitle('💰 TRANSACTION COMPLETE')
                            .setDescription('**NEURAL MARKETPLACE**\n\nAll ores sold successfully!')
                            .addFields(
                                {
                                    name: '💰 EARNED',
                                    value: `🪙 ${soldTotal.toLocaleString()}`,
                                    inline: true
                                },
                                {
                                    name: '📦 ITEMS SOLD',
                                    value: `${soldItems}`,
                                    inline: true
                                },
                                {
                                    name: '🏦 MINING BANK',
                                    value: `🪙 ${user.mining_bank.toLocaleString()}`,
                                    inline: true
                                }
                            )
                            .setFooter({ text: 'NEURAL MINING SYSTEM v2.0 // TRANSACTION COMPLETE' })
                    ],
                    components: []
                });
                collector.stop();
            }
        });

        collector.on('end', async (collected, reason) => {
            if (reason === 'time') {
                try {
                    await message.edit({ components: [] });
                } catch {}
            }
        });
    }
};
