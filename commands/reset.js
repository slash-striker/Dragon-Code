/*
 * /reset — the single admin hub for destructive resets.
 *
 * Merged (handlers preserved, shared confirm-button flow):
 *   reset        → /reset user · stats · wallet(+everyone) · inventory(+everyone)
 *   resetxp      → /reset xp everyone:true (global wipe + level-role strip)
 *   level-reset  → /reset xp (single user) · /reset xp everyone:true
 *
 * Level 1-10 role order — keep in sync with LEVEL_ROLE_ORDER in
 * systems/leveling/levelingSystem.js. null = no role for that level yet.
 */
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../database');
const { getUser } = require('../systems/economy/userManager');
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

// Admin role config lives in systems/admin/adminVisibility.js (DB-backed).

const LEVEL_ROLES = [
    '1504406476796465293', // Level 1
    '1504406534506156173', // Level 2
    '1504406613681770536', // Level 3
    '1504406653204824214', // Level 4
    '1523406315022581872', // Level 5
    '1523406642777948282', // Level 6
    '1523406792535707758', // Level 7
    '1523407458515812462', // Level 8
    '1523407746958098534', // Level 9
    '1504406632962986004'  // Level 10
];

function isAdmin(interaction) {
    return isAdminUser(interaction);
}

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('reset')
        .setDescription('[ADMIN ONLY] Reset user economy data')
        .addStringOption(opt => opt
            .setName('action')
            .setDescription('What to reset')
            .setRequired(true)
            .addChoices(
                { name: 'Everything (economy, stats, inventory)', value: 'user' },
                { name: 'Stats only', value: 'stats' },
                { name: 'Wallet and bank', value: 'wallet' },
                { name: 'Inventory', value: 'inventory' },
                { name: 'XP and level', value: 'xp' }
            ))
        .addUserOption(opt => opt.setName('target').setDescription('User to reset'))
        .addBooleanOption(opt => opt.setName('everyone').setDescription('Reset for EVERY member (wallet, inventory, or xp)')),

    async execute(interaction) {
        if (!isAdminUser(interaction)) return interaction.reply({ content: '❌ Administrator access required.' });
        const target = interaction.options.getUser('target');
        const scope = interaction.options.getString('action', true);
        const everyone = interaction.options.getBoolean('everyone') ?? false;

        if (everyone && (scope === 'user' || scope === 'stats')) {
            return interaction.reply({ content: '❌ `everyone` only applies to wallet, inventory, or xp — pick a target user for this reset.' });
        }
        if (!everyone && !target) {
            return interaction.reply({ content: '❌ Pick a target user, or set `everyone:True`.' });
        }

        const customId = `reset:${interaction.user.id}:${target?.id ?? 'all'}:${scope}`;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${customId}:confirm`).setLabel('Confirm Reset').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`${customId}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );
        const scopeLabels = {
            user: 'entire economy, stats, and inventory',
            stats: 'stored stats',
            wallet: 'wallet and bank',
            inventory: 'inventory',
            xp: 'XP and level'
        };
        const confirmText = scope === 'xp' && everyone
            ? '⚠️ **Are you sure you want to reset XP and levels for EVERY user? Their level roles will also be removed.** This cannot be undone.'
            : everyone
                ? `⚠️ **Are you sure you want to reset EVERY member's ${scopeLabels[scope]}?** This cannot be undone.`
                : `⚠️ **Are you sure you want to reset ${target.tag}'s ${scopeLabels[scope]}?** This cannot be undone.`;
        const message = await interaction.reply({
            content: confirmText,
            components: [row],
            fetchReply: true
        });
        const choice = await message.awaitMessageComponent({
            filter: button => button.user.id === interaction.user.id,
            time: 30000
        }).catch(() => null);
        if (!choice) return interaction.editReply({ content: '⌛ Reset confirmation expired.', components: [] });
        if (choice.customId.endsWith(':cancel')) return choice.update({ content: '✅ Reset cancelled.', components: [] });

        if (scope === 'wallet') {
            if (everyone) {
                db.prepare('UPDATE users SET wallet = 0, bank = 0').run();
                return choice.update({ content: '✅ Reset wallet and bank for every member.', components: [] });
            }
            db.prepare('UPDATE users SET wallet = 0, bank = 0 WHERE userId = ?').run(target.id);
            return choice.update({ content: `✅ Reset wallet and bank for ${target.tag}.`, components: [] });
        }
        if (scope === 'inventory') {
            if (everyone) {
                db.prepare('DELETE FROM inventory').run();
                return choice.update({ content: '✅ Reset inventory for every member.', components: [] });
            }
            if (!target) return choice.update({ content: '❌ Pick a target user or set everyone.', components: [] });
            db.prepare('DELETE FROM inventory WHERE userId = ?').run(target.id);
            return choice.update({ content: `✅ Reset inventory for ${target.tag}.`, components: [] });
        }
        if (scope === 'xp') {
            if (everyone) {
                // Global wipe (was /resetxp) — one UPDATE for all rows, then
                // strip every level role from cached guild members.
                const result = db.prepare(
                    'UPDATE users SET xp = 0, level = 0, totalMessageCount = 0, lastSeenAt = NULL'
                ).run();
                let stripped = 0;
                for (const member of interaction.guild?.members?.cache?.values() ?? []) {
                    for (const roleId of LEVEL_ROLES) {
                        if (roleId && member.roles.cache.has(roleId)) {
                            await member.roles.remove(roleId).catch(() => {});
                            stripped += 1;
                        }
                    }
                }
                return choice.update({ content: `✅ Reset XP and levels for ${result.changes} users and removed ${stripped} level role(s).`, components: [] });
            }
            if (!target) return choice.update({ content: '❌ Pick a target user or set everyone.', components: [] });
            // Single user (was /level-reset user).
            db.prepare(
                'UPDATE users SET xp = 0, level = 0, totalMessageCount = 0, lastSeenAt = NULL WHERE userId = ?'
            ).run(target.id);
            return choice.update({ content: `✅ Reset XP and level for ${target.tag}.`, components: [] });
        }
        if (scope === 'user') {
            db.prepare('DELETE FROM inventory WHERE userId = ?').run(target.id);
            db.prepare('DELETE FROM mining_inventory WHERE userId = ?').run(target.id);
            db.prepare('DELETE FROM mining_profile WHERE userId = ?').run(target.id);
            db.prepare('DELETE FROM transactions WHERE userId = ?').run(target.id);
            db.prepare('DELETE FROM users WHERE userId = ?').run(target.id);
            getUser(target.id);
        } else {
            db.prepare(`UPDATE users SET
                xp = 0, level = 0, totalMessageCount = 0, lastSeenAt = NULL,
                dailyLastClaim = NULL, dailyStreak = 0, dailyMissedDays = 0,
                dailyLongestStreak = 0, weeklyWeekStart = NULL, weeklyProgress = 0,
                weeklyCycleStart = NULL, weeklyStartedOnMonday = 0, weeklyClaimDays = '[]',
                weeklyRewardClaimed = 0, jobWorkProgress = 0, lifetimeWorkCount = 0,
                lifetimeWorkEarnings = 0, lastWorkedAt = NULL, promotionStatus = 'READY',
                prestigeLevel = 0, prestigeMultiplier = 1, crimeSuccess = 0,
                crimeFails = 0, heatLevel = 0, bounty = 0, fishCount = 0,
                begCount = 0, scratchcardCount = 0, lotteryEntryCount = 0,
                moneySpent = 0 WHERE userId = ?`).run(target.id);
        }
        return choice.update({ content: `✅ Reset ${scope === 'user' ? 'economy, stats, and inventory' : 'all stats'} for ${target.tag}.`, components: [] });    }
};
