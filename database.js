const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, 'economy.db'));

/* =========================
   USERS TABLE (ECONOMY ONLY)
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    userId TEXT PRIMARY KEY,

    wallet INTEGER DEFAULT 0,
    bank INTEGER DEFAULT 0,

    dailyLastClaim TEXT,
    dailyStreak INTEGER DEFAULT 0,
    dailyMissedDays INTEGER DEFAULT 0,

    weeklyWeekStart TEXT,
    weeklyProgress INTEGER DEFAULT 0,
    weeklyCycleStart TEXT,
    weeklyStartedOnMonday INTEGER DEFAULT 0,
    weeklyClaimDays TEXT DEFAULT '[]',
    weeklyRewardClaimed INTEGER DEFAULT 0,
    dailyLongestStreak INTEGER DEFAULT 0,

    job TEXT DEFAULT 'Dock Worker',
    careerLevel INTEGER DEFAULT 0,
    currentJobSalary INTEGER DEFAULT 90,
    jobWorkProgress INTEGER DEFAULT 0,
    lifetimeWorkCount INTEGER DEFAULT 0,
    lifetimeWorkEarnings INTEGER DEFAULT 0,
    lastWorkedAt TEXT,
    promotionStatus TEXT DEFAULT 'READY',

    prestigeLevel INTEGER DEFAULT 0,
    prestigeMultiplier REAL DEFAULT 1,

    -- 🧠 CRIME SYSTEM
    crimeSuccess INTEGER DEFAULT 0,
    crimeFails INTEGER DEFAULT 0,
    heatLevel INTEGER DEFAULT 0,
    bounty INTEGER DEFAULT 0
);
`);

// SQLite does not apply new columns to an existing table when it sees
// CREATE TABLE IF NOT EXISTS, so keep schema upgrades in one safe place.
const userColumns = new Set(
    db.prepare('PRAGMA table_info(users)').all().map(column => column.name)
);

const userMigrationColumns = {
    careerLevel: 'INTEGER DEFAULT 0',
    currentJobSalary: 'INTEGER DEFAULT 90',
    jobWorkProgress: 'INTEGER DEFAULT 0',
    lifetimeWorkCount: 'INTEGER DEFAULT 0',
    lifetimeWorkEarnings: 'INTEGER DEFAULT 0',
    lastWorkedAt: 'TEXT',
    promotionStatus: "TEXT DEFAULT 'READY'"
    ,weeklyCycleStart: 'TEXT'
    ,weeklyStartedOnMonday: 'INTEGER DEFAULT 0'
    ,weeklyClaimDays: "TEXT DEFAULT '[]'"
    ,weeklyRewardClaimed: 'INTEGER DEFAULT 0'
    ,dailyLongestStreak: 'INTEGER DEFAULT 0'
    ,fishCount: 'INTEGER DEFAULT 0'
    ,begCount: 'INTEGER DEFAULT 0'
    ,scratchcardCount: 'INTEGER DEFAULT 0'
    ,lotteryEntryCount: 'INTEGER DEFAULT 0'
    ,moneySpent: 'INTEGER DEFAULT 0'
    ,uiStyle: "TEXT DEFAULT 'hightech'"
    ,xp: 'INTEGER DEFAULT 0'
    ,level: 'INTEGER DEFAULT 0'
    ,totalMessageCount: 'INTEGER DEFAULT 0'
    ,lastSeenAt: 'TEXT'
    ,timezone: 'INTEGER DEFAULT 0'
    ,wakeTime: 'TEXT'
    ,sleepTime: 'TEXT'
};

for (const [name, definition] of Object.entries(userMigrationColumns)) {
    if (!userColumns.has(name)) {
        db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
    }
}

// The previous placeholder job was not part of the new progression. Preserve
// those accounts by mapping them to the equivalent entry-level role.
db.prepare(`
    UPDATE users
    SET job = 'Dock Worker', careerLevel = 0, currentJobSalary = 90
    WHERE job IS NULL OR job = 'Driller'
`).run();

/* =========================
   HEISTS TABLE
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS heists (
    heistId TEXT PRIMARY KEY,
    leaderId TEXT,
    target TEXT,
    difficulty TEXT,
    entryFee INTEGER,
    status TEXT,
    maxPlayers INTEGER,
    createdAt TEXT
);
`);

/* =========================
   PARTICIPANTS TABLE
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS heist_participants (
    heistId TEXT,
    userId TEXT,
    contribution INTEGER DEFAULT 0,
    PRIMARY KEY (heistId, userId)
);
`);

/* =========================
   INVENTORY TABLE
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS inventory (
    userId TEXT NOT NULL,
    itemId TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (userId, itemId)
);

CREATE TABLE IF NOT EXISTS fishing_inventory (
    catchId INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    fishId TEXT NOT NULL,
    name TEXT NOT NULL,
    rarity TEXT NOT NULL,
    emoji TEXT NOT NULL,
    weight REAL NOT NULL,
    value INTEGER NOT NULL,
    caughtAt TEXT NOT NULL,
    soldAt TEXT,
    location TEXT
);
CREATE INDEX IF NOT EXISTS idx_fishing_inventory_user_unsold
    ON fishing_inventory(userId, soldAt);

CREATE TABLE IF NOT EXISTS fishing_equipment (
    userId TEXT PRIMARY KEY,
    rodTier INTEGER NOT NULL DEFAULT 0,
    baitTier INTEGER NOT NULL DEFAULT 0,
    netTier INTEGER NOT NULL DEFAULT 0,
    locationTier INTEGER NOT NULL DEFAULT 0
);
`);

// Older databases may predate fishing location ownership — add the column.
try {
    db.prepare('SELECT locationTier FROM fishing_equipment LIMIT 1').get();
} catch {
    db.exec('ALTER TABLE fishing_equipment ADD COLUMN locationTier INTEGER NOT NULL DEFAULT 0');
}

/* =========================
   MINING SYSTEM
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS mining_profile (
    userId TEXT PRIMARY KEY,
    miningLevel INTEGER NOT NULL DEFAULT 1,
    miningXp INTEGER NOT NULL DEFAULT 0,
    activeDrill TEXT NOT NULL DEFAULT 'basic_drill',
    activeLocation TEXT NOT NULL DEFAULT 'quantum_craters',
    unlockedLocations TEXT NOT NULL DEFAULT '["quantum_craters"]',
    ownedDrills TEXT NOT NULL DEFAULT '["basic_drill"]',
    boostTier INTEGER NOT NULL DEFAULT 0,
    droneTier INTEGER NOT NULL DEFAULT 0,
    mineCooldown INTEGER NOT NULL DEFAULT 0,
    relicsFound INTEGER NOT NULL DEFAULT 0,
    totalMines INTEGER NOT NULL DEFAULT 0,
    totalOreFound INTEGER NOT NULL DEFAULT 0,
    miningStreak INTEGER NOT NULL DEFAULT 0,
    lastMineTime TEXT
);

CREATE TABLE IF NOT EXISTS mining_inventory (
    userId TEXT NOT NULL,
    oreId TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (userId, oreId)
);

CREATE TABLE IF NOT EXISTS mining_progress (
    userId TEXT PRIMARY KEY,
    progress INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    combo INTEGER NOT NULL DEFAULT 0,
    targetOreId TEXT NOT NULL,
    savedAt TEXT NOT NULL,
    creditedProgress INTEGER NOT NULL DEFAULT 0
);
`);

const miningProgressColumns = new Set(
    db.prepare('PRAGMA table_info(mining_progress)').all().map(column => column.name)
);
if (!miningProgressColumns.has('creditedProgress')) {
    db.exec('ALTER TABLE mining_progress ADD COLUMN creditedProgress INTEGER NOT NULL DEFAULT 0');
}

const miningProfileColumns = new Set(
    db.prepare('PRAGMA table_info(mining_profile)').all().map(column => column.name)
);
if (!miningProfileColumns.has('ownedDrills')) {
    db.exec(`ALTER TABLE mining_profile ADD COLUMN ownedDrills TEXT NOT NULL DEFAULT '["basic_drill"]'`);
}
if (!miningProfileColumns.has('boostTier')) {
    db.exec('ALTER TABLE mining_profile ADD COLUMN boostTier INTEGER NOT NULL DEFAULT 0');
}

if (!userColumns.has('mining_bank')) {
    db.exec('ALTER TABLE users ADD COLUMN mining_bank INTEGER NOT NULL DEFAULT 0');
}

/* =========================
   MINING EXPANSION
========================= */
db.exec(`
    CREATE TABLE IF NOT EXISTS mining_contracts (
        contractId INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL,
        title TEXT NOT NULL,
        targetOre TEXT NOT NULL,
        targetQuantity INTEGER NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        reward INTEGER NOT NULL DEFAULT 0,
        xpReward INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        acceptedAt TEXT NOT NULL,
        completedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mining_contracts_user_status
        ON mining_contracts(userId, status);

    CREATE TABLE IF NOT EXISTS mining_drones (
        userId TEXT PRIMARY KEY,
        tier INTEGER NOT NULL DEFAULT 0,
        assignedLocation TEXT,
        lastCollectedAt TEXT,
        totalOreCollected INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS mining_workers (
        workerId INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL,
        name TEXT NOT NULL,
        specialty TEXT NOT NULL DEFAULT 'excavator',
        efficiency INTEGER NOT NULL DEFAULT 1,
        hiredAt TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_mining_workers_user ON mining_workers(userId, active);

    CREATE TABLE IF NOT EXISTS mining_refined_inventory (
        userId TEXT NOT NULL,
        materialId TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(userId, materialId)
    );

    CREATE TABLE IF NOT EXISTS mining_events (
        eventId INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        multiplier REAL NOT NULL DEFAULT 1,
        eventType TEXT NOT NULL DEFAULT 'yield',
        startsAt TEXT NOT NULL,
        endsAt TEXT NOT NULL,
        locationId TEXT,
        announced INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mining_events_active ON mining_events(startsAt, endsAt);

    CREATE TABLE IF NOT EXISTS mining_artifacts (
        userId TEXT NOT NULL,
        artifactId TEXT NOT NULL,
        name TEXT NOT NULL,
        rarity TEXT NOT NULL,
        value INTEGER NOT NULL DEFAULT 0,
        discoveredAt TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(userId, artifactId)
    );

    CREATE TABLE IF NOT EXISTS mining_guilds (
        guildId INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        ownerId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        totalOre INTEGER NOT NULL DEFAULT 0,
        totalCredits INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mining_guild_members (
        guildId INTEGER NOT NULL,
        userId TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        joinedAt TEXT NOT NULL,
        PRIMARY KEY(guildId, userId)
    );
    CREATE TABLE IF NOT EXISTS mining_guild_contributions (
        guildId INTEGER NOT NULL,
        userId TEXT NOT NULL,
        season TEXT NOT NULL,
        ore INTEGER NOT NULL DEFAULT 0,
        credits INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(guildId, userId, season)
    );

    -- Shared guild treasury for the daily payroll: 10% of every member's
    -- /mine deposit is tithed here per season, then split equally among all
    -- members every 24h (see systems/mining/guildPerks.js).
    CREATE TABLE IF NOT EXISTS mining_guild_fund (
        guildId INTEGER NOT NULL,
        season TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(guildId, season)
    );

    CREATE TABLE IF NOT EXISTS mining_season_stats (
        season TEXT NOT NULL,
        userId TEXT NOT NULL,
        oreMined INTEGER NOT NULL DEFAULT 0,
        creditsEarned INTEGER NOT NULL DEFAULT 0,
        artifactsFound INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(season, userId)
    );

    -- Persistent Monopoly-style mine claims.  A claim is owned by one user and
    -- its level increases that user's extraction yield and mining-bank income.
    CREATE TABLE IF NOT EXISTS mining_properties (
        userId TEXT NOT NULL,
        propertyId TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 1,
        purchasedAt TEXT NOT NULL,
        PRIMARY KEY(userId, propertyId)
    );
`);

/* =========================
   CASINO SYSTEM
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS casino_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_acknowledgements (
    userId TEXT PRIMARY KEY,
    acknowledgedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_limits (
    userId TEXT PRIMARY KEY,
    pausedUntil TEXT
);

CREATE TABLE IF NOT EXISTS casino_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    game TEXT NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balanceAfter INTEGER NOT NULL,
    note TEXT,
    createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_sessions (
    sessionId TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    game TEXT NOT NULL,
    channelId TEXT NOT NULL,
    state TEXT NOT NULL,
    payload TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_profiles (
    userId TEXT PRIMARY KEY,
    cardBack TEXT NOT NULL DEFAULT 'neon-grid',
    chipSkin TEXT NOT NULL DEFAULT 'cyan-core',
    tableTheme TEXT NOT NULL DEFAULT 'midnight-grid',
    dealerStyle TEXT NOT NULL DEFAULT 'neural-dealer',
    badge TEXT NOT NULL DEFAULT 'rookie'
);

CREATE TABLE IF NOT EXISTS casino_unlocks (
    userId TEXT NOT NULL,
    cosmeticId TEXT NOT NULL,
    unlockedAt TEXT NOT NULL,
    PRIMARY KEY (userId, cosmeticId)
);

CREATE TABLE IF NOT EXISTS casino_achievements (
    userId TEXT NOT NULL,
    achievementId TEXT NOT NULL,
    earnedAt TEXT NOT NULL,
    PRIMARY KEY (userId, achievementId)
);

CREATE TABLE IF NOT EXISTS five_dice_stats (
    userId TEXT PRIMARY KEY,
    gamesPlayed INTEGER NOT NULL DEFAULT 0,
    gamesWon INTEGER NOT NULL DEFAULT 0,
    totalCredits INTEGER NOT NULL DEFAULT 0,
    highestPayout INTEGER NOT NULL DEFAULT 0,
    currentStreak INTEGER NOT NULL DEFAULT 0,
    bestStreak INTEGER NOT NULL DEFAULT 0,
    fiveOfAKind INTEGER NOT NULL DEFAULT 0,
    fourOfAKind INTEGER NOT NULL DEFAULT 0,
    fullHouses INTEGER NOT NULL DEFAULT 0,
    achievements TEXT NOT NULL DEFAULT '[]',
    dailyDateKey TEXT,
    dailyCompleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mini_game_stats (
    userId TEXT NOT NULL,
    game TEXT NOT NULL,
    gamesPlayed INTEGER NOT NULL DEFAULT 0,
    gamesWon INTEGER NOT NULL DEFAULT 0,
    creditsEarned INTEGER NOT NULL DEFAULT 0,
    bestPayout INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (userId, game)
);

CREATE TABLE IF NOT EXISTS high_low_stats (
    userId TEXT PRIMARY KEY,
    roundsPlayed INTEGER NOT NULL DEFAULT 0,
    roundsWon INTEGER NOT NULL DEFAULT 0,
    gamesPlayed INTEGER NOT NULL DEFAULT 0,
    gamesWon INTEGER NOT NULL DEFAULT 0,
    totalWinnings INTEGER NOT NULL DEFAULT 0,
    highestPayout INTEGER NOT NULL DEFAULT 0,
    currentStreak INTEGER NOT NULL DEFAULT 0,
    bestStreak INTEGER NOT NULL DEFAULT 0,
    luckyRounds INTEGER NOT NULL DEFAULT 0,
    mysteryMultipliers INTEGER NOT NULL DEFAULT 0,
    twoXMultipliers INTEGER NOT NULL DEFAULT 0,
    pvpGames INTEGER NOT NULL DEFAULT 0,
    pvpWins INTEGER NOT NULL DEFAULT 0,
    progressionXP INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 1,
    achievements TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS lights_out_stats (
    userId TEXT PRIMARY KEY,
    gamesPlayed INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    totalMoves INTEGER NOT NULL DEFAULT 0,
    bestMoves INTEGER,
    bestTimeMs INTEGER,
    currentStreak INTEGER NOT NULL DEFAULT 0,
    bestStreak INTEGER NOT NULL DEFAULT 0,
    hintsUsed INTEGER NOT NULL DEFAULT 0,
    perfectWins INTEGER NOT NULL DEFAULT 0,
    dailyWins INTEGER NOT NULL DEFAULT 0,
    challengesWon INTEGER NOT NULL DEFAULT 0,
    battlesWon INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS lights_out_daily_wins (
    userId TEXT NOT NULL,
    dateKey TEXT NOT NULL,
    PRIMARY KEY (userId, dateKey)
);

CREATE TABLE IF NOT EXISTS netquel_highscores (
    userId TEXT PRIMARY KEY,
    score INTEGER NOT NULL,
    setBy TEXT NOT NULL,
    setAt TEXT NOT NULL,
    note TEXT
);

/* Per-mode highscores: same schema, keyed by mode (ffa, forge, ...). */
CREATE TABLE IF NOT EXISTS netquel_highscores_mode (
    userId TEXT NOT NULL,
    mode TEXT NOT NULL,
    score INTEGER NOT NULL,
    setBy TEXT NOT NULL,
    setAt TEXT NOT NULL,
    note TEXT,
    PRIMARY KEY (userId, mode)
);

/* Timed role grants (xp/mega xp boost roles, etc.) — auto-expired by a ticker. */
CREATE TABLE IF NOT EXISTS timed_roles (
    userId TEXT NOT NULL,
    roleId TEXT NOT NULL,
    expiresAt INTEGER NOT NULL,
    source TEXT,
    PRIMARY KEY (userId, roleId)
);

/* SLASH services (custom spaces/roles/emojis) — one row per purchase.
 * Ownership (not stackable inventory) drives the per-choice purchase limits. */
CREATE TABLE IF NOT EXISTS service_purchases (
    userId TEXT NOT NULL,
    serviceId TEXT NOT NULL,
    price INTEGER NOT NULL,
    purchasedAt TEXT NOT NULL,
    PRIMARY KEY (userId, serviceId)
);

/* Cooldown ping subscriptions (work/fish/mine). Permanent ownership with an
 * on/off toggle — /toggle-ping flips the enabled column. */
CREATE TABLE IF NOT EXISTS ping_subscriptions (
    userId TEXT NOT NULL,
    command TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (userId, command)
);

/* Auto-deposit subscription: nightly wallet→bank sweep while active.
 * stacks tracks how many 30-day purchases were applied (limit 3). */
CREATE TABLE IF NOT EXISTS auto_deposit_subscriptions (
    userId TEXT PRIMARY KEY,
    expiresAt INTEGER NOT NULL,
    stacks INTEGER NOT NULL DEFAULT 1
);

/* User birthdays (YYYY-MM-DD; year 2000 placeholder when unknown). */
CREATE TABLE IF NOT EXISTS birthdays (
    userId TEXT PRIMARY KEY,
    birthday TEXT NOT NULL,
    year INTEGER,
    setAt TEXT NOT NULL
);

/* Purchased /daily Streak Protection: N cover days remaining per user. */
CREATE TABLE IF NOT EXISTS streak_protection (
    userId TEXT PRIMARY KEY,
    coverDays INTEGER NOT NULL DEFAULT 0,
    purchasedAt TEXT
);

-- Small key/value store for bot-managed state such as the pinned
-- highscore leaderboard message id.
CREATE TABLE IF NOT EXISTS bot_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Tracks live fishing sessions so a user can only run one /fish at a time.
-- A new /fish TAKES OVER any existing session (close the old game, start fresh);
-- messageId lets the takeover strip the dead game's buttons.
CREATE TABLE IF NOT EXISTS fish_sessions (
    userId TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    messageId TEXT,
    startedAt INTEGER NOT NULL
);

-- Game Night suite tables.
-- Roulette: message_id is UNIQUE so one embed can only host one live wheel.
CREATE TABLE IF NOT EXISTS gamenight_roulette (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'betting',
    round INTEGER NOT NULL DEFAULT 1,
    ends_at INTEGER,
    pockets TEXT NOT NULL,
    pot TEXT NOT NULL DEFAULT '{}',
    history TEXT NOT NULL DEFAULT '[]',
    createdBy TEXT
);

-- Guess the Number: one live round per channel, shared pot, last-writer-wins guesses.
CREATE TABLE IF NOT EXISTS gamenight_guess (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL UNIQUE,
    phase TEXT NOT NULL DEFAULT 'active',
    number INTEGER NOT NULL,
    range_min INTEGER NOT NULL,
    range_max INTEGER NOT NULL,
    pot INTEGER NOT NULL DEFAULT 0,
    guesses TEXT NOT NULL DEFAULT '{}',
    round INTEGER NOT NULL DEFAULT 1,
    ends_at INTEGER,
    last_winner_id TEXT,
    last_number INTEGER
);

-- QOTD / quote bank: populated by the watch-emoji logging hook.
CREATE TABLE IF NOT EXISTS quote_bank (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    authorId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    messageId TEXT NOT NULL UNIQUE,
    loggedAt INTEGER NOT NULL
);

-- Quotes already revealed as a QOTD round, so they do not repeat.
CREATE TABLE IF NOT EXISTS qotd_state (
    messageId TEXT PRIMARY KEY,
    quoteId INTEGER NOT NULL,
    phase TEXT NOT NULL DEFAULT 'open',
    endsAt INTEGER NOT NULL,
    channelId TEXT NOT NULL,
    votes TEXT NOT NULL DEFAULT '{}',
    revealed INTEGER NOT NULL DEFAULT 0
);

-- Party games (bomb defusal, math duel, mafia, spy) share a simple
-- generic session shape with JSON payloads.
CREATE TABLE IF NOT EXISTS gamenight_sessions (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    messageId TEXT,
    host_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'lobby',
    state TEXT NOT NULL DEFAULT '{}',
    ends_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gamenight_sessions_channel ON gamenight_sessions (channel_id, kind);
CREATE INDEX IF NOT EXISTS idx_quote_bank_channel ON quote_bank (channelId);



CREATE TABLE IF NOT EXISTS mastermind_stats (
    userId TEXT PRIMARY KEY,
    gamesPlayed INTEGER NOT NULL DEFAULT 0,
    gamesWon INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    timeouts INTEGER NOT NULL DEFAULT 0,
    quits INTEGER NOT NULL DEFAULT 0,
    totalAttempts INTEGER NOT NULL DEFAULT 0,
    bestAttempts INTEGER,
    fastestTimeMs INTEGER,
    perfectWins INTEGER NOT NULL DEFAULT 0,
    dailyWins INTEGER NOT NULL DEFAULT 0,
    speedrunWins INTEGER NOT NULL DEFAULT 0,
    totalRewards INTEGER NOT NULL DEFAULT 0,
    creditsSpent INTEGER NOT NULL DEFAULT 0,
    hintsUsed INTEGER NOT NULL DEFAULT 0,
    currentStreak INTEGER NOT NULL DEFAULT 0,
    bestStreak INTEGER NOT NULL DEFAULT 0,
    achievements TEXT NOT NULL DEFAULT '[]'
);
`);

// Component collectors cannot survive a bot restart. Close old persisted
// sessions so they never trap a player in an abandoned table after restart.
db.prepare(`UPDATE casino_sessions SET state = 'closed', updatedAt = ? WHERE state = 'active'`)
    .run(new Date().toISOString());

const casinoDefaults = [
    ['blackjack_max_bet', '5000']
];
const insertCasinoSetting = db.prepare(
    'INSERT OR IGNORE INTO casino_settings (key, value) VALUES (?, ?)'
);
for (const setting of casinoDefaults) insertCasinoSetting.run(...setting);

// Mining v2 intentionally starts everyone with a clean, non-clicker economy.
db.exec(`
    CREATE TABLE IF NOT EXISTS mining_economy_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
`);
const miningVersion = db.prepare('SELECT value FROM mining_economy_meta WHERE key = ?').get('version');
if (miningVersion?.value !== '2') {
    db.transaction(() => {
        for (const table of [
            'mining_progress', 'mining_inventory', 'mining_refined_inventory',
            'mining_artifacts', 'mining_workers', 'mining_drones',
            'mining_contracts', 'mining_events', 'mining_properties',
            'mining_guild_contributions', 'mining_guild_members', 'mining_guilds',
            'mining_season_stats', 'mining_profile'
        ]) {
            db.prepare(`DELETE FROM ${table}`).run();
        }
        db.prepare('UPDATE users SET mining_bank = 0').run();
        db.prepare(`
            INSERT INTO mining_economy_meta (key, value) VALUES ('version', '2')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run();
    })();
}


/*
 * Game Night self-heal: databases synced from an older schema could be
 * missing the gamenight tables or their newer columns, which used to crash
 * every boot inside the roulette/guess bootstrap handlers. CREATE ... IF NOT
 * EXISTS is idempotent, so re-asserting the shape here is always safe.
 */
db.exec(`
    CREATE TABLE IF NOT EXISTS gamenight_roulette (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'betting',
        round INTEGER NOT NULL DEFAULT 1,
        ends_at INTEGER,
        pockets TEXT NOT NULL,
        pot TEXT NOT NULL DEFAULT '{}',
        history TEXT NOT NULL DEFAULT '[]',
        createdBy TEXT
    );
    CREATE TABLE IF NOT EXISTS gamenight_guess (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL DEFAULT 'active',
        number INTEGER NOT NULL,
        range_min INTEGER NOT NULL,
        range_max INTEGER NOT NULL,
        pot INTEGER NOT NULL DEFAULT 0,
        guesses TEXT NOT NULL DEFAULT '{}',
        round INTEGER NOT NULL DEFAULT 1,
        ends_at INTEGER,
        last_winner_id TEXT,
        last_number INTEGER
    );
`);

for (const [table, column, definition] of [
    ['gamenight_roulette', 'channel_id', 'TEXT'],
    ['gamenight_roulette', 'round', 'INTEGER NOT NULL DEFAULT 1'],
    ['gamenight_roulette', 'history', "TEXT NOT NULL DEFAULT '[]'"],
    ['gamenight_guess', 'range_min', 'INTEGER NOT NULL DEFAULT 1'],
    ['gamenight_guess', 'range_max', 'INTEGER NOT NULL DEFAULT 1000'],
    ['gamenight_guess', 'user_guesses', "TEXT NOT NULL DEFAULT '{}'"],
    ['gamenight_guess', 'last_winner_id', 'TEXT'],
    ['gamenight_guess', 'last_number', 'INTEGER'],
    ['birthdays', 'note', 'TEXT'],
    ['fishing_inventory', 'location', 'TEXT'],
    ['fish_sessions', 'messageId', 'TEXT']
]) {
    try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (error) {
        // Column already exists -- nothing to heal.
    }
}

/* =========================
   DRAGON HATCHERY
   =========================
 * The flagship system. An egg is found (mine/fish/heist/shop/event), placed
 * in an incubator for 24-48h, then hatched into a dragon or beast pet.
 * `side` drives the good-side (Dragonflight) vs bad-side (Onslaught) rivalry.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS dragon_eggs (
    eggId INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    eggType TEXT NOT NULL,
    rarity TEXT NOT NULL DEFAULT 'common',
    side TEXT NOT NULL DEFAULT 'good',
    source TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    incubatorSlot INTEGER,
    incubateStartedAt TEXT,
    incubateEndsAt TEXT,
    hatchedAt TEXT,
    foundAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dragon_eggs_user ON dragon_eggs(userId, status);

CREATE TABLE IF NOT EXISTS dragon_incubators (
    userId TEXT NOT NULL,
    slot INTEGER NOT NULL,
    unlocked INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (userId, slot)
);

CREATE TABLE IF NOT EXISTS dragons (
    dragonId INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    eggId INTEGER,
    speciesId TEXT NOT NULL,
    name TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT 'good',
    rarity TEXT NOT NULL DEFAULT 'common',
    trait TEXT NOT NULL,
    trait2 TEXT,
    level INTEGER NOT NULL DEFAULT 1,
    xp INTEGER NOT NULL DEFAULT 0,
    hunger INTEGER NOT NULL DEFAULT 100,
    happiness INTEGER NOT NULL DEFAULT 100,
    power INTEGER NOT NULL DEFAULT 0,
    speed INTEGER NOT NULL DEFAULT 0,
    stamina INTEGER NOT NULL DEFAULT 0,
    bond INTEGER NOT NULL DEFAULT 0,
    fedCount INTEGER NOT NULL DEFAULT 0,
    trainCount INTEGER NOT NULL DEFAULT 0,
    playCount INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0,
    lastFedAt TEXT,
    lastTrainedAt TEXT,
    lastPlayedAt TEXT,
    hatchedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dragons_user ON dragons(userId, active);

CREATE TABLE IF NOT EXISTS dragon_feed_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dragonId INTEGER NOT NULL,
    userId TEXT NOT NULL,
    foodType TEXT NOT NULL,
    foodName TEXT NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    fedAt TEXT NOT NULL
);

`);

/* =========================
   QUESTS / ACHIEVEMENTS / BADGES
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS quest_progress (
    userId TEXT NOT NULL,
    questId TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT 'daily',
    dateKey TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    claimed INTEGER NOT NULL DEFAULT 0,
    claimedAt TEXT,
    PRIMARY KEY (userId, questId, period, dateKey)
);
CREATE INDEX IF NOT EXISTS idx_quest_progress_user ON quest_progress(userId, period, dateKey);

CREATE TABLE IF NOT EXISTS badges (
    userId TEXT NOT NULL,
    badgeId TEXT NOT NULL,
    earnedAt TEXT NOT NULL,
    PRIMARY KEY (userId, badgeId)
);

CREATE TABLE IF NOT EXISTS cosmetic_titles (
    userId TEXT NOT NULL,
    titleId TEXT NOT NULL,
    equipped INTEGER NOT NULL DEFAULT 0,
    acquiredAt TEXT NOT NULL,
    PRIMARY KEY (userId, titleId)
);

CREATE TABLE IF NOT EXISTS quest_stats (
    userId TEXT PRIMARY KEY,
    questsClaimed INTEGER NOT NULL DEFAULT 0,
    badgesEarned INTEGER NOT NULL DEFAULT 0,
    dailyStreak INTEGER NOT NULL DEFAULT 0,
    lastDailyKey TEXT
);

`);

/* =========================
   FISHING TOURNAMENTS
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS fishing_tournaments (
    tournamentId INTEGER PRIMARY KEY AUTOINCREMENT,
    channelId TEXT NOT NULL,
    messageId TEXT,
    name TEXT NOT NULL DEFAULT 'Neon Fishing Derby',
    pot INTEGER NOT NULL DEFAULT 0,
    entryFee INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'live',
    startsAt INTEGER NOT NULL,
    endsAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fishing_tournament_scores (
    tournamentId INTEGER NOT NULL,
    userId TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    catches INTEGER NOT NULL DEFAULT 0,
    bestRarity TEXT,
    PRIMARY KEY (tournamentId, userId)
);
CREATE TABLE IF NOT EXISTS fishing_tournament_records (
    userId TEXT PRIMARY KEY,
    wins INTEGER NOT NULL DEFAULT 0,
    podiums INTEGER NOT NULL DEFAULT 0,
    bestScore INTEGER NOT NULL DEFAULT 0,
    tournaments INTEGER NOT NULL DEFAULT 0
);

`);

/* =========================
   MARKET PVP ROUNDS (/invest)
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS market_rounds (
    roundId INTEGER PRIMARY KEY AUTOINCREMENT,
    oreId TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    startPrice REAL NOT NULL,
    endPrice REAL,
    startedAt INTEGER NOT NULL,
    endsAt INTEGER NOT NULL,
    settledAt INTEGER,
    outcome TEXT
);
CREATE TABLE IF NOT EXISTS market_bets (
    betId INTEGER PRIMARY KEY AUTOINCREMENT,
    roundId INTEGER NOT NULL,
    userId TEXT NOT NULL,
    oreId TEXT NOT NULL,
    direction TEXT NOT NULL,
    amount INTEGER NOT NULL,
    payout INTEGER NOT NULL DEFAULT 0,
    settled INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    UNIQUE(roundId, userId)
);
CREATE TABLE IF NOT EXISTS market_pvp_stats (
    userId TEXT PRIMARY KEY,
    rounds INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    netCredits INTEGER NOT NULL DEFAULT 0,
    bestPayout INTEGER NOT NULL DEFAULT 0,
    contrarianWins INTEGER NOT NULL DEFAULT 0
);

`);

/* =========================
   BOUNTIES
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS bounties (
    targetId TEXT PRIMARY KEY,
    amount INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bounty_contributions (
    targetId TEXT NOT NULL,
    contributorId TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (targetId, contributorId)
);

`);

/* =========================
   REMINDERS
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS reminders (
    reminderId INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    channelId TEXT,
    message TEXT NOT NULL,
    dueAt INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(delivered, dueAt);

`);

/* =========================
   PLAYER TRADES
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS trades (
    tradeId TEXT PRIMARY KEY,
    initiatorId TEXT NOT NULL,
    partnerId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    messageId TEXT,
    giveItems TEXT NOT NULL DEFAULT '[]',
    giveCredits INTEGER NOT NULL DEFAULT 0,
    giveAccount TEXT NOT NULL DEFAULT 'wallet',
    receiveItems TEXT NOT NULL DEFAULT '[]',
    receiveCredits INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    initiatorConfirmed INTEGER NOT NULL DEFAULT 0,
    partnerConfirmed INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
);

`);

/* =========================
   DRAGON RACING
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS dragon_races (
    raceId INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'open',
    trackId TEXT NOT NULL DEFAULT 'ember_canyon',
    entrants TEXT NOT NULL DEFAULT '[]',
    pot INTEGER NOT NULL DEFAULT 0,
    winnerDragonId INTEGER,
    startsAt INTEGER NOT NULL,
    endsAt INTEGER NOT NULL,
    settledAt INTEGER
);
CREATE TABLE IF NOT EXISTS dragon_race_bets (
    betId INTEGER PRIMARY KEY AUTOINCREMENT,
    raceId INTEGER NOT NULL,
    userId TEXT NOT NULL,
    dragonId INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    payout INTEGER NOT NULL DEFAULT 0,
    settled INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    UNIQUE(raceId, userId)
);
CREATE TABLE IF NOT EXISTS dragon_race_records (
    dragonId INTEGER PRIMARY KEY,
    races INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    bestTime REAL,
    earnings INTEGER NOT NULL DEFAULT 0
);

`);

/* =========================
   TIC-TAC-TOE ELO LADDER
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS ttt_elo (
    userId TEXT PRIMARY KEY,
    elo INTEGER NOT NULL DEFAULT 1000,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 0,
    bestStreak INTEGER NOT NULL DEFAULT 0,
    peakElo INTEGER NOT NULL DEFAULT 1000,
    updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ttt_matches (
    matchId INTEGER PRIMARY KEY AUTOINCREMENT,
    challengerId TEXT NOT NULL,
    opponentId TEXT NOT NULL,
    winnerId TEXT,
    result TEXT NOT NULL,
    challengerDelta INTEGER NOT NULL DEFAULT 0,
    opponentDelta INTEGER NOT NULL DEFAULT 0,
    playedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ttt_promotions (
    userId TEXT NOT NULL,
    weekKey TEXT NOT NULL,
    rank INTEGER NOT NULL,
    elo INTEGER NOT NULL,
    awardedAt TEXT NOT NULL,
    PRIMARY KEY (userId, weekKey)
);

`);

/* =========================
   FLASH DEALS / SEASONAL / CAPSULES
========================= */
db.exec(`
CREATE TABLE IF NOT EXISTS flash_deals (
    dealId INTEGER PRIMARY KEY AUTOINCREMENT,
    itemId TEXT NOT NULL,
    discount INTEGER NOT NULL,
    dateKey TEXT NOT NULL,
    startsAt INTEGER NOT NULL,
    endsAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flash_deals_date ON flash_deals(dateKey);

CREATE TABLE IF NOT EXISTS seasonal_claims (
    userId TEXT NOT NULL,
    event TEXT NOT NULL,
    dayKey TEXT NOT NULL,
    reward TEXT,
    claimedAt TEXT NOT NULL,
    PRIMARY KEY (userId, event, dayKey)
);

CREATE TABLE IF NOT EXISTS credit_capsules (
    capsuleId INTEGER PRIMARY KEY AUTOINCREMENT,
    channelId TEXT NOT NULL,
    messageId TEXT,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'live',
    spawnedAt INTEGER NOT NULL,
    endsAt INTEGER NOT NULL,
    claimedBy TEXT,
    claimedAt INTEGER
);

/* Global rarity tally for the server-wide dragon/beast rivalry meter. */
CREATE TABLE IF NOT EXISTS dragon_season_stats (
    season TEXT NOT NULL,
    userId TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT 'good',
    eggsFound INTEGER NOT NULL DEFAULT 0,
    dragonsHatched INTEGER NOT NULL DEFAULT 0,
    racesWon INTEGER NOT NULL DEFAULT 0,
    battlesWon INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (season, userId)
);
`);

/*
 * Heist escalation (3 higher tiers gated on role composition) reuses the
 * existing heists/heist_participants tables — those predate tiers, so the new
 * columns are added defensively. `rolePlan` is JSON {hacker:n, driver:n,
 * muscle:n}; participants pick a role that must satisfy it.
 */
db.exec(`
    CREATE TABLE IF NOT EXISTS heist_runs (
        runId TEXT PRIMARY KEY,
        heistId TEXT,
        tier TEXT NOT NULL DEFAULT 'standard',
        target TEXT NOT NULL,
        requiredPlayers INTEGER NOT NULL DEFAULT 2,
        rolePlan TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'lobby',
        outcome TEXT,
        payout INTEGER NOT NULL DEFAULT 0,
        log TEXT NOT NULL DEFAULT '[]',
        startedAt INTEGER,
        resolvedAt INTEGER
    );
`);

for (const [table, column, definition] of [
    ['heists', 'tier', "TEXT NOT NULL DEFAULT 'standard'"],
    ['heists', 'rolePlan', "TEXT NOT NULL DEFAULT '{}'"],
    ['heists', 'target', 'TEXT'],
    ['heist_participants', 'role', 'TEXT'],
    ['heists', 'log', "TEXT NOT NULL DEFAULT '[]'"],
    ['heists', 'resolvedAt', 'TEXT'],
    ['heists', 'payout', 'INTEGER NOT NULL DEFAULT 0']
]) {
    try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (error) {
        // Column already exists -- nothing to heal.
    }
}

/* Titles equipped per user (one at a time) get resolved through
 * cosmetic_titles; nothing extra to migrate. */

module.exports = db;

