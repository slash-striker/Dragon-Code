const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { getUser, updateUser } = require('../systems/economy/userManager');
const { createProgressBar, getCareerLevel, getJob, jobs } = require('./job');
const { getItemQuantity, removeItem } = require('../systems/economy/shopItems');
const { logTransaction } = require('../systems/economy/transactionLogger');
const { setCooldown, getRemainingTime, formatRemainingTime } = require('../systems/economy/cooldownManager');
const { getColor, formatTitle, formatFieldName, isHighTech } = require('../systems/economy/uiStyleHelper');
const db = require('../database');
const ALLOWED_CHANNEL = '1504562791967756448';

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
module.exports = {
    data: new SlashCommandBuilder().setName('work').setDescription('Complete a career assignment and earn credits'),

    async execute(interaction) {
        // Acknowledge FIRST — before any check, DB read, or lookup — so /work
        // can never miss Discord's 3-second acknowledgement window, even if
        // the event loop is busy. All later messages edit the placeholder.
        await interaction.deferReply();

        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.editReply({
                content: `❌ Access denied. Terminal locked to <#${ALLOWED_CHANNEL}>.` });
        }

        // Check cooldown
        const remainingTime = getRemainingTime(interaction.user.id, 'work');
        if (remainingTime > 0) {
            return interaction.editReply({
                content: `❌ You are on cooldown for work. Please wait ${formatRemainingTime(remainingTime)}.` });
        }

        const user = getUser(interaction.user.id);
        const level = getCareerLevel(user);
        const job = getJob(level);
        const now = Date.now();
        const progress = Number(user.jobWorkProgress) || 0;
        let nextJob = jobs[level + 2];
        const isMaxRank = !nextJob;
        const isPromotionReady = !isMaxRank && progress >= job.workRequired;

        if (isPromotionReady) {
            nextJob = jobs[level + 1];
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(0xffd166)
                    .setTitle('◢ PROMOTION CLEARANCE AVAILABLE ◣')
                    .setDescription(`Your record as **${job.name}** is complete. Submit **/job action:apply** to accept your next assignment: ${nextJob.icon} **${nextJob.name}**.`)] });
            nextJob = jobs[level + 2];
        }

        let finalSalary = job.salary;
        let coffeeUsed = false;
        let energyDrinkUsed = false;
        let bonusAmount = 0;
        let taxAmount = 0;
        let timingStatus = 'normal';

        // Determine timing status based on last work time
        const lastWorkedAt = user.lastWorkedAt ? new Date(user.lastWorkedAt).getTime() : 0;
        const hoursSinceLastWork = lastWorkedAt ? (now - lastWorkedAt) / (1000 * 60 * 60) : Infinity;

        // Timing thresholds (in hours)
        const EARLY_THRESHOLD = 1.5; // Working within 1.5-2 hours is "early"
        const LATE_THRESHOLD = 2.5; // Working after 2.5 hours is "late"

        if (hoursSinceLastWork < EARLY_THRESHOLD && lastWorkedAt > 0) {
            timingStatus = 'early';
        } else if (hoursSinceLastWork > LATE_THRESHOLD) {
            timingStatus = 'late';
        } else {
            timingStatus = 'ontime';
        }

        // Check for Coffee
        const coffeeQty = getItemQuantity(interaction.user.id, 'coffee', db);
        if (coffeeQty > 0) {
            coffeeUsed = true;
            removeItem(interaction.user.id, 'coffee', 1);

            // Coffee guarantees an on-time-or-early arrival. It is not a
            // shopping prompt or an energy-drink replacement.
            if (timingStatus === 'early') {
                finalSalary = job.salary * 2;
            } else {
                timingStatus = 'ontime';
                finalSalary = job.salary;
            }
        } else {
            // Without coffee: late = half salary
            if (timingStatus === 'late') {
                finalSalary = Math.floor(job.salary / 2);
            }
            // Early and on-time get normal salary without coffee
        }

        // Check for Energy Drink
        const energyDrinkQty = getItemQuantity(interaction.user.id, 'energy_drink', db);
        if (energyDrinkQty > 0) {
            energyDrinkUsed = true;
            removeItem(interaction.user.id, 'energy_drink', 1);
            bonusAmount = rand(130, 500);
        }

        // Orbital Salvager and higher careers pay a 10% tax to SlashDragon Bank.
        const prestigeMultiplier = Math.max(1, Number(user.prestigeMultiplier) || 1);
        const grossReward = Math.floor((finalSalary + bonusAmount) * prestigeMultiplier);
        if (level >= 1 && interaction.client.user?.id) {
            taxAmount = Math.floor(grossReward * 0.10);
            const bankUser = getUser(interaction.client.user.id);
            bankUser.bank = Number(bankUser.bank || 0) + taxAmount;
            updateUser(bankUser);
            logTransaction(interaction.client.user.id, 'tax', taxAmount, `Tax received from ${interaction.user.id}`);
        }

        // Apply bonuses after tax is routed to the bank.
        user.wallet += grossReward - taxAmount;
        user.jobWorkProgress = progress + 1;
        user.lifetimeWorkCount = (Number(user.lifetimeWorkCount) || 0) + 1;
        user.lifetimeWorkEarnings = (Number(user.lifetimeWorkEarnings) || 0) + grossReward;
        user.lastWorkedAt = new Date(now).toISOString();
        user.careerLevel = level;
        user.currentJobSalary = job.salary;

        // Log transaction
        logTransaction(interaction.user.id, 'work', grossReward - taxAmount, `${job.name}${taxAmount ? `; 10% tax paid: ${taxAmount}` : ''}`);

        // Set cooldown
        setCooldown(interaction.user.id, 'work');
        // 📋 Quest board hook.
        try {
            require('../systems/economy/questManager').recordQuestEvent(interaction.user.id, 'work', 1, { job: job.name });
        } catch (error) {
            console.error('Work quest hook failed:', error.message);
        }

        const promotionUnlocked = !isMaxRank && user.jobWorkProgress >= job.workRequired;
        user.promotionStatus = isMaxRank ? 'MAXIMUM CLEARANCE' : promotionUnlocked ? 'ADVANCEMENT AVAILABLE' : 'IN PROGRESS';
        updateUser(user);

        const target = job.workRequired || user.jobWorkProgress;
        const displayedProgress = Math.min(user.jobWorkProgress, target);
        const progressLine = isMaxRank
            ? '`MAXIMUM CLEARANCE HELD`'
            : `\`${createProgressBar(displayedProgress, target)}\` **${displayedProgress}/${target}**`;
        const promotionNote = promotionUnlocked
            ? `\n\n⚡ **PROMOTION SIGNAL DETECTED** — use \`/job action:apply\` to advance to ${nextJob.icon} **${nextJob.name}**.`
            : '';

        // Build item usage text
        let itemUsageText = '';
        if (coffeeUsed || energyDrinkUsed) {
            itemUsageText = '\n\n**ITEMS USED:**';
            if (coffeeUsed) {
                const coffeeEffect = timingStatus === 'early'
                    ? 'You drank coffee and arrived early, doubling your salary.'
                    : 'Coffee guaranteed an on-time arrival and protected your full salary.';
                itemUsageText += `\n☕ ${coffeeEffect}`;
            }
            if (energyDrinkUsed) {
                itemUsageText += `\n⚡ You drank an energy drink, which earned you an extra 🪙 ${bonusAmount.toLocaleString()}.`;
            }
        }

        // Add timing status
        let timingText = '';
        if (timingStatus === 'early') {
            timingText = `\n⚡ **EARLY SHIFT** — You arrived ahead of schedule!`;
        } else if (timingStatus === 'late') {
            timingText = `\n⏰ **LATE ARRIVAL** — ${coffeeUsed ? 'Coffee saved you from penalty!' : 'Salary reduced by 50%'}`;
        }

        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(getColor(interaction.user.id, promotionUnlocked ? 0xffd166 : 0x00e5ff))
                .setTitle(formatTitle(interaction.user.id, '◢ ASSIGNMENT COMPLETE // CREDIT LEDGER SYNCED ◣', 'Assignment Complete'))
                .setDescription([
                    `**${job.icon} ${job.name}**`,
                    `> ${job.description}`,
                    '',
                    `**REWARD DEPOSITED**  \`🪙 +${(grossReward - taxAmount).toLocaleString()} credits\``,
                    taxAmount ? `**SLASHDRAGON BANK TAX**  \`🪙 -${taxAmount.toLocaleString()} credits\`` : '',
                    `**PROMOTION MATRIX**  ${progressLine}`,
                    promotionNote,
                    timingText,
                    itemUsageText
                ].join('\n'))
                .addFields(
                    { name: formatFieldName(interaction.user.id, '◈ Career Level', 'Career Level'), value: `${level + 1}/${jobs.length}`, inline: true },
                    { name: formatFieldName(interaction.user.id, '◈ Lifetime Assignments', 'Lifetime Assignments'), value: user.lifetimeWorkCount.toLocaleString(), inline: true },
                    { name: formatFieldName(interaction.user.id, '◈ Work Revenue', 'Work Revenue'), value: `🪙 ${user.lifetimeWorkEarnings.toLocaleString()}`, inline: true },
                    { name: formatFieldName(interaction.user.id, '◈ Wallet Node', 'Wallet'), value: `🪙 ${user.wallet.toLocaleString()}`, inline: false }
                )
                .setFooter({ text: isHighTech(interaction.user.id) ? 'NETQUEL CAREER GRID • Assignment telemetry verified' : 'Career System' })
                .setTimestamp()]
        });
    }
};
