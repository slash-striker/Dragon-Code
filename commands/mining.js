/*
 * /mining — the single hub for every mining subsystem.
 *
 * The slash command takes NO options: bare /mining opens the guided hub
 * embed with a section pick-list, and every section panel owns its complete
 * section — views, one-click action buttons, and pick-lists — so nothing
 * needs to be memorized:
 *   equipment  → drill buy/equip + location unlock/travel (pick-lists)
 *   fleet      → drone hangar: buy / station / recall (buttons + selects)
 *   refine     → the interactive refinery (recipe → batch size → run)
 *   upgrades   → cooldown boosts with a Buy button
 *   crew       → hire workers (price buttons + name modal), guild create/join/leave
 *   contracts  → view, accept, and claim contracts with buttons
 *   property   → claim cards with Buy/Upgrade buttons
 *   info       → live stats dashboard + quick links to events/relics/leaderboard
 *   guide      → posts the price guide
 *
 * Every operation funnels through runAction(), which is also what the panel
 * buttons call — one implementation powers everything.
 *
 * Merged (handlers moved verbatim from the old standalone commands):
 *   mining-drones        → fleet panel
 *   mining-refine        → refinery panel
 *   mining-boost         → upgrades panel (boost-buy)
 *   mining-drill → equipment panel (drill-buy · location-unlock · ℹ️ cards)
 *   mining-events        → info panel buttons (events)
 *   mining-relics        → info panel buttons (relics)
 *   mining-crew          → crew panel (crew-hire · guild ops)
 *   mining-contract      → contracts panel (accept · claim)
 *   mining-properties    → property panel (buy · upgrade)
 *   mining-stats         → info panel (stats)
 *   mining-help          → guide section
 *   mining-leaderboard   → info panel buttons (leaderboard)
 *
 * /drill was fully absorbed into the Equipment panel and the file deleted.
 * The mining command set is now: /mine · /mining-inventory · /mining.
 */
const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');

const db = require('../database');
const { ensureUser } = require('../systems/utils/ensureUser');
const { getInventory } = require('../systems/mining/inventoryManager');
const { getGuildWorkerSlotBonus } = require('../systems/mining/guildPerks');
const {
    getGuildPerkState,
    getSeasonFund,
    getWageStatus,
    TIERS: GUILD_PERK_TIERS
} = require('../systems/mining/guildPerks');
const { locations, MINING_BOOSTS, getDrillUpgradeCost, getLocationUnlockCost } = require('../systems/mining/drillTables');
const { drills } = require('../systems/mining/drillTables');
const { getMiningProfile, updateMiningProfile, xpNeeded, canMine } = require('../systems/mining/miningManager');
const { MINING_PROPERTIES, getOwnedProperties, buyProperty, upgradeProperty, getYieldMultiplier } = require('../systems/mining/propertyManager');
const {
    DRONE_TIERS,
    DRONE_FLEET_MAX,
    WORKER_SPECIALTIES,
    RECIPES,
    getFleet,
    getDrone,
    collectDroneOre,
    buyDrone,
    assignDrone,
    getWorkers,
    hireWorker,
    createGuild,
    joinGuild,
    leaveGuild,
    getUserGuild,
    refineOre,
    getRefinedInventory,
    getArtifacts,
    getContracts,
    getOrCreateContract,
    claimContract,
    getActiveMiningEvent,
    getRecentMiningEvents,
    getLeaderboard,
    seasonKey
} = require('../systems/mining/expansionManager');
const { logTransaction } = require('../systems/economy/transactionLogger');

const ALLOWED_CHANNEL = '1504562791967756448';

function fmt(n) { return Number(n || 0).toLocaleString(); }
const money = value => `🪙${Number(value || 0).toLocaleString()}`;

// Full guide is pinned to the economy channel (as /miningguide was).
function buildFullGuide() {
    return new EmbedBuilder()
        .setColor(0x00ffff)
        .setTitle('⚡ SLASHYTRON MINING SYSTEM GUIDE')
        .setDescription('**Complete Guide to Mining in SlashyTron**')
        .addFields(
            { name: '📖 OVERVIEW', value: 'Quick extraction mining with one automatic run per cooldown. Upgrade your equipment, hire helpers, collect ore, and build your mining bank without a clicker loop.', inline: false },
            { name: '⚡ /mine - Start Mining', value: 'One use completes a full extraction automatically. You receive ore, XP, mining-bank credits, helper bonuses, and occasional discoveries. Runs every **3 hours**; better drills and the `/mining` Boosts panel upgrades shorten the wait and add bonus ore.', inline: false },
            { name: '🔧 Equipment — in the /mining hub', value: 'Pick **🔧 Drill & Locations** in the hub: buy/equip drills and unlock travel sites with two pick-lists. ℹ️ buttons show detail cards for your active drill and location. Selling ore is handled separately by `/sell`.', inline: false },
            { name: '🎒 /main-hub - Inventory & Balance', value: 'View wallet, Main Bank Account, mining bank, and mining inventory with current market values. Use `/main-hub` as the mining home screen.', inline: false },
            { name: '💰 /sell - Sell Ores', value: 'Sell ores and refined materials for the exact live market price. Credits go to mining bank; the mining hub does not sell anything.', inline: false },
            { name: '📈 /market - View Prices', value: 'Browse live ore prices by category. Check current market events affecting prices.', inline: false },
            { name: '💳 /transfer - Transfer to Main Bank', value: 'Choose Mining bank or Wallet as the source, then transfer credits to your Main Bank Account. Use amount -1 to transfer all from the selected source.', inline: false },
            { name: '🏦 MINING BANK', value: 'Mining-bank credits are the mining economy\'s own currency — separate from your Main Bank Account. Every `/mine` run deposits credits there, `/sell` pays ore value into it, and it is the **only** currency drills, site unlocks, drones, claims and refinery batches accept. Flow it into your Main Bank with `/transfer` (source: Mining bank) to spend it in the Dragon Code economy.', inline: false },
            { name: '🚁 DRONE FLEET', value: 'Open `/mining` and pick **🚁 Drone Fleet**: buy drones (price buttons), station them at your unlocked sites with the pick-list, and recall them the same way. Drones collect while you are away.', inline: false },
            { name: '📜 Contracts & Automation', value: 'Pick **📜 Contracts** in the hub: accept commissions, deliver ore with `/mine`, and hit **Claim** when ready.', inline: false },
            { name: '⚗️ Refining & Discoveries', value: 'Pick **⚗️ Refinery** in the hub: choose a recipe from the menu (it shows what you own), pick a batch size, done — results are sold via `/sell`. Artifacts live under **Stats & Records → Artifacts**.', inline: false },
            { name: '🌋 Events & Competition', value: 'Events can boost or wreck yields. See the live feed under **Stats & Records → Event feed**, and compare seasons with **Leaderboard**.', inline: false },
            { name: '📊 QUICK RUNS', value: 'Every completed run counts toward your mining stats and streak. The **Stats & Records** dashboard shows level, stored ore, mining bank, crew, drones, and claims.', inline: false },
            { name: '📦 MARKET EVENTS', value: 'Mining Boom (+50%), Market Crash (-40%), Tech Surge (+30%), Supply Glut (-30%). Events last 1 hour.', inline: false },
            { name: '💎 DRILLS', value: 'Basic → Plasma → Laser → Quantum → Void → Stellar → Primordial → Singularity → Omega. Each purchase price is shown in the hub’s **Drill & Locations** panel; better drills improve efficiency and reduce cooldown.', inline: false },
            { name: '🌍 LOCATIONS', value: 'Quantum Craters → Cyber Depths → Frozen Sector → Lunar Station → Nexus Core → Asteroid Belt → Singularity Rift. Unlock prices are shown in the hub’s **Drill & Locations** panel.', inline: false },
            { name: '⚡ MINING BOOSTS', value: 'Pick **⚡ Boosts** in the hub for exact prices and a one-click **Buy** — cooldowns drop up to **40%** (3h → ~1h47m fully stacked) and every run gains **bonus ore**.', inline: false },
            { name: '🏭 PERSISTENT MINE CLAIMS', value: 'Pick **⛏️ Mine Claims** in the hub: every claim shows its price, yield and revenue per level, with **Buy** / **Upgrade** buttons.', inline: false },
            { name: '🛡️ MINING GUILDS', value: 'Open `/mining` → **Crew & Guilds**: found your own guild (you become owner) or join an existing one by exact name. Members get a personal ore bonus that scales with roster size: **+5%** at 2 members, **+10%** at 3, **+15%** at 4, **+20%** at 6+. Guilds of 4+ also add **+1 crew slot** (5 → 6 workers).', inline: false },
            { name: '🪙 TITHE & DAILY PAYROLL', value: 'Guilds share a season fund: 10% of every member\'s `/mine` deposit is tithed into the fund, and once a day the whole fund is split **equally** among the roster — paid straight into everyone\'s mining bank — then resets. Active miners circulate earnings to the whole crew. Your fund, next payroll timer and next-tier progress show on the guild-status card.', inline: false },
            { name: '💡 TIPS', value: '• Use `/mine` once per cooldown\n• Upgrade drills and locations\n• Hire workers and collect drones\n• Buy claims for yield and revenue\n• Everything above lives in the `/mining` hub panels', inline: false },
            { name: '🔗 ECONOMY INTEGRATION', value: 'Wallet balance is shared with Dragon Code. Credits from mining can be used in Dragon Code economy commands.', inline: false }
        )
        .setFooter({ text: 'NEURAL MINING SYSTEM v2.1 // GUIDE' });
}

function propertyDescription(property, owned) {
    if (!owned) {
        return `**Price:** ${money(property.price)} • **Yield:** +${Math.round(property.yieldPerLevel * 100)}% • **Revenue:** ${Math.round(property.incomePerLevel * 100)}% of mined value`;
    }
    const nextPrice = owned.level < property.maxLevel ? property.upgradeBase * owned.level : 0;
    return `**Level:** ${owned.level}/${property.maxLevel} • **Yield:** +${Math.round(owned.level * property.yieldPerLevel * 100)}% • **Revenue:** ${Math.round(owned.level * property.incomePerLevel * 100)}% of mined value` +
        (nextPrice ? ` • **Next upgrade:** ${money(nextPrice)}` : ' • **MAX LEVEL**');
}

/*
 * Mining guide — posts the guide as a STANDALONE message in the channel it
 * is used in (not as a reply to the invoking command). The invoker only gets
 * an ephemeral "posted" acknowledgement, so the channel shows just the guide.
 * Reached through the hub's 📖 Full Guide section.
 */
async function executeHelp(interaction) {
    // Hub entry already deferred (publicly) before routing here — defer only
    // when this is the first response to the interaction.
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }
    ensureUser(interaction.user.id);

    let embed;
    if (interaction.channelId === ALLOWED_CHANNEL) {
        embed = buildFullGuide();
    } else {
        embed = new EmbedBuilder().setColor(0x00d4ff).setTitle('Mining Help')
            .setDescription('Use `/mine` once per cooldown. It completes one extraction automatically; no clicking or saved sessions are needed.\n\nOpen `/mining` for the guided hub — every section has buttons.');
        embed.addFields(
            { name: 'Drills', value: Object.entries(drills).map(([id, drill]) => `**${drill.name}** — ${money(getDrillUpgradeCost(id))} — level ${drill.levelRequired} — ${drill.description}`).join('\n') },
            { name: 'Locations', value: Object.entries(locations).map(([id, location]) => `**${location.name}** — unlock ${money(getLocationUnlockCost(id))} — level ${location.levelRequired} — ${location.description}`).join('\n') },
            { name: 'Workers', value: Object.entries(WORKER_SPECIALTIES).map(([id, worker]) => `**${id}** — ${money(worker.cost)} — adds efficiency to quick runs`).join('\n') },
            { name: 'Drones / Clones', value: DRONE_TIERS.map(drone => `**${drone.name}** — ${money(drone.cost)} — delivers up to ${drone.hourlyYield} ore per trip when collected`).join('\n') },
            { name: 'Properties', value: MINING_PROPERTIES.map(property => `**${property.name}** — ${money(property.price)} — +${Math.round(property.yieldPerLevel * 100)}% yield and ${Math.round(property.incomePerLevel * 100)}% revenue per level`).join('\n') }
        );
    }

    // Post the guide as its own channel message, not a command reply.
    if (interaction.channel?.send) {
        await interaction.channel.send({ embeds: [embed] });
        return interaction.editReply({ content: '✅ Mining guide posted.' });
    }
    // Fallback: channel not cached — reply with the guide directly.
    return interaction.editReply({ embeds: [embed] });
}

module.exports = {
    /*
     * Bare /mining — zero options. The hub embed's section pick-list IS the
     * interface; every operation lives on a panel button or pick-list.
     */
    data: new SlashCommandBuilder()
        .setName('mining')
        .setDescription('Mining hub — guided panels: drill, drones, refinery, boosts, crew, contracts, claims, stats'),

    /*
     * GUIDED HUB — /mining always opens the hub menu; every section panel
     * owns its complete section (views + one-click actions), so a player
     * never needs to remember action names.
     */
    async execute(interaction) {
        // Defer up front — the hub embed does profile/DB reads that could
        // brush Discord's 3-second reply window. openHub answers with editReply.
        await interaction.deferReply();
        ensureUser(interaction.user.id);
        return openHub(interaction);
    },

    // Component + modal routers, wired from index.js.
    handleComponent,
    handleModal
};

/* =========================
   SHARED ACTION ENGINE — every operation keyed by one action name. Slash
   shortcuts and panel buttons both funnel through runAction, so each
   operation has a single implementation. Extra op context (e.g. a worker
   name typed into a modal) travels in `opts`.
========================= */

const MINE_HINT = 'Run `/mine` when the timer is up — that is the actual mining.';

async function runAction(interaction, action, arg = null, opts = {}) {
    // Slash calls arrive un-deferred; button calls arrive raw (the section
    // panel hands off before invoking). Defer only when needed — every
    // branch below answers with editReply.
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply();
    }
    ensureUser(interaction.user.id);

    /* ============ drones (was /mining-drones) ============ */
    if (action === 'drones' || action === 'drone-buy' || action === 'drone-assign' || action === 'drone-unassign') {
        // Sweep pending ore on any fleet interaction so payouts never idle.
        const droneCollection = collectDroneOre(interaction.user.id);

        if (action === 'drone-buy') {
            const tier = Number(arg);
            if (!tier) return interaction.editReply({ content: '❌ Pick a drone tier — the buttons or the Hangar panel pick-list do the buying.' });
            const wallet = db.prepare('SELECT wallet FROM users WHERE userId = ?').get(interaction.user.id)?.wallet || 0;
            const result = buyDrone(interaction.user.id, tier, wallet);
            if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
            logTransaction(interaction.user.id, 'mining_drone', -result.config.cost,
                result.addedUnit ? `Purchased additional ${result.config.name} (drone #${result.fleet.length})` : `Purchased ${result.config.name}`);
            return interaction.editReply(result.addedUnit
                ? `✅ Drone **#${result.fleet.length}** joined your hangar — **${result.config.name}** for **${money(result.config.cost)}**. Station it from the Fleet panel — each drone can hold a different location.`
                : `✅ Fleet upgraded to **${result.config.name}** for **${money(result.config.cost)}**. Every drone now mines at Tier ${result.config.tier} efficiency.`);
        }

        if (action === 'drone-assign') {
            const location = arg;
            if (!location) return interaction.editReply({ content: '❌ Pick a drone + site from the Station pick-list in the Fleet panel.' });
            const profile = getMiningProfile(interaction.user.id);
            if (!profile.unlockedLocations.includes(location)) {
                return interaction.editReply({ content: '❌ You must unlock that location first — use the Equipment panel (🔧) in the hub.' });
            }
            const droneNum = 1;
            const result = assignDrone(interaction.user.id, location, droneNum);
            if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
            return interaction.editReply(`✅ **Drone #${result.fleet.findIndex(d => d.droneId === result.drone.droneId) + 1}** stationed at **${locations[location].name}**. All assigned drones run on their own timers and stock your ore store in parallel.`);
        }

        if (action === 'drone-unassign') {
            const droneNum = Number(arg ?? 1);
            const result = assignDrone(interaction.user.id, 'unassign', droneNum);
            if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
            return interaction.editReply('✅ Drone recalled to the hangar.');
        }

        // drones (view)
        const fleet = getFleet(interaction.user.id);
        const summary = getDrone(interaction.user.id);
        const embed = new EmbedBuilder().setColor(0x00d4ff).setTitle('🤖 Drone Hangar');
        if (!fleet.length) {
            embed.setDescription('No drones owned. Open `/mining` → **Drone Fleet** and grab Tier 1 — then add up to **7 units**, one per mining location.');
        } else {
            const lines = fleet.map((drone, index) => {
                const tier = DRONE_TIERS.find(item => item.tier === drone.tier);
                const post = drone.assignedLocation
                    ? `📍 ${locations[drone.assignedLocation]?.name || drone.assignedLocation}`
                    : '💤 idle in hangar';
                return `**#${index + 1} ${tier.name}** — ${post} · ${drone.totalOreCollected || 0} lifetime ore`;
            });
            const idle = fleet.filter(d => !d.assignedLocation).length;
            embed.setDescription([
                `**Fleet: ${fleet.length}/${DRONE_FLEET_MAX} drones · Tier ${summary.tier} (${DRONE_TIERS.find(t => t.tier === summary.tier)?.name})**`,
                '',
                ...lines,
                '',
                idle ? `💤 ${idle} idle drone(s) — station them from the Fleet panel (one per location).` : '✅ All drones on station. Seven drones = one per location for maximum weekly yield.',
                droneCollection.quantity ? `\n📦 Swept **${droneCollection.quantity} ore** into your store just now.` : ''
            ].join('\n'));
        }
        return interaction.editReply({ embeds: [embed] });
    }        /* ============ refine (was /mining-refine) ============ */
    if (action === 'refine') {
        const recipeArg = arg; // panel buttons never pass one; the panel below is the path

        // Direct path — a recipe id arrives only from code (modals/tests); the
        // player-facing path is the panel below.
        if (recipeArg) {
            const result = refineOre(interaction.user.id, recipeArg, 1);
            if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
            return interaction.editReply({
                embeds: [new EmbedBuilder().setColor(0x00ff99).setTitle('⚗️ Refining Complete')
                    .setDescription(`Consumed **${result.recipe.amount} ${result.recipe.input.replace(/_/g, ' ')}** and produced **${result.quantity} ${result.recipe.name}**.\nNo credits were charged. Sell refined materials with \`/sell\`.`)]
            });
        }

        // ── INTERACTIVE REFINERY PANEL ────────────────────────────
        // Select a recipe from the menu (options show owned/needed),
        // then pick how many batches to run. Nothing is consumed until
        // the final "Refine" button.
        const buildPanel = () => {
            const ownedCounts = new Map(getInventory(interaction.user.id).map(row => [row.oreId, row.quantity]));
            const ownedRefined = new Map(getRefinedInventory(interaction.user.id).map(row => [row.materialId, row.quantity]));

            const recipeList = Object.entries(RECIPES).map(([value, recipe]) => {
                const owned = ownedCounts.get(recipe.input) || 0;
                const batches = Math.floor(owned / recipe.amount);
                const emoji = batches > 0 ? '✅' : '🔒';
                return {
                    value,
                    recipe,
                    owned,
                    batches,
                    menuLabel: `${emoji} ${recipe.name}`.slice(0, 100),
                    menuDesc: `You have ${owned} · needs ${recipe.amount} → ${Math.floor(batches)} batch${batches === 1 ? '' : 'es'} ready`
                        .replace('→ 0 batches ready', '→ not enough ore').slice(0, 100),
                    refined: ownedRefined.get(value) || 0
                };
            });

            const menu = new StringSelectMenuBuilder()
                .setCustomId(`refine:pick:${interaction.user.id}`)
                .setPlaceholder('Pick a recipe to refine…')
                .addOptions(recipeList.map(item => ({
                    label: item.menuLabel,
                    value: item.value,
                    description: item.menuDesc
                })));

            const embed = new EmbedBuilder()
                .setColor(0x00ff99)
                .setTitle('⚗️ REFINERY TERMINAL')
                .setDescription([
                    'Turn raw ore into higher-value materials. No credits charged.',
                    '',
                    recipeList.map(item =>
                        `**${item.recipe.name}** — needs **${item.recipe.amount}×** ${item.recipe.input.replace(/_/g, ' ')}\n` +
                        `　• Raw ore owned: **${item.owned}**${item.batches > 0 ? ` → **${item.batches}** batch${item.batches === 1 ? '' : 'es'} ready` : ' → ❌ not enough ore'}\n` +
                        `　• Output: **${item.recipe.output}× ${item.recipe.name}** per batch (worth ${money(item.recipe.value)} each)\n` +
                        `　• Refined stock: **${item.refined}**`).join('\n\n'),
                    '',
                    `Sell results with \`/sell\` · view stock with the Refined button below.`
                ].join('\n'))
                .setFooter({ text: 'Select a recipe below, then choose a batch size' });

            return { embed, menu, recipeList };
        };

        const panel = buildPanel();
        const message = await interaction.editReply({
            embeds: [panel.embed],
            components: [new ActionRowBuilder().addComponents(panel.menu), backRow(interaction.user.id)],
            fetchReply: true
        });

        const collector = message.createMessageComponentCollector({ time: 120_000 });
        let selected = null;

        collector.on('collect', async (component) => {
            if (component.user.id !== interaction.user.id) {
                return component.reply({ content: 'This refinery panel is not yours.', ephemeral: true });
            }

            // Step 1: recipe picked → offer batch sizes.
            if (component.customId.startsWith('refine:pick:')) {
                selected = panel.recipeList.find(item => item.value === component.values[0]);
                const maxBatches = Math.min(100, selected.batches);
                const choices = [1, 5, 10, 25, 50].filter(n => n <= maxBatches);
                if (maxBatches > 0 && !choices.includes(maxBatches)) choices.push(maxBatches);

                if (!choices.length) {
                    const missing = `❌ Not enough **${selected.recipe.input.replace(/_/g, ' ')}** — you have ${selected.owned}, each batch needs ${selected.recipe.amount}. Mine more first!`;
                    selected = null;
                    return component.reply({ content: missing, ephemeral: true });
                }

                const batchMenu = new StringSelectMenuBuilder()
                    .setCustomId(`refine:batch:${interaction.user.id}:${selected.value}`)
                    .setPlaceholder(`How many batches of ${selected.recipe.name}?`)
                    .addOptions(choices.map(n => ({
                        label: `${n} batch${n === 1 ? '' : 'es'}`,
                        description: `Uses ${selected.recipe.amount * n} ${selected.recipe.input.replace(/_/g, ' ')} → makes ${selected.recipe.output * n} ${selected.recipe.name}`,
                        value: String(n)
                    })));

                return component.update({
                    embeds: [new EmbedBuilder().setColor(0x00ff99).setTitle(`⚗️ ${selected.recipe.name}`)
                        .setDescription([
                            `You have **${selected.owned}×** ${selected.recipe.input.replace(/_/g, ' ')} — each batch consumes **${selected.recipe.amount}×** and produces **${selected.recipe.output}× ${selected.recipe.name}** (${money(selected.recipe.value)} each).`,
                            '',
                            `Currently ready: **${selected.batches}** batch${selected.batches === 1 ? '' : 'es'}. Pick how many to run:`
                        ].join('\n'))],
                    components: [new ActionRowBuilder().addComponents(batchMenu)]
                });
            }

            // Step 2: batch size picked → refine immediately.
            if (component.customId.startsWith('refine:batch:')) {
                const recipeId = component.customId.split(':')[3];
                const batches = parseInt(component.values[0], 10);
                const result = refineOre(interaction.user.id, recipeId, batches);
                if (!result.ok) {
                    return component.update({
                        embeds: [new EmbedBuilder().setColor(0xff5577).setTitle('⚗️ Refining Failed').setDescription(`❌ ${result.message}`)],
                        components: []
                    });
                }
                const refreshed = buildPanel();
                await component.update({
                    embeds: [
                        new EmbedBuilder().setColor(0x00ff99).setTitle('⚗️ Refining Complete')
                            .setDescription(`Consumed **${result.recipe.amount * batches} ${result.recipe.input.replace(/_/g, ' ')}** → produced **${result.quantity} ${result.recipe.name}** (${money(result.quantity * result.recipe.value)} when sold).\nNo credits were charged.`)
                            .setFooter({ text: 'Panel refreshed — refine more below' }),
                        refreshed.embed
                    ],
                    components: [new ActionRowBuilder().addComponents(refreshed.menu), backRow(interaction.user.id)]
                });
                selected = null;
            }
        });

        collector.on('end', () => message.edit({ components: [] }).catch(() => {}));
        return;
    }

    if (action === 'refined') {
        const inventory = getRefinedInventory(interaction.user.id);
        return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(0x00ff99).setTitle('⚗️ Refined Materials')
                .setDescription(inventory.length
                    ? inventory.map(item => `• ${RECIPES[item.materialId]?.name || item.materialId}: **${item.quantity}**`).join('\n')
                    : 'No refined materials. Use the Refinery panel in the hub.')]
        });
    }

    /* ============ boost (was /mining-boost) ============ */
    if (action === 'boost' || action === 'boost-buy') {
        const profile = getMiningProfile(interaction.user.id);
        const next = MINING_BOOSTS.find(boost => boost.tier === profile.boostTier + 1);
        if (action === 'boost-buy') {
            if (!next) return interaction.editReply({ content: '✅ You already own every mining boost.' });
            if (profile.miningLevel < next.levelRequired) {
                return interaction.editReply({ content: `❌ Requires mining level ${next.levelRequired}.` });
            }
            const result = db.transaction(() => {
                const debit = db.prepare('UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?')
                    .run(next.cost, interaction.user.id, next.cost);
                if (debit.changes !== 1) throw new Error(`You need ${money(next.cost)}.`);
                profile.boostTier = next.tier;
                updateMiningProfile(profile);
            });
            try {
                result();
            } catch (error) {
                return interaction.editReply({ content: `❌ ${error.message}` });
            }
            logTransaction(interaction.user.id, 'mining_boost', -next.cost, `Purchased ${next.name}`);
            const bonusLine = next.bonusOre ? ` Every run now carries **+${next.bonusOre} bonus ore**.` : '';
            return interaction.editReply(`✅ Purchased **${next.name}** for **${money(next.cost)}**. Mining cooldowns are now ${Math.round(next.reduction * 100)}% shorter.${bonusLine}`);
        }

        const wallet = db.prepare('SELECT wallet FROM users WHERE userId = ?').get(interaction.user.id)?.wallet || 0;
        return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(0x00d4ff).setTitle('⚡ Mining Cooldown Boosts')
                .setDescription(MINING_BOOSTS.map(boost => {
                    const owned = boost.tier <= profile.boostTier;
                    const bonus = boost.bonusOre ? ` • **+${boost.bonusOre} ore/run**` : '';
                    return `${owned ? '✅' : '⬜'} **Tier ${boost.tier} — ${boost.name}**\n` +
                        `Cooldown: **-${Math.round(boost.reduction * 100)}%**${bonus} • Price: **${money(boost.cost)}** • Level ${boost.levelRequired}`;
                }).join('\n\n') + `\n\nWallet: **${money(wallet)}**\n\n💡 Buy the next boost from the \`/mining\` Upgrades panel — one click.`)]
        });
    }

    /* ============ events (was /mining-events) ============ */
    if (action === 'events') {
        const active = getActiveMiningEvent();
        const recent = getRecentMiningEvents(5);
        // Severity emoji: good events 📈, bad events 📉, catastrophic ☠️.
        const severity = m => m >= 1 ? '📈' : m >= 0.5 ? '📉' : '☠️';
        const lines = recent.map(event => {
            const activeMark = active?.eventId === event.eventId ? ' **(ACTIVE)**' : '';
            return `${severity(Number(event.multiplier))} **${event.name}**${activeMark} — x${Number(event.multiplier).toFixed(2)} ${event.eventType}\n${event.description}`;
        });
        return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(active ? 0xff6600 : 0x00d4ff).setTitle('🌋 Mining Event Feed')
                .setDescription(lines.join('\n\n') || 'No event has been recorded yet. Keep mining!')
                .setFooter({ text: active ? `Active until ${new Date(active.endsAt).toLocaleTimeString()}` : 'Events can begin during any mining operation.' })]
        });
    }

    /* ============ relics (was /mining-relics) ============ */
    if (action === 'relics') {
        const artifacts = getArtifacts(interaction.user.id);
        return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(0xffaa00).setTitle('🏺 Artifact Archive')
                .setDescription(artifacts.length
                    ? artifacts.map(item => `**${item.name}** ×${item.quantity} — ${item.rarity.toUpperCase()} — ${money(item.value)}`).join('\n')
                    : 'No artifacts discovered yet. Rare finds can appear during `/mine`.')
                .setFooter({ text: `${artifacts.reduce((sum, item) => sum + item.quantity, 0)} artifact(s) catalogued` })]
        });
    }

    /* ============ crew (was /mining-crew) ============ */
    if (action === 'crew-hire') {
        const wallet = db.prepare('SELECT wallet FROM users WHERE userId = ?').get(interaction.user.id)?.wallet || 0;
        const name = opts.name;
        const specialty = arg;
        if (!name || !specialty) {
            return interaction.editReply({ content: '❌ Pick a specialty button in the Crew & Guilds panel (it asks for a name).' });
        }
        const result = hireWorker(interaction.user.id, name, specialty, wallet);
        if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
        logTransaction(interaction.user.id, 'mining_worker', -result.config.cost, `Hired ${result.worker.name}`);
        return interaction.editReply(`✅ Hired **${result.worker.name}**, a ${result.worker.specialty}, for **${money(result.config.cost)}** from your wallet. Crew efficiency increased.`);
    }
    if (action === 'guild-create' || action === 'guild-join') {
        const name = opts.name;
        if (!name) {
            return interaction.editReply({ content: '❌ Give the guild a name — the panel button asks for one.' });
        }
        const result = action === 'guild-create'
            ? createGuild(interaction.user.id, name)
            : joinGuild(interaction.user.id, name);
        if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
        return interaction.editReply(`✅ You are now part of mining guild **${result.guild.name}** with ${result.guild.members.length} member(s).`);
    }
    if (action === 'guild-leave') {
        const result = leaveGuild(interaction.user.id);
        if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
        return interaction.editReply('✅ You left your mining guild. Guild ownership was transferred to the next member when necessary.');
    }
    if (action === 'guild-status') {
        const guild = getUserGuild(interaction.user.id);
        if (!guild) return interaction.editReply({ content: 'You are not in a mining guild. Use the Crew & Guilds panel to found or join one.' });
        const perkState = getGuildPerkState(interaction.user.id);
        const activeTier = perkState.guildId === guild.guildId ? perkState.tier : null;
        const nextTier = GUILD_PERK_TIERS.find(tier => tier.members > guild.members.length) || null;
        const fund = getSeasonFund(guild.guildId);
        return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(0x9966ff).setTitle(`⛏️ ${guild.name}`)
                .setDescription(`Owner: <@${guild.ownerId}>\nMembers: ${guild.members.length}\nGuild ore: **${guild.totalOre.toLocaleString()}**\nGuild credits: **${money(guild.totalCredits)}**`)
                .addFields(
                    { name: 'Crew', value: guild.members.map(member => `<@${member.userId}> (${member.role})`).join('\n') },
                    {
                        name: '⚔️ Perks',
                        value: activeTier
                            ? [
                                `Ore bonus: **+${Math.round(activeTier.oreBonus * 100)}%** per /mine run`,
                                `Crew slots: **${5 + activeTier.slots}** for every member`,
                                `Season fund: **🪙${fund.toLocaleString()}** — splits equally among all members every 24h`,
                                nextTier
                                    ? `Next tier at ${nextTier.members} members: +${Math.round(nextTier.oreBonus * 100)}% ore${nextTier.slots > activeTier.slots ? ' + crew slot' : ''}`
                                    : '🏆 Maximum tier reached.'
                            ].join('\n')
                            : `This guild is below the 2-member threshold — recruit one more member to unlock +5% ore and fund payouts.`
                    }
                )]
        });
    }

    /* ============ contracts (was /mining-contract) ============ */
    if (action === 'contract-accept') {
        const contract = getOrCreateContract(interaction.user.id);
        return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(0x00d4ff).setTitle('📜 Mining Contract Accepted')
                .setDescription(`**${contract.title}** (#${contract.contractId})`)
                .addFields(
                    { name: 'Target', value: `${contract.targetQuantity} ${contract.targetOre.replace(/_/g, ' ')}`, inline: true },
                    { name: 'Reward', value: `🪙 ${contract.reward.toLocaleString()} + ${contract.xpReward} XP`, inline: true }
                )]
        });
    }
    if (action === 'contract-claim') {
        const id = Number(arg);
        if (!id) return interaction.editReply({ content: '❌ Which contract? Use the Claim button in the Contracts panel.' });
        const result = claimContract(interaction.user.id, id);
        if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
        logTransaction(interaction.user.id, 'mining_contract', result.contract.reward, `Contract payout to mining bank: ${result.contract.title}`);
        return interaction.editReply({
            content: `✅ Contract **${result.contract.title}** paid exactly **${money(result.contract.reward)}** to your mining bank and ${result.contract.xpReward} XP to your mining profile.`
        });
    }

    /* ============ property (was /mining-properties) ============ */
    if (action === 'property-buy') {
        const propertyId = arg;
        if (!propertyId) return interaction.editReply({ content: '❌ Which claim? Use the Buy buttons in the Mine Claims panel.' });
        const result = buyProperty(interaction.user.id, propertyId);
        if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
        logTransaction(interaction.user.id, 'mining_property', -result.price, `Purchased ${result.property.name}`);
        return interaction.editReply(`✅ Purchased **${result.property.name}** for **${money(result.price)}**. Mining yield bonus is now included in /mine.`);
    }
    if (action === 'property-upgrade') {
        const propertyId = arg;
        if (!propertyId) return interaction.editReply({ content: '❌ Which claim? Use the Upgrade buttons in the Mine Claims panel.' });
        const result = upgradeProperty(interaction.user.id, propertyId);
        if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
        logTransaction(interaction.user.id, 'mining_property_upgrade', -result.price, `Upgraded ${result.property.name} to level ${result.level}`);
        return interaction.editReply(`✅ Upgraded **${result.property.name}** to level **${result.level}** for **${money(result.price)}**.`);
    }

    /* ============ equipment (was /drill's select logic) ============ */
    if (action === 'drill-buy' || action === 'location-unlock') {
        // One handler for both pick-lists on the Equipment panel: buying a
        // drill auto-equips it; unlocking a location auto-travels there.
        // Replies are returned as strings, not posted — the select handlers
        // render the outcome as a banner above the refreshed panel, so a
        // content line here would linger and show the message twice.
        const say = message => message;
        const id = arg;
        if (action === 'drill-buy') {
            const drill = drills[id];
            if (!drill) return say('❌ Unknown drill.');
            const profile = getMiningProfile(interaction.user.id);
            if (drill.levelRequired > profile.miningLevel) {
                return say(`❌ **${drill.name}** requires mining level ${drill.levelRequired}.`);
            }

            if (!profile.ownedDrills.includes(id)) {
                const cost = getDrillUpgradeCost(id);
                const wallet = db.prepare('SELECT wallet FROM users WHERE userId = ?').get(interaction.user.id)?.wallet || 0;
                if (wallet < cost) {
                    return say(`❌ Insufficient funds. **${drill.name}** costs 🪙${cost.toLocaleString()} — you have 🪙${wallet.toLocaleString()}.`);
                }
                db.transaction(() => {
                    const debit = db.prepare('UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?')
                        .run(cost, interaction.user.id, cost);
                    if (debit.changes !== 1) throw new Error(`Purchase failed. Exact price is 🪙${cost.toLocaleString()}.`);
                    profile.ownedDrills.push(id);
                    profile.activeDrill = id;
                    updateMiningProfile(profile);
                })();
                logTransaction(interaction.user.id, 'mining_drill', -cost, `Purchased & equipped ${drill.name}`);
                return say(`✅ Purchased **${drill.name}** for 🪙${cost.toLocaleString()} and equipped it.`);
            }

            profile.activeDrill = id;
            updateMiningProfile(profile);
            return say(`✅ Equipped **${drill.name}**.`);
        }

        const loc = locations[id];
        if (!loc) return say('❌ Unknown location.');
        const profile = getMiningProfile(interaction.user.id);
        if (loc.levelRequired > profile.miningLevel) {
            return say(`❌ **${loc.name}** requires mining level ${loc.levelRequired}.`);
        }

        if (!profile.unlockedLocations.includes(id)) {
            const cost = getLocationUnlockCost(id);
            const wallet = db.prepare('SELECT wallet FROM users WHERE userId = ?').get(interaction.user.id)?.wallet || 0;
            if (wallet < cost) {
                return say(`❌ Insufficient funds. Unlocking **${loc.name}** costs 🪙${cost.toLocaleString()} — you have 🪙${wallet.toLocaleString()}.`);
            }
            db.transaction(() => {
                const debit = db.prepare('UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?')
                    .run(cost, interaction.user.id, cost);
                if (debit.changes !== 1) throw new Error(`Purchase failed. Exact price is 🪙${cost.toLocaleString()}.`);
                profile.unlockedLocations.push(id);
                profile.activeLocation = id;
                updateMiningProfile(profile);
            })();
            logTransaction(interaction.user.id, 'mining_location', -cost, `Unlocked ${loc.name}`);
            return say(`🔓 Unlocked **${loc.name}** for 🪙${cost.toLocaleString()} — now mining there.`);
        }

        profile.activeLocation = id;
        updateMiningProfile(profile);
        return say(`✅ Travelled to **${loc.name}**.`);
    }

    if (action === 'drill-info' || action === 'location-info') {
        // Detail cards for the ACTIVE drill / location (were /drill's ℹ️
        // buttons). The card replaces the panel; the back row returns to hub.
        const profile = getMiningProfile(interaction.user.id);
        if (action === 'drill-info') {
            const drill = drills[profile.activeDrill];
            if (!drill) return interaction.editReply({ content: '❌ No drill equipped.' });
            const card = new EmbedBuilder()
                .setColor(0x00aaff)
                .setTitle(`🔧 ${drill.name}`)
                .setDescription(drill.description)
                .addFields(
                    { name: '⚡ RARITY BONUS', value: `+${drill.rarityBonus}%`, inline: true },
                    { name: '⏱ COOLDOWN REDUCTION', value: `-${(drill.cooldownReduction / 1000).toFixed(0)}s`, inline: true },
                    { name: '📊 MINING EFFICIENCY', value: `x${drill.miningEfficiency.toFixed(1)}`, inline: true },
                    { name: '📊 LEVEL REQUIRED', value: `Level ${drill.levelRequired}`, inline: true },
                    { name: '💰 PURCHASE PRICE', value: `🪙 ${getDrillUpgradeCost(profile.activeDrill).toLocaleString()} (wallet)`, inline: true }
                )
                .setFooter({ text: 'NEURAL MINING SYSTEM v2.1 // EQUIPMENT INFO' });
            await interaction.editReply({ embeds: [card], components: [backRow(interaction.user.id)] });
            return true;
        }
        const loc = locations[profile.activeLocation];
        if (!loc) return interaction.editReply({ content: '❌ No active location.' });
        const unlocked = profile.unlockedLocations.includes(profile.activeLocation);
        const card = new EmbedBuilder()
            .setColor(0x00aaff)
            .setTitle(`📍 ${loc.name}`)
            .setDescription(loc.description)
            .addFields(
                { name: '📊 LEVEL REQUIRED', value: `Level ${loc.levelRequired}`, inline: true },
                { name: '⏱ BASE COOLDOWN', value: `${(loc.baseCooldown / 3600000).toFixed(0)}h (drills & boosts shorten this)`, inline: true },
                { name: '🔓 STATUS', value: unlocked ? 'Unlocked' : `Locked — 🪙${getLocationUnlockCost(profile.activeLocation).toLocaleString()} to unlock`, inline: true }
            )
            .setFooter({ text: 'NEURAL MINING SYSTEM v2.1 // LOCATION INFO' });
        await interaction.editReply({ embeds: [card], components: [backRow(interaction.user.id)] });
        return true;
    }

    /* ============ stats (was /mining-stats) ============ */
    if (action === 'stats') {
        const targetUser = interaction.user;
        const targetId = targetUser.id;
        ensureUser(targetId);
        const profile = getMiningProfile(targetId);
        const nextLevelXp = xpNeeded(profile.miningLevel);
        const xpRemaining = Math.max(0, nextLevelXp - profile.miningXp);
        const balance = db.prepare('SELECT COALESCE(mining_bank, 0) AS miningBank FROM users WHERE userId = ?').get(targetId)?.miningBank || 0;
        const ore = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS quantity FROM mining_inventory WHERE userId = ?').get(targetId)?.quantity || 0;
        const properties = getOwnedProperties(targetId);
        const drone = getDrone(targetId);
        const cooldownLine = canMine(profile) ? '✅ ready — run `/mine`!' : `⏳ ready <t:${Math.floor(profile.mineCooldown / 1000)}:R>`;
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00d4ff)
            .setTitle(`Mining Stats — ${targetUser.displayName || targetUser.username}`)
            .addFields(
            { name: 'Level / XP', value: `${profile.miningLevel} / ${profile.miningXp}`, inline: true },
            { name: 'XP to next level', value: `${xpRemaining.toLocaleString()} XP (${profile.miningXp.toLocaleString()} / ${nextLevelXp.toLocaleString()})`, inline: true },
            { name: 'Quick runs', value: `${profile.totalMines}`, inline: true },
            { name: 'Ore stored', value: `${ore}`, inline: true },
            { name: 'Mining bank', value: `${money(balance)}`, inline: true },
            { name: 'Drill / Location', value: `${drills[profile.activeDrill]?.name ?? profile.activeDrill} / ${locations[profile.activeLocation]?.name ?? profile.activeLocation}`, inline: true },
            { name: 'Next run', value: cooldownLine, inline: true },
            { name: 'Workers / Drone fleet', value: `${getWorkers(targetId).length} / tier ${drone.tier || 0} ×${drone.count || 0}`, inline: true },
            { name: 'Properties', value: `${properties.length}`, inline: true },
            { name: 'Streak', value: `${profile.miningStreak}`, inline: true }
        )] });
    }

    /* ============ property view panel (was /mining-properties view) ============ */
    if (action === 'property') {
        const owned = new Map(getOwnedProperties(interaction.user.id).map(row => [row.propertyId, row]));
        const embed = new EmbedBuilder()
            .setColor(0x00d4ff)
            .setTitle('⛏️ MINING PROPERTY EXCHANGE')
            .setDescription(`Persistent claims boost every extraction. Combined yield multiplier: **x${getYieldMultiplier(interaction.user.id).toFixed(2)}**\n\n💡 Buy and upgrade claims with one click from the \`/mining\` Mine Claims panel.`);
        for (const property of MINING_PROPERTIES) {
            embed.addFields({
                name: `${property.name} ${owned.has(property.id) ? '✅' : '⬜'}`,
                value: `${property.description}\n${propertyDescription(property, owned.get(property.id))}`,
                inline: false
            });
        }
        return interaction.editReply({ embeds: [embed] });
    }

    /* ============ leaderboard (was /mining-leaderboard) ============ */
    if (action === 'leaderboard') {
        const rows = getLeaderboard(10);
        return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(0xffd700).setTitle('🏆 Seasonal Mining Leaderboard')
                .setDescription(rows.length
                    ? rows.map((row, index) => `**${index + 1}.** <@${row.userId}> — ⛏️ ${row.oreMined.toLocaleString()} ore · 🪙 ${row.creditsEarned.toLocaleString()} · 🏺 ${row.artifactsFound}`).join('\n')
                    : 'No mining activity recorded this season.')
                .setFooter({ text: `Season ${seasonKey()} • Rankings reset quarterly` })]
        });
    }

    // crew (workers view) — the plain fallback
    const workers = getWorkers(interaction.user.id);
    return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x9966ff).setTitle('👷 Mining Crew')
            .setDescription(workers.length
                ? workers.map(worker => `**${worker.name}** — ${worker.specialty} (efficiency ${worker.efficiency})`).join('\n')
                : 'No workers hired. Use the Crew & Guilds panel.')]
    });
}

/* =========================
   GUIDED HUB — the simple path. /mining with no action opens the hub menu;
   each section panel owns its complete section (views + one-click buttons +
   sub-selects), so players never memorize action names. Slash shortcuts map
   onto the same panels; runAction stays the single engine.
========================= */

const HUB_SECTIONS = [
    { id: 'equipment', label: '🔧 Drill & Locations', desc: 'Upgrade your drill, unlock and travel to mining sites' },
    { id: 'fleet', label: '🚁 Drone Fleet', desc: 'Buy, station, and recall automated miners' },
    { id: 'refine', label: '⚗️ Refinery', desc: 'Turn raw ore into higher-value materials' },
    { id: 'upgrades', label: '⚡ Boosts', desc: 'Shorten mine cooldowns, add bonus ore' },
    { id: 'crew', label: '👷 Crew & Guilds', desc: 'Hire workers, join a mining guild' },
    { id: 'contracts', label: '📜 Contracts', desc: 'Ore commissions that pay bonus rewards' },
    { id: 'property', label: '⛏️ Mine Claims', desc: 'Permanent yield & revenue upgrades' },
    { id: 'info', label: '📊 Stats & Records', desc: 'Progress, artifacts, events, leaderboard' },
    { id: 'guide', label: '📖 Full Guide', desc: 'The complete SlashyTron mining guide' }
];

function hubMenu(userId) {
    return new StringSelectMenuBuilder()
        .setCustomId(`mining-hub:${userId}`)
        .setPlaceholder('Where to? Pick a mining section…')
        .addOptions(HUB_SECTIONS.map(section => ({
            label: section.label,
            description: section.desc,
            value: section.id
        })));
}

function backRow(userId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mining-back:${userId}`).setLabel('⬅ Hub').setStyle(ButtonStyle.Secondary)
    );
}

function hubEmbed(interaction) {
    const profile = getMiningProfile(interaction.user.id);
    const cooldownMs = Math.max(0, (profile.mineCooldown || 0) - Date.now());
    const nextMine = cooldownMs > 0
        ? `⏳ next run in <t:${Math.floor((Date.now() + cooldownMs) / 1000)}:R>`
        : '✅ ready to run now';
    return new EmbedBuilder()
        .setColor(0x00d4ff)
        .setTitle('⛏️ MINING COMMAND HUB')
        .setDescription([
            `**Drill:** ${drills[profile.activeDrill]?.name ?? profile.activeDrill} · **Location:** ${locations[profile.activeLocation]?.name ?? profile.activeLocation}`,
            `**Mining bank:** ${money(db.prepare('SELECT COALESCE(mining_bank, 0) AS v FROM users WHERE userId = ?').get(interaction.user.id)?.v || 0)} · ${nextMine}`,
            '',
            'Pick a section below. Each panel explains itself and gives you buttons — no command syntax to remember.',
            MINE_HINT
        ].join('\n'));
}

/* Entry from the slash command (already deferred + user ensured). */
async function openHub(interaction) {
    const message = await interaction.editReply({
        embeds: [hubEmbed(interaction)],
        components: [new ActionRowBuilder().addComponents(hubMenu(interaction.user.id))],
        fetchReply: true
    });
    // Section selection is owned by handleComponent (routed from index.js) —
    // this collector only clears the menu when the hub times out.
    const collector = message.createMessageComponentCollector({ time: 180_000 });
    collector.on('end', () => message.edit({ components: [] }).catch(() => {}));
}

/* Section panels — each fully self-contained. */
async function openSection(interaction, section) {
    switch (section) {
        case 'equipment': return equipmentPanel(interaction);
        case 'fleet': return fleetPanel(interaction);
        case 'refine': return runAction(interaction, 'refine'); // refinery was already a guided panel
        case 'upgrades': return upgradesPanel(interaction);
        case 'crew': return crewPanel(interaction);
        case 'contracts': return contractsPanel(interaction);
        case 'property': return propertyPanel(interaction);
        case 'info': return infoPanel(interaction);
        case 'guide': return executeHelp(interaction);
        default:
            return interaction.editReply({ content: '❌ Unknown mining section.' });
    }
}

/* Shared: every panel message keeps ONE lightweight collector whose only job
   is to clear stale components when the panel times out. Every click is
   handled by handleComponent (routed from index.js) — processing ops here as
   well would double-handle each press. */
function panelRouter(_interaction, message) {
    const collector = message.createMessageComponentCollector({ time: 240_000 });
    collector.on('collect', () => {}); // clicks are owned by handleComponent
    collector.on('end', () => message.edit({ components: [] }).catch(() => {}));
}

function actionSection(action) {
    return ({
        'drill-buy': 'equipment', 'location-unlock': 'equipment',
        'drone-buy': 'fleet', 'boost-buy': 'upgrades', 'crew-hire': 'crew',
        'guild-create': 'crew', 'guild-join': 'crew', 'guild-leave': 'crew', 'guild-status': 'crew',
        'contract-accept': 'contracts', 'contract-claim': 'contracts',
        'property-buy': 'property', 'property-upgrade': 'property'
    })[action];
}

function opButton(userId, action, label, style = ButtonStyle.Primary, arg = null, disabled = false) {
    return new ButtonBuilder().setCustomId(`mining-op:${userId}:${action}${arg ? `:${arg}` : ''}`).setLabel(label).setStyle(style).setDisabled(disabled);
}

/*
 * buildSectionView — the live view behind each panel (also what re-renders
 * after a button op). Returns { embed, rows }.
 */
async function buildSectionView(interaction, section) {
    const userId = interaction.user.id;
    const embed = new EmbedBuilder();

    if (section === 'equipment') {
        // Drill upgrade + location unlock/equip — absorbed /drill's terminal.
        const profile = getMiningProfile(userId);
        const wallet = db.prepare('SELECT wallet FROM users WHERE userId = ?').get(userId)?.wallet || 0;
        const activeDrill = drills[profile.activeDrill];
        const activeLoc = locations[profile.activeLocation];
        embed.setColor(0x00ffff).setTitle('🔧 DRILL & LOCATIONS')
            .setDescription([
                `**Equipped drill:** ${activeDrill?.name ?? profile.activeDrill} · efficiency x${(activeDrill?.miningEfficiency ?? 1).toFixed(1)} · rarity +${activeDrill?.rarityBonus ?? 0}%`,
                `**Mining at:** ${activeLoc?.name ?? profile.activeLocation} · ${(activeLoc ? (activeLoc.baseCooldown / 3600000).toFixed(0) : 3)}h base cooldown`,
                `**Mining level:** ${profile.miningLevel} · **Wallet:** ${money(wallet)}`,
                `**Record:** 🔥 ${profile.miningStreak}-day streak · 🏆 ${profile.totalMines} runs · ⚡ boost tier ${profile.boostTier}`,
                `**Support:** 🤖 ${getDrone(userId).count || 0} drone(s) · 👷 ${getWorkers(userId).length} worker(s)`,
                '',
                'Pick a drill to buy & equip (or re-equip an owned one), and a location to unlock & travel to — both lists below.'
            ].join('\n'))
            .addFields(
                ...Object.entries(drills).filter(([, drill]) => drill.levelRequired <= profile.miningLevel)
                    .slice(0, 6)
                    .map(([id, drill]) => {
                        const owned = profile.ownedDrills.includes(id);
                        const equipped = profile.activeDrill === id;
                        const cost = getDrillUpgradeCost(id);
                        return {
                            name: `${equipped ? '⚡' : owned ? '✅' : '🔒'} ${drill.name}`,
                            value: equipped ? 'Currently equipped'
                                : owned ? 'Owned — pick it below to equip'
                                    : `Buy & equip — ${money(cost)} · rarity +${drill.rarityBonus}% · cooldown -${(drill.cooldownReduction / 1000).toFixed(0)}s · efficiency x${drill.miningEfficiency.toFixed(1)}`,
                            inline: false
                        };
                    }),
                ...Object.entries(locations).filter(([, loc]) => loc.levelRequired <= profile.miningLevel)
                    .map(([id, loc]) => {
                        const unlocked = profile.unlockedLocations.includes(id);
                        const active = profile.activeLocation === id;
                        const cost = getLocationUnlockCost(id);
                        return {
                            name: `${active ? '📍' : unlocked ? '✅' : '🔒'} ${loc.name}`,
                            value: active ? 'Currently active'
                                : unlocked ? 'Unlocked — pick it below to travel'
                                    : `Unlock & travel — ${money(cost)} · ${loc.description}`,
                            inline: false
                        };
                    })
            );
        const rows = [];
        const drillChoices = Object.entries(drills)
            .filter(([id, drill]) => drill.levelRequired <= profile.miningLevel)
            .map(([id, drill]) => ({
                id,
                owned: profile.ownedDrills.includes(id),
                cost: getDrillUpgradeCost(id),
                name: drill.name
            }));
        if (drillChoices.length) {
            rows.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`mining-drill-select:${userId}`)
                    .setPlaceholder('Pick a drill to buy or equip…')
                    .addOptions(drillChoices.map(drill => ({
                        label: `${drill.owned ? '✅' : '🛒'} ${drill.name}`.slice(0, 100),
                        description: (drill.owned ? 'Owned — select to equip' : `Buy & equip — ${money(drill.cost)}`).slice(0, 100),
                        value: drill.id
                    })))
            ));
        }
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`mining-location-select:${userId}`)
                .setPlaceholder('Pick a location to unlock or travel…')
                .addOptions(Object.entries(locations)
                    .filter(([id, loc]) => loc.levelRequired <= profile.miningLevel)
                    .map(([id, loc]) => ({
                        label: `${profile.unlockedLocations.includes(id) ? '✅' : '🔒'} ${loc.name}`.slice(0, 100),
                        description: (profile.activeLocation === id ? 'Currently active'
                            : profile.unlockedLocations.includes(id) ? 'Unlocked — select to travel'
                                : `Unlock & travel — ${money(getLocationUnlockCost(id))}`).slice(0, 100),
                        value: id
                    })))
        ));
        rows.push(new ActionRowBuilder().addComponents(
            opButton(userId, 'drill-info', 'ℹ️ Drill info', ButtonStyle.Secondary),
            opButton(userId, 'location-info', 'ℹ️ Location info', ButtonStyle.Secondary)
        ));
        rows.push(backRow(userId));
        return { embed, rows };
    }

    if (section === 'fleet') {
        const droneCollection = collectDroneOre(userId);
        const fleet = getFleet(userId);
        const summary = getDrone(userId);
        embed.setColor(0x00d4ff).setTitle('🚁 DRONE HANGAR');
        if (!fleet.length) {
            embed.setDescription([
                'Drones mine **while you are away** — each one works its own site on its own timer and stocks your ore store.',
                '',
                'Buy your first drone with a button below:'
            ].join('\n'));
        } else {
            const lines = fleet.map((drone, index) => {
                const tier = DRONE_TIERS.find(item => item.tier === drone.tier);
                const post = drone.assignedLocation
                    ? `📍 ${locations[drone.assignedLocation]?.name || drone.assignedLocation}`
                    : '💤 idle in hangar';
                return `**#${index + 1} ${tier.name}** — ${post} · ${drone.totalOreCollected || 0} lifetime ore`;
            });
            const idle = fleet.filter(d => !d.assignedLocation).length;
            embed.setDescription([
                `**Fleet: ${fleet.length}/${DRONE_FLEET_MAX} · Tier ${summary.tier} (${DRONE_TIERS.find(t => t.tier === summary.tier)?.name})**`,
                '',
                ...lines,
                '',
                idle ? `💤 ${idle} idle drone(s) — station them below (one per location).` : '✅ All drones on station.',
                droneCollection.quantity ? `\n📦 Swept **${droneCollection.quantity} ore** into your store just now.` : ''
            ].join('\n'));
        }
        const rows = [];
        if (fleet.length) {
            const profile = getMiningProfile(userId);
            const assignMenu = new StringSelectMenuBuilder()
                .setCustomId(`mining-drone-station:${userId}`)
                .setPlaceholder('Station a drone at a site…')
                .addOptions(fleet.flatMap((drone, index) => {
                    const tier = DRONE_TIERS.find(item => item.tier === drone.tier);
                    return Object.entries(locations)
                        .filter(([id]) => profile.unlockedLocations.includes(id))
                        .map(([id, loc]) => ({
                            label: `#${index + 1} → ${loc.name}`.slice(0, 100),
                            description: drone.assignedLocation === id ? 'Already stationed here' : `Tier ${drone.tier} drone`,
                            value: `${index + 1}:${id}`
                        }));
                }).slice(0, 25));
            rows.push(new ActionRowBuilder().addComponents(assignMenu));
            const recallMenu = new StringSelectMenuBuilder()
                .setCustomId(`mining-drone-recall:${userId}`)
                .setPlaceholder('Recall a drone…')
                .addOptions(fleet.map((drone, index) => ({
                    label: `#${index + 1} ${DRONE_TIERS.find(item => item.tier === drone.tier)?.name ?? `Tier ${drone.tier}`}`,
                    description: drone.assignedLocation ? `From ${locations[drone.assignedLocation]?.name || drone.assignedLocation}` : 'Already in the hangar',
                    value: String(index + 1)
                })));
            rows.push(new ActionRowBuilder().addComponents(recallMenu));
        }
        const wallet = db.prepare('SELECT wallet FROM users WHERE userId = ?').get(userId)?.wallet || 0;
        rows.push(new ActionRowBuilder().addComponents(
            DRONE_TIERS.map(tier => opButton(userId, 'drone-buy', `Tier ${tier.tier} — ${money(tier.cost)}`,
                tier.cost > wallet ? ButtonStyle.Secondary : ButtonStyle.Success,
                String(tier.tier), tier.cost > wallet))
        ));
        rows.push(backRow(userId));
        return { embed, rows };
    }

    if (section === 'upgrades') {
        const profile = getMiningProfile(userId);
        const next = MINING_BOOSTS.find(boost => boost.tier === profile.boostTier + 1);
        const wallet = db.prepare('SELECT wallet FROM users WHERE userId = ?').get(userId)?.wallet || 0;
        embed.setColor(0xffd700).setTitle('⚡ COOLDOWN BOOSTS')
            .setDescription([
                ...MINING_BOOSTS.map(boost => {
                    const owned = boost.tier <= profile.boostTier;
                    const bonus = boost.bonusOre ? ` • **+${boost.bonusOre} ore/run**` : '';
                    return `${owned ? '✅' : '⬜'} **Tier ${boost.tier} — ${boost.name}**\nCooldown **-${Math.round(boost.reduction * 100)}%**${bonus} • ${money(boost.cost)} • Level ${boost.levelRequired}`;
                }),
                '',
                `Wallet: **${money(wallet)}**`,
                next ? (next.cost <= wallet ? '✅ You can afford the next boost — one click below.' : '❌ Not enough wallet for the next boost yet.') : '✅ Every boost owned — maximum reduction reached.',
                MINE_HINT
            ].join('\n'));
        const rows = [new ActionRowBuilder().addComponents(
            opButton(userId, 'boost-buy', next ? `Buy ${next.name} — ${money(next.cost)}` : 'All boosts owned',
                next && next.cost <= wallet ? ButtonStyle.Success : ButtonStyle.Secondary, null, !next)
        ), backRow(userId)];
        return { embed, rows };
    }

    if (section === 'crew') {
        const workers = getWorkers(userId);
        const guild = getUserGuild(userId);
        const wallet = db.prepare('SELECT wallet FROM users WHERE userId = ?').get(userId)?.wallet || 0;
        const perkState = getGuildPerkState(userId);
        const workerCap = 5 + getGuildWorkerSlotBonus(userId);
        const nextTier = perkState.inGuild
            ? GUILD_PERK_TIERS.find(tier => tier.members > perkState.memberCount) || null
            : GUILD_PERK_TIERS[0];
        const wageStatus = getWageStatus();

        const perkLines = perkState.inGuild && perkState.tier
            ? [
                `⚔️ **Ore bonus:** +${Math.round(perkState.tier.oreBonus * 100)}% per /mine run`,
                `👷 **Crew slots:** ${workerCap} (base 5${perkState.tier.slots ? ' + 1 guild bonus' : ''})`,
                `💰 **Season fund:** 🪙${getSeasonFund(perkState.guildId).toLocaleString()} — splits equally among all members every 24h${wageStatus.nextAt ? ` (next payroll <t:${Math.ceil(wageStatus.nextAt / 1000)}:R>)` : ''}`,
                nextTier
                    ? `📈 Next tier at **${nextTier.members} members**: +${Math.round(nextTier.oreBonus * 100)}% ore${nextTier.slots > perkState.tier.slots ? ' + crew slot' : ''}`
                    : '🏆 Maximum guild tier reached.'
            ]
            : [
                '⚔️ **Guild perks:** join a guild to earn them —',
                ...GUILD_PERK_TIERS.map(tier => `• ${tier.members}+ members: **+${Math.round(tier.oreBonus * 100)}% ore**${tier.slots ? ' + 1 crew slot' : ''} + daily fund payout`),
                '💡 Create or join below, then every /mine feeds your guild fund.'
            ];

        embed.setColor(0x9966ff).setTitle('👷 CREW & GUILDS')
            .setDescription([
                `**Workers (${workers.length}/${workerCap})** — each adds efficiency to quick runs:`,
                workers.length ? workers.map(w => `• **${w.name}** — ${w.specialty} (efficiency ${w.efficiency})`).join('\n') : '• none yet',
                '',
                guild
                    ? `**Guild:** ⛏️ ${guild.name} — ${guild.members.length} member(s) · guild ore ${guild.totalOre.toLocaleString()}`
                    : '**Guild:** none — found or join one below.',
                ...perkLines,
                '',
                `Specialties & prices: ${Object.entries(WORKER_SPECIALTIES).map(([id, cfg]) => `${id} ${money(cfg.cost)}`).join(' · ')}`,
                `Wallet: **${money(wallet)}**`
            ].join('\n'));
        const rows = [];
        rows.push(new ActionRowBuilder().addComponents(
            Object.entries(WORKER_SPECIALTIES).map(([id, cfg]) =>
                opButton(userId, 'crew-hire', `${id[0].toUpperCase() + id.slice(1)} — ${money(cfg.cost)}`,
                    cfg.cost > wallet ? ButtonStyle.Secondary : ButtonStyle.Success, id, cfg.cost > wallet))
        ));
        rows.push(new ActionRowBuilder().addComponents(
            opButton(userId, 'guild-create', 'Create a guild', ButtonStyle.Secondary),
            opButton(userId, 'guild-join', 'Join a guild', ButtonStyle.Secondary),
            opButton(userId, 'guild-leave', 'Leave guild', ButtonStyle.Danger, null, !guild),
            opButton(userId, 'guild-status', 'Refresh guild info', ButtonStyle.Secondary, null, !guild)
        ));
        rows.push(backRow(userId));
        return { embed, rows };
    }

    if (section === 'contracts') {
        const contractList = getContracts(userId);
        const active = contractList.filter(c => c.status === 'active');
        const ready = contractList.filter(c => c.status === 'completed');
        embed.setColor(0x00d4ff).setTitle('📜 MINING CONTRACTS')
            .setDescription([
                active.length
                    ? active.map(c => `**${c.title}** (#${c.contractId}) — deliver ${c.targetQuantity} ${String(c.targetOre).replace(/_/g, ' ')} → ${money(c.reward)} + ${c.xpReward} XP`).join('\n')
                    : 'No active contract — accept one below.',
                ready.length
                    ? `\n✅ Ready to claim: ${ready.map(c => `#${c.contractId} ${c.title} (${money(c.reward)})`).join(' · ')}`
                    : '',
                '',
                'Deliver the ore with `/mine`, then hit **Claim**. Contracts pay to your mining bank.'
            ].filter(Boolean).join('\n'));
        const rows = [];
        if (ready.length) {
            rows.push(new ActionRowBuilder().addComponents(
                ready.slice(0, 5).map(c => opButton(userId, 'contract-claim', `Claim #${c.contractId} — ${money(c.reward)}`, ButtonStyle.Success, String(c.contractId)))
            ));
        }
        rows.push(new ActionRowBuilder().addComponents(
            opButton(userId, 'contract-accept', 'Accept a new contract', ButtonStyle.Primary, null, active.length > 0)
        ));
        rows.push(backRow(userId));
        return { embed, rows };
    }

    if (section === 'property') {
        const owned = new Map(getOwnedProperties(userId).map(row => [row.propertyId, row]));
        const wallet = db.prepare('SELECT wallet FROM users WHERE userId = ?').get(userId)?.wallet || 0;
        embed.setColor(0x00d4ff).setTitle('⛏️ MINE CLAIMS (PROPERTY)')
            .setDescription(`Persistent claims boost every extraction. Combined yield multiplier: **x${getYieldMultiplier(userId).toFixed(2)}** · Wallet: **${money(wallet)}**`);
        for (const property of MINING_PROPERTIES) {
            embed.addFields({
                name: `${property.name} ${owned.has(property.id) ? '✅' : '⬜'}`,
                value: `${property.description}\n${propertyDescription(property, owned.get(property.id))}`,
                inline: false
            });
        }
        const rows = [new ActionRowBuilder().addComponents(
            MINING_PROPERTIES.map(property => {
                const ownedRow = owned.get(property.id);
                const affordable = (ownedRow ? property.upgradeBase * ownedRow.level : property.price) <= wallet;
                return opButton(userId, ownedRow ? 'property-upgrade' : 'property-buy',
                    ownedRow ? `Upgrade ${property.name}` : `Buy ${property.name}`,
                    affordable ? ButtonStyle.Success : ButtonStyle.Secondary, property.id, false);
            })
        ), backRow(userId)];
        return { embed, rows };
    }

    if (section === 'info') {
        const targetUser = interaction.user;
        ensureUser(targetUser.id);
        const profile = getMiningProfile(targetUser.id);
        const nextLevelXp = xpNeeded(profile.miningLevel);
        const xpRemaining = Math.max(0, nextLevelXp - profile.miningXp);
        const balance = db.prepare('SELECT COALESCE(mining_bank, 0) AS miningBank FROM users WHERE userId = ?').get(targetUser.id)?.miningBank || 0;
        const ore = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS quantity FROM mining_inventory WHERE userId = ?').get(targetUser.id)?.quantity || 0;
        const properties = getOwnedProperties(targetUser.id);
        const drone = getDrone(targetUser.id);
        const cooldownLine = canMine(profile) ? '✅ ready — run `/mine`!' : `⏳ ready <t:${Math.floor(profile.mineCooldown / 1000)}:R>`;
        const artifacts = getArtifacts(targetUser.id);
        const active = getActiveMiningEvent();
        const recent = getRecentMiningEvents(3);
        const severity = m => m >= 1 ? '📈' : m >= 0.5 ? '📉' : '☠️';
        embed.setColor(0x00d4ff).setTitle(`📊 MINING STATS — ${targetUser.displayName || targetUser.username}`)
            .addFields(
                { name: 'Level / XP', value: `${profile.miningLevel} · ${xpRemaining.toLocaleString()} XP to next`, inline: true },
                { name: 'Mining bank', value: `${money(balance)}`, inline: true },
                { name: 'Ore stored', value: `${ore.toLocaleString()}`, inline: true },
                { name: 'Drill / Location', value: `${drills[profile.activeDrill]?.name ?? profile.activeDrill} / ${locations[profile.activeLocation]?.name ?? profile.activeLocation}`, inline: true },
                { name: 'Next run', value: cooldownLine, inline: true },
                { name: 'Quick runs / Streak', value: `${profile.totalMines} / ${profile.miningStreak}`, inline: true },
                { name: 'Workers / Drones', value: `${getWorkers(targetUser.id).length} / tier ${drone.tier || 0} ×${drone.count || 0}`, inline: true },
                { name: 'Claims / Artifacts', value: `${properties.length} / ${artifacts.reduce((s, a) => s + a.quantity, 0)}`, inline: true },
                { name: 'Active event', value: active ? `${severity(Number(active.multiplier))} ${active.name} (x${Number(active.multiplier).toFixed(2)})` : 'none', inline: true },
                { name: 'Recent events', value: recent.length ? recent.map(e => `${severity(Number(e.multiplier))} ${e.name}`).join(' · ') : 'none yet', inline: true },
                { name: 'Boost tier', value: `${profile.boostTier}`, inline: true },
                { name: 'Contracts', value: `${getContracts(targetUser.id).filter(c => c.status === 'active').length} active`, inline: true }
            );
        const rows = [new ActionRowBuilder().addComponents(
            opButton(userId, 'open-section', '🚁 Hangar', ButtonStyle.Secondary, 'fleet'),
            opButton(userId, 'events', '🌋 Event feed', ButtonStyle.Secondary),
            opButton(userId, 'relics', '🏺 Artifacts', ButtonStyle.Secondary),
            opButton(userId, 'leaderboard', '🏆 Leaderboard', ButtonStyle.Secondary),
            opButton(userId, 'refined', '⚗️ Refined stock', ButtonStyle.Secondary)
        ), backRow(userId)];
        return { embed, rows };
    }

    return { embed: embed.setColor(0xff5577).setTitle('Unknown section'), rows: [backRow(userId)] };
}

/* Panel shells — build the view, wire the collector. */
async function equipmentPanel(interaction) {
    const view = await buildSectionView(interaction, 'equipment');
    const message = await interaction.editReply({ embeds: [view.embed], components: view.rows, fetchReply: true });
    panelRouter(interaction, message);
}
async function fleetPanel(interaction) {
    const view = await buildSectionView(interaction, 'fleet');
    const message = await interaction.editReply({ embeds: [view.embed], components: view.rows, fetchReply: true });
    panelRouter(interaction, message);
}
async function upgradesPanel(interaction) {
    const view = await buildSectionView(interaction, 'upgrades');
    const message = await interaction.editReply({ embeds: [view.embed], components: view.rows, fetchReply: true });
    panelRouter(interaction, message);
}
async function crewPanel(interaction) {
    const view = await buildSectionView(interaction, 'crew');
    const message = await interaction.editReply({ embeds: [view.embed], components: view.rows, fetchReply: true });
    panelRouter(interaction, message);
}
async function contractsPanel(interaction) {
    const view = await buildSectionView(interaction, 'contracts');
    const message = await interaction.editReply({ embeds: [view.embed], components: view.rows, fetchReply: true });
    panelRouter(interaction, message);
}
async function propertyPanel(interaction) {
    const view = await buildSectionView(interaction, 'property');
    const message = await interaction.editReply({ embeds: [view.embed], components: view.rows, fetchReply: true });
    panelRouter(interaction, message);
}
async function infoPanel(interaction) {
    const view = await buildSectionView(interaction, 'info');
    const message = await interaction.editReply({ embeds: [view.embed], components: view.rows, fetchReply: true });
    panelRouter(interaction, message);
}

/*
 * Component router — wired from index.js for button & select interactions.
 * Covers: hub menu, back-to-hub buttons, drone station/recall selects, and
 * all `mining-op:` action buttons.
 */
async function handleComponent(interaction) {
    const userId = interaction.user.id;
    ensureUser(userId);

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('mining-hub:')) {
        if (interaction.customId !== `mining-hub:${userId}`) {
            return interaction.reply({ content: 'This mining hub is not yours.', ephemeral: true });
        }
        await interaction.deferUpdate();
        return openSection(interaction, interaction.values[0]);
    }
    if (interaction.isButton() && interaction.customId.startsWith('mining-back:')) {
        if (interaction.customId !== `mining-back:${userId}`) {
            return interaction.reply({ content: 'This mining panel is not yours.', ephemeral: true });
        }
        await interaction.deferUpdate();
        // Re-open the hub menu in place (selections stay owned by
        // handleComponent; this collector only clears components on timeout).
        const message = await interaction.editReply({
            embeds: [hubEmbed(interaction)],
            components: [new ActionRowBuilder().addComponents(hubMenu(userId))],
            fetchReply: true
        });
        const collector = message.createMessageComponentCollector({ time: 180_000 });
        collector.on('end', () => message.edit({ components: [] }).catch(() => {}));
        return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('mining-drill-select:')) {
        // Equipment panel: buy/equip a drill (arg carries the drill id).
        if (interaction.customId !== `mining-drill-select:${userId}`) {
            return interaction.reply({ content: 'This mining panel is not yours.', ephemeral: true });
        }
        await interaction.deferUpdate();
        try {
            const drillId = interaction.values[0];
            const note = await runAction(interaction, 'drill-buy', drillId);
            const view = await buildSectionView(interaction, 'equipment');
            if (note) {
                const banner = new EmbedBuilder()
                    .setColor(note.startsWith('❌') ? 0xff5577 : 0x00ff99)
                    .setDescription(note);
                await interaction.editReply({ embeds: [view.embed, banner], components: view.rows });
            }
        } catch (error) {
            console.error('mining drill-select failed:', error);
            await interaction.editReply({ content: `❌ ${error.message || 'That operation failed.'}` }).catch(() => {});
        }
        return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('mining-location-select:')) {
        // Equipment panel: unlock a location or travel to an unlocked one.
        if (interaction.customId !== `mining-location-select:${userId}`) {
            return interaction.reply({ content: 'This mining panel is not yours.', ephemeral: true });
        }
        await interaction.deferUpdate();
        try {
            const locationId = interaction.values[0];
            const note = await runAction(interaction, 'location-unlock', locationId);
            const view = await buildSectionView(interaction, 'equipment');
            if (note) {
                const banner = new EmbedBuilder()
                    .setColor(note.startsWith('❌') ? 0xff5577 : 0x00ff99)
                    .setDescription(note);
                await interaction.editReply({ embeds: [view.embed, banner], components: view.rows });
            }
        } catch (error) {
            console.error('mining location-select failed:', error);
            await interaction.editReply({ content: `❌ ${error.message || 'That operation failed.'}` }).catch(() => {});
        }
        return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('mining-drone-station:')) {
        if (interaction.customId !== `mining-drone-station:${userId}`) {
            return interaction.reply({ content: 'This mining panel is not yours.', ephemeral: true });
        }
        const [numStr, locationId] = interaction.values[0].split(':');
        await interaction.deferUpdate();
        const result = assignDrone(userId, locationId, parseInt(numStr, 10));
        const view = await buildSectionView(interaction, 'fleet');
        if (result.ok) {
            await interaction.editReply({
                embeds: [view.embed, new EmbedBuilder().setColor(0x00ff99).setDescription(`✅ Drone #${numStr} stationed at **${locations[locationId]?.name ?? locationId}**.`)],
                components: view.rows
            });
        } else {
            await interaction.editReply({ content: `❌ ${result.message}` });
        }
        return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('mining-drone-recall:')) {
        if (interaction.customId !== `mining-drone-recall:${userId}`) {
            return interaction.reply({ content: 'This mining panel is not yours.', ephemeral: true });
        }
        await interaction.deferUpdate();
        const result = assignDrone(userId, 'unassign', parseInt(interaction.values[0], 10));
        const view = await buildSectionView(interaction, 'fleet');
        if (result.ok) {
            await interaction.editReply({
                embeds: [view.embed, new EmbedBuilder().setColor(0x00ff99).setDescription('✅ Drone recalled to the hangar.')],
                components: view.rows
            });
        } else {
            await interaction.editReply({ content: `❌ ${result.message}` });
        }
        return;
    }

    // mining-op:<userId>:<action>[:arg]
    if (interaction.isButton() && interaction.customId.startsWith('mining-op:')) {
        const [, opOwner, action, arg] = interaction.customId.split(':');
        if (opOwner !== userId) return interaction.reply({ content: 'This mining panel is not yours.', ephemeral: true });
        // Section quick-links (e.g. the Stats panel's 🚁 Hangar button) jump
        // straight to another panel — no runAction involved.
        if (action === 'open-section') {
            await interaction.deferUpdate();
            return openSection(interaction, arg);
        }
        // Guild create/join need a name — ask for it with a modal.
        if (action === 'guild-create' || action === 'guild-join') {
            const modal = new ModalBuilder().setCustomId(`mining-guild:${userId}:${action}`).setTitle(action === 'guild-create' ? 'Found a mining guild' : 'Join a mining guild');
            modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('guildName').setLabel('Guild name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)
            ));
            return interaction.showModal(modal);
        }
        if (action === 'crew-hire') {
            if (!arg) return interaction.reply({ content: 'Pick a specialty button in the Crew panel.', ephemeral: true });
            const modal = new ModalBuilder().setCustomId(`mining-hire:${userId}:${arg}`).setTitle('Hire a mining worker');
            modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('workerName').setLabel('Worker name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32)
            ));
            return interaction.showModal(modal);
        }
        await interaction.deferUpdate();
        try {
            const result = await runAction(interaction, action, arg);
            const section = actionSection(action);
            if (section && result !== false) {
                const view = await buildSectionView(interaction, section);
                await interaction.editReply({ embeds: [view.embed], components: view.rows });
            }
        } catch (error) {
            console.error(`mining op ${action} failed:`, error);
            await interaction.editReply({ content: `❌ ${error.message || 'That operation failed.'}` }).catch(() => {});
        }
    }
}

/*
 * Modal router — wired from index.js for the guild/hire modals above.
 */
async function handleModal(interaction) {
    const userId = interaction.user.id;
    if (interaction.customId.startsWith('mining-guild:')) {
        const [, owner, action] = interaction.customId.split(':');
        if (owner !== userId) return interaction.reply({ content: 'This dialog is not yours.', ephemeral: true });
        const name = interaction.fields.getTextInputValue('guildName').trim();
        await interaction.deferReply({ ephemeral: true });
        const result = action === 'guild-create' ? createGuild(userId, name) : joinGuild(userId, name);
        return interaction.editReply({ content: result.ok ? `✅ You are now part of mining guild **${result.guild.name}** with ${result.guild.members.length} member(s).` : `❌ ${result.message}` });
    }
    if (interaction.customId.startsWith('mining-hire:')) {
        const [, owner, specialty] = interaction.customId.split(':');
        if (owner !== userId) return interaction.reply({ content: 'This dialog is not yours.', ephemeral: true });
        const name = interaction.fields.getTextInputValue('workerName').trim();
        await interaction.deferReply({ ephemeral: true });
        return runAction(interaction, 'crew-hire', specialty || null, { name });
    }
}
