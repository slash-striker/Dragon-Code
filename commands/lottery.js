const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');

const {
    getUser
} = require('../systems/economy/userManager');

const lottery = require('../systems/lottery/lotteryManager');

const ALLOWED_CHANNEL = '1504562791967756448';

function safe(n) {
    return typeof n === 'number' && !isNaN(n) ? n : 0;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('lottery')
        .setDescription('Neural Lottery System')
        .addStringOption(opt =>
            opt.setName('action')
                .setDescription('Join the lottery, check status, or view odds')
                .setRequired(true)
                .addChoices(
                    { name: 'Join — enter with an amount', value: 'join' },
                    { name: 'Status — view current pool & players', value: 'status' },
                    { name: 'Odds — view entry probabilities', value: 'odds' }
                ))
        .addIntegerOption(opt =>
            opt.setName('amount')
                .setDescription('Amount to enter (join only)')
                .setRequired(false)),

    async execute(interaction) {

        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ Access denied. Terminal locked to <#${ALLOWED_CHANNEL}>.` });
        }

        const sub = interaction.options.getString('action', true);

        const user = await getUser(interaction.user.id);

        const wallet = safe(user.wallet);

        // -----------------------------
        // JOIN LOTTERY
        // -----------------------------
        if (sub === 'join') {

            const amount = interaction.options.getInteger('amount');

            if (amount <= 0) {
                return interaction.reply({
                    content: '❌ Entry amount must be greater than 0.' });
            }

            if (wallet < amount) {
                return interaction.reply({
                    content: '❌ Insufficient funds in wallet.' });
            }

            // fake scan UI
            await interaction.reply(
                "🧠 Connecting to Lottery Grid...\n📡 Syncing wallet...\n🔐 Verifying transaction..."
            );

            await new Promise(r => setTimeout(r, 1200));

            user.wallet -= amount;

            lottery.addEntry(interaction.user.id, amount);
            require('../database').prepare('UPDATE users SET lotteryEntryCount = COALESCE(lotteryEntryCount, 0) + 1, moneySpent = COALESCE(moneySpent, 0) + ? WHERE userId = ?').run(amount, interaction.user.id);

            const pool = lottery.getPool();
            const prize = lottery.getPrize();

            const embed = new EmbedBuilder()
                .setColor(0x00ffff)
                .setTitle('🎰 NEURAL ENTRY CONFIRMED')
                .setDescription('```yaml\nSTATUS: ACCEPTED\nSECURITY: VERIFIED\nNODE: SYNCHRONIZED\n```')
                .addFields(
                    {
                        name: '💰 Entry',
                        value: `\`🪙 ${amount.toLocaleString()}\``,
                        inline: true
                    },
                    {
                        name: '📊 Current Pool',
                        value: `\`🪙 ${pool.toLocaleString()}\``,
                        inline: true
                    },
                    {
                        name: '🏆 Prize (Doubled)',
                        value: `\`🪙 ${prize.toLocaleString()}\``,
                        inline: true
                    }
                )
                .setFooter({ text: 'Neural Lottery Grid v1.0' })
                .setTimestamp();

            const { updateUser } = require('../systems/economy/userManager');// safe if mongoose, ignore if custom
            updateUser(user);

            return interaction.editReply
                ? interaction.editReply({ content: null, embeds: [embed] })
                : interaction.followUp({ embeds: [embed] });
        }

        // -----------------------------
        // STATUS
        // -----------------------------
        if (sub === 'status') {

            const pool = lottery.getPool();
            const prize = lottery.getPrize();
            const entries = lottery.getEntries();

            const embed = new EmbedBuilder()
                .setColor(0x00d4ff)
                .setTitle('🧠 NEURAL LOTTERY GRID')
                .setDescription(
                    [
                        "```yaml",
                        `status: ONLINE`,
                        `participants: ${entries.length}`,
                        `pool: ${pool}`,
                        `system_match: ${pool}`,
                        `final_prize: ${prize}`,
                        "```"
                    ].join("\n")
                )
                .addFields(
                    {
                        name: '💰 Jackpot Pool',
                        value: `🪙 ${pool.toLocaleString()}`,
                        inline: true
                    },
                    {
                        name: '🏆 Final Prize',
                        value: `🪙 ${prize.toLocaleString()}`,
                        inline: true
                    },
                    {
                        name: '👥 Players',
                        value: `${entries.length}`,
                        inline: true
                    }
                )
                .setFooter({ text: 'Draw every Sunday 12PM EST' });

            return interaction.reply({ embeds: [embed] });
        }

        // -----------------------------
        // ODDS
        // -----------------------------
        if (sub === 'odds') {

            const entries = lottery.getEntries();

            if (!entries.length) {
                return interaction.reply({
                    content: '❌ No entries yet.' });
            }

            const total = entries.reduce((a, b) => a + b.amount, 0);

            const sorted = [...entries]
                .sort((a, b) => b.amount - a.amount);

            const lines = await Promise.all(sorted.map(async e => {

                let name = e.userId;

                try {
                    const member = await interaction.guild.members.fetch(e.userId);
                    name =
                        member?.displayName ||
                        member?.user?.username ||
                        e.userId;
                } catch {}

                const percent = ((e.amount / total) * 100).toFixed(2);

                const bars = '█'.repeat(Math.floor(percent / 5));

                return `${name}\n${bars} ${percent}%`;
            }));

            const embed = new EmbedBuilder()
                .setColor(0xff00ff)
                .setTitle('📊 NEURAL ODDS MATRIX')
                .setDescription(lines.join('\n\n'))
                .setFooter({ text: 'Weighted by contribution size' });

            return interaction.reply({ embeds: [embed] });
        }
    }
};
