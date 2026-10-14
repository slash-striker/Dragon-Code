const db = require('../../database');

const USER_DEFAULTS = {
    wallet: 0,
    bank: 0,
    dailyLastClaim: null,
    dailyStreak: 0,
    dailyMissedDays: 0,
    weeklyWeekStart: null,
    weeklyProgress: 0,
    weeklyCycleStart: null,
    weeklyStartedOnMonday: 0,
    weeklyClaimDays: '[]',
    weeklyRewardClaimed: 0,
    dailyLongestStreak: 0,
    job: 'Dock Worker',
    careerLevel: 0,
    currentJobSalary: 90,
    jobWorkProgress: 0,
    lifetimeWorkCount: 0,
    lifetimeWorkEarnings: 0,
    lastWorkedAt: null,
    promotionStatus: 'READY',
    prestigeLevel: 0,
    prestigeMultiplier: 1,
    crimeSuccess: 0,
    crimeFails: 0,
    heatLevel: 0,
    bounty: 0,
    fishCount: 0,
    begCount: 0,
    scratchcardCount: 0,
    lotteryEntryCount: 0,
    moneySpent: 0,
    uiStyle: 'hightech',
    xp: 0,
    level: 0,
    totalMessageCount: 0,
    lastSeenAt: null,
    timezone: 0,
    wakeTime: null,
    sleepTime: null
};

function getUser(userId) {
    let user = db.prepare('SELECT * FROM users WHERE userId = ?').get(userId);

    if (!user) {
        db.prepare(`
            INSERT INTO users (
                userId,
                wallet,
                bank,
                dailyLastClaim,
                dailyStreak,
                dailyMissedDays,
                weeklyWeekStart,
                weeklyProgress,
                job,
                prestigeLevel,
                prestigeMultiplier,
                xp,
                level,
                totalMessageCount,
                uiStyle
            )
            VALUES (?, 0, 0, NULL, 0, 0, ?, 0, 'Dock Worker', 0, 1, 0, 0, 0, 'hightech')
        `).run(userId, new Date().toISOString());

        user = db.prepare('SELECT * FROM users WHERE userId = ?').get(userId);
    }

    return normalizeUser(user);
}

function normalizeUser(user) {
    if (!user) return null;

    const normalized = { ...USER_DEFAULTS, ...user };

    if (!normalized.weeklyWeekStart) {
        normalized.weeklyWeekStart = new Date().toISOString();
    }

    return {
        ...normalized,
        userId: user.userId,
        wallet: Number(normalized.wallet ?? 0),
        bank: Number(normalized.bank ?? 0),
        dailyStreak: Number(normalized.dailyStreak ?? 0),
        dailyMissedDays: Number(normalized.dailyMissedDays ?? 0),
        weeklyProgress: Number(normalized.weeklyProgress ?? 0),
        weeklyStartedOnMonday: Number(normalized.weeklyStartedOnMonday ?? 0),
        weeklyRewardClaimed: Number(normalized.weeklyRewardClaimed ?? 0),
        dailyLongestStreak: Number(normalized.dailyLongestStreak ?? 0),
        careerLevel: Number(normalized.careerLevel ?? 0),
        currentJobSalary: Number(normalized.currentJobSalary ?? 90),
        jobWorkProgress: Number(normalized.jobWorkProgress ?? 0),
        lifetimeWorkCount: Number(normalized.lifetimeWorkCount ?? 0),
        lifetimeWorkEarnings: Number(normalized.lifetimeWorkEarnings ?? 0),
        prestigeLevel: Number(normalized.prestigeLevel ?? 0),
        prestigeMultiplier: Number(normalized.prestigeMultiplier ?? 1),
        crimeSuccess: Number(normalized.crimeSuccess ?? 0),
        crimeFails: Number(normalized.crimeFails ?? 0),
        heatLevel: Number(normalized.heatLevel ?? 0),
        bounty: Number(normalized.bounty ?? 0),
        fishCount: Number(normalized.fishCount ?? 0),
        begCount: Number(normalized.begCount ?? 0),
        scratchcardCount: Number(normalized.scratchcardCount ?? 0),
        lotteryEntryCount: Number(normalized.lotteryEntryCount ?? 0),
        moneySpent: Number(normalized.moneySpent ?? 0),
        xp: Number(normalized.xp ?? 0),
        level: Number(normalized.level ?? 0),
        totalMessageCount: Number(normalized.totalMessageCount ?? 0),
        timezone: Number(normalized.timezone ?? 0)
    };
}

function updateUser(user) {
    const safe = normalizeUser(user);
    if (!safe) return;

    db.prepare(`
        UPDATE users SET
            wallet = ?,
            bank = ?,
            dailyLastClaim = ?,
            dailyStreak = ?,
            dailyMissedDays = ?,
            weeklyWeekStart = ?,
            weeklyProgress = ?,
            weeklyCycleStart = ?,
            weeklyStartedOnMonday = ?,
            weeklyClaimDays = ?,
            weeklyRewardClaimed = ?,
            dailyLongestStreak = ?,
            job = ?,
            careerLevel = ?,
            currentJobSalary = ?,
            jobWorkProgress = ?,
            lifetimeWorkCount = ?,
            lifetimeWorkEarnings = ?,
            lastWorkedAt = ?,
            promotionStatus = ?,
            prestigeLevel = ?,
            prestigeMultiplier = ?,
            crimeSuccess = ?,
            crimeFails = ?,
            heatLevel = ?,
            bounty = ?,
            fishCount = ?,
            begCount = ?,
            scratchcardCount = ?,
            lotteryEntryCount = ?,
            moneySpent = ?,
            uiStyle = ?,
            xp = ?,
            level = ?,
            totalMessageCount = ?,
            lastSeenAt = ?,
            timezone = ?,
            wakeTime = ?,
            sleepTime = ?
        WHERE userId = ?
    `).run(
        safe.wallet,
        safe.bank,
        safe.dailyLastClaim,
        safe.dailyStreak,
        safe.dailyMissedDays,
        safe.weeklyWeekStart,
        safe.weeklyProgress,
        safe.weeklyCycleStart,
        safe.weeklyStartedOnMonday,
        safe.weeklyClaimDays,
        safe.weeklyRewardClaimed,
        safe.dailyLongestStreak,
        safe.job,
        safe.careerLevel,
        safe.currentJobSalary,
        safe.jobWorkProgress,
        safe.lifetimeWorkCount,
        safe.lifetimeWorkEarnings,
        safe.lastWorkedAt,
        safe.promotionStatus,
        safe.prestigeLevel,
        safe.prestigeMultiplier,
        safe.crimeSuccess,
        safe.crimeFails,
        safe.heatLevel,
        safe.bounty,
        safe.fishCount,
        safe.begCount,
        safe.scratchcardCount,
        safe.lotteryEntryCount,
        safe.moneySpent,
        safe.uiStyle,
        safe.xp,
        safe.level,
        safe.totalMessageCount,
        safe.lastSeenAt,
        safe.timezone,
        safe.wakeTime,
        safe.sleepTime,
        safe.userId
    );
}

module.exports = { getUser, updateUser, normalizeUser };
