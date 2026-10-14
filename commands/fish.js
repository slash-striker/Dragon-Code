const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');

const db = require('../database');
const { addItem } = require('../systems/economy/inventoryh');
const { setCooldown, getRemainingTime, formatRemainingTime } = require('../systems/economy/cooldownManager');
const { getColor, formatTitle, formatFieldName, isHighTech } = require('../systems/economy/uiStyleHelper');
const { getUser } = require('../systems/economy/userManager');
const { getItemQuantity, removeItem } = require('../systems/economy/shopItems');
const {
    getBonuses, recordCatch, getOwnedLocations, getNextLocationUnlock, purchaseNextLocation,
    EQUIPMENT, MAX_LOCATION_TIER, getEquipment, getAvailableUpgrades, upgrade
} = require('../systems/economy/fishingManager');
const { logTransaction } = require('../systems/economy/transactionLogger');
const dragonManager = require('../systems/dragons/dragonManager');
const questManager = require('../systems/economy/questManager');
const fishingTournament = require('../systems/economy/fishingTournament');
const seasonalEvents = require('../systems/economy/seasonalEvents');

/*
 * /fish HUB — bare `/fish` opens this main embed (menu below) instead of
 * dropping the angler straight into a session. Every action is also a
 * slash option, so both doors stay open; the select menu + cast button
 * here cover the interactive paths and the rest gives a one-line pointer.
 */
const FISH_HUB_ACTIONS = [
    { value: 'fish:hub:cast', label: '🎣 Cast — go fishing (the main game)', emoji: '', description: 'Start a fishing session right here on this message' },
    { value: 'fish:hub:view', label: '📖 Collection log — species dex', emoji: '', description: 'Use /fish action:view (or /fish-collection)' },
    { value: 'fish:hub:sell', label: '💰 Sell — sell a fish type & amount', emoji: '', description: 'Use /fish action:sell and pick a species + amount' },
    { value: 'fish:hub:sell-all', label: '💰 Sell all — cash in everything stored', emoji: '', description: 'Use /fish action:sell-all' },
    { value: 'fish:hub:shop', label: '🛒 Shop — rod, bait & net upgrades', emoji: '', description: 'Use /fish action:shop' },
    { value: 'fish:hub:shop-location', label: '🌊 Unlock next fishing location', emoji: '', description: 'Use /fish action:shop-location' },
    { value: 'fish:hub:inventory', label: '🎒 Inventory — stored fish & loadout', emoji: '', description: 'Use /fish action:inventory' },
    { value: 'fish:hub:tournament', label: '🏆 Tournament — live derby standings', emoji: '', description: 'The pot, the leaderboard and how much time is left' }
];

function fishHubEmbed(userId, user) {
    const name = user?.displayName ?? user?.username ?? 'Angler';
    const catches = db.prepare('SELECT COUNT(*) AS n FROM fishing_inventory WHERE userId = ?').get(userId)?.n ?? 0;
    const owned = getOwnedLocations(userId);
    const equipment = getEquipment(userId);
    return new EmbedBuilder()
        .setColor(getColor(userId, 0x00d4ff))
        .setTitle(formatTitle(userId, '🌊 NEURAL OCEAN FISHING — MAIN TERMINAL', 'Fishing'))
        .setDescription(
            `**Welcome back, ${name}.** Pick an action below — or just hit 🎣 to cast.\n\n` +
            `🎣 Rod: **${equipment.rod.name}** · 🪱 Bait: **${equipment.bait.name}** · 🕸️ Net: **${equipment.net.name}**\n` +
            `📍 Locations owned: **${owned.length}/${MAX_LOCATION_TIER + 1}** — ${owned.map(l => l.emoji).join(' ') || ' shoreline only'}\n` +
            `🐟 Lifetime catches logged: **${catches.toLocaleString()}**\n\n` +
            '_Slashing works too: every action below is also an option on `/fish` (e.g. `/fish action:inventory`)._' )
        .setFooter({ text: '/fish casts instantly when nothing is picked before • this menu never expires' })
        .setTimestamp();
}

function fishHubRows() {
    const menuRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('fish:hub:menu')
            .setPlaceholder('Choose your next move…')
            .addOptions(FISH_HUB_ACTIONS.map(a =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(a.label)
                    .setValue(a.value)
                    .setDescription(a.description))));
    const castRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('fish:hub:cast')
            .setLabel('Cast Now')
            .setEmoji('🎣')
            .setStyle(ButtonStyle.Primary));
    return [menuRow, castRow];
}

/* The session functions reply() as if they were a fresh slash command —
   wrap the component interaction so runFishingGame can drive it exactly
   like a slash (reply → first message, followUp etc.).
   
   IMPORTANT: handleComponent must NOT call deferUpdate() before passing
   the facade to a runner — the facade owns the deferral so it happens
   exactly once and update()/editReply() never hit InteractionAlreadyReplied.
*/
function safeUpdate(interaction, payload) {
    // Works on both a real Discord.js interaction and the hub facade:
    //   - real ChatInputCommandInteraction: editReply() is the real API.
    //   - hub facade: editReply() is aliased to interaction.update(...args).
    // Both are ASYNC: InteractionAlreadyReplied arrives as a rejected promise,
    // which a synchronous try/catch around the call cannot see — so the
    // fallback lives in .catch(), which also covers synchronous throws.
    // On InteractionAlreadyReplied (the reply was already sent, not just
    // deferred), fall back to followUp() — used elsewhere in this codebase on
    // real interactions and exposed by the facade.
    return Promise.resolve()
        .then(() => interaction.editReply(payload))
        .catch(error => {
            if (error && (error.code === 'InteractionAlreadyReplied' || error.status === 40062)) {
                return interaction.followUp(payload).catch(() => {});
            }
            throw error;
        });
}

function facadeForHubComponent(interaction) {
    const ack = { done: false };
    return {
        user: interaction.user,
        member: interaction.member,
        guild: interaction.guild,
        client: interaction.client,
        channel: interaction.channel,
        channelId: interaction.channelId,
        options: { getString: () => null, getInteger: () => null, getUser: () => null, getBoolean: () => null },
        customId: interaction.customId,
        createdTimestamp: interaction.createdTimestamp,
        get deferred() { return ack.done; },
        get replied() { return ack.done; },
        deferReply: async () => { await interaction.deferUpdate().catch(() => {}); ack.done = true; },
        reply: async () => { ack.done = true; return interaction.update({}); },
        editReply: (...args) => interaction.update(...args),
        fetchReply: async () => interaction.message,
        followUp: (...args) => interaction.followUp(...args),
        deferUpdate: async () => interaction.deferUpdate(),
        update: (...args) => interaction.update(...args)
    };
}

async function runFishHub(interaction) {
    await interaction.deferReply();
    // Bare /fish is now an embed-only terminal — no interactive menu attached.
    // The action selector on /fish itself (and /fish action:cast) is the path
    // into a session; this message is a read-only status board that survives
    // bot restarts because index.js routes every `fish:hub:` interaction back
    // to handleComponent.
    await safeUpdate(interaction, {
        embeds: [fishHubEmbed(interaction.user.id, interaction.user)]
    });
}

const RARITY_STYLES = {
    Junk: { color: 0x6b7280, emoji: '⚪' },
    Common: { color: 0x22c55e, emoji: '🟢' },
    Uncommon: { color: 0x14b8a6, emoji: '🩵' },
    Rare: { color: 0x3b82f6, emoji: '🔵' },
    Epic: { color: 0xa855f7, emoji: '🟣' },
    Mythic: { color: 0xf97316, emoji: '🟠' },
    Legendary: { color: 0xffd700, emoji: '🟡' },
    Impossible: { color: 0xff4dff, emoji: '🔮' },
    'LEGENDARY EVENT': { color: 0xffd700, emoji: '🌟' }
};

/* =========================
   COLLECTION LOG QUERIES
   Defined HERE, not imported from fishingManager, so the dex and sell
   commands can never crash from a stale host copy of that module (the
   "getDex is not a function" failure). All are pure SQL against
   fishing_inventory with the same return shapes fishingManager used.
========================= */

function getDex(userId) {
    const rows = db.prepare(`
        SELECT fishId,
               COUNT(*)              AS caught,
               MAX(value)            AS bestValue,
               MAX(weight)           AS bestWeight,
               MAX(caughtAt)         AS lastCaught,
               SUM(CASE WHEN soldAt IS NULL THEN 1 ELSE 0 END) AS stored
        FROM fishing_inventory
        WHERE userId = ?
        GROUP BY fishId
    `).all(userId);
    return Object.fromEntries(rows.map(row => [row.fishId, row]));
}

function getCaughtSpeciesCount(userId) {
    return db.prepare('SELECT COUNT(DISTINCT fishId) AS species FROM fishing_inventory WHERE userId = ?')
        .get(userId)?.species || 0;
}

function getCollection(userId, limit = 25) {
    return db.prepare(`
        SELECT * FROM fishing_inventory
        WHERE userId = ? AND soldAt IS NULL
        ORDER BY caughtAt DESC
        LIMIT ?
    `).all(userId, limit);
}

function sellFishLocal(userId, fishId, amount) {
    return db.transaction(() => {
        const rows = db.prepare(`
            SELECT * FROM fishing_inventory
            WHERE userId = ? AND fishId = ? AND soldAt IS NULL
            ORDER BY caughtAt ASC
            LIMIT ?
        `).all(userId, fishId, amount);
        if (rows.length !== amount) return null;
        const total = rows.reduce((sum, row) => sum + row.value, 0);
        const soldAt = new Date().toISOString();
        const markSold = db.prepare('UPDATE fishing_inventory SET soldAt = ? WHERE catchId = ?');
        for (const row of rows) markSold.run(soldAt, row.catchId);
        db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(total, userId);
        return { fish: rows, total };
    })();
}

function sellAllLocal(userId) {
    return db.transaction(() => {
        // No effective limit — the total must cover EVERY stored fish.
        const rows = getCollection(userId, 1_000_000);
        if (!rows.length) return { fish: [], total: 0 };
        const total = rows.reduce((sum, row) => sum + row.value, 0);
        db.prepare('UPDATE fishing_inventory SET soldAt = ? WHERE userId = ? AND soldAt IS NULL')
            .run(new Date().toISOString(), userId);
        db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(total, userId);
        return { fish: rows, total };
    })();
}

/* =========================
   OCEAN SYSTEM
========================= */

function getTide() {
    const r = Math.random();
    if (r < 0.3) return { name: "Low Tide", bonus: 0.8 };
    if (r < 0.7) return { name: "Normal Tide", bonus: 1.0 };
    return { name: "High Tide", bonus: 1.3 };
}

function getTimeBonus() {
    const hour = new Date().getHours();
    if (hour >= 0 && hour < 6) return { name: "Deep Night", bonus: 1.4 };
    if (hour >= 18) return { name: "Dusk Waters", bonus: 1.2 };
    return { name: "Daylight", bonus: 1.0 };
}

/* =========================
   FISH DATABASE
   45 species across 9 rarities. `w` is the base roll weight inside its
   location's rarity pool (not global — see LOCATIONS below).
========================= */

const FISH = [
    // ---- Junk ----
    { id: 'plastic_bag', name: "Plastic Bag", value: 100, emoji: "🛍️", rarity: "Junk", w: 20 },
    { id: 'old_boot', name: "Old Boot", value: 200, emoji: "🥾", rarity: "Junk", w: 15 },
    { id: 'tin_can', name: "Tin Can", value: 150, emoji: "🥫", rarity: "Junk", w: 15 },
    { id: 'broken_drone', name: "Broken Drone Shell", value: 350, emoji: "🤖", rarity: "Junk", w: 8 },
    { id: 'seaweed_mass', name: "Tangled Seaweed", value: 120, emoji: "🌿", rarity: "Junk", w: 12 },
    { id: 'soggy_journal', name: "Soggy Journal Page", value: 400, emoji: "📜", rarity: "Junk", w: 5 },

    // ---- Common ----
    { id: 'small_fish', name: "Small Fish", value: 300, emoji: "🐟", rarity: "Common", w: 25 },
    { id: 'salmon', name: "Salmon", value: 400, emoji: "🐠", rarity: "Common", w: 12 },
    { id: 'tuna', name: "Tuna", value: 600, emoji: "🐟", rarity: "Common", w: 10 },
    { id: 'cod', name: "Atlantic Cod", value: 350, emoji: "🐟", rarity: "Common", w: 14 },
    { id: 'mackerel', name: "Mackerel", value: 450, emoji: "🐠", rarity: "Common", w: 12 },
    { id: 'sardine', name: "Sardine", value: 250, emoji: "🐟", rarity: "Common", w: 18 },

    // ---- Uncommon ----
    { id: 'sea_bass', name: "Neon Sea Bass", value: 800, emoji: "🐡", rarity: "Uncommon", w: 14 },
    { id: 'squid', name: "Glass Squid", value: 900, emoji: "🦑", rarity: "Uncommon", w: 12 },
    { id: 'jellyfish', name: "Lumen Jellyfish", value: 1000, emoji: "🪼", rarity: "Uncommon", w: 10 },
    { id: 'mantis_shrimp', name: "Mantis Shrimp", value: 1100, emoji: "🦐", rarity: "Uncommon", w: 9 },
    { id: 'pufferfish', name: "Volt Pufferfish", value: 1200, emoji: "🐡", rarity: "Uncommon", w: 8 },
    { id: 'barracuda', name: "Razor Barracuda", value: 1300, emoji: "🐠", rarity: "Uncommon", w: 7 },

    // ---- Rare ----
    { id: 'golden_carp', name: "Golden Carp", value: 1600, emoji: "🐡", rarity: "Rare", w: 12 },
    { id: 'rainbow_trout', name: "Rainbow Trout", value: 1800, emoji: "🌈", rarity: "Rare", w: 10 },
    { id: 'anglerfish', name: "Neon Anglerfish", value: 2000, emoji: "💡", rarity: "Rare", w: 8 },
    { id: 'swordfish', name: "Ion Swordfish", value: 2400, emoji: "⚔️", rarity: "Rare", w: 6 },
    { id: 'sturgeon', name: "Void Sturgeon", value: 2600, emoji: "🐟", rarity: "Rare", w: 5 },
    { id: 'manta_ray', name: "Chrome Manta Ray", value: 3000, emoji: "🪁", rarity: "Rare", w: 4 },

    // ---- Epic ----
    { id: 'deep_ray', name: "Deep Sea Ray", value: 3500, emoji: "🦈", rarity: "Epic", w: 10 },
    { id: 'hammerhead', name: "Hammerhead Sentinel", value: 4200, emoji: "🦈", rarity: "Epic", w: 8 },
    { id: 'octopus_king', name: "Crowned Octopus", value: 4800, emoji: "🐙", rarity: "Epic", w: 6 },
    { id: 'electric_eel', name: "Storm Eel", value: 5500, emoji: "⚡", rarity: "Epic", w: 5 },
    { id: 'phoenix_fish', name: "Phoenix Guppy", value: 6500, emoji: "🔥", rarity: "Epic", w: 3 },
    { id: 'ghost_shark', name: "Ghost Shark", value: 7500, emoji: "👻", rarity: "Epic", w: 2 },

    // ---- Mythic ----
    { id: 'kraken_fragment', name: "Kraken Fragment", value: 9000, emoji: "🐙", rarity: "Mythic", w: 10 },
    { id: 'leviathan_pup', name: "Leviathan Pup", value: 12000, emoji: "🐋", rarity: "Mythic", w: 7 },
    { id: 'chronofish', name: "Chronofish", value: 15000, emoji: "⏳", rarity: "Mythic", w: 5 },
    { id: 'quantum_ray', name: "Quantum Ray", value: 18000, emoji: "🌀", rarity: "Mythic", w: 4 },
    { id: 'obsidian_whale', name: "Obsidian Whale", value: 22000, emoji: "🐋", rarity: "Mythic", w: 3 },

    // ---- Legendary ----
    { id: 'abyssal_serpent', name: "Abyssal Serpent", value: 30000, emoji: "🐍", rarity: "Legendary", w: 8 },
    { id: 'star_eater', name: "Star Eater", value: 40000, emoji: "✨", rarity: "Legendary", w: 5 },
    { id: 'neon_kraken', name: "Neon Kraken", value: 55000, emoji: "🟣", rarity: "Legendary", w: 3 },
    { id: 'frost_leviathan', name: "Frost Leviathan", value: 70000, emoji: "❄️", rarity: "Legendary", w: 2 },

    // ---- Impossible ----
    { id: 'shrimp', name: "Shrimp", value: 100000, emoji: "🦐", rarity: "Impossible", w: 10 },
    { id: 'singularity_fish', name: "Singularity Fish", value: 150000, emoji: "🕳️", rarity: "Impossible", w: 6 },
    { id: 'beyond_fish', name: "The One Beyond", value: 250000, emoji: "🌌", rarity: "Impossible", w: 2 },

    // ---- LEGENDARY EVENT (global, not in location pools) ----
    { id: 'tropical_fish', name: "Tropical Anomaly Fish", value: 2500, emoji: "🌴🐠", rarity: "LEGENDARY EVENT", w: 0 }
];

const FISH_BY_ID = Object.fromEntries(FISH.map(f => [f.id, f]));

/* =========================
   FISHING LOCATIONS
   Each location has its own rarity pool: the weights inside a rarity tier
   are shared (the fish's `w`), but the RARITY distribution changes by
   location — deeper/more dangerous water shifts weight toward rare tiers.
   `unlock` entries name what the location is thematically gated by (flavor).
========================= */

const LOCATIONS = [
    {
        id: 'shoreline',
        name: 'Neon Shoreline',
        emoji: '🏖️',
        description: 'Shallow neon-lit shallows. Safe, but the big ones never come this close.',
        valueBonus: 1.0,
        danger: 0,
        rarities: { Junk: 42, Common: 38, Uncommon: 14, Rare: 5, Epic: 1, Mythic: 0, Legendary: 0, Impossible: 0 }
    },
    {
        id: 'neon_marina',
        name: 'Neon Marina',
        emoji: '⛵',
        description: 'Docked yachts and humming lights. A step up from the sand.',
        valueBonus: 1.1,
        danger: 0,
        rarities: { Junk: 32, Common: 36, Uncommon: 20, Rare: 9, Epic: 2.5, Mythic: 0.5, Legendary: 0, Impossible: 0 }
    },
    {
        id: 'coral_flats',
        name: 'Coral Flats',
        emoji: '🪸',
        description: 'Bioluminescent coral mazes teeming with curious mid-tier life.',
        valueBonus: 1.25,
        danger: 0.05,
        rarities: { Junk: 20, Common: 30, Uncommon: 28, Rare: 16, Epic: 5, Mythic: 1, Legendary: 0, Impossible: 0 }
    },
    {
        id: 'kelp_forest',
        name: 'Kelp Cathedral',
        emoji: '🌿',
        description: 'Towering kelp spires. Predators use the shadows — so can you.',
        valueBonus: 1.45,
        danger: 0.1,
        rarities: { Junk: 12, Common: 24, Uncommon: 28, Rare: 22, Epic: 10, Mythic: 3.5, Legendary: 0.5, Impossible: 0 }
    },
    {
        id: 'open_water',
        name: 'Open Neon Water',
        emoji: '🌊',
        description: 'Endless open water. No cover, no mercy, serious catches.',
        valueBonus: 1.7,
        danger: 0.18,
        rarities: { Junk: 6, Common: 18, Uncommon: 24, Rare: 26, Epic: 17, Mythic: 7, Legendary: 2, Impossible: 0 }
    },
    {
        id: 'trench',
        name: 'Abyssal Trench',
        emoji: '🕳️',
        description: 'The drop-off. Pressure, darkness, and things with too many teeth.',
        valueBonus: 2.2,
        danger: 0.3,
        rarities: { Junk: 2, Common: 10, Uncommon: 18, Rare: 26, Epic: 25, Mythic: 13, Legendary: 5.5, Impossible: 0.5 }
    },
    {
        id: 'singularity',
        name: 'The Singularity',
        emoji: '🌌',
        description: 'Where reality thins. Physics is optional. Legend status only.',
        valueBonus: 3.0,
        danger: 0.45,
        rarities: { Junk: 0, Common: 4, Uncommon: 10, Rare: 20, Epic: 26, Mythic: 22, Legendary: 14, Impossible: 4 }
    }
];

const LOCATION_BY_ID = Object.fromEntries(LOCATIONS.map(loc => [loc.id, loc]));

function buildRarityPool(location) {
    const pool = [];
    for (const fish of FISH) {
        const rarityWeight = location.rarities[fish.rarity];
        if (!rarityWeight || fish.rarity === 'LEGENDARY EVENT') continue;
        pool.push({ fish, weight: fish.w * rarityWeight });
    }
    return pool;
}

const POOLS = Object.fromEntries(LOCATIONS.map(loc => [loc.id, buildRarityPool(loc)]));

function rollFish(location, rarityBonus = 0) {
    // Global legendary event — rare regardless of location.
    if (Math.random() < 0.01) {
        return FISH_BY_ID.tropical_fish;
    }

    const pool = POOLS[location.id];
    const weightFor = entry => {
        const boost = ['Rare', 'Epic', 'Mythic', 'Legendary', 'Impossible'].includes(entry.fish.rarity)
            ? 1 + rarityBonus * 3
            : entry.fish.rarity === 'Common' ? 1 + rarityBonus : 1;
        return entry.weight * boost;
    };

    let total = pool.reduce((sum, entry) => sum + weightFor(entry), 0);
    let r = Math.random() * total;
    for (const entry of pool) {
        r -= weightFor(entry);
        if (r < 0) return entry.fish;
    }
    return FISH_BY_ID.sardine; // unreachable safeguard
}

function getCatchDetails(fish, location) {
    const minWeight = fish.rarity === 'Junk' ? 0.1
        : fish.rarity === 'Common' ? 0.5
        : fish.rarity === 'Rare' ? 2
        : fish.rarity === 'Uncommon' ? 1
        : fish.rarity === 'Epic' ? 4
        : fish.rarity === 'Mythic' ? 8
        : fish.rarity === 'Legendary' ? 15
        : 25;
    const maxWeight = minWeight * (fish.rarity === 'Impossible' ? 8 : 4);
    return {
        ...fish,
        weight: minWeight + Math.random() * (maxWeight - minWeight),
        location: location.name,
        description: fish.rarity === 'Junk'
            ? `Hauled out of the ${location.name}. Someone's trash.`
            : `A valuable signal pulled from the ${location.name}.`
    };
}

/* =========================
   UTIL
========================= */

const delay = ms => new Promise(r => setTimeout(r, ms));

/* Dex engine constants (declared before module.exports so the export object
   can reference DEX_COLLECTOR_MS during module evaluation). */
const DEX_PAGE_SIZE = 12;
const DEX_COLLECTOR_MS = 3 * 60_000;
const DEX_RARITY_ORDER = ['Junk', 'Common', 'Uncommon', 'Rare', 'Epic', 'Mythic', 'Legendary', 'Impossible', 'LEGENDARY EVENT'];

/* =========================
   MAIN
========================= */

module.exports = {
    data: new SlashCommandBuilder()
        .setName('fish')
        .setDescription('Neural Ocean Fishing System — cast, sell, shop, or view your log')
        /*
         * Single "/fish" entry with an action selector. Bare /fish (no action)
         * casts — the main game. The fishing shop keeps its own "gear" picker
         * (renamed from "action" to avoid clashing with the top-level one).
         */
        .addStringOption(option => option
            .setName('action')
            .setDescription('Leave empty to cast (the main game)')
            .addChoices(
                { name: '🎣 Cast — go fishing (same as leaving this empty)', value: 'cast' },
                { name: '📖 View — species collection log', value: 'view' },
                { name: '💰 Sell — sell a fish type & amount', value: 'sell' },
                { name: '💰 Sell all — sell everything stored', value: 'sell-all' },
                { name: '🛒 Shop — rod, bait & net upgrades', value: 'shop' },
                { name: '🌊 Shop location — unlock deeper water', value: 'shop-location' },
                { name: '🎒 Inventory — stored fish & loadout', value: 'inventory' }
            ))
        .addStringOption(option => option
            .setName('fish')
            .setDescription('Sell: fish type to sell')
            .setAutocomplete(true))
        .addIntegerOption(option => option.setName('amount')
            .setDescription('Sell: number of this fish to sell')
            .setMinValue(1)
            .setMaxValue(100))
        .addStringOption(option => option
            .setName('gear')
            .setDescription('Shop: view gear, or buy the next upgrade for one type')
            .addChoices(
                { name: '🔍 View gear & prices', value: 'view' },
                { name: '🎣 Buy next Rod upgrade', value: 'rod' },
                { name: '🪱 Buy next Bait upgrade', value: 'bait' },
                { name: '🕸️ Buy next Net upgrade', value: 'net' }
            ))
        .addUserOption(option => option
            .setName('user')
            .setDescription('Inventory: view another angler\'s fish inventory')),

    // Shared with /fish-collection for the species dex (collection log).
    FISH,
    LOCATIONS,
    RARITY_STYLES,

    autocomplete: fishAutocomplete,

    // Dex internals shared with /fish-collection (standalone view command).
    buildDexEmbed,
    dexComponents,
    DEX_COLLECTOR_MS,

    async execute(interaction) {
        const sub = interaction.options.getString('action');
        if (!sub) {
            // Bare /fish — the main hub embed.
            return runFishHub(interaction);
        }
        if (sub === 'view') return runCollectionView(interaction);
        if (sub === 'sell') return runFishSell(interaction);
        if (sub === 'sell-all') return runFishSellAll(interaction);
        if (sub === 'shop') return runFishingShop(interaction);
        if (sub === 'shop-location') return runFishingShopLocation(interaction);
        if (sub === 'inventory') return runFishInventory(interaction);
        // action:cast — the main fishing game.
        return runFishingGame(interaction);
    },

    handleComponent,

    runFishingGame,
};

/* =========================
   FISH INVENTORY — /fish inventory
   (absorbed the standalone /fish-inventory command)
========================= */

/* 10 rows/page — each inventory line carries emoji, name, counts, prices and
   weight (~87 chars absolute worst case), so 10 rows ≈ 880 chars stays inside
   Discord's hard 1024-character field limit. 15-row pages blew past it and
   crashed the command (CombinedPropertyError on the host). The clamp in
   buildFishInventoryEmbed remains as pure insurance. */
const FISH_INV_PAGE_SIZE = 10;

const FISH_INV_RARITY_EMOJI = {
    Junk: '⚪', Common: '🟢', Uncommon: '🩵', Rare: '🔵', Epic: '🟣',
    Mythic: '🟠', Legendary: '🟡', Impossible: '🔮', 'LEGENDARY EVENT': '🌟'
};

function getStoredFish(userId) {
    return db.prepare(`
        SELECT fishId, name, emoji, rarity,
               COUNT(*) AS quantity,
               SUM(value) AS totalValue,
               MAX(value) AS bestValue,
               MAX(weight) AS bestWeight
        FROM fishing_inventory
        WHERE userId = ? AND soldAt IS NULL
        GROUP BY fishId
        ORDER BY totalValue DESC
    `).all(userId);
}

function buildFishInventoryEmbed(target, page) {
    const targetId = target.id ?? target;
    const fish = getStoredFish(targetId);
    const user = db.prepare('SELECT wallet, bank FROM users WHERE userId = ?').get(targetId);
    const gear = db.prepare(`
        SELECT rodTier, baitTier, netTier, locationTier FROM fishing_equipment
        WHERE userId = ?
    `).get(targetId);
    const bigCatch = fish.length
        ? db.prepare(`
            SELECT name, emoji, value FROM fishing_inventory
            WHERE userId = ? AND soldAt IS NULL
            ORDER BY value DESC LIMIT 1
        `).get(targetId)
        : null;

    const totalValue = fish.reduce((sum, item) => sum + item.totalValue, 0);
    const totalCount = fish.reduce((sum, item) => sum + item.quantity, 0);
    const pages = Math.max(1, Math.ceil(fish.length / FISH_INV_PAGE_SIZE));
    page = Math.min(Math.max(0, page), pages - 1);

    const entries = fish.slice(page * FISH_INV_PAGE_SIZE, (page + 1) * FISH_INV_PAGE_SIZE);
    const lines = entries.length
        ? entries.map(item =>
            `${item.emoji || '🐟'} **${item.name}** ×${item.quantity} — 🪙${Number(item.totalValue).toLocaleString()}` +
            ` · best 🪙${Number(item.bestValue).toLocaleString()}${item.bestWeight ? ` · ${Number(item.bestWeight).toFixed(2)}kg` : ''} · ${FISH_INV_RARITY_EMOJI[item.rarity] ?? ''} ${item.rarity}`
        )
        : ['_Live tank is empty — cast with `/fish` to catch something._'];

    /* Discord caps every embed field value at 1024 characters — a tank full
       of long-named species blew past that and crashed the command
       (CombinedPropertyError). Drop lines from the bottom of the page until
       the value fits; a "…+N more" note replaces the trimmed rows. */
    const FIELD_BUDGET = 1024;
    const NOTE_RESERVE = 100; // headroom for the possible “…+N more” line
    let overflow = 0;
    while (lines.join('\n').length + NOTE_RESERVE > FIELD_BUDGET && lines.length > 1) {
        lines.pop();
        overflow++;
    }
    if (overflow > 0) {
        const hiddenValue = entries.slice(entries.length - overflow)
            .reduce((sum, item) => sum + item.totalValue, 0);
        lines.push(`…+${overflow} more species on this page — 🪙${hiddenValue.toLocaleString()} (flip pages to see everything)`);
    }

    const gearLines = gear
        ? [
            `🎣 Rod: **${EQUIPMENT.rod[gear.rodTier]?.name ?? 'Starter Rod'}**`,
            `🪱 Bait: **${EQUIPMENT.bait[gear.baitTier]?.name ?? 'Basic Bait'}**`,
            `🥅 Net: **${EQUIPMENT.net[gear.netTier]?.name ?? 'Hand Net'}**`,
            `🌊 Locations unlocked: ${Number(gear.locationTier ?? 0) + 1}/${MAX_LOCATION_TIER + 1} — latest: **${LOCATIONS[Math.min(gear.locationTier ?? 0, LOCATIONS.length - 1)]?.name ?? 'Neon Shoreline'}**`
        ]
        : ['_No fishing loadout yet — visit `/fish action:shop`._'];

    const embed = new EmbedBuilder()
        .setColor(0x00d4ff)
        .setTitle(`🐟 ${(target.username ?? 'Angler')}'s Fish Inventory`)
        .setDescription(
            `**Live tank:** ${totalCount} stored fish across ${fish.length} species` +
            (bigCatch ? `\n**Trophy catch:** ${bigCatch.emoji || '🐟'} ${bigCatch.name} — 🪙${Number(bigCatch.value).toLocaleString()}` : '')
        )
        .addFields(
            { name: `🐟 Stored fish — 🪙${totalValue.toLocaleString()} (page ${page + 1}/${pages})`, value: lines.join('\n'), inline: false },
            { name: '🎣 Fishing loadout', value: gearLines.join('\n'), inline: false },
            { name: '💳 Wallet', value: `🪙 ${Number(user?.wallet ?? 0).toLocaleString()}`, inline: true },
            { name: '🏦 Bank', value: `🪙 ${Number(user?.bank ?? 0).toLocaleString()}`, inline: true }
        )
        .setFooter({ text: 'Sell with /fish action:sell or action:sell-all · collection log: /fish action:view' })
        .setTimestamp();

    return { embed, page, pages };
}

function fishInventoryComponents(userId, page, pages) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`finv_prev_${userId}_${page}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
        new ButtonBuilder().setCustomId(`finv_next_${userId}_${page}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1)
    )];
}

async function runFishInventory(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getUser('user') ?? interaction.user;
    const { embed, page, pages } = buildFishInventoryEmbed(target, 0);
    const message = await interaction.editReply({
        embeds: [embed],
        components: fishInventoryComponents(interaction.user.id, page, pages)
    });

    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 120_000
    });

    collector.on('collect', async component => {
        if (component.user.id !== interaction.user.id) {
            return component.reply({ content: 'This fish inventory belongs to another angler.', ephemeral: true });
        }
        const [, verb, , pageStr] = component.customId.split('_');
        let next = Number(pageStr) || 0;
        if (verb === 'prev') next = Math.max(0, next - 1);
        if (verb === 'next') next = next + 1;

        const built = buildFishInventoryEmbed(target, next);
        await component.update({
            embeds: [built.embed],
            components: fishInventoryComponents(interaction.user.id, built.page, built.pages)
        }).catch(() => {});
    });

    collector.on('end', async () => {
        await message.edit({ components: [] }).catch(() => {});
    });
}

/* =========================
   FISHING SHOP — /fish shop + /fish shop-location
   (absorbed the standalone /fishing-shop command)
========================= */

async function runFishingShopLocation(interaction) {
    const result = purchaseNextLocation(interaction.user.id);
    if (!result.ok) return interaction.reply({ content: `❌ ${result.message}` });
    logTransaction(interaction.user.id, 'fishing_location', -result.price, `Unlocked ${result.location.name}`);
    return interaction.reply(
        `🌊 Unlocked **${result.location.emoji} ${result.location.name}** for **🪙${result.price.toLocaleString()}**! ` +
        `Better waters mean better fish and higher value.`
    );
}

async function runFishingShop(interaction) {
    const action = interaction.options.getString('gear') ?? 'view';

    if (action === 'rod' || action === 'bait' || action === 'net') {
        const result = upgrade(interaction.user.id, action);
        if (!result.ok) return interaction.reply({ content: `❌ ${result.message}` });
        logTransaction(interaction.user.id, 'fishing_upgrade', -result.price, `Bought ${result.equipment.name}`);
        return interaction.reply(`✅ Upgraded to **${result.equipment.name}** for **🪙${result.price.toLocaleString()}**.`);
    }

    const equipment = getEquipment(interaction.user.id);
    const upgrades = getAvailableUpgrades(interaction.user.id);
    const owned = getOwnedLocations(interaction.user.id);
    const nextLocation = getNextLocationUnlock(interaction.user.id);
    const lines = [
        `📍 **Locations:** ${owned.map(loc => loc.emoji).join(' ')} — ${owned.length}/${MAX_LOCATION_TIER + 1} owned`,
        nextLocation
            ? `🔒 **Next spot:** ${nextLocation.emoji} ${nextLocation.name} — 🪙${nextLocation.price.toLocaleString()} → buy with \`/fish action:shop-location\``
            : '🌌 **All locations unlocked** — you own the whole ocean.',
        '',
        `🎣 **Rod:** ${equipment.rod.name}`,
        `🪱 **Bait:** ${equipment.bait.name}`,
        `🕸️ **Net:** ${equipment.net.name}`,
        '',
        '**Next upgrades:**',
        upgrades.length ? upgrades.map(item => `${item.type}: **${item.name}** — 🪙${item.price.toLocaleString()}`).join('\n') : 'All equipment is fully upgraded.',
        '',
        '_Buy with `/fish action:shop gear:rod` (or gear:bait / gear:net)._'
    ];
    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(0xa855f7)
            .setTitle('🎣 FISHING EQUIPMENT SHOP')
            .setDescription(lines.join('\n'))
            .setFooter({ text: 'Equipment boosts value & rare odds • deeper locations unlock better fish' })]
    });
}

/* =========================
   COLLECTION LOG — /fish view (the Angler's dex)
   Every catch is permanently logged (selling only stamps the row), so the
   dex shows lifetime species records: caught, bests, stored — and which
   fish are still needed.
========================= */

function buildDexLines(pageEntries, dex) {
    return pageEntries.map(fish => {
        const record = dex[fish.id];
        if (!record) {
            return `❌ ${fish.emoji} **${fish.name}** — ${fish.rarity} · *not caught yet*`;
        }
        const stored = record.stored > 0 ? ` · **${record.stored}** stored` : '';
        const best = `best 🪙${Number(record.bestValue).toLocaleString()}${record.bestWeight ? ` · ${Number(record.bestWeight).toFixed(2)}kg` : ''}`;
        return `✅ ${fish.emoji} **${fish.name}** — caught **${record.caught}×** · ${best}${stored}`;
    });
}

function buildDexEmbed(userId, page, dex) {
    const speciesTotal = FISH.length;
    const caught = getCaughtSpeciesCount(userId);
    const sorted = [...FISH].sort((a, b) =>
        DEX_RARITY_ORDER.indexOf(a.rarity) - DEX_RARITY_ORDER.indexOf(b.rarity) || a.value - b.value);

    const pages = Math.max(1, Math.ceil(sorted.length / DEX_PAGE_SIZE));
    page = Math.min(Math.max(0, page), pages - 1);

    const entries = sorted.slice(page * DEX_PAGE_SIZE, (page + 1) * DEX_PAGE_SIZE);
    const lines = buildDexLines(entries, dex);

    const missing = sorted.filter(fish => !dex[fish.id]);
    const needed = missing.length
        ? missing.slice(0, 6).map(fish => `${fish.emoji} ${fish.name}`).join(' · ') +
          (missing.length > 6 ? ` … +${missing.length - 6} more` : '')
        : '🏆 **DEXY COMPLETE — every species logged!**';

    const percent = Math.floor((caught / speciesTotal) * 100);
    const embed = new EmbedBuilder()
        .setColor(0x00d4ff)
        .setTitle(`🎣 ANGLER'S COLLECTION LOG — ${caught}/${speciesTotal} SPECIES (${percent}%)`)
        .setDescription(
            `**On this page:**\n${lines.join('\n')}\n\n` +
            `**Still needed:**\n${needed}`
        )
        .setFooter({ text: `Page ${page + 1}/${pages} · sells never erase your log · /fish action:sell to cash in stored fish` })
        .setTimestamp();
    return { embed, page, pages };
}

function dexComponents(userId, page, pages) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`fdex_prev_${userId}_${page}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
        new ButtonBuilder().setCustomId(`fdex_refresh_${userId}_${page}`).setLabel('🔄 Refresh').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`fdex_next_${userId}_${page}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1)
    );
    return [row];
}

async function runCollectionView(interaction) {
    await interaction.deferReply();
    const dex = getDex(interaction.user.id);
    const { embed, page, pages } = buildDexEmbed(interaction.user.id, 0, dex);
    const message = await interaction.editReply({
        embeds: [embed],
        components: dexComponents(interaction.user.id, page, pages)
    });

    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: DEX_COLLECTOR_MS
    });

    collector.on('collect', async component => {
        if (component.user.id !== interaction.user.id) {
            return component.reply({ content: 'This collection log belongs to another angler.', ephemeral: true });
        }
        const [, verb, , pageStr] = component.customId.split('_');
        let next = Number(pageStr) || 0;
        if (verb === 'prev') next = Math.max(0, next - 1);
        if (verb === 'next') next = next + 1;

        const freshDex = getDex(interaction.user.id);
        const built = buildDexEmbed(interaction.user.id, next, freshDex);
        await component.update({
            embeds: [built.embed],
            components: dexComponents(interaction.user.id, built.page, built.pages)
        }).catch(() => {});
    });

    collector.on('end', async () => {
        // Leave the last page visible; just retire the buttons.
        await message.edit({ components: [] }).catch(() => {});
    });
}

/* =========================
   SELL — /fish sell + /fish sell-all
========================= */

async function runFishSell(interaction) {
    /* The `fish` option is autocomplete (not required — it would then be
       demanded for every /fish cast/inventory/shop run). Older deploys did
       still miss it, so answer with a friendly pointer instead of a
       CommandInteractionOptionNotFound crash (host log). */
    const fishId = interaction.options.getString('fish');
    if (!fishId) {
        return interaction.reply({
            content: '❌ Pick which fish to sell — run `/fish action:sell` and choose a species in the `fish` autocomplete field.',
            ephemeral: true
        });
    }
    const amount = interaction.options.getInteger('amount') ?? 1;
    const result = sellFishLocal(interaction.user.id, fishId, amount);
    if (!result) return interaction.reply({ content: `❌ You do not have **${amount}** of that fish stored.` });
    const fish = result.fish[0];
    logTransaction(interaction.user.id, 'fish_sale', result.total, `Sold ${amount} ${fish.name}`);
    return interaction.reply(`💰 Sold **${amount} ${fish.emoji} ${fish.name}** for **🪙${result.total.toLocaleString()}**.`);
}

async function runFishSellAll(interaction) {
    const result = sellAllLocal(interaction.user.id);
    if (!result.fish.length) return interaction.reply({ content: '🎣 Your collection is empty — nothing stored to sell.' });
    logTransaction(interaction.user.id, 'fish_sale', result.total, `Sold ${result.fish.length} stored fish`);

    // Group identical fish so the sale report stays readable.
    const grouped = new Map();
    for (const fish of result.fish) {
        const current = grouped.get(fish.fishId) || { name: fish.name, emoji: fish.emoji, rarity: fish.rarity, quantity: 0, value: 0 };
        current.quantity += 1;
        current.value += fish.value;
        grouped.set(fish.fishId, current);
    }
    const lines = [...grouped.values()]
        .sort((a, b) => b.value - a.value)
        .map(fish => `${fish.emoji} **${fish.name}** ×${fish.quantity} • ${fish.rarity} — 🪙${fish.value.toLocaleString()}`);

    // Keep the receipt within Discord's 4096-char embed limit.
    const MAX_LINES = 40;
    const shown = lines.slice(0, MAX_LINES);
    const hiddenCount = lines.length - shown.length;
    if (hiddenCount > 0) {
        const hiddenValue = [...grouped.values()]
            .sort((a, b) => b.value - a.value)
            .slice(MAX_LINES)
            .reduce((sum, fish) => sum + fish.value, 0);
        shown.push(`…and **${hiddenCount}** more species — 🪙${hiddenValue.toLocaleString()}`);
    }

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(0x00d4ff)
            .setTitle('💰 FISH SALE RECEIPT')
            .setDescription(
                `Sold **${result.fish.length} fish** for **🪙${result.total.toLocaleString()}** total.\n\n` +
                shown.join('\n'))
            .setFooter({ text: `${grouped.size} species sold • Credits added to your wallet • Your collection log keeps them recorded` })]
    });
}

async function fishAutocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const grouped = new Map();
    for (const fish of getCollection(interaction.user.id, 1000)) {
        const current = grouped.get(fish.fishId) || { ...fish, quantity: 0 };
        current.quantity += 1;
        grouped.set(fish.fishId, current);
    }
    return interaction.respond([...grouped.values()]
        .filter(fish => fish.name.toLowerCase().includes(focused))
        .slice(0, 25)
        .map(fish => ({
            name: `${fish.emoji} ${fish.name} (${fish.quantity} stored)`.slice(0, 100),
            value: fish.fishId
        })));
}

/* =========================
   MAIN FISHING GAME — /fish (and /fish cast)
========================= */

/* =========================
   FISH HUB COMPONENT ROUTER — fish:hub:menu / fish:hub:cast
   Routed from index.js. The select menu covers every action; cast starts
   a real session on the hub message via a slash-shaped facade.
========================= */

const FISH_HUB_QUICK = new Set(['view', 'inventory', 'shop', 'sell-all', 'shop-location', 'tournament']);

/* 🏆 Live fishing-tournament board, reachable straight from the hub. */
async function runTournamentView(interaction) {
    const userId = interaction.user.id;
    const live = fishingTournament.getActiveTournament();
    const stats = fishingTournament.getStats(userId);

    const back = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('fish:hub:back').setLabel('Back to hub').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );

    if (!live) {
        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(0x00d4ff)
                .setTitle('🏆 FISHING TOURNAMENTS')
                .setDescription([
                    '**No derby is live right now.**',
                    '',
                    'When staff open one, a notice is posted in the economy terminal and every catch you land during the window is scored by rarity — Junk is worth 1 point, a Legendary 45.',
                    'The pot splits **50 / 30 / 20** across the top three anglers.',
                    '',
                    `**Your record:** 🏆 ${stats.wins} win(s) · 🥈 ${stats.podiums} podium(s) · 📈 best score ${Number(stats.bestScore || 0).toLocaleString()}`,
                    '',
                    '_The tournament is announced in the channel it runs in — keep an eye out while you fish._'
                ].join('\n'))],
            components: [back]
        });
    }

    const board = fishingTournament.describeLeaderboard(live.tournamentId, 10);
    return interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor(0xffd166)
            .setTitle('🏆 NEON FISHING DERBY — LIVE')
            .setDescription([
                `**${live.name}** is running — every catch banks rarity-weighted points.`,
                '',
                `🪙 **Pot:** ${Number(live.pot).toLocaleString()} \u2014 split **50 / 30 / 20** across the top three.`,
                `⏳ **Closes:** <t:${Math.floor(Number(live.endsAt) / 1000)}:R>`,
                '',
                board.length ? board.join('\n') : '_Nobody has scored yet — the water is quiet._',
                '',
                `**Your record:** 🏆 ${stats.wins} win(s) · 🥈 ${stats.podiums} podium(s) · 📈 best score ${Number(stats.bestScore || 0).toLocaleString()}`
            ].join('\n'))
            .setFooter({ text: 'Cast with 🎣 — every catch during the window scores automatically' })],
        components: [back]
    });
}

async function handleComponent(interaction) {
    const action = interaction.customId.split(':').slice(1).join(':'); // 'hub:menu' | 'hub:cast' | 'hub:<quick>'
    if (action === 'hub:cast') {
        // Let the facade own the deferral so update()/editReply() never hit
        // InteractionAlreadyReplied from a double-defer.
        return runFishingGame(facadeForHubComponent(interaction));
    }
    if (action.startsWith('hub:menu')) {
        const value = interaction.values?.[0];
        if (!value?.startsWith('fish:hub:')) {
            return interaction.deferUpdate().catch(() => {});
        }
        const picked = value.split(':')[2];
        if (picked === 'cast') {
            return runFishingGame(facadeForHubComponent(interaction));
        }
        if (picked === 'back') {
            return runFishHub(facadeForHubComponent(interaction));
        }
        if (FISH_HUB_QUICK.has(picked)) {
            const runner = {
                view: runCollectionView,
                inventory: runFishInventory,
                shop: runFishingShop,
                'sell-all': runFishSellAll,
                'shop-location': runFishingShopLocation,
                tournament: runTournamentView
            }[picked];
            if (picked === 'shop-location' || picked === 'shop') {
                // These act directly through the real interaction (reply()).
                return runner(interaction);
            }
            // Let the facade own the deferral.
            return runner(facadeForHubComponent(interaction));
        }
        if (picked === 'sell') {
            return interaction.reply({
                content: '💰 Pick the species **and** amount first — run `/fish action:sell` and choose a fish in the autocomplete field.',
                ephemeral: true
            }).catch(() => {});
        }
        return interaction.deferUpdate().catch(() => {});
    }
    return interaction.deferUpdate().catch(() => {});
}

async function runFishingGame(interaction) {
        // Defer FIRST. Under load, everything before the old mid-function defer
        // (session claim, cooldown checks) could eat the 3-second window: the
        // interaction expired (10062) before the game message could render —
        // but the session row was already claimed, so every retry for the next
        // 3 minutes answered "Game In Progress" with no game to finish. Deferring
        // up front guarantees an acknowledgement, and the session claim below
        // can only strand a game when this run truly renders one.
        await interaction.deferReply();

        const userId = interaction.user.id;
        const highTech = isHighTech(userId);

        // Create the account before the interactive session can award a catch.
        getUser(userId);

        // Check cooldown
        const remainingTime = getRemainingTime(userId, 'fish');
        if (remainingTime > 0) {
            return safeUpdate(interaction, { content: `🎣 Rod cooling... Please wait ${formatRemainingTime(remainingTime)}.` });
        }

        // One active game per user, claimed ATOMICALLY. Spamming /fish fires
        // several runs that all pass the "is there a session?" check before any
        // of them INSERTs (an await sits between the read and the write), so
        // two games used to open together — and each could reel its own catch.
        // userId is the PRIMARY KEY, so exactly one claim survives the race;
        // the losers get "your game is already running" instead.
        //
        // Stale rows (bot restart, crash, expired interaction) are TAKEN OVER,
        // not rejected: the collector only lives 2 minutes, so any row older
        // than 3 minutes is provably dead and gets closed + replaced.
        const STALE_SESSION_MS = 3 * 60 * 1000;
        const sessionId = `${userId}-${Date.now()}`;
        const claimSession = () => db.prepare(`
            INSERT INTO fish_sessions (userId, sessionId, channelId, messageId, startedAt)
            VALUES (?, ?, ?, NULL, ?)
            ON CONFLICT(userId) DO NOTHING
        `).run(userId, sessionId, interaction.channelId, Date.now());
        let claim = claimSession();
        if (claim.changes === 0) {
            const existing = db.prepare('SELECT * FROM fish_sessions WHERE userId = ?').get(userId);
            if (existing && Date.now() - existing.startedAt > STALE_SESSION_MS) {
                // Dead session — strip its game message, then re-claim.
                if (existing.messageId && interaction.channel) {
                    await interaction.channel.messages.fetch(existing.messageId)
                        .then(oldMessage => oldMessage.edit({
                            embeds: [new EmbedBuilder().setColor(0xff5577).setTitle('🚪 Fishing Game Closed')
                                .setDescription('This fishing game was closed automatically. Run `/fish` to cast a fresh line.')],
                            components: []
                        }))
                        .catch(() => { /* already deleted or channel lost */ });
                }
                db.prepare('DELETE FROM fish_sessions WHERE userId = ? AND sessionId = ?')
                    .run(userId, existing.sessionId);
                claim = claimSession();
            }
        }
        if (claim.changes === 0) {
            return safeUpdate(interaction, {
                embeds: [new EmbedBuilder().setColor(0xff5577).setTitle('⏳ Game In Progress')
                    .setDescription('You already have a fishing game running. Finish it (catch something) or use **Stop Fishing** to end it before starting another.')]
            });
        }

        // (Old dead games were already closed by the stale takeover above.)

        /* =========================
           ENVIRONMENT
        ========================= */

        const tide = getTide();
        const time = getTimeBonus();
        const hookUsed = getItemQuantity(userId, 'magic_fishing_hook', db) > 0;
        if (hookUsed) removeItem(userId, 'magic_fishing_hook', 1, db);

        // Session row was claimed atomically at the top — reuse that id.

        // Location defaults to the deepest owned spot and can be changed any time between casts.
        // Better locations are one-time purchases (see /fishing-shop) — deeper water = better pools.
        const owned = getOwnedLocations(userId);
        // Fall back to the default shoreline if the owned row is somehow unknown,
        // so a data mismatch can never crash the whole session.
        let location = LOCATION_BY_ID[owned[owned.length - 1]?.id] || LOCATIONS[0];
        let canReel = false;
        let sessionFinished = false;
        // Scoped to THIS sessionId: if a later /fish takes over, this session's
        // cleanup can never delete the newer game's row.
        const endSession = () => db.prepare('DELETE FROM fish_sessions WHERE userId = ? AND sessionId = ?').run(userId, sessionId);

        const componentPrefix = `fish:${userId}:`;

        const locationMenu = () => {
            const owned = getOwnedLocations(userId);
            const next = getNextLocationUnlock(userId);
            const options = owned
                // Manager rows carry only id/name/emoji/price — resolve the rich local
                // location data (valueBonus, description) before building menu options.
                .map(ownedLoc => LOCATION_BY_ID[ownedLoc.id])
                .filter(Boolean)
                .map(loc => new StringSelectMenuOptionBuilder()
                    .setLabel(`${loc.emoji} ${loc.name}`)
                    .setValue(loc.id)
                    .setDescription(`Owned — value x${(loc.valueBonus ?? 1).toFixed(2)} — ${loc.description || 'Owned fishing location'}`.slice(0, 100))
                    .setDefault(loc.id === location.id));
            if (next) {
                options.push(new StringSelectMenuOptionBuilder()
                    .setLabel(`🔒 ${next.emoji} ${next.name} — 🪙${next.price.toLocaleString()}`)
                    .setValue('purchase')
                    .setDescription(`Unlock this location (one-time purchase)`));
            }
            return new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`${componentPrefix}location`)
                    .setPlaceholder('Change fishing location')
                    .addOptions(options)
            );
        };

        const actionRow = () => new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${componentPrefix}scan`)
                .setLabel(highTech ? "Scan Waters" : "Look for a Bite")
                .setStyle(ButtonStyle.Secondary)
                .setEmoji("🌊"),

            new ButtonBuilder()
                .setCustomId(`${componentPrefix}reel`)
                .setLabel(highTech ? "Reel" : "Reel In")
                .setStyle(ButtonStyle.Success)
                .setEmoji("🎯"),

            new ButtonBuilder()
                .setCustomId(`${componentPrefix}abort`)
                .setLabel(highTech ? "Abort" : "Stop Fishing")
                .setStyle(ButtonStyle.Danger)
                .setEmoji("🚪")
        );

        const sessionEmbed = () => new EmbedBuilder()
            .setColor(getColor(userId, 0x00d4ff))
            .setTitle(formatTitle(userId, "🌊 NEURAL OCEAN ACTIVE", "Fishing"))
            .setDescription(highTech
                ? `Casting into **${location.emoji} ${location.name}**...`
                : `You cast your line at the **${location.emoji} ${location.name}**.`)
            .addFields(
                { name: "📍 Location", value: `${location.emoji} ${location.name}`, inline: true },
                { name: "🌊 Tide", value: tide.name, inline: true },
                { name: "🕒 Time", value: time.name, inline: true },
                { name: "💰 Value Bonus", value: `x${(location.valueBonus ?? 1).toFixed(2)}`, inline: true },
                { name: "⚡ Boost", value: `${(tide.bonus * time.bonus * (hookUsed ? 1.25 : 1)).toFixed(2)}x${hookUsed ? ' (Hook)' : ''}`, inline: true },
                { name: "🎯 Rarity Shift", value: location.rarities.Impossible > 0 ? 'Impossible possible' : `Top tier: ${['Mythic', 'Legendary'].find(r => location.rarities[r] > 0) || 'Epic'}`, inline: true }
            );

        // Interaction already deferred at the top of runFishingGame.
        const msg = await interaction.editReply({
            embeds: [sessionEmbed()],
            components: [locationMenu(), actionRow()]
        });

        // REPLACE: the takeover above keeps the old row until this new game is live.
        db.prepare('UPDATE fish_sessions SET channelId = ?, messageId = ? WHERE userId = ? AND sessionId = ?')
            .run(interaction.channelId, msg.id, userId, sessionId);

        const collector = msg.createMessageComponentCollector({ time: 120000 });

        collector.on("collect", async (i) => {
            if (i.user.id !== userId) {
                return i.reply({ content: "Not your session." });
            }

            /* =========================
               LOCATION CHANGE
            ========================= */

            if (i.customId === `${componentPrefix}location`) {
                // The 🔒 entry is a purchase, not a destination.
                if (i.values[0] === 'purchase') {
                    const result = purchaseNextLocation(userId);
                    if (!result.ok) {
                        return i.reply({ content: `🔒 ${result.message}` });
                    }
                    return i.update({
                        embeds: [
                            sessionEmbed().setDescription(
                                `🔓 **Location unlocked: ${result.location.emoji} ${result.location.name}** for 🪙${result.price.toLocaleString()}!\n` +
                                (highTech ? `New sonar data acquired. Deeper waters detected.` : `You now have access to better fishing grounds.`))
                        ],
                        components: [locationMenu(), actionRow()]
                    });
                }
                const chosen = LOCATION_BY_ID[i.values[0]];
                if (!chosen) return i.reply({ content: "Unknown location." });
                location = chosen;
                canReel = false; // moving spots resets any pending bite
                return i.update({
                    embeds: [
                        sessionEmbed().setDescription(highTech
                            ? `Recalibrating sonar for **${location.emoji} ${location.name}**...`
                            : `You pack up and head to the **${location.emoji} ${location.name}**.`)
                    ],
                    components: [locationMenu(), actionRow()]
                });
            }

            /* =========================
               ABORT
            ========================= */

            if (i.customId === `${componentPrefix}abort`) {
                sessionFinished = true;
                endSession();
                collector.stop();
                return i.update({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(getColor(userId, 0xff4444))
                            .setTitle(formatTitle(userId, "🚪 SESSION ABORTED", "Fishing Stopped"))
                            .setDescription(highTech ? "The ocean goes silent..." : "You put away your fishing rod.")
                    ],
                    components: []
                });
            }

            /* =========================
               SCAN
            ========================= */

            if (i.customId === `${componentPrefix}scan`) {
                canReel = false;

                await i.update({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(getColor(userId, 0x0099ff))
                            .setTitle(formatTitle(userId, `🌊 SCANNING ${location.name.toUpperCase()}...`, "Watching the Water..."))
                            .setDescription(highTech ? "Currents shifting... something is near..." : "The water moves. Something may be nearby...")
                    ],
                    components: [locationMenu(), actionRow()]
                });

                await delay(2000);

                // Deeper water bites more reliably but also risks snags.
                const biteChance = 0.7 + location.danger * 0.15;
                const event = Math.random();

                if (event < biteChance) {
                    canReel = true;

                    return msg.edit({
                        embeds: [
                            new EmbedBuilder()
                                .setColor(getColor(userId, 0xffcc00))
                                .setTitle(formatTitle(userId, "👀 BITE DETECTED", "You Have a Bite!"))
                                .setDescription(highTech ? "Something is pulling HARD on your line!" : "Something is pulling on your line!")
                                .addFields(
                                    { name: formatFieldName(userId, "⚡ Action", "Action"), value: highTech ? "Reel now or lose it!" : "Reel in now!", inline: false }
                                )
                        ],
                        components: [locationMenu(), actionRow()]
                    });
                }

                return msg.edit({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(getColor(userId, 0x444444))
                            .setTitle(formatTitle(userId, "🌊 NOTHING HERE", "No Bite"))
                            .setDescription(highTech ? "The ocean shifts... but nothing bites." : "Nothing took the bait this time.")
                    ],
                    components: [locationMenu(), actionRow()]
                });
            }

            /* =========================
               REEL
            ========================= */

            if (i.customId === `${componentPrefix}reel`) {

                // Session guard: once this game is finished (catch landed, abort,
                // timeout, or a takeover), any further clicks are dead. Without
                // this, a double-click on Reel could resolve the catch twice.
                if (sessionFinished ||
                    !db.prepare('SELECT 1 FROM fish_sessions WHERE userId = ? AND sessionId = ?').get(userId, sessionId)) {
                    return i.update({ components: [] }).catch(() => {});
                }

                if (!canReel) {
                    return i.reply({ content: "❌ No bite detected yet!" });
                }

                canReel = false;

                const useHighTech = isHighTech(userId);

                await i.update({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(getColor(userId, 0xffaa00))
                            .setTitle(formatTitle(userId, "🎯 REELING...", "Reeling In..."))
                            .setDescription(useHighTech ? "Line tension critical..." : "You pull the line in...")
                    ],
                    components: []
                });

                await delay(2000);

                try {
                    const equipmentBonus = getBonuses(userId);
                    const fish = getCatchDetails(rollFish(location, equipmentBonus.rarity), location);
                    const rarityStyle = RARITY_STYLES[fish.rarity] || RARITY_STYLES.Common;
                    const bonus = tide.bonus * time.bonus * (hookUsed ? 1.25 : 1) * equipmentBonus.value * location.valueBonus;

                /* =========================
                   NORMAL CATCH
                ========================= */

                if (fish.rarity !== "LEGENDARY EVENT") {

                    /* 🐉 Hatchery + 🎁 seasonal multipliers stack on top of the
                       rod/bait/net/location stack that `bonus` already holds. */
                    const dragonBonus = dragonManager.getDragonBonus(userId, 'fish_value');
                    const seasonalBonus = seasonalEvents.getSeasonalMultiplier('credits');
                    const totalBonus = bonus * (1 + dragonBonus) * seasonalBonus;
                    const reward = Math.floor(fish.value * totalBonus);
                    recordCatch(userId, { ...fish, value: reward });

                    db.prepare(`
                        UPDATE users
                        SET fishCount = fishCount + 1
                        WHERE userId = ?
                    `).run(userId);
                    setCooldown(userId, 'fish');

                    /* 🏆 Tournament scoring — a no-op when no derby is live. */
                    let tourneyLine = null;
                    try {
                        const scored = fishingTournament.addCatchScore(userId, { ...fish, value: reward });
                        if (scored) {
                            const board = fishingTournament.getLeaderboard(scored.tournamentId, 3);
                            const place = board.findIndex(row => row.userId === userId) + 1;
                            tourneyLine = `🏆 **Tournament +${scored.score} pts** (total ${scored.total.toLocaleString()})` +
                                (place > 0 ? ` — you are **#${place}** on the board` : '');
                        }
                    } catch (error) {
                        console.error('Tournament scoring failed:', error.message);
                    }

                    /* 📋 Quests / achievements. */
                    try {
                        questManager.recordQuestEvent(userId, 'fish_catch', 1, { rarity: fish.rarity });
                        if (['Mythic', 'Legendary', 'Impossible', 'LEGENDARY EVENT'].includes(fish.rarity)) {
                            questManager.recordQuestEvent(userId, 'fish_rarity', 1, { rarity: fish.rarity });
                        }
                    } catch (error) {
                        console.error('Fishing quest hook failed:', error.message);
                    }

                    /* 🥚 Dragon egg drop — the better the fish, the better the egg. */
                    let eggDrop = null;
                    try {
                        const tierScore = { Junk: 0, Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Mythic: 3, Legendary: 4, Impossible: 4, 'LEGENDARY EVENT': 4 }[fish.rarity] ?? 1;
                        eggDrop = dragonManager.rollEggDrop(userId, { source: 'fish', tierScore });
                    } catch (error) {
                        console.error('Fishing egg drop failed:', error.message);
                    }

                    const catchEmbed = new EmbedBuilder()
                        .setTitle(formatTitle(userId, `${fish.emoji} ${fish.name}`, fish.name))
                        .setColor(eggDrop ? 0xff3d81 : rarityStyle.color)
                        .setDescription(`You caught a **${fish.emoji} ${fish.name}**!\n\n${rarityStyle.emoji} **${fish.rarity}**\n📍 **Location:** ${location.emoji} ${location.name}\n⚖️ **Weight:** ${fish.weight.toFixed(2)} kg\n💰 **Value:** ${reward.toLocaleString()} credits\n\n*${fish.description}*\n\nUse \`/fish\` again when your rod is ready.`)
                        .setFooter({ text: `Angler: ${interaction.user.tag}` })
                        .setTimestamp();

                    if (dragonBonus > 0) {
                        catchEmbed.addFields({ name: '🐉 Pet bonus', value: `+${(dragonBonus * 100).toFixed(1)}% fish value from your active pet`, inline: true });
                    }
                    if (seasonalBonus > 1) {
                        catchEmbed.addFields({ name: '🎁 Seasonal bonus', value: `×${seasonalBonus.toFixed(2)} event payout`, inline: true });
                    }
                    if (tourneyLine) {
                        catchEmbed.addFields({ name: 'Tournament', value: tourneyLine, inline: false });
                    }
                    if (eggDrop) {
                        const eggType = dragonManager.EGG_TYPES[eggDrop.eggType];
                        const eggStyle = dragonManager.RARITY_STYLE[eggDrop.rarity] || dragonManager.RARITY_STYLE.common;
                        catchEmbed.addFields({
                            name: '🥚 DRAGON EGG FOUND',
                            value: `${eggType?.emoji || '🥚'} **${eggType?.name || 'Mystery Egg'}** — ${eggStyle.emoji} ${eggStyle.label}\n` +
                                (eggDrop.side === 'evil' ? '🩸 Onslaught bloodline' : '🌌 Dragonflight bloodline') +
                                `\nIncubate it from \`/profile\` → **Eggs** (${Math.round((eggType?.incubateMs || 0) / 3_600_000)}h).`,
                            inline: false
                        });
                    }

                    sessionFinished = true;
                    endSession();
                    collector.stop();
                    return interaction.editReply({
                        embeds: [catchEmbed],
                        components: []
                    });
                }

                /* =========================
                   LEGENDARY EVENT
                ========================= */

                addItem(userId, "tropical_fish", 1);

                const eventValue = Math.floor(2500 * bonus);
                recordCatch(userId, {
                    id: 'tropical_fish',
                    name: 'Tropical Anomaly Fish',
                    value: eventValue,
                    emoji: '🌴🐠',
                    rarity: 'LEGENDARY EVENT',
                    weight: 10,
                    location: location.name
                });
                db.prepare(`
                    UPDATE users
                    SET fishCount = fishCount + 1
                    WHERE userId = ?
                `).run(userId);
                setCooldown(userId, 'fish');

                sessionFinished = true;
                endSession();
                collector.stop();
                return interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(getColor(userId, 0xff4dff))
                            .setTitle(formatTitle(userId, "🌴🐠 OCEAN ANOMALY EVENT", "Ocean Anomaly"))
                            .setDescription(useHighTech ? "The ocean REWRITES reality..." : "A legendary event occurred!")
                            .addFields(
                                { name: formatFieldName(userId, "💰 Catch Value", "Catch Value"), value: `${eventValue.toLocaleString()} credits`, inline: true },
                                { name: formatFieldName(userId, "🌊 Event", "Event"), value: "Legendary Spawn", inline: true },
                                { name: formatFieldName(userId, "📦 Inventory", "Inventory"), value: "Tropical Fish Added", inline: true }
                            )
                    ],
                    components: []
                });
                } catch (error) {
                    console.error(`Fishing resolution failed for ${userId}:`, error);
                    sessionFinished = true;
                    endSession();
                    collector.stop('error');
                    return interaction.editReply({
                        embeds: [
                            new EmbedBuilder()
                                .setColor(getColor(userId, 0xff4444))
                                .setTitle(formatTitle(userId, '🎣 FISHING ERROR', 'Catch Failed'))
                                .setDescription('The line went dead while resolving your catch. No credits or fish were lost; please try fishing again.')
                        ],
                        components: []
                    }).catch(() => {});
                }
            }
        });

        collector.on("end", async () => {
            // Scoped to THIS sessionId (never a newer game's row).
            db.prepare('DELETE FROM fish_sessions WHERE userId = ? AND sessionId = ?').run(userId, sessionId);
            if (sessionFinished) return;
            try {
                await msg.edit({ components: [] });
            } catch (error) {
                if (error.code !== 10008 && error.status !== 503) {
                    console.error('Unable to close fishing session:', error.message);
                }
            }
        });
}
