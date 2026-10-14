const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const {
    GALAXIES,
    REBIRTH_LEVEL_REQUIREMENT,
    getGalaxyProfile,
    getGalaxyMultiplier,
    getRebirthMultiplier,
    unlockGalaxy,
    travelToGalaxy,
    rebirthCost,
    rebirth
} = require('../systems/mining/galaxyManager');
const { getMiningProfile, updateMiningProfile } = require('../systems/mining/miningManager');

const ALLOWED_CHANNEL = '1504562791967756448';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('galaxy')
        .setDescription('Galaxy travel & rebirth — the prestige layer of the mining grid')
        .addStringOption(option => option
            .setName('action')
            .setDescription('View the star chart, unlock, travel, or rebirth')
            .setRequired(true)
            .addChoices(
                { name: '🗺️ View — star chart, progress & rebirth stats', value: 'view' },
                { name: '🔓 Unlock — permanently unlock a galaxy', value: 'unlock' },
                { name: '🚀 Travel — jump to an unlocked galaxy', value: 'travel' },
                { name: '♻️ Rebirth — +25% permanent yield', value: 'rebirth' }
            ))
        .addStringOption(option => option
            .setName('galaxy')
            .setDescription('Unlock/travel: which galaxy')
            .addChoices(...Object.entries(GALAXIES).map(([value, g]) => ({
                name: g.cost ? `${g.name} — 🪙${g.cost.toLocaleString()}`.slice(0, 100) : g.name.slice(0, 100),
                value
            })))),

    async execute(interaction) {
        // Acknowledge first — galaxy math + DB work can brush the 3s window.
        await interaction.deferReply();

        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.editReply({ content: `❌ The star charts only open in <#${ALLOWED_CHANNEL}>.` });
        }

        ensureUserFallback(interaction.user.id);
        const action = interaction.options.getString('action', true);
        const profile = getGalaxyProfile(interaction.user.id);
        const miningBank = getMiningBank(interaction.user.id);

        /* ---------------- view ---------------- */
        if (action === 'view') {
            const miningLevel = getMiningLevel(interaction.user.id);
            const nextRebirthCost = rebirthCost(profile.rebirths);
            const canRebirth = miningLevel >= REBIRTH_LEVEL_REQUIREMENT;

            const embed = new EmbedBuilder()
                .setColor(0x9b59ff)
                .setTitle('🗺️ GALAXY STAR CHART')
                .setDescription([
                    `Current galaxy: **${GALAXIES[profile.currentGalaxy].name}**`,
                    `Mining bank: **🪙${Number(miningBank).toLocaleString()}** (unlocks & rebirths are paid from here)`,
                    `Travel multiplier: **x${getGalaxyMultiplier(interaction.user.id).toFixed(2)}** · Rebirth multiplier: **x${getRebirthMultiplier(interaction.user.id).toFixed(2)}**`,
                    `Combined /mine multiplier: **x${(getGalaxyMultiplier(interaction.user.id) * getRebirthMultiplier(interaction.user.id)).toFixed(2)}**`,
                    '',
                    `♻️ **Rebirths:** ${profile.rebirths} (lifetime ${profile.totalRebirths})`,
                    canRebirth
                        ? `Ready to rebirth! Next costs 🪙${nextRebirthCost.toLocaleString()} mining bank → permanent **+25%** yield.`
                        : `Rebirth unlocks at mining level **${REBIRTH_LEVEL_REQUIREMENT}** (you are ${miningLevel}).`
                ].join('\n'));

            for (const [id, galaxy] of Object.entries(GALAXIES)) {
                const owned = profile.unlockedGalaxies.includes(id);
                const here = profile.currentGalaxy === id;
                embed.addFields({
                    name: `${here ? '📍' : owned ? '✅' : '🔒'} ${galaxy.name}`,
                    value: [
                        galaxy.description,
                        `Yield: **x${galaxy.multiplier.toFixed(2)}** · Rarity shift: **+${galaxy.rarityShift}**`,
                        owned ? (here ? '**You are here.**' : 'Unlocked — `/galaxy action:travel` to move.') :
                            `Locked — 🪙${galaxy.cost.toLocaleString()} mining bank · level ${galaxy.levelRequired}`
                    ].join('\n'),
                    inline: false
                });
            }
            embed.setFooter({ text: 'Rebirths keep drones, crew, drills & galaxies — only your mining level resets.' });
            return interaction.editReply({ embeds: [embed] });
        }

        /* ---------------- unlock ---------------- */
        if (action === 'unlock') {
            const galaxyId = interaction.options.getString('galaxy');
            const galaxy = GALAXIES[galaxyId];
            if (!galaxy) {
                return interaction.editReply({ content: '❌ Pick a galaxy with the **galaxy** option (e.g. `/galaxy action:unlock galaxy:andromeda`).' });
            }
            const miningLevel = getMiningLevel(interaction.user.id);
            if (miningLevel < galaxy.levelRequired) {
                return interaction.editReply({ content: `❌ **${galaxy.name}** requires mining level **${galaxy.levelRequired}** (you are ${miningLevel}).` });
            }
            const result = unlockGalaxy(interaction.user.id, galaxyId);
            if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
            return interaction.editReply({
                embeds: [new EmbedBuilder().setColor(0x00ff99).setTitle('🌌 GALAXY UNLOCKED')
                    .setDescription(`**${galaxy.name}** is now on your star chart — travel with \`/galaxy action:travel galaxy:${galaxyId}\`.\nYield here: **x${galaxy.multiplier.toFixed(2)}** · Rarity shift: **+${galaxy.rarityShift}**\nPaid: 🪙${galaxy.cost.toLocaleString()} from mining bank.`)]
            });
        }

        /* ---------------- travel ---------------- */
        if (action === 'travel') {
            const galaxyId = interaction.options.getString('galaxy');
            if (!galaxyId || !GALAXIES[galaxyId]) {
                return interaction.editReply({ content: '❌ Pick a destination with the **galaxy** option (e.g. `/galaxy action:travel galaxy:andromeda`).' });
            }
            const result = travelToGalaxy(interaction.user.id, galaxyId);
            if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
            const galaxy = result.galaxy;
            return interaction.editReply({
                embeds: [new EmbedBuilder().setColor(0x9b59ff).setTitle('🚀 HYPERSPACE JUMP COMPLETE')
                    .setDescription(`Welcome to **${galaxy.name}**.\n${galaxy.description}\n\nAll /mine runs here yield **x${galaxy.multiplier.toFixed(2)}** ore with **+${galaxy.rarityShift}** rarity shift.`)
                    .setFooter({ text: 'Combined with rebirths, your total multiplier is x' + (getGalaxyMultiplier(interaction.user.id) * getRebirthMultiplier(interaction.user.id)).toFixed(2) })]
            });
        }

        /* ---------------- rebirth ---------------- */
        if (action === 'rebirth') {
            const miningProfile = getMiningProfile(interaction.user.id);
            const cost = rebirthCost(profile.rebirths);
            const before = {
                level: miningProfile.miningLevel,
                multiplier: getRebirthMultiplier(interaction.user.id)
            };
            const result = rebirth(interaction.user.id, miningProfile);
            if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
            updateMiningProfile(miningProfile);
            return interaction.editReply({
                embeds: [new EmbedBuilder().setColor(0xffd700).setTitle('♻️ REBIRTH COMPLETE')
                    .setDescription([
                        `You collapsed your level **${before.level}** miner into a singularity… and stepped out **reborn**.`,
                        '',
                        `♻️ Rebirth #**${result.profile.rebirths}**`,
                        `Yield multiplier: x${before.multiplier.toFixed(2)} → **x${result.nextMultiplier.toFixed(2)}** (+25% permanent)`,
                        `Paid: 🪙${result.cost.toLocaleString()} mining bank`,
                        `Mining level: **${before.level}** → **1** (XP wiped)`,
                        '',
                        'Kept: drones · crew · drills · galaxies · artifacts · refined stock.',
                        'Next rebirth costs 🪙' + rebirthCost(result.profile.rebirths).toLocaleString() + ' at level ' + REBIRTH_LEVEL_REQUIREMENT + '.'
                    ].join('\n'))
                    .setFooter({ text: 'Prestige layer • The grid remembers every rebirth' })]
            });
        }
    }
};

/* Local helpers — tiny, avoid importing more of the economy here. */
function ensureUserFallback(userId) {
    db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(userId);
}
function getMiningBank(userId) {
    return db.prepare('SELECT COALESCE(mining_bank, 0) AS v FROM users WHERE userId = ?').get(userId)?.v ?? 0;
}
function getMiningLevel(userId) {
    return db.prepare('SELECT miningLevel FROM mining_profile WHERE userId = ?').get(userId)?.miningLevel || 1;
}
