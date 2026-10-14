const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getInventory } = require('../systems/mining/inventoryManager');
const { getOrePrice } = require('../systems/mining/marketEngine');
const {
    getRefinedInventory, getArtifacts, RECIPES,
    getDrone, getFleet, getWorkers,
    getActiveMiningEvent, getOrCreateContract, getContracts,
    DRONE_TIERS, WORKER_SPECIALTIES
} = require('../systems/mining/expansionManager');
const { getMiningProfile } = require('../systems/mining/miningManager');
const { drills, locations } = require('../systems/mining/drillTables');
const { getYieldMultiplier } = require('../systems/mining/propertyManager');
const db = require('../database');

/*
 * /mining-inventory — the dedicated MINING storage view.
 *
 * Split out of /inventory so each system has its own command:
 *   • /inventory         → shop items only
 *   • /mining            → the hub: drones, crew, contracts, refining, boosts…
 *   • /fish-inventory    → stored fish + fishing gear
 * Ores are valued at the live /market price; the mining bank shows the
 * unspent credits side of the operation.
 */

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mining-inventory')
        .setDescription('View your mining inventory: ores, refined materials, artifacts, drones and crew')
        .addUserOption(option => option
            .setName('user')
            .setDescription('View another player\'s mining inventory')
            .setRequired(false)),

    async execute(interaction) {
        // Defer immediately — multi-table aggregation can breach the 3s window.
        await interaction.deferReply();
        const target = interaction.options.getUser('user') ?? interaction.user;
        const targetId = target.id;

        const ores = getInventory(targetId);
        const refined = getRefinedInventory(targetId);
        const artifacts = getArtifacts(targetId);
        const fleet = getFleet(targetId);
        const droneSummary = getDrone(targetId);
        const workers = getWorkers(targetId);
        const profile = getMiningProfile(targetId);
        const event = getActiveMiningEvent(false);
        const contract = getOrCreateContract(targetId);
        const activeContracts = getContracts(targetId).filter(c => c.status === 'active' || c.status === 'completed');
        const miningBank = db.prepare('SELECT COALESCE(mining_bank, 0) AS v FROM users WHERE userId = ?').get(targetId)?.v ?? 0;
        const yieldMultiplier = getYieldMultiplier(targetId);

        // ---- Ore stockpile (live market value) ----
        const oreValue = ores.reduce((sum, ore) => sum + getOrePrice(ore.oreId) * ore.quantity, 0);
        const oreLines = ores.length
            ? ores.map(ore => `⛏️ ${ore.oreId.replace(/_/g, ' ')} ×${ore.quantity} — 🪙${(getOrePrice(ore.oreId) * ore.quantity).toLocaleString()}`)
            : ['_Empty — use `/mine` to collect ore._'];

        // ---- Refined materials ----
        const refinedValue = refined.reduce((sum, item) => sum + (RECIPES[item.materialId]?.value || 0) * item.quantity, 0);
        const refinedLines = refined.length
            ? refined.map(item => `⚗️ ${RECIPES[item.materialId]?.name || item.materialId} ×${item.quantity} — 🪙${((RECIPES[item.materialId]?.value || 0) * item.quantity).toLocaleString()}`)
            : ['_None — refine ore with the `/mining` Refinery panel._'];

        // ---- Artifacts ----
        const artifactValue = artifacts.reduce((sum, item) => sum + item.value * item.quantity, 0);
        const artifactLines = artifacts.length
            ? artifacts.map(item => `🏺 ${item.name} ×${item.quantity} — 🪙${(item.value * item.quantity).toLocaleString()}`)
            : ['_None yet — rare finds from `/mine`._'];

        // ---- Drone fleet ----
        const fleetLines = fleet.length
            ? fleet.map((drone, index) => {
                const tier = DRONE_TIERS.find(t => t.tier === drone.tier);
                const site = drone.assignedLocation
                    ? (locations[drone.assignedLocation]?.name ?? drone.assignedLocation)
                    : '*unassigned*';
                return `🛸 #${index + 1} ${tier?.name ?? `Tier ${drone.tier}`} → ${site}`;
            })
            : ['_No drones — buy one from the `/mining` Drone Fleet panel._'];

        // ---- Crew ----
        const crewLines = workers.length
            ? workers.map(worker => {
                const spec = WORKER_SPECIALTIES[worker.specialty];
                return `👷 ${worker.name} — ${worker.specialty} (×${worker.efficiency}${spec ? `, paid 🪙${spec.cost.toLocaleString()}` : ''})`;
            })
            : ['_No workers hired — see the `/mining` Crew & Guilds panel._'];

        // ---- Setup summary ----
        const drill = drills[profile.activeDrill] || drills.basic_drill;
        const site = locations[profile.activeLocation] || locations.quantum_craters;
        const setupLines = [
            `🔧 Drill: **${drill.name}** (efficiency ×${drill.miningEfficiency})`,
            `📍 Site: **${site.name}**`,
            `📈 Yield bonus: ×${yieldMultiplier.toFixed(2)}`,
            `📊 Lifetime: ${Number(profile.totalMines || 0).toLocaleString()} runs · ${Number(profile.totalOreFound || 0).toLocaleString()} ore · streak ${profile.miningStreak}`
        ];

        const totalValue = oreValue + refinedValue + artifactValue;

        const embed = new EmbedBuilder()
            .setColor(0x00d4ff)
            .setTitle(`⛏️ ${target.username}'s Mining Inventory`)
            .setDescription(
                `**Operational status**\n${setupLines.join('\n')}` +
                (event ? `\n🌍 Active event: **${event.name}** — ${event.description}` : '')
            )
            .addFields(
                { name: `🪨 Ore stockpile — 🪙${oreValue.toLocaleString()}`, value: oreLines.slice(0, 20).join('\n'), inline: false },
                { name: `⚗️ Refined materials — 🪙${refinedValue.toLocaleString()}`, value: refinedLines.join('\n'), inline: false },
                { name: `🏺 Artifacts — 🪙${artifactValue.toLocaleString()}`, value: artifactLines.join('\n'), inline: false },
                { name: `🛸 Drone fleet (${fleet.length}/7)${droneSummary?.totalOreCollected ? ` — ${Number(droneSummary.totalOreCollected).toLocaleString()} ore delivered` : ''}`, value: fleetLines.join('\n'), inline: false },
                { name: `👷 Crew (${workers.length}/5)`, value: crewLines.join('\n'), inline: false },
                { name: '🏦 Mining bank', value: `🪙 ${Number(miningBank).toLocaleString()}`, inline: true },
                { name: '📈 Stockpile value', value: `🪙 ${totalValue.toLocaleString()}`, inline: true }
            )
            .setFooter({ text: 'Ore valued at live /market prices · refine with the /mining Refinery panel · sell with /sell' })
            .setTimestamp();

        if (activeContracts.length) {
            embed.addFields({
                name: '📜 Active contracts',
                value: activeContracts.slice(0, 3).map(c =>
                    `• **${c.title}** — ${c.progress}/${c.targetQuantity} ${String(c.targetOre).replace(/_/g, ' ')}${c.status === 'completed' ? ' ✅ ready to claim' : ''}`
                ).join('\n') + '\n_Manage with the `/mining` Contracts panel._'
            });
        }

        return interaction.editReply({ embeds: [embed] });
    }
};
