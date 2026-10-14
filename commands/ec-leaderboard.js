const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType } = require('discord.js');

const ALLOWED_CHANNEL = '1504562791967756448';
const TOP_CREDITS_ROLE_ID = '1508482485313474643';
const SLASHDRAGON_ID = '1505829367631183963';

function safe(n) {
    const num = Number(n);
    return Number.isFinite(num) ? num : 0;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ec-leaderboard')
        .setDescription('View the richest users in the economy'),

    async execute(interaction) {

        // ------------------------------
        // CHANNEL RESTRICTION
        // ------------------------------
        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ You can only use this in <#${ALLOWED_CHANNEL}>.` });
        }

        // ------------------------------
        // GUILD SAFETY CHECK
        // ------------------------------
        const guild = interaction.guild;
        if (!guild) {
            return interaction.reply({
                content: '❌ This command can only be used in a server.' });
        }

        // Member lookups can take longer than Discord's three-second initial
        // response window, so acknowledge before building the leaderboard.
        await interaction.deferReply();
        // ------------------------------
        // DB IMPORT (safe inside execution)
        // ------------------------------
        const db = require('../database');
        let rows;
        try {
            rows = db.prepare(`
                SELECT userId,
                       COALESCE(wallet, 0) AS wallet,
                       COALESCE(bank, 0) AS bank
                FROM users
                WHERE length(userId) BETWEEN 17 AND 20
                  AND userId NOT GLOB '*[^0-9]*'
                  AND userId != ?
            `).all(SLASHDRAGON_ID);
        } catch (err) {
            console.error('Leaderboard DB error:', err);
            return interaction.editReply({ content: '❌ Failed to load leaderboard data.' });
        }
        if (!rows || rows.length === 0) {
            return interaction.editReply({ content: '❌ No economy data found yet.' });
        }

        const totalsById = new Map(rows.map(row => [
            row.userId,
            safe(row.wallet) + safe(row.bank)
        ]));
        const syncTopRole = async () => {
            const topUserId = rows
                .filter(row => row.userId !== SLASHDRAGON_ID)
                .map(row => ({ userId: row.userId, total: safe(row.wallet) + safe(row.bank) }))
                .sort((a, b) => b.total - a.total)[0]?.userId;
            const topRole = guild.roles.cache.get(TOP_CREDITS_ROLE_ID);
            const botMember = guild.members.me;
            if (!topRole || !topUserId || !botMember?.permissions.has('ManageRoles') || !topRole.editable) return;
            await Promise.all([...topRole.members.values()]
                .filter(member => member.id !== topUserId && member.manageable)
                .map(member => member.roles.remove(TOP_CREDITS_ROLE_ID)
                    .catch(error => console.error(`Unable to remove top credits role from ${member.id}: ${error.message}`))));
            const topMember = await guild.members.fetch(topUserId);
            if (!topMember.user.bot && topMember.manageable) {
                await topMember.roles.add(TOP_CREDITS_ROLE_ID)
                    .catch(error => console.error(`Unable to assign top credits role to ${topUserId}: ${error.message}`));
            }
        };

        async function build(mode) {
            const sorted = rows.map(u => ({
                userId: u.userId,
                value: mode === 'bank' ? safe(u.bank) : safe(u.wallet)
            })).sort((a, b) => b.value - a.value).slice(0, 10);
            const names = await Promise.all(sorted.map(async u => {
                try {
                    const member = await guild.members.fetch(u.userId);
                    return member?.nickname || member?.user?.globalName || member?.user?.username || `<@${u.userId}>`;
                } catch {
                    return `<@${u.userId}>`;
                }
            }));
            const lines = sorted.map((u, i) => {
                const medal = ['🥇', '🥈', '🥉'][i] || '🔹';
                return `${medal} **#${i + 1}** ${names[i]}\n   └ 🪙 ${u.value.toLocaleString()}`;
            });
            return new EmbedBuilder().setColor(0x00d4ff)
                .setTitle(mode === 'bank' ? '🏦 Bank Leaderboard' : '� Wallet Leaderboard')
                .setDescription(lines.join('\n\n'))
                .setFooter({ text: 'Choose a different ranking view below' }).setTimestamp();
        }
        const menu = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
            .setCustomId('ec-leaderboard:mode').setPlaceholder('Choose a ranking view')
            .addOptions({ label: 'Wallet Balance', value: 'wallet', description: 'Wallet credits only' }, { label: 'Bank Balance', value: 'bank', description: 'Bank credits only' }));
        const message = await interaction.editReply({ embeds: [await build('wallet')], components: [menu] });
        syncTopRole().catch(error => console.error('Leaderboard top-role sync failed:', error));
        const collector = message.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 60000 });
        collector.on('collect', async component => {
            if (component.user.id !== interaction.user.id) return component.reply({ content: 'Open your own leaderboard panel.' });
            await component.update({ embeds: [await build(component.values[0])], components: [menu] });
        });
        collector.on('end', () => message.edit({ components: [] }).catch(() => {}));
    }
};
