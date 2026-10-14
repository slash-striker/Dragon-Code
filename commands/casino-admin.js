const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const casino = require('../systems/casino/casinoManager');
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

/*
 * [ADMIN ONLY] Casino controls — /casino pause + /casino maxbet moved here.
 * Split from /casino because Discord cannot hide individual subcommands:
 * the visible /casino keeps the member-facing rules/stats actions.
 */
module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('casino-admin')
        .setDescription('[ADMIN ONLY] Casino table controls')
        .addSubcommand(sub => sub
            .setName('pause')
            .setDescription('Pause Blackjack for all users')
            .addIntegerOption(o => o.setName('hours')
                .setDescription('1 to 720 hours')
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('maxbet')
            .setDescription('Set a table limit')
            .addStringOption(o => o.setName('game')
                .setDescription('Which table')
                .addChoices({ name: 'Blackjack', value: 'blackjack' }, { name: 'Roulette', value: 'roulette' })
                .setRequired(true))
            .addIntegerOption(o => o.setName('amount')
                .setDescription('Maximum bet per spin (min 100)')
                .setRequired(true)
                .setMinValue(100))),

    async execute(interaction) {
        // Runtime gate — non-admins cannot run it even via permission overrides.
        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ This command is restricted to administrators.' });
        }

        const sub = interaction.options.getSubcommand();

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

        // maxbet — behavior identical to the old /casino maxbet.
        if (!casino.isCasinoAdmin(interaction)) {
            return interaction.reply({ content: 'Only the server owner or Head Staff can change this setting.' });
        }
        const game = interaction.options.getString('game');
        const amount = interaction.options.getInteger('amount');
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
};
