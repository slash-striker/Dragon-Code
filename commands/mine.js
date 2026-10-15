const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { ensureUser } = require('../systems/utils/ensureUser');
const { getMiningProfile, updateMiningProfile, addMiningXP, updateMiningStreak, canMine, setCooldown, getMineCooldown } = require('../systems/mining/miningManager');
const { getOrePool } = require('../systems/mining/oreTables');
const { drills, locations, getBoostBonusOre } = require('../systems/mining/drillTables');
const { addOre } = require('../systems/mining/inventoryManager');
const dragonManager = require('../systems/dragons/dragonManager');
const questManager = require('../systems/economy/questManager');
const { getWorkers, getFleet, DRONE_TIERS, collectDroneOre, getActiveMiningEvent, recordMining } = require('../systems/mining/expansionManager');
const { getYieldMultiplier, creditPropertyIncome } = require('../systems/mining/propertyManager');
const { getMiningPrestigeMultiplier, getRarityRollCount } = require('../systems/mining/galaxyManager');
const { getGuildOreBonus, chargeGuildTithe, payGuildWages } = require('../systems/mining/guildPerks');
const { logTransaction } = require('../systems/economy/transactionLogger');
const { isConfiguredChannel, configuredChannelId } = require('../systems/discord/commandChannel');

const ALLOWED_CHANNEL = '1504562791967756448';
function miningChannelId(interaction) {
    return configuredChannelId(interaction.guildId, 'mining', ALLOWED_CHANNEL);
}

// Human string for the embed's Cooldown field: the cadence of the NEXT run,
// e.g. "3h", "1h 47m", "30m" — NEVER the ready-at timestamp. (That bug once
// rendered "497399h 30m": the ready-at epoch was formatted as if it were a
// duration. The actual ready time gets its own <t:…:R> countdown line below.)
function formatMineCooldown(ms) {
    const totalMin = Math.max(1, Math.round(ms / 60000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const dur = h <= 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
    return `${dur} (next run — boosts shorten this)`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mine')
        .setDescription('Complete one quick mining run for ore, XP, and mining-bank credits'),

    async execute(interaction) {
        // Acknowledge immediately — this handler does DB writes + canvas-free
        // embed building and can exceed Discord's 3-second reply window.
        await interaction.deferReply();

        if (!isConfiguredChannel(interaction, ALLOWED_CHANNEL, 'mining')) {
            return interaction.editReply({ content: `❌ Mining restricted to <#${miningChannelId(interaction)}>` });
        }

        ensureUser(interaction.user.id);
        const profile = getMiningProfile(interaction.user.id);
        if (!canMine(profile)) {
            const remainingMs = Math.max(0, profile.mineCooldown - Date.now());
            const hrs = Math.floor(remainingMs / 3600000);
            const mins = Math.floor((remainingMs % 3600000) / 60000);
            const secs = Math.floor((remainingMs % 60000) / 1000);
            const remaining = hrs > 0 ? `${hrs}h ${mins}m` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
            return interaction.editReply({ content: `⏳ Your drill is working. Try again in **${remaining}**.` });
        }

        const drill = drills[profile.activeDrill] || drills.basic_drill;
        const location = locations[profile.activeLocation] || locations.quantum_craters;
        const workers = getWorkers(interaction.user.id);
        const fleet = getFleet(interaction.user.id);
        const droneNames = fleet.length
            ? fleet.map((drone, index) => `🛸 #${index + 1} ${DRONE_TIERS.find(tier => tier.tier === drone.tier)?.name || 'Drone'} → ${locations[drone.assignedLocation]?.name || (drone.assignedLocation ? drone.assignedLocation : 'hangar')}`)
            : ['🛸 No drones on this run'];
        const workerNames = workers.length
            ? workers.map(worker => `👷 ${worker.name} (${worker.specialty})`)
            : ['👷 No workers on this run'];
        const miningFrame = (progress, phase) => new EmbedBuilder()
            .setColor(0x00d4ff)
            .setTitle('⛏️ EXTRACTION IN PROGRESS')
            .setDescription([
                `**Location:** ${location.name}`,
                `**Drill:** ${drill.name}`,
                '',
                `**${phase}**  \`${'▰'.repeat(progress)}${'▱'.repeat(10 - progress)}\` **${progress * 10}%**`,
                '',
                '**Drone crew**', ...droneNames,
                '',
                '**Workers**', ...workerNames
            ].join('\n'));
        await interaction.editReply({ embeds: [miningFrame(3, 'Powering the drill…')] });
        await new Promise(resolve => setTimeout(resolve, 450));
        await interaction.editReply({ embeds: [miningFrame(6, 'Drilling through the site…')] });
        await new Promise(resolve => setTimeout(resolve, 450));
        await interaction.editReply({ embeds: [miningFrame(9, 'Collecting the ore…')] });
        const droneCollection = collectDroneOre(interaction.user.id);

        // Galaxy + rebirth rarity shift: roll the location pool N times and
        // keep the rarest result (lowest relative weight) — Roblox-style
        // "luck" that pushes miners toward the top of the ore table.
        const pool = getOrePool(profile.activeLocation) || getOrePool('quantum_craters');
        const totalWeight = pool.reduce((sum, o) => sum + o.weight, 0) || 1;
        const rolls = getRarityRollCount(interaction.user.id);
        let ore = pool[0];
        let bestRarity = Infinity;
        for (let i = 0; i < rolls; i++) {
            const candidate = pool[Math.floor(Math.random() * pool.length)];
            const rarityScore = candidate.weight / totalWeight;
            if (rarityScore < bestRarity) {
                bestRarity = rarityScore;
                ore = candidate;
            }
        }
        const event = getActiveMiningEvent();

        let quantity = Math.max(1, Math.floor((1 + Math.random() * 2) * drill.miningEfficiency));
        quantity += Math.floor(workers.reduce((sum, worker) => sum + Math.max(0, Number(worker.efficiency) - 1), 0) / 2);
        if (event?.eventType === 'yield') quantity = Math.max(1, Math.floor(quantity * event.multiplier));
        quantity = Math.max(1, Math.floor(quantity * getYieldMultiplier(interaction.user.id)));
        if (Math.random() < 0.08 + drill.rarityBonus / 100) quantity += 1;
        // Rebalance: hard per-run cap so drill/worker/property stacking can no
        // longer print piles of top-tier ore. Boost-tier bonus ore is added
        // AFTER the cap — that's what buying boosts actually buys. The
        // galaxy+rebirth prestige multiplier applies after everything: it is
        // the endgame reward for sinking mining-bank credits into the layer.
        quantity = Math.min(6, quantity);
        quantity = Math.min(9, quantity + getBoostBonusOre(profile.boostTier));
        quantity = Math.max(1, Math.floor(quantity * getMiningPrestigeMultiplier(interaction.user.id)));
        // ⛏️ Guild perk: +5%/+10%/+15%/+20% ore at 2/3/4/6+ members — applied
        // last so it scales the FULL stack (drill, workers, event, prestige).
        const guildBonus = getGuildOreBonus(interaction.user.id);
        if (guildBonus > 0) quantity = Math.max(1, Math.floor(quantity * (1 + guildBonus)));

        // ⿀ Hatchery: the ACTIVE pet's trait scales the raw yield. Applied
        // before the guild perk so the guild bonus still multiplies the whole
        // stack (the same ordering rule the drill/worker stack already uses).
        const dragonBonus = dragonManager.getDragonBonus(interaction.user.id, 'mine_yield');
        if (dragonBonus > 0) quantity = Math.max(1, Math.floor(quantity * (1 + dragonBonus)));

        const xpGain = Math.max(1, Math.floor(ore.xp * quantity * drill.miningEfficiency));
        const leveledUp = addMiningXP(profile, xpGain);
        updateMiningStreak(profile);
        profile.totalMines += 1;
        profile.totalOreFound += quantity;
        addOre(interaction.user.id, ore.id, quantity);
        const record = recordMining(interaction.user.id, ore.id, quantity, 0);
        const propertyIncome = creditPropertyIncome(interaction.user.id, ore.value, quantity);
        if (propertyIncome > 0) {
            logTransaction(interaction.user.id, 'mining_property_income', propertyIncome, `Property income from ${quantity} ${ore.name}`);
        }
        const mineValue = ore.value * quantity;
        db.prepare('UPDATE users SET mining_bank = COALESCE(mining_bank, 0) + ? WHERE userId = ?').run(mineValue, interaction.user.id);
        // ⛏️ Guild tithe: 10% of this deposit joins the guild's season fund.
        const titheAmount = chargeGuildTithe(interaction.user.id, mineValue);
        const nextRunMs = getMineCooldown(profile, Math.max(15000, location.baseCooldown), drill.cooldownReduction);
        const mineCooldownMs = setCooldown(profile, nextRunMs); // returns the READY-AT timestamp
        updateMiningProfile(profile);
        // Two DIFFERENT numbers, never mix them up:
        //   nextRunMs      → the cadence/duration — formatted by formatMineCooldown
        //   mineCooldownMs → the ready-at epoch — rendered as a <t:…:R> countdown
        // (Feeding the timestamp to formatMineCooldown is what once produced
        // "497399h 30m (next run)".)

        const embed = new EmbedBuilder()
            .setColor(0x00d4ff)
            .setTitle('⛏️ QUICK EXTRACTION COMPLETE')
            .setDescription(`Your **${drill.name}** completed a run in **${location.name}**.`)
            .addFields(
                { name: 'Ore', value: `${ore.name} x${quantity}`, inline: true },
                { name: 'Mining-bank credit', value: `🪙${mineValue.toLocaleString()}`, inline: true },
                { name: 'XP', value: `+${xpGain}${leveledUp ? ' • LEVEL UP!' : ''}`, inline: true },
                { name: 'Cooldown', value: `${formatMineCooldown(nextRunMs)}\n⏳ Ready <t:${Math.ceil(mineCooldownMs / 1000)}:R>`, inline: true },
                { name: 'Streak', value: `${profile.miningStreak} run(s)`, inline: true },
                { name: 'Helpers', value: `${workers.length} worker(s)${droneCollection.quantity ? ` • drone returned ${droneCollection.quantity}` : ''}`, inline: true }
            );
        /* 🥚 DRAGON EGG DROP — deliberately rare. The ore's rarity feeds the
           roll, so a deeper site produces materially better eggs. */
        let eggDrop = null;
        try {
            const oreRarity = (pool || []).find(entry => entry.id === ore.id)?.rarity;
            const tierScore = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 3, mythic: 4, seasonal: 3 }[oreRarity] ?? 1;
            eggDrop = dragonManager.rollEggDrop(interaction.user.id, { source: 'mine', tierScore });
        } catch (error) {
            console.error('Mining egg drop failed:', error.message);
        }
        if (eggDrop) {
            const eggType = dragonManager.EGG_TYPES[eggDrop.eggType];
            const eggStyle = dragonManager.RARITY_STYLE[eggDrop.rarity] || dragonManager.RARITY_STYLE.common;
            embed.addFields({
                name: '🥚 DRAGON EGG FOUND',
                value: `${eggType?.emoji || '🥚'} **${eggType?.name || 'Mystery Egg'}** — ${eggStyle.emoji} ${eggStyle.label}\n` +
                    (eggDrop.side === 'evil' ? '🩸 Onslaught bloodline' : '🌌 Dragonflight bloodline') +
                    `\nIncubate it from \`/profile\` → **Eggs** (${Math.round((eggType?.incubateMs || 0) / 3_600_000)}h).`,
                inline: false
            });
        }
        if (dragonBonus > 0) {
            embed.addFields({ name: '🐉 Pet bonus', value: `+${(dragonBonus * 100).toFixed(1)}% ore yield from your active pet`, inline: false });
        }

        // 📋 Quests / lifetime achievements — one event hook, many quests.
        try {
            questManager.recordQuestEvent(interaction.user.id, 'mine_run', 1, { oreId: ore.id });
            questManager.recordQuestEvent(interaction.user.id, 'ore_mined', quantity, { oreId: ore.id });
        } catch (error) {
            console.error('Mining quest hook failed:', error.message);
        }

        if (record.artifact) embed.addFields({ name: 'Artifact found', value: record.artifact.name, inline: false });
        if (propertyIncome > 0) embed.addFields({ name: 'Property revenue', value: `+🪙${propertyIncome.toLocaleString()} mining bank`, inline: false });
        if (guildBonus > 0) embed.addFields({ name: '⚔️ Guild bonus', value: `+${Math.round(guildBonus * 100)}% ore (${titheAmount > 0 ? `🪙${titheAmount.toLocaleString()} to guild fund` : 'guild bonus'})`, inline: false });

        // ⛏️ Guild payroll: every 24h each guild's season fund splits equally
        // among its members. Triggered here so it ticks without a cron job.
        try {
            payGuildWages();
        } catch (error) {
            console.error('guild payroll failed:', error);
        }

        return interaction.editReply({ embeds: [embed] });
    },
    formatMineCooldown,
};
