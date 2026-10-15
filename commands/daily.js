const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { getUser, updateUser } = require('../systems/economy/userManager');
const { setCooldown, getRemainingTime, formatRemainingTime } = require('../systems/economy/cooldownManager');
const { logTransaction } = require('../systems/economy/transactionLogger');
const { getColor, formatTitle, formatFieldName, isHighTech } = require('../systems/economy/uiStyleHelper');

const ALLOWED_CHANNEL = '1504562791967756448';
const EASTERN_TIME_ZONE = 'America/New_York';
const WEEKLY_REWARD = 500;
// A full week is SEVEN collection days (Mon–Sun, all eligible) — the weekly
// reward only pays for claiming every day, streak protection aside.
const REQUIRED_WEEKLY_CLAIMS = 7;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function getEasternCalendar(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: EASTERN_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short'
    }).formatToParts(date);
    const value = type => parts.find(part => part.type === type)?.value;
    const key = `${value('year')}-${value('month')}-${value('day')}`;
    const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday'));
    return { key, dayIndex };
}

function dateIndex(key) {
    const [year, month, day] = key.split('-').map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function dateKeyFromIndex(index) {
    return new Date(index * 86_400_000).toISOString().slice(0, 10);
}

function getMondayKey(calendar) {
    const daysSinceMonday = (calendar.dayIndex + 6) % 7;
    return dateKeyFromIndex(dateIndex(calendar.key) - daysSinceMonday);
}

function countEligibleDaysBetween(startKey, endKey) {
    // Every calendar day is now eligible (no Sunday exemption) — a missed day
    // is a missed day, streak protection aside.
    let days = 0;
    for (let index = dateIndex(startKey) + 1; index < dateIndex(endKey); index += 1) {
        days += 1;
    }
    return days;
}

function parseClaimDays(value) {
    try {
        const days = JSON.parse(value || '[]');
        return Array.isArray(days) ? days.filter(day => typeof day === 'string') : [];
    } catch {
        return [];
    }
}

function getStreakMultiplier(streak) {
    return Math.min(1 + streak * 0.05, 2);
}

function rollLootbox(streak) {
    const chance = Math.min(0.05 + streak * 0.005, 0.20);
    if (Math.random() > chance) return null;
    const lootboxes = [
        { name: '🌌 Nebula Crate', reward: 100 },
        { name: '📡 Signal Boost Box', reward: 150 },
        { name: '🚀 Rocket Cache', reward: 200 },
        { name: '💥 Supernova Chest', reward: 350 }
    ];
    return lootboxes[Math.floor(Math.random() * lootboxes.length)];
}

function rollViralMode() {
    return Math.random() < 0.02;
}

module.exports = {
    data: new SlashCommandBuilder().setName('daily').setDescription('Claim your cosmic daily reward'),

    async execute(interaction) {
        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ You can only use this command in <#${ALLOWED_CHANNEL}>.` });
        }

        // Check cooldown
        const remainingTime = getRemainingTime(interaction.user.id, 'daily');
        if (remainingTime > 0) {
            return interaction.reply({
                content: `🌌 You already collected today’s cosmic signal. Please wait ${formatRemainingTime(remainingTime)}.` });
        }

        await interaction.deferReply();

        // Reject an already-claimed date before rendering the timed vault
        // animation. A duplicate must never strand the user's message on the
        // 60% frame while replacing only its text.
        const preflightUser = getUser(interaction.user.id);
        const preflightNow = new Date();
        const preflightToday = getEasternCalendar(preflightNow).key;
        const preflightLastClaim = preflightUser.dailyLastClaim
            ? getEasternCalendar(new Date(preflightUser.dailyLastClaim)).key
            : null;
        if (preflightLastClaim === preflightToday) {
            return interaction.editReply({
                content: '🌌 You already collected today’s cosmic signal.',
                embeds: [],
                components: [],
                attachments: []
            });
        }

        const progressEmbed = (title, icon, progress, text) => new EmbedBuilder()
            .setColor(getColor(interaction.user.id, 0x9b5cff))
            .setTitle(formatTitle(interaction.user.id, `✦ ${title} ✦`, title))
            .setDescription(`✦ ─────────────── ✦\n\n        ${icon}\n\n${text}\n\n\`${'▰'.repeat(progress)}${'▱'.repeat(10 - progress)}\` **${progress * 10}%**\n\n✦ ─────────────── ✦`);
        await interaction.editReply({ embeds: [progressEmbed('DAILY VAULT', '🔮', 2, 'Searching the cosmic vault...')] });
        await delay(650);
        await interaction.editReply({ embeds: [progressEmbed('VAULT UNLOCKING', '🔓', 6, 'Decrypting today’s reward signal...')] });
        await delay(650);

        const now = new Date();
        const calendar = getEasternCalendar(now);
        // Sundays are claimable like any other day — no rest cycle, no free pass.
        // A missed day breaks the streak unless Streak Protection covers it.

        const user = getUser(interaction.user.id);
        const today = calendar.key;
        const mondayKey = getMondayKey(calendar);
        const lastClaimKey = user.dailyLastClaim ? getEasternCalendar(new Date(user.dailyLastClaim)).key : null;

        if (lastClaimKey === today) {
            return interaction.editReply({
                content: '🌌 You already collected today’s cosmic signal.',
                embeds: [],
                components: [],
                attachments: []
            });
        }

        // Remove the old duplicate check since we already have cooldown check above

        user.wallet = Number(user.wallet) || 0;
        user.dailyStreak = Number(user.dailyStreak) || 0;
        user.dailyLongestStreak = Number(user.dailyLongestStreak) || 0;

        const missedEligibleDays = lastClaimKey ? countEligibleDaysBetween(lastClaimKey, today) : 0;
        /*
         * Streak logic: every missed eligible calendar day breaks the streak
         * UNLESS purchased Streak Protection covers it — one banked cover day
         * is consumed per missed day. If protection covers all misses, the
         * streak continues as if the user had claimed.
         */
        const { consumeCoverDay, getCoverDays } = require('../systems/economy/streakProtection');
        let missedRemaining = missedEligibleDays;
        let protectedMisses = 0;
        while (missedRemaining > 0 && consumeCoverDay(interaction.user.id)) {
            protectedMisses += 1;
            missedRemaining -= 1;
        }
        const streakSaved = missedEligibleDays > 0 && missedRemaining === 0;
        user.dailyStreak = !lastClaimKey || (missedEligibleDays > 0 && !streakSaved)
            ? 1
            : user.dailyStreak + 1;
        user.dailyLongestStreak = Math.max(user.dailyLongestStreak, user.dailyStreak);
        user.dailyLastClaim = now.toISOString();

        if (user.weeklyCycleStart !== mondayKey) {
            user.weeklyCycleStart = mondayKey;
            user.weeklyWeekStart = mondayKey;
            user.weeklyProgress = 0;
            user.weeklyStartedOnMonday = 0;
            user.weeklyClaimDays = '[]';
            user.weeklyRewardClaimed = 0;
        }

        const claimDays = parseClaimDays(user.weeklyClaimDays);
        if (calendar.dayIndex === 1) user.weeklyStartedOnMonday = 1;
        claimDays.push(today);
        user.weeklyClaimDays = JSON.stringify([...new Set(claimDays)]);
        user.weeklyProgress = parseClaimDays(user.weeklyClaimDays).length;

        const baseReward = 60;
        const multiplier = getStreakMultiplier(user.dailyStreak);
        let reward = Math.floor(baseReward * multiplier);
        const themeText = [
            `🌌 Cosmic dust collected: +${reward}🪙`,
            `📺 Algorithm boost detected: +${reward}🪙`,
            `🪐 Nebula energy harvested: +${reward}🪙`,
            `🚀 Rocket fuel bonus: +${reward}🪙`
        ][Math.floor(Math.random() * 4)];

        let viralText = null;
        if (rollViralMode()) {
            const viralBonus = reward * 5;
            reward += viralBonus;
            viralText = `📈 VIRAL MODE! +${viralBonus}`;
        }

        const loot = rollLootbox(user.dailyStreak);
        if (loot) user.wallet += loot.reward;
        user.wallet += reward;

        const qualifiesForWeekly = Boolean(user.weeklyStartedOnMonday)
            && user.weeklyProgress >= REQUIRED_WEEKLY_CLAIMS;
        let weeklyText = null;
        if (qualifiesForWeekly && !user.weeklyRewardClaimed) {
            user.wallet += WEEKLY_REWARD;
            user.weeklyRewardClaimed = 1;
            weeklyText = `🏆 **WEEKLY REWARD UNLOCKED** · 🪙 +${WEEKLY_REWARD.toLocaleString()} credits`;
        }

        const coverLeft = getCoverDays(interaction.user.id);
        const protectedText = streakSaved
            ? `🛡️ **Streak Protection activated** — ${protectedMisses} missed day${protectedMisses === 1 ? '' : 's'} covered, your streak survived!`
            : null;

        updateUser(user);

        // Log transaction and set cooldown
        logTransaction(interaction.user.id, 'daily', reward, 'Daily reward');
        setCooldown(interaction.user.id, 'daily');
        // 📋 Quest board hook — claiming the daily is its own quest.
        try {
            require('../systems/economy/questManager').recordQuestEvent(interaction.user.id, 'daily_claim', 1, {});
        } catch (error) {
            console.error('Daily quest hook failed:', error.message);
        }

        const weeklyStatus = user.weeklyStartedOnMonday
            ? `${user.weeklyProgress}/${REQUIRED_WEEKLY_CLAIMS} collection days · ${user.weeklyRewardClaimed ? 'REWARD CLAIMED' : `${Math.max(0, REQUIRED_WEEKLY_CLAIMS - user.weeklyProgress)} needed`}`
            : 'LOCKED · A weekly run must begin with Monday’s collection';

        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(getColor(interaction.user.id, weeklyText ? 0xffd166 : 0x00d4ff))
                .setTitle(formatTitle(interaction.user.id, '◢ DAILY COSMIC REWARD // CREDIT SYNCED ◣', 'Daily Reward Collected'))
                .setDescription([
                    themeText,
                    protectedText,
                    loot ? `🎁 ${loot.name} (+${loot.reward})` : null,
                    viralText,
                    weeklyText
                ].filter(Boolean).join('\n'))
                .addFields(
                    { name: formatFieldName(interaction.user.id, '🔥 Current Streak', 'Current Streak'), value: `${user.dailyStreak} collections`, inline: true },
                    { name: formatFieldName(interaction.user.id, '✦ Longest Streak', 'Longest Streak'), value: `${user.dailyLongestStreak} collections`, inline: true },
                    { name: formatFieldName(interaction.user.id, '⚡ Multiplier', 'Multiplier'), value: `${multiplier.toFixed(2)}x`, inline: true },
                    { name: formatFieldName(interaction.user.id, '🛡️ Protection Banked', 'Protection Banked'), value: `${coverLeft} day${coverLeft === 1 ? '' : 's'}`, inline: true },
                    { name: formatFieldName(interaction.user.id, '📅 Weekly Run', 'Weekly Progress'), value: weeklyStatus, inline: false }
                )
                .setFooter({ text: isHighTech(interaction.user.id) ? 'Netquel Reward Grid • Streak Protection keeps missed days from breaking your streak' : 'Daily Reward System' })
                .setTimestamp()]
        });
    },

    // Exported for focused calendar tests without needing Discord interactions.
    _calendar: { getEasternCalendar, getMondayKey, countEligibleDaysBetween }
};
