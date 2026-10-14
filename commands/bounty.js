/*
 * /bounty — the player-funded revenge loop.
 *
 *   /bounty action:add  user:<@u> amount:<n>   pool credits on a target
 *   /bounty action:view [user:<@u>]            inspect a bounty or the top ten
 *
 * The pool is held in the bounty ledger and paid out the moment somebody
 * SUCCESSFULLY robs the target — no staff involvement, no expiry. The robbery
 * payout path is what calls claimBounty(), so placing a bounty is the only
 * thing this command has to do; reading it back is the rest.
 */
const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const { ensureUser } = require('../systems/utils/ensureUser');
const bounties = require('../systems/economy/bountyManager');

const ALLOWED_CHANNEL = '1504562791967756448';
const COLOR = 0xe74c3c;
const COLOR_VIEW = 0x00d4ff;

function money(value) {
    return Number(value || 0).toLocaleString();
}

function contributorLines(targetId, limit = 5) {
    const rows = bounties.listContributors(targetId, limit);
    if (!rows.length) return '_No listed contributors._';
    return rows.map((row, index) => `**#${index + 1}** <@${row.contributorId}> — 🪙${money(row.amount)}`).join('\n');
}

function topLines(limit = 10) {
    const rows = bounties.topBounties(limit);
    if (!rows.length) return '_Nobody is wanted right now. The grid is disappointingly peaceful._';
    return rows.map((row, index) => `**#${index + 1}** <@${row.targetId}> — 🪙${money(row.amount)}`).join('\n');
}

function controls(userId, { includeClose = true } = {}) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`bounty:${userId}:top`)
            .setLabel('Top bounties')
            .setEmoji('🎯')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`bounty:${userId}:mine`)
            .setLabel('Bounty on me')
            .setEmoji('🛡️')
            .setStyle(ButtonStyle.Secondary)
    );
    if (includeClose) {
        row.addComponents(new ButtonBuilder()
            .setCustomId(`bounty:${userId}:close`)
            .setLabel('Close')
            .setEmoji('✖')
            .setStyle(ButtonStyle.Secondary));
    }
    return [row];
}

function overviewEmbed(userId) {
    const own = bounties.getBounty(userId);
    return new EmbedBuilder()
        .setColor(COLOR_VIEW)
        .setTitle('🎯 NEURAL BOUNTY BOARD')
        .setDescription([
            "A bounty is a pool of credits on somebody's head.",
            '',
            '**How it pays out:** whoever successfully robs that player collects the **entire pool** on top of whatever they steal — instantly, automatically, no staff action needed.',
            '',
            'Pool a reward with `/bounty action:add`, or watch the board with `/bounty action:view`.'
        ].join('\n'))
        .addFields(
            {
                name: '🏦 TOTAL POOL',
                value: `🪙${money(bounties.totalBountyPool())}`,
                inline: true
            },
            {
                name: '🛡️ BOUNTY ON YOU',
                value: Number(own.amount) > 0 ? `🪙${money(own.amount)}` : 'Nothing — you are safe',
                inline: true
            },
            {
                name: '🏆 MOST WANTED',
                value: topLines(5),
                inline: false
            }
        )
        .setFooter({ text: 'NEURAL BOUNTY BOARD • funded entirely by players' })
        .setTimestamp();
}

function targetEmbed(targetId, displayName) {
    const row = bounties.getBounty(targetId);
    const amount = Number(row.amount) || 0;
    return new EmbedBuilder()
        .setColor(amount > 0 ? COLOR : COLOR_VIEW)
        .setTitle(`🎯 BOUNTY — ${String(displayName || 'PLAYER').slice(0, 40)}`)
        .setDescription(amount > 0
            ? [
                `<@${targetId}> currently carries a **🪙${money(amount)}** bounty.`,
                '',
                'Robbing them successfully collects the whole pool on top of the steal.'
            ].join('\n')
            : `There is no bounty on <@${targetId}> right now. Somebody should fix that.`)
        .addFields({ name: '💸 FUNDED BY', value: contributorLines(targetId), inline: false })
        .setFooter({ text: 'NEURAL BOUNTY BOARD • funded entirely by players' })
        .setTimestamp();
}

function placedEmbed(contributorId, targetId, result) {
    return new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('🎯 BOUNTY PLACED')
        .setDescription([
            `<@${contributorId}> just staked **🪙${money(result.total)}** on <@${targetId}>.`,
            '',
            'Every robber in the grid now has a reason to visit them.'
        ].join('\n'))
        .addFields(
            { name: '💰 NEW TOTAL', value: `🪙${money(result.total)}`, inline: true },
            { name: '💸 FUNDED BY', value: contributorLines(targetId), inline: false }
        )
        .setFooter({ text: 'NEURAL BOUNTY BOARD • first successful robbery collects it' })
        .setTimestamp();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('bounty')
        .setDescription('Pool credits on another player — whoever robs them collects the whole reward')
        .addStringOption(option => option
            .setName('action')
            .setDescription('Add to a bounty or view the board')
            .addChoices(
                { name: 'Add — pool credits on a target', value: 'add' },
                { name: 'View — inspect a bounty or the board', value: 'view' }
            ))
        .addUserOption(option => option
            .setName('user')
            .setDescription('The target player'))
        .addIntegerOption(option => option
            .setName('amount')
            .setDescription('Credits to put on their head (minimum 500)')
            .setMinValue(500)),

    async execute(interaction) {
        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ You can only use this in <#${ALLOWED_CHANNEL}>.`
            });
        }

        await interaction.deferReply();

        const action = interaction.options.getString('action') || 'view';
        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        ensureUser(interaction.user.id);

        if (action === 'add') {
            if (!target || !amount) {
                return interaction.editReply({
                    content: '❌ A bounty needs both a **user** and an **amount** — try `/bounty action:add user:@someone amount:5000`.'
                });
            }

            if (target.id === interaction.user.id) {
                return interaction.editReply({
                    content: '❌ You cannot put a price on your own head — that is just called a savings account.'
                });
            }

            ensureUser(target.id);
            const result = bounties.placeBounty({
                targetId: target.id,
                contributorId: interaction.user.id,
                amount
            });

            if (!result.ok) {
                return interaction.editReply({ content: `❌ ${result.message}` });
            }

            return interaction.editReply({
                content: `🎯 <@${target.id}> — a price was just put on your head.`,
                embeds: [placedEmbed(interaction.user.id, target.id, result)],
                components: controls(interaction.user.id)
            });
        }

        if (target) {
            const displayName = target.displayName || target.username || 'Player';
            return interaction.editReply({
                embeds: [targetEmbed(target.id, displayName)],
                components: controls(interaction.user.id)
            });
        }

        return interaction.editReply({
            embeds: [overviewEmbed(interaction.user.id)],
            components: controls(interaction.user.id)
        });
    },

    /*
     * Component router — index.js routes every id starting with 'bounty:' here.
     * Ids are scoped to the opener: bounty:<userId>:<action>.
     */
    async handleComponent(interaction) {
        const pieces = String(interaction.customId).split(':');
        const ownerId = pieces[1];
        const action = pieces[2];

        if (!ownerId || !action) return;
        if (interaction.user.id !== ownerId) {
            return interaction.reply({
                content: '❌ This bounty board belongs to someone else — run /bounty to open your own.',
                flags: 64
            });
        }

        ensureUser(ownerId);

        if (action === 'close') {
            return interaction.update({ content: '🎯 Bounty board closed.', embeds: [], components: [] });
        }

        if (action === 'top') {
            const embed = new EmbedBuilder()
                .setColor(COLOR)
                .setTitle('🏆 MOST WANTED')
                .setDescription(topLines(10))
                .addFields({
                    name: '🏦 TOTAL POOL',
                    value: `🪙${money(bounties.totalBountyPool())}`,
                    inline: true
                })
                .setFooter({ text: 'NEURAL BOUNTY BOARD • funded entirely by players' })
                .setTimestamp();
            return interaction.update({ content: null, embeds: [embed], components: controls(ownerId) });
        }

        if (action === 'mine') {
            const own = bounties.getBounty(ownerId);
            const value = Number(own.amount) || 0;
            const embed = new EmbedBuilder()
                .setColor(value > 0 ? COLOR : 0x2ecc71)
                .setTitle(value > 0 ? '🛡️ YOU ARE WANTED' : '🛡️ NO PRICE ON YOUR HEAD')
                .setDescription(value > 0
                    ? [
                        `There is **🪙${money(value)}** waiting for whoever robs you successfully.`,
                        '',
                        'Rob insurance and guards exist for exactly this situation. Sleep with one eye open.'
                    ].join('\n')
                    : [
                        'Nobody has funded a bounty on you. Enjoy the anonymity while it lasts.',
                        '',
                        `The global pool currently stands at 🪙${money(bounties.totalBountyPool())}.`
                    ].join('\n'))
                .addFields({ name: '💸 FUNDED BY', value: value > 0 ? contributorLines(ownerId) : '_nobody_', inline: false })
                .setFooter({ text: 'NEURAL BOUNTY BOARD • funded entirely by players' })
                .setTimestamp();
            return interaction.update({ content: null, embeds: [embed], components: controls(ownerId) });
        }
    }
};
