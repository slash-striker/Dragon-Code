const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} = require('discord.js');

const {
    getMarketInfo,
    BASE_ORE_VALUES
} = require('../systems/mining/marketEngine');

const ALLOWED_CHANNEL = '1504562791967756448';

// ==================================================
// ORE CATEGORIES
// ==================================================
const ORE_CATEGORIES = {
    common: ['raw_crystal', 'neon_shard', 'quantum_fragment'],
    rare: ['data_crystal', 'circuit_core', 'plasma_ore'],
    epic: ['void_essence', 'frost_data', 'ice_processor', 'cryo_relic'],
    legendary: ['dark_matter', 'moon_chip', 'cosmic_drive', 'stellar_artifact', 'energy_crystal', 'nexus_fragment', 'primordial_core', 'titanium_lattice', 'ion_crystal', 'asteroid_core', 'event_horizon_shard', 'gravity_lens', 'singularity_core'],
    seasonal: ['gift_data', 'holo_candy', 'frost_processor', 'santa_relay', 'pumpkin_drive', 'ghost_data', 'bat_processor', 'cursed_core', 'egg_chip', 'bloom_data', 'rabbit_drive', 'golden_core', 'love_data', 'rose_processor', 'heart_drive', 'clover_chip', 'rainbow_data', 'leprechaun_core', 'celebration_drive', 'time_crystal', 'eternal_processor']
};

// ==================================================
// RARITY COLORS
// ==================================================
const RARITY_COLORS = {
    common: 0x808080,
    rare: 0x0088ff,
    epic: 0x8800ff,
    legendary: 0xffaa00,
    seasonal: 0x00ff00
};

// ==================================================
// MAIN COMMAND
// ==================================================
module.exports = {
    data: new SlashCommandBuilder()
        .setName('market')
        .setDescription('View live ore prices and market events'),

    async execute(interaction) {
        /* 10062 fix — acknowledge BEFORE any heavier work. The channel gate
           is a fast reply; the embed build + fetchReply that used to eat the
           3-second window now run post-defer and answer via editReply. */
        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ Market access restricted to <#${ALLOWED_CHANNEL}>` });
        }

        await interaction.deferReply();

        let currentPage = 0;
        const categories = Object.keys(ORE_CATEGORIES);

        const buildEmbed = () => {
            const marketInfo = getMarketInfo();
            const category = categories[currentPage];
            const ores = ORE_CATEGORIES[category];
            
            const embed = new EmbedBuilder()
                .setColor(marketInfo.event ? 0xff6600 : 0x00ffff)
                .setTitle('📈 NEURAL MARKET GRID')
                .setDescription('**LIVE ORE PRICING**')
                .addFields(
                    {
                        name: '📊 MARKET STATUS',
                        value: marketInfo.event 
                            ? `🔥 **${marketInfo.event}**\n${marketInfo.eventDescription}\nMultiplier: x${marketInfo.multiplier.toFixed(2)}`
                            : '✅ **Stable Market**\nNo active events\nMultiplier: x1.00',
                        inline: false
                    },
                    {
                        name: '📘 HOW TO READ PRICES',
                        value: 'Current price is the amount paid per unit when you sell. Base is the normal reference value; the percentage shows how far the live price is above or below base. Market events apply their multiplier before normal volatility.',
                        inline: false
                    },
                    {
                        name: '🧠 MARKET TELEMETRY',
                        value: `Cycle: **${marketInfo.stats.cycle}** — whether demand is accumulating or distributing.\nVolatility: **${marketInfo.stats.volatility.toFixed(1)}%** — expected price movement.\nSentiment: **${marketInfo.stats.sentiment >= 0 ? '+' : ''}${marketInfo.stats.sentiment}** — market demand direction.\nActivity: **${marketInfo.stats.activity}%** — trading intensity.\nLiquidity: **${marketInfo.stats.liquidity}%** — ease of selling at the displayed price.`,
                        inline: false
                    },
                    {
                        name: '⏱️ NEXT SHIFT',
                        value: `<t:${Math.floor(new Date(marketInfo.stats.nextShift).getTime() / 1000)}:R>${marketInfo.stats.eventEndsAt ? `\nEvent ends <t:${Math.floor(new Date(marketInfo.stats.eventEndsAt).getTime() / 1000)}:R>` : ''}`,
                        inline: false
                    }
                );

            // Add ore prices for current category
            for (const oreId of ores) {
                const baseValue = BASE_ORE_VALUES[oreId] || 0;
                const currentPrice = marketInfo.prices[oreId] || 0;
                const change = ((currentPrice - baseValue) / baseValue * 100).toFixed(1);
                const isUp = currentPrice >= baseValue;
                
                embed.addFields({
                    name: `${oreId.replace(/_/g, ' ').toUpperCase()}`,
                    value: `🪙 **${currentPrice.toLocaleString()}**\n${isUp ? '📈' : '📉'} ${change}% (Base: ${baseValue})`,
                    inline: true
                });
            }

            embed.setFooter({ 
                text: `Category: ${category.toUpperCase()} (${currentPage + 1}/${categories.length}) • Prices update dynamically` 
            });

            return embed;
        };

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('prev')
                .setLabel('⬅ Previous')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('next')
                .setLabel('Next ➡')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('refresh')
                .setLabel('🔄 Refresh')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('close')
                .setLabel('✖ Close')
                .setStyle(ButtonStyle.Danger)
        );

        const message = await interaction.editReply({
            embeds: [buildEmbed()],
            components: [row],
            fetchReply: true
        });

        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 120000
        });

        collector.on('collect', async (i) => {
            if (i.user.id !== interaction.user.id) {
                return i.reply({ content: 'Not your market view!' });
            }

            if (i.customId === 'prev') {
                currentPage = currentPage > 0 ? currentPage - 1 : categories.length - 1;
            } else if (i.customId === 'next') {
                currentPage = currentPage < categories.length - 1 ? currentPage + 1 : 0;
            } else if (i.customId === 'refresh') {
                // Just refresh the embed
            } else if (i.customId === 'close') {
                await i.update({
                    content: '📉 Market feed closed.',
                    embeds: [],
                    components: []
                });
                collector.stop();
                return;
            }

            await i.update({
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
