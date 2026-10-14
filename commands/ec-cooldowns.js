const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} = require('discord.js');
const { getAllCooldowns, formatCooldownExpiry } = require('../systems/economy/cooldownManager');
const { getUser } = require('../systems/economy/userManager');
const { getMiningProfile } = require('../systems/mining/miningManager');
const { getColor, formatTitle, formatButtonLabel, isHighTech } = require('../systems/economy/uiStyleHelper');

const ALLOWED_CHANNEL = '1504562791967756448';

const COMMAND_NAMES = {
    rob_bank: 'Rob Bank',
    rob_player: 'Rob Player',
    scratchcard: 'Scratchcard',
    crime: 'Crime',
    beg: 'Beg',
    work: 'Work',
    fish: 'Fish',
    mine: 'Mine',
    daily: 'Daily',
    fivedice: 'Five Dice',
    matchpairs: 'Match Pairs',
    lightsout: 'Lights Out',
    mastermind: 'Mastermind',
    hangman: 'Hangman',
    highlow: 'High/Low',
    rps: 'Rock Paper Scissors',
    tictactoe: 'Tic-Tac-Toe'
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ec-cooldowns')
        .setDescription('View command cooldowns — yours, or peek at another member\u2019s')
        .addUserOption(option => option
            .setName('user')
            .setDescription('Whose cooldowns to view (defaults to you)')),

    async execute(interaction) {
        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ You can only use this in <#${ALLOWED_CHANNEL}>.` });
        }

        const viewerId = interaction.user.id;
        // Optional peek: pick a member to see THEIR cooldown matrix instead.
        const targetUser = interaction.options.getUser('user') ?? interaction.user;
        const userId = targetUser.id;
        const viewingOther = userId !== viewerId;
        getUser(userId);
        const highTech = isHighTech(userId);
        const commands = Object.entries(COMMAND_NAMES).map(([key, name]) => ({
            key,
            name,
            emoji: {
                rob_bank: '🏦', rob_player: '🔫', scratchcard: '🎫', crime: '🔪',
                beg: '🙏', work: '💼', fish: '🎣', mine: '⛏️', daily: '🌟',
                fivedice: '🎲', matchpairs: '🧩', lightsout: '💡',
                mastermind: '🧠', hangman: '☠️', highlow: '📈',
                rps: '✂️', tictactoe: '⭕'
            }[key] || '⏱️'
        }));

        const buildEmbed = () => {
            const activeCooldowns = getAllCooldowns(userId);
            // /mine keeps its ready-at timestamp on the mining profile
            // (mining_profile.mineCooldown), not in command_cooldowns — read
            // it there so the Mine row reflects reality instead of always
            // showing Ready.
            let mineReadyAt = null;
            try {
                const readyAt = Number(getMiningProfile(userId)?.mineCooldown) || 0;
                if (readyAt > Date.now()) mineReadyAt = readyAt;
            } catch {
                mineReadyAt = null;
            }
            const statuses = commands.map(command => {
                const cooldown = command.key === 'mine'
                    ? (mineReadyAt ? { expiresAt: mineReadyAt } : null)
                    : activeCooldowns.find(item => item.command === command.key);
                return {
                    ...command,
                    active: Boolean(cooldown),
                    status: cooldown
                        ? formatCooldownExpiry(cooldown.expiresAt)
                        : (highTech ? '🟢 READY' : 'Ready')
                };
            });
            const active = statuses.filter(command => command.active);
            const ready = statuses.filter(command => !command.active);
            const noun = viewingOther ? 'commands' : highTech ? 'systems' : 'commands';
            let description = highTech
                ? `**[ ⏱️ COMMAND COOLDOWN MATRIX ]**${viewingOther ? ` — ${targetUser.username.toUpperCase()}` : ''}\n\n> ${ready.length}/${statuses.length} ${noun} ready\n\n`
                : `**Command status**${viewingOther ? ` — ${targetUser.username}` : ''}\n\n> ${ready.length}/${statuses.length} commands ready\n\n`;

            if (active.length) {
                description += `${highTech ? '⏳ **ACTIVE COOLDOWN SIGNALS**' : '⏳ **On cooldown**'}\n`;
                description += active.map(command =>
                    `${command.emoji} **${command.name}**\n└─ ${highTech ? '⏱️ ' : ''}${command.status}`
                ).join('\n');
                description += '\n\n';
            }

            description += `${highTech ? '🟢 **READY SYSTEMS**' : '🟢 **Ready to use**'}\n`;
            description += ready.map(command => `${command.emoji} **${command.name}** ── ${command.status}`).join('\n');

            if (!active.length) {
                description += `\n\n${highTech ? '🎉 **ALL SYSTEMS ONLINE**\nDeploy your next move.' : 'Everything is ready.'}`;
            }

            return new EmbedBuilder()
                .setColor(getColor(userId, 0x00d4ff))
                .setTitle(formatTitle(userId, '🌐 COOLDOWN CONTROL TERMINAL', 'Command Cooldowns'))
                .setDescription(description)
                .setFooter({ text: viewingOther
                    ? `${interaction.user.tag} • Viewing ${targetUser.tag}`
                    : `${interaction.user.tag} • ${highTech ? 'Live economy dashboard' : 'Economy dashboard'}` })
                .setTimestamp();
        };

        const refreshButton = new ButtonBuilder()
            .setCustomId(`cooldowns:refresh:${userId}`)
            .setLabel(formatButtonLabel(userId, 'Refresh Matrix', 'Refresh'))
            .setEmoji('🔄')
            .setStyle(ButtonStyle.Primary);
        const row = new ActionRowBuilder().addComponents(refreshButton);
        const message = await interaction.reply({
            embeds: [buildEmbed()],
            components: [row],
            fetchReply: true
        });
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 15 * 60 * 1000
        });

        collector.on('collect', async button => {
            if (button.user.id !== userId) {
                return button.reply({ content: 'This cooldown dashboard belongs to someone else.' });
            }
            if (button.customId === `cooldowns:refresh:${userId}`) {
                await button.update({ embeds: [buildEmbed()], components: [row] });
            }
        });

        collector.on('end', async () => {
            try {
                await message.edit({
                    components: [new ActionRowBuilder().addComponents(
                        ButtonBuilder.from(refreshButton).setDisabled(true)
                    )]
                });
            } catch (error) {
                if (error.code !== 10008) console.error('Unable to close cooldown dashboard:', error);
            }
        });
    }
};
