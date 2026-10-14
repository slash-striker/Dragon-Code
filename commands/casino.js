const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const casino = require('../systems/casino/casinoManager');
const db = require('../database');
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');
const rules = 'Also: 99% of players quit before they hit big……………..';

/*
 * Combined casino command: member-facing (rules / stats) + admin controls
 * (pause / maxbet). One `action` option instead of subcommands, so the
 * command is a single entry — the admin actions are gated at runtime via
 * adminVisibility (Discord cannot hide individual entries within a command).
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('casino')
        .setDescription('Virtual casino tools')
        .addStringOption(o => o
            .setName('action')
            .setDescription('What to do (default: rules)')
            .addChoices(
                { name: 'Read the virtual-play agreement', value: 'rules' },
                { name: 'View casino summary', value: 'stats' },
                { name: 'Pause Blackjack for all users (admin only)', value: 'pause' },
                { name: 'Set a table limit (admin only)', value: 'maxbet' }
            ))
        .addUserOption(o => o
            .setName('player')
            .setDescription('Player to inspect (for stats)')
            .setRequired(false))
        .addIntegerOption(o => o
            .setName('hours')
            .setDescription('Pause length in hours, 1 to 720 (for pause)')
            .setRequired(false))
        .addStringOption(o => o
            .setName('game')
            .setDescription('Which table (for maxbet)')
            .addChoices({ name: 'Blackjack', value: 'blackjack' }, { name: 'Roulette', value: 'roulette' })
            .setRequired(false))
        .addIntegerOption(o => o
            .setName('amount')
            .setDescription('Maximum bet per spin, min 100 (for maxbet)')
            .setRequired(false)
            .setMinValue(100)),

    async execute(interaction) {
        const sub = interaction.options.getString('action') ?? 'rules';

        if (sub === 'rules') {
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xffcc66).setTitle('Virtual-play rules').setDescription(rules)] });
        }

        if (sub === 'stats') {
            const player = interaction.options.getUser('player') || interaction.user;
            const rows = db.prepare(`SELECT type, SUM(amount) total FROM casino_ledger WHERE userId = ? GROUP BY type`).all(player.id);
            const summary = Object.fromEntries(rows.map(r => [r.type, r.total]));
            const totals = db.prepare(`SELECT COALESCE(SUM(CASE WHEN type = 'debit' THEN -amount ELSE 0 END), 0) wagers, COALESCE(SUM(CASE WHEN type IN ('payout', 'cashout') THEN amount ELSE 0 END), 0) credits FROM casino_ledger`).get();
            return interaction.reply({
                embeds: [new EmbedBuilder().setColor(0x00d4ff).setTitle(`${player.username}'s virtual casino summary`).setDescription(`**Player stats**\nCredits deposited: ${((summary.payout || 0) + (summary.cashout || 0)).toLocaleString()}\nWagers debited: ${Math.abs(summary.debit || 0).toLocaleString()}\n\n**All players**\nTotal wagers: 🪙 ${Number(totals.wagers || 0).toLocaleString()}\nTotal credits paid: 🪙 ${Number(totals.credits || 0).toLocaleString()}\n\n${rules}`)]
            });
        }

        // Admin-only subcommands
        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ This command is restricted to administrators.' });
        }

        if (sub === 'pause') {
            if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: 'Only server administrators can pause Blackjack for everyone.' });
            }
            const hours = interaction.options.getInteger('hours');
            if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
                return interaction.reply({ content: 'Choose a pause from 1 to 720 hours.' });
            }
            const until = casino.pauseBlackjack(hours);
            return interaction.reply({ content: `Blackjack is paused for everyone until <t:${Math.floor(new Date(until).getTime() / 1000)}:F>.` });
        }

        if (sub === 'maxbet') {
            if (!casino.isCasinoAdmin(interaction)) {
                return interaction.reply({ content: 'Only the server owner or Head Staff can change this setting.' });
            }
            const game = interaction.options.getString('game');
            const amount = interaction.options.getInteger('amount');
            if (!game || amount === null) {
                return interaction.reply({ content: '❌ Setting a table limit needs `game` and `amount`.' });
            }
            try {
                casino.setMaxBet(game, amount);
            } catch (error) {
                return interaction.reply({ content: error.message });
            }
            const gameLabel = game === 'blackjack' ? 'Blackjack' : 'Roulette';
            const replyPromise = interaction.reply({ content: `🎡 ${gameLabel} table limit set to 🪙 **${casino.getMaxBet(game).toLocaleString()}** per spin.` });

            if (game === 'blackjack') {
                (async () => {
                    try {
                        const logChannel = await interaction.client.channels.fetch('1504365033637806134');
                        if (!logChannel?.isTextBased()) return;
                        const profileName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
                        const configuredMaxBet = casino.getMaxBet('blackjack');
                        const executedAt = new Date().toLocaleString('en-US', {
                            year: 'numeric', month: '2-digit', day: '2-digit',
                            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
                        });
                        await logChannel.send({
                            embeds: [new (require('discord.js').EmbedBuilder)()
                                .setColor(0xa855f7)
                                .setTitle('♠ BLACKJACK MAX-BET UPDATED')
                                .setDescription(`Maximum wager configuration updated for **${interaction.guild.name}**.`)
                                .addFields(
                                    { name: 'Updated by', value: `${profileName}\n<@${interaction.user.id}>`, inline: true },
                                    { name: 'New maximum', value: `🪙${configuredMaxBet.toLocaleString()}`, inline: true },
                                    { name: 'Executed at', value: executedAt, inline: true }
                                )
                                .setFooter({ text: 'NEON CASINO CORE • Configuration audit' })
                                .setTimestamp()]
                        });
                    } catch (error) {
                        console.error('Unable to log blackjack max-bet update:', error);
                    }
                })();
            }
            return replyPromise;
        }
    }
};
