const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../database');
const { ensureUser } = require('../systems/utils/ensureUser');
const { getInventory } = require('../systems/mining/inventoryManager');
const { getMarketInfo } = require('../systems/mining/marketEngine');
const {
    getRefinedInventory, getArtifacts, RECIPES,
    getFleet, getWorkers, getOrCreateContract, getContracts,
    DRONE_TIERS, WORKER_SPECIALTIES
} = require('../systems/mining/expansionManager');
const { getMiningProfile } = require('../systems/mining/miningManager');
const { drills, locations } = require('../systems/mining/drillTables');
const { getYieldMultiplier } = require('../systems/mining/propertyManager');

/*
 * /main-hub — the full command center.
 *
 * Balances + a complete mining overview: setup (drill/active site), drone
 * fleet, crew, stockpile value and active contracts. The raw ore list lives
 * in /mining-inventory; this is the at-a-glance operations board.
 *
 * Two views, one message:
 *   • full    — the operations board (default)
 *   • compact — three lines for people tired of scrolling
 *
 * 🔧 The drill/location pick-lists deliberately live in the /mining hub's
 * Equipment panel, so this stays a read-only overview: the ONLY button here
 * is the compact/full toggle. Do not add more.
 *
 * The toggle is stateless: the button carries BOTH the user who owns the
 * panel and the user being viewed, so index.js can route the click straight
 * back here after a restart with nothing to look up. That means the ids are
 * `mainhub:compact:<ownerId>:<targetId>` / `mainhub:full:<ownerId>:<targetId>`
 * rather than the bare `mainhub:compact` prefix — the viewer has to be
 * recoverable, and the reviewed user is not always the viewer.
 */

const OWNER_PREFIX = 'mainhub';
const ROUTE = `${OWNER_PREFIX}:`;

/*
 * Explicit newline constant instead of a literal escape inside template
 * strings: every multi-line block below is built by joining, and this keeps
 * the source free of embedded line-break escapes.
 */
const NL = String.fromCharCode(10);

// ---------------------------------------------------------------------------
// Data gathering (shared by the command and the toggle button)
// ---------------------------------------------------------------------------
async function gatherHub(targetId) {
    ensureUser(targetId);

    const user = db.prepare('SELECT wallet, bank, mining_bank FROM users WHERE userId = ?').get(targetId)
        || { wallet: 0, bank: 0, mining_bank: 0 };
    const market = getMarketInfo();

    const ores = getInventory(targetId);
    const refined = getRefinedInventory(targetId);
    const artifacts = getArtifacts(targetId);
    const fleet = getFleet(targetId);
    const workers = getWorkers(targetId);
    const profile = getMiningProfile(targetId);
    const activeContracts = getContracts(targetId).filter(c => c.status === 'active' || c.status === 'completed');

    const stockpileValue =
        ores.reduce((sum, item) => sum + (market.prices[item.oreId] || 0) * item.quantity, 0) +
        refined.reduce((sum, item) => sum + (RECIPES[item.materialId]?.value || 0) * item.quantity, 0) +
        artifacts.reduce((sum, item) => sum + item.value * item.quantity, 0);

    const oreCount = ores.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    const drill = drills[profile.activeDrill] || drills.basic_drill;
    const site = locations[profile.activeLocation] || locations.quantum_craters;
    const yieldMultiplier = getYieldMultiplier(targetId);

    const fleetLines = fleet.length
        ? fleet.map((drone, index) => {
            const tier = DRONE_TIERS.find(t => t.tier === drone.tier);
            const tierName = tier?.name ?? `Tier ${drone.tier}`;
            const post = drone.assignedLocation
                ? (locations[drone.assignedLocation]?.name ?? drone.assignedLocation)
                : 'unassigned';
            return `🛸 #${index + 1} ${tierName} → ${post}`;
        })
        : '_Hangar empty — `/mining drone-buy`._';

    const crewLines = workers.length
        ? workers.map(worker => `👷 ${worker.name} — ${worker.specialty} (×${worker.efficiency})`)
        : '_No crew — `/mining crew-hire`._';

    const contractLines = activeContracts.length
        ? activeContracts.slice(0, 3).map(c =>
            `📜 **${c.title}** — ${c.progress}/${c.targetQuantity} ${String(c.targetOre).replace(/_/g, ' ')}${c.status === 'completed' ? ' ✅ ready to claim' : ''}`
        )
        : '_No active contracts — `/mining contract-accept`._';

    const opOverview = [
        `🔧 Drill: **${drill.name}** · 📍 Active site: **${site.name}** · 📈 Yield: ×${yieldMultiplier.toFixed(2)}`,
        `📊 Lifetime: ${Number(profile.totalMines || 0).toLocaleString()} runs · ${Number(profile.totalOreFound || 0).toLocaleString()} ore · streak ${profile.miningStreak}`,
        `🛸 Fleet (${fleet.length}/7): ${fleet.length ? '' : ''}${NL}${fleetLines}`,
        `👷 Crew (${workers.length}/5):${NL}${crewLines}`,
        `📜 Contracts:${NL}${contractLines}`
    ].join(NL + NL);

    return { user, stockpileValue, oreCount, opOverview, drill, site, fleet, workers };
}

// ---------------------------------------------------------------------------
// Embed builders
// ---------------------------------------------------------------------------
function buildFullEmbed(targetUser, data, viewerId) {
    const { user, stockpileValue, opOverview } = data;
    const netWorth = Number(user.wallet) + Number(user.bank) + Number(user.mining_bank) + stockpileValue;

    return new EmbedBuilder()
        .setColor(0x00d4ff)
        .setTitle('🏠 Main Hub')
        .setDescription(targetUser.id === viewerId
            ? 'Your Dragon Code command center — balances and full mining operation.'
            : `**${targetUser.displayName ?? targetUser.username}**'s Dragon Code command center.`)
        .addFields(
            { name: '💳 Wallet', value: `🪙 ${Number(user.wallet).toLocaleString()}`, inline: true },
            { name: '🏦 Main Bank', value: `🪙 ${Number(user.bank).toLocaleString()}`, inline: true },
            { name: '⛏️ Mining Bank', value: `🪙 ${Number(user.mining_bank).toLocaleString()}`, inline: true },
            { name: '📊 Total Net Worth', value: `🪙 ${netWorth.toLocaleString()} (incl. 🪙${stockpileValue.toLocaleString()} stockpile)`, inline: false },
            { name: '⛏️ Mining operation', value: opOverview, inline: false },
            { name: '📈 Inventory values', value: 'Ore totals use the current `/market` sell prices. Refined materials and artifacts show their listed value.', inline: false }
        )
        .setFooter({ text: 'Ore detail: /mining-inventory · Fish storage: /fish inventory · Shop items: /inventory' })
        .setTimestamp();
}

/*
 * Compact view — deliberately three lines and nothing else. No fields list,
 * no footer paragraph, no timestamp block: the whole point is that it fits on
 * one screen.
 */
function buildCompactEmbed(targetUser, data, viewerId) {
    const { user, stockpileValue, oreCount, drill, site } = data;
    const netWorth = Number(user.wallet) + Number(user.bank) + Number(user.mining_bank) + stockpileValue;
    const who = targetUser.id === viewerId ? '' : ` — **${targetUser.displayName ?? targetUser.username}**`;

    return new EmbedBuilder()
        .setColor(0x00d4ff)
        .setTitle('🏠 Main Hub — compact')
        .setDescription([
            `📊 **Net worth** 🪙 ${netWorth.toLocaleString()} (🪙${stockpileValue.toLocaleString()} stockpile)${who}`,
            `💳 Wallet 🪙 ${Number(user.wallet).toLocaleString()} · 🏦 Bank 🪙 ${Number(user.bank).toLocaleString()} · ⛏️ Mining 🪙 ${Number(user.mining_bank).toLocaleString()}`,
            `⛏️ **${drill.name}** at **${site.name}** · ${oreCount.toLocaleString()} ore in the stockpile`
        ].join(NL));
}

function buildEmbed(targetUser, data, compact, viewerId) {
    return compact
        ? buildCompactEmbed(targetUser, data, viewerId)
        : buildFullEmbed(targetUser, data, viewerId);
}

function toggleRow(ownerId, targetId, compact) {
    const button = compact
        ? new ButtonBuilder()
            .setCustomId(`${ROUTE}full:${ownerId}:${targetId}`)
            .setLabel('Full view')
            .setEmoji('📋')
            .setStyle(ButtonStyle.Secondary)
        : new ButtonBuilder()
            .setCustomId(`${ROUTE}compact:${ownerId}:${targetId}`)
            .setLabel('Compact mode')
            .setEmoji('🔎')
            .setStyle(ButtonStyle.Secondary);
    return new ActionRowBuilder().addComponents(button);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------
module.exports = {
    data: new SlashCommandBuilder()
        .setName('main-hub')
        .setDescription('Your Dragon Code command center: balances and mining operation overview')
        .addUserOption(option => option
            .setName('user')
            .setDescription('User whose hub to view')
            .setRequired(false)),

    async execute(interaction) {
        await interaction.deferReply();
        const targetUser = interaction.options.getUser('user') ?? interaction.user;
        const data = await gatherHub(targetUser.id);

        return interaction.editReply({
            embeds: [buildEmbed(targetUser, data, false, interaction.user.id)],
            components: [toggleRow(interaction.user.id, targetUser.id, false)]
        });
    },

    /*
     * Toggle router — index.js sends every `mainhub:` component here.
     * Only the person who opened the panel may flip it; anyone else gets an
     * ephemeral refusal and the panel is left exactly as it was.
     */
    async handleComponent(interaction) {
        const pieces = String(interaction.customId).split(':');
        if (pieces[0] !== OWNER_PREFIX) return;
        const mode = pieces[1];
        if (mode !== 'compact' && mode !== 'full') return;

        const ownerId = pieces[2];
        const targetId = pieces[3] || ownerId;

        if (ownerId && interaction.user.id !== ownerId) {
            return interaction.reply({
                content: '❌ This hub belongs to someone else — run /main-hub to open your own.',
                ephemeral: true
            });
        }

        const targetUser = targetId === interaction.user.id
            ? interaction.user
            : await interaction.client.users.fetch(targetId).catch(() => null);
        if (!targetUser) {
            return interaction.reply({ content: '❌ That user could not be loaded any more.', ephemeral: true });
        }

        const compact = mode === 'compact';
        const data = await gatherHub(targetId);
        const payload = {
            embeds: [buildEmbed(targetUser, data, compact, interaction.user.id)],
            components: [toggleRow(interaction.user.id, targetId, compact)]
        };

        if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
        return interaction.update(payload);
    }
};
