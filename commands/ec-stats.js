const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const db = require('../database');
const { getUser } = require('../systems/economy/userManager');
const { getTotalSpent } = require('../systems/economy/transactionLogger');
const { getColor, formatTitle, formatFieldName, formatButtonLabel, isHighTech } = require('../systems/economy/uiStyleHelper');
const ALLOWED_CHANNEL = '1504562791967756448';
const COLLECTIBLES = { moneybag: '💰 Moneybag', tropical_fish: '🐠 Tropical Fish', old_shoe: '👞 An Old Shoe', ninja: '🥷 Ninja', diamond: '💎 Diamond' };

/*
 * /ec-stats — economy + casino statistics in one command (formerly
 * /ec-stats + /casino-stats). Three switchable sections:
 *   📊 Economy Profile · 🎮 Mini-game Stats (blackjack) · 🎰 Casino Stats (whole ledger)
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('ec-stats')
        .setDescription('View your economy and casino statistics')
        .addUserOption(option => option
            .setName('player')
            .setDescription('Player to inspect (casino section shows anyone; economy shows you)')
            .setRequired(false)),

    async execute(interaction) {
        if (interaction.channelId !== ALLOWED_CHANNEL) return interaction.reply({ content: `Use this in <#${ALLOWED_CHANNEL}>.` });
        const player = interaction.options.getUser('player') || interaction.user;
        const user = getUser(interaction.user.id);
        const items = db.prepare('SELECT itemId, quantity FROM inventory WHERE userId = ?').all(interaction.user.id).filter(row => COLLECTIBLES[row.itemId]);

        // Get total spent from transactions
        const totalSpent = getTotalSpent(interaction.user.id);

        // Get blackjack stats from casino_ledger
        const blackjackStats = db.prepare(`
            SELECT
                SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END) as totalWagered,
                SUM(CASE WHEN type = 'debit' THEN 1 ELSE 0 END) as handsPlayed,
                SUM(CASE WHEN type = 'payout' OR type = 'cashout' THEN amount ELSE 0 END) as totalPayouts
            FROM casino_ledger
            WHERE userId = ? AND game = 'blackjack'
        `).get(interaction.user.id) || { totalWagered: 0, handsPlayed: 0, totalPayouts: 0 };

        const userStats = db.prepare('SELECT fishCount, begCount, scratchcardCount, lotteryEntryCount FROM users WHERE userId = ?').get(interaction.user.id) || { fishCount: 0, begCount: 0, scratchcardCount: 0, lotteryEntryCount: 0 };

        // Full casino ledger summary (the old /casino-stats view) for the
        // inspected player.
        const ledgerRows = db.prepare(
            'SELECT type, SUM(amount) total FROM casino_ledger WHERE userId = ? GROUP BY type'
        ).all(player.id);
        const ledger = Object.fromEntries(ledgerRows.map(row => [row.type, Number(row.total) || 0]));
        const casinoWagered = Math.abs(ledger.debit || 0);
        const casinoPayouts = (ledger.payout || 0) + (ledger.cashout || 0);
        const casinoNet = casinoPayouts - casinoWagered;
        const games = db.prepare('SELECT COUNT(DISTINCT game) AS games FROM casino_ledger WHERE userId = ?').get(player.id)?.games || 0;
        const favorite = db.prepare('SELECT game, COUNT(*) plays FROM casino_ledger WHERE userId = ? GROUP BY game ORDER BY plays DESC LIMIT 1').get(player.id);

        const useHighTech = isHighTech(interaction.user.id);

        const main = new EmbedBuilder()
            .setColor(getColor(interaction.user.id))
            .setTitle(formatTitle(interaction.user.id, '📊 ECONOMY PROFILE // NEURAL LEDGER', 'Economy Profile'))
            .addFields(
                { name: formatFieldName(interaction.user.id, '💼 Current Job', 'Current Job'), value: user.job || 'Unassigned', inline: true },
                { name: formatFieldName(interaction.user.id, '🧰 Shifts Worked', 'Shifts Worked'), value: String(user.lifetimeWorkCount || 0), inline: true },
                { name: formatFieldName(interaction.user.id, '🪙 Work Earnings', 'Work Earnings'), value: (user.lifetimeWorkEarnings || 0).toLocaleString(), inline: true },
                { name: formatFieldName(interaction.user.id, '💸 Total Spent', 'Total Spent'), value: `🪙 ${totalSpent.toLocaleString()}`, inline: true },
                { name: formatFieldName(interaction.user.id, '🥷 Successful Crimes', 'Successful Crimes'), value: String(user.crimeSuccess || 0), inline: true },
                { name: formatFieldName(interaction.user.id, '🎣 Times Fished', 'Times Fished'), value: String(userStats.fishCount || 0), inline: true },
                { name: formatFieldName(interaction.user.id, '🤲 Times Begged', 'Times Begged'), value: String(userStats.begCount || 0), inline: true },
                { name: formatFieldName(interaction.user.id, '🎫 Scratchcards Used', 'Scratchcards Used'), value: String(userStats.scratchcardCount || 0), inline: true },
                { name: formatFieldName(interaction.user.id, '🎰 Lottery Entries', 'Lottery Entries'), value: String(userStats.lotteryEntryCount || 0), inline: true },
                { name: formatFieldName(interaction.user.id, '🎒 Collectibles Earned', 'Collectibles'), value: items.length ? items.map(row => `${COLLECTIBLES[row.itemId]} ×${row.quantity}`).join('\n') : 'None yet', inline: false }
            ).setFooter({ text: useHighTech ? 'Activity counters for fishing, begging, scratchcards and lottery are tracked.' : 'Activity tracking enabled' });

        const netResult = blackjackStats.totalPayouts - blackjackStats.totalWagered;
        const mini = new EmbedBuilder()
            .setColor(getColor(interaction.user.id, 0xa64dff))
            .setTitle(formatTitle(interaction.user.id, '🎮 MINI-GAME STATS // BLACKJACK', 'Blackjack Stats'))
            .setDescription(`Hands played: **${blackjackStats.handsPlayed}**\nTotal wagered: **🪙 ${blackjackStats.totalWagered.toLocaleString()}**\nTotal payouts: **🪙 ${blackjackStats.totalPayouts.toLocaleString()}**\nNet result: **${netResult >= 0 ? '+' : ''}🪙 ${netResult.toLocaleString()}**`);

        const casino = new EmbedBuilder()
            .setColor(getColor(interaction.user.id, 0x00d4ff))
            .setTitle(formatTitle(interaction.user.id, `🎰 CASINO STATS // ${String(player.username ?? 'player').toUpperCase()}`, 'Casino Stats'))
            .setDescription(player.id === interaction.user.id
                ? 'Full casino ledger — every game you have played.'
                : `Full casino ledger for **${player.username}**.`)
            .addFields(
                { name: formatFieldName(interaction.user.id, '🎲 Total Wagered', 'Wagered'), value: `🪙 ${casinoWagered.toLocaleString()}`, inline: true },
                { name: formatFieldName(interaction.user.id, '💎 Total Payouts', 'Payouts'), value: `🪙 ${casinoPayouts.toLocaleString()}`, inline: true },
                { name: formatFieldName(interaction.user.id, '📈 Net Result', 'Net'), value: `${casinoNet >= 0 ? '+' : ''}🪙 ${casinoNet.toLocaleString()}`, inline: true },
                { name: formatFieldName(interaction.user.id, '🎮 Games Played', 'Games'), value: String(games) + (favorite ? ` · favorite: **${favorite.game}** (${favorite.plays} rounds)` : ''), inline: false }
            )
            .setFooter({ text: 'Casino ledger statistics' })
            .setTimestamp();

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('stats:main').setLabel(formatButtonLabel(interaction.user.id, 'Economy Profile', 'Economy Profile')).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('stats:mini').setLabel(formatButtonLabel(interaction.user.id, 'Mini-game Stats', 'Mini-game Stats')).setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('stats:casino').setLabel(formatButtonLabel(interaction.user.id, '🎰 Casino Stats', 'Casino Stats')).setStyle(ButtonStyle.Success)
            );
        const message = await interaction.reply({ embeds: [main], components: [row], fetchReply: true });
        const sections = { 'stats:main': main, 'stats:mini': mini, 'stats:casino': casino };
        const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });
        collector.on('collect', component => { if (component.user.id !== interaction.user.id) return component.reply({ content: 'Open your own profile.' }); return component.update({ embeds: [sections[component.customId] ?? main], components: [row] }); });
        collector.on('end', () => message.edit({ components: [] }).catch(() => {}));
    }
};
