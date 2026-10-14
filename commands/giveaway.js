const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} = require('discord.js');
const db = require('../database');
const { logTransaction } = require('../systems/economy/transactionLogger');
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

// Admin role config lives in systems/admin/adminVisibility.js (DB-backed).
const GIVEAWAY_CHANNEL_ID = '1504365033071706315';
const PING_ROLE_ID = '1548526895929368667';
const SLASHDRAGON_ID = '1505829367631183963';

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('giveaway')
        .setDescription('[ADMIN ONLY] Launch a credit giveaway')
        .addIntegerOption(option => option.setName('amount').setDescription('Credits awarded to the winner').setMinValue(1).setMaxValue(1_000_000).setRequired(true))
        .addIntegerOption(option => option.setName('days').setDescription('Entry window in days').setMinValue(1).setMaxValue(30).setRequired(true)),

    async execute(interaction) {
        if (interaction.channelId !== GIVEAWAY_CHANNEL_ID) {
            return interaction.reply({ content: `Use this command in <#${GIVEAWAY_CHANNEL_ID}>.` });
        }
        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ This command is restricted to administrators.' });
        }
        const amount = interaction.options.getInteger('amount', true);
        const days = interaction.options.getInteger('days', true);
        const duration = days * 24 * 60 * 60;
        const entrants = new Set();
        const endsAt = Date.now() + duration * 1000;
        const render = () => new EmbedBuilder()
            .setColor(0xff4fd8)
            .setTitle('🎁 NEON CREDIT DROP')
            .setDescription(`Click **JOIN GIVEAWAY** below for a chance to win **🪙${amount.toLocaleString()} credits**.\n\nOne winner will be selected randomly when the countdown ends. Every entrant has an equal **${entrants.size ? (100 / entrants.size).toFixed(2) : '0.00'}%** chance while the grid is active.`)
            .addFields(
                { name: '👥 Entrants', value: `**${entrants.size}** joined`, inline: true },
                { name: '⏳ Closes', value: `<t:${Math.floor(endsAt / 1000)}:R>`, inline: true },
                { name: '💠 Prize', value: `🪙${amount.toLocaleString()}`, inline: true }
            )
            .setFooter({ text: 'NEON ECONOMY CORE • One winner • Fair random draw' })
            .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`giveaway:join:${interaction.id}`).setLabel('Join Giveaway').setEmoji('🎟️').setStyle(ButtonStyle.Success)
        );
        const message = await interaction.reply({ content: `<@&${PING_ROLE_ID}>`, embeds: [render()], components: [row], allowedMentions: { roles: [PING_ROLE_ID] }, fetchReply: true });
        const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: duration * 1000 });
        collector.on('collect', async component => {
            if (entrants.has(component.user.id)) return component.reply({ content: 'You are already entered.', ephemeral: true });
            entrants.add(component.user.id);
            await component.update({ content: `<@&${PING_ROLE_ID}>`, embeds: [render()], components: [row], allowedMentions: { roles: [PING_ROLE_ID] } });
        });
        collector.on('end', async () => {
            const entrantCount = entrants.size;
            const winnerId = entrantCount ? [...entrants][Math.floor(Math.random() * entrantCount)] : null;
            const winChance = entrantCount ? (100 / entrantCount).toFixed(2) : '0.00';
            const winner = winnerId ? await interaction.guild.members.fetch(winnerId).catch(() => null) : null;
            let paid = false;
            if (winner) {
                const payout = db.transaction(() => {
                    db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(SLASHDRAGON_ID);
                    db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(winnerId);
                    const debit = db.prepare('UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?').run(amount, SLASHDRAGON_ID, amount);
                    if (debit.changes !== 1) throw new Error('SlashDragon does not have enough reserve credits.');
                    db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(amount, winnerId);
                });
                try { payout(); paid = true; logTransaction(SLASHDRAGON_ID, 'giveaway', -amount, `Giveaway winner ${winnerId}`); logTransaction(winnerId, 'giveaway', amount, `Won giveaway hosted by ${interaction.user.id}`); } catch (error) { console.error('Giveaway payout failed:', error); }
            }
            const closedDescription = !winnerId
                ? 'The giveaway closed with no entrants — no winner was drawn.'
                : paid
                    ? `Winner: <@${winnerId}>\n\n**🪙${amount.toLocaleString()} credits** transferred successfully.\nWinning odds: **${winChance}%** (${entrantCount} entrant${entrantCount === 1 ? '' : 's'}).`
                    : `Draw completed — winner: <@${winnerId}>\nBut the payout could not be delivered because the SlashDragon reserve was unavailable.`;
            await message.edit({
                content: `<@&${PING_ROLE_ID}>`,
                embeds: [render().setColor(paid ? 0x57f287 : 0xff5577).setTitle(!winnerId ? '🎁 NEON CREDIT DROP — CLOSED' : paid ? '🏆 NEON CREDIT DROP COMPLETE' : '⚠️ GIVEAWAY FAILED').setDescription(closedDescription)],
                components: []
            }).catch(() => {});

            /*
             * Separate winner announcement posted after the event closes:
             * who won, how much, and their odds of winning.
             */
            if (winnerId && paid) {
                const announcement = new EmbedBuilder()
                    .setColor(0x57f287)
                    .setTitle('🎉 NEON CREDIT DROP — WE HAVE A WINNER')
                    .setDescription(
                        `Congratulations <@${winnerId}>! 🏆\n\n` +
                        `**🪙${amount.toLocaleString()} credits** have been added to your wallet.\n\n` +
                        `Your chance to win was **${winChance}%** out of **${entrantCount}** total entrant${entrantCount === 1 ? '' : 's'}.`
                    )
                    .addFields(
                        { name: '🏆 Winner', value: `<@${winnerId}>`, inline: true },
                        { name: '💠 Prize', value: `🪙${amount.toLocaleString()}`, inline: true },
                        { name: '🎯 Win Chance', value: `**${winChance}%**`, inline: true }
                    )
                    .setFooter({ text: 'NEON ECONOMY CORE • Fair random draw' })
                    .setTimestamp();
                const channel = await interaction.client.channels.fetch(GIVEAWAY_CHANNEL_ID).catch(() => null);
                if (channel) {
                    const posted = await channel.send({
                        content: `<@${winnerId}>`,
                        embeds: [announcement],
                        allowedMentions: { users: [winnerId] }
                    }).catch(() => null);

                    /*
                     * Persist everything a reroll needs BEFORE the button is
                     * offered, so the button is never live without state
                     * behind it. The key is the announcement's message id and
                     * the button payload is that same id — the two halves can
                     * never drift apart across a restart.
                     */
                    if (posted) {
                        setRerollState(posted.id, {
                            amount,
                            winnerId,
                            entrants: [...entrants],
                            channelId: GIVEAWAY_CHANNEL_ID,
                            hostId: interaction.user.id,
                            rerolled: false
                        });
                        await posted.edit({
                            components: [new ActionRowBuilder().addComponents(
                                new ButtonBuilder()
                                    .setCustomId(`giveaway:reroll:${posted.id}`)
                                    .setLabel('Reroll winner')
                                    .setEmoji('🎲')
                                    .setStyle(ButtonStyle.Danger)
                            )]
                        }).catch(() => {});
                    }
                }
            }
        });
    },

    /* ---------------------------------------------------------------
     * Staff reroll.
     *
     * Choice of persistence: bot_meta, NOT memory. The winner is drawn from
     * the collector's `end` event, and Discord collectors are torn down the
     * moment the event fires — so by the time anybody can click this button
     * the closure above is long gone. One JSON blob per announcement id in
     * bot_meta survives restarts and is read back here.
     * --------------------------------------------------------------- */
    async handleComponent(interaction) {
        const pieces = String(interaction.customId).split(':');
        if (pieces[0] !== 'giveaway' || pieces[1] !== 'reroll') return;
        const messageId = pieces[2];

        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ Only administrators can reroll a giveaway.', ephemeral: true });
        }

        const state = getRerollState(messageId);
        if (!state) {
            return interaction.reply({
                content: '❌ This giveaway can no longer be rerolled — its draw state is not on record.',
                ephemeral: true
            });
        }
        if (state.rerolled) {
            return interaction.reply({ content: '❌ This giveaway has already been rerolled once.', ephemeral: true });
        }

        const pool = Array.isArray(state.entrants) ? state.entrants : [];
        if (!pool.length) {
            return interaction.reply({ content: '❌ That giveaway had no entrants to draw from.', ephemeral: true });
        }

        // Never hand the same entrant the prize twice when there is an alternative.
        const candidates = pool.length > 1 ? pool.filter(id => id !== state.winnerId) : pool;
        const newWinnerId = candidates[Math.floor(Math.random() * candidates.length)];
        const amount = Number(state.amount) || 0;
        const winChance = (100 / pool.length).toFixed(2);

        let paid = false;
        let failure = null;
        try {
            db.transaction(() => {
                db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(SLASHDRAGON_ID);
                db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(newWinnerId);

                // Claw the prize back from the original winner first. If they
                // already spent it the whole reroll is refused and nothing moves.
                const clawback = db.prepare(
                    'UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?'
                ).run(amount, state.winnerId, amount);
                if (clawback.changes !== 1) {
                    throw new Error(`<@${state.winnerId}> no longer holds 🪙${amount.toLocaleString()}, so the prize cannot be clawed back.`);
                }
                db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(amount, SLASHDRAGON_ID);

                const debit = db.prepare(
                    'UPDATE users SET wallet = wallet - ? WHERE userId = ? AND wallet >= ?'
                ).run(amount, SLASHDRAGON_ID, amount);
                if (debit.changes !== 1) throw new Error('The SlashDragon reserve does not hold enough credits for the reroll.');
                db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(amount, newWinnerId);
            })();
            paid = true;
        } catch (error) {
            failure = error.message;
            console.error('Giveaway reroll failed:', error);
        }

        if (!paid) {
            return interaction.reply({
                content: `❌ Reroll failed — ${failure} The original winner keeps the prize; nothing was moved.`,
                ephemeral: true
            });
        }

        logTransaction(state.winnerId, 'giveaway_reroll', -amount, 'Giveaway prize clawed back for a staff reroll');
        logTransaction(newWinnerId, 'giveaway', amount, `Won a staff-rerolled giveaway (replacing ${state.winnerId})`);

        // Mark it rerolled BEFORE announcing, so a double click can never double-pay.
        setRerollState(messageId, { ...state, winnerId: newWinnerId, rerolled: true });

        const rerolled = new EmbedBuilder()
            .setColor(0xffa640)
            .setTitle('🎲 NEON CREDIT DROP — REROLLED')
            .setDescription(
                `The draw was rerolled by staff.\n\n` +
                `New winner: <@${newWinnerId}> 🏆\n\n` +
                `**🪙${amount.toLocaleString()} credits** were clawed back from <@${state.winnerId}> and paid to the new winner.\n\n` +
                `Winning odds: **${winChance}%** out of **${pool.length}** entrant${pool.length === 1 ? '' : 's'}.`
            )
            .addFields(
                { name: '🏆 Winner', value: `<@${newWinnerId}>`, inline: true },
                { name: '💠 Prize', value: `🪙${amount.toLocaleString()}`, inline: true },
                { name: '🎯 Win Chance', value: `**${winChance}%**`, inline: true }
            )
            .setFooter({ text: 'NEON ECONOMY CORE • Staff reroll • one reroll per giveaway' })
            .setTimestamp();

        let updated = false;
        try {
            const channel = interaction.channel
                || await interaction.client.channels.fetch(state.channelId).catch(() => null);
            const target = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;
            if (target) {
                await target.edit({
                    content: `<@${newWinnerId}>`,
                    embeds: [rerolled],
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`giveaway:reroll:${messageId}`)
                            .setLabel('Already rerolled')
                            .setEmoji('🎲')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(true)
                    )]
                });
                updated = true;
            }
        } catch (error) {
            console.error('Giveaway reroll announcement update failed:', error);
        }

        return interaction.reply({
            content: updated
                ? `🎲 Rerolled — <@${newWinnerId}> now holds the 🪙${amount.toLocaleString()} prize.`
                : `🎲 Rerolled — <@${newWinnerId}> was paid 🪙${amount.toLocaleString()}, but the winner message could not be updated (it may have been deleted).`,
            allowedMentions: { users: [newWinnerId] }
        });
    }
};

/* ---------------------------------------------------------------
 * Durable reroll state — one row of bot_meta per giveaway.
 * Set BEFORE the reroll button is attached and flipped to rerolled:true
 * before the payout is announced, so a restart or a double click can never
 * pay twice.
 * --------------------------------------------------------------- */
const REROLL_KEY_PREFIX = 'giveaway:reroll:';

function setRerollState(messageId, state) {
    db.prepare(`
        INSERT INTO bot_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(`${REROLL_KEY_PREFIX}${messageId}`, JSON.stringify(state));
}

function getRerollState(messageId) {
    const row = db.prepare('SELECT value FROM bot_meta WHERE key = ?').get(`${REROLL_KEY_PREFIX}${messageId}`);
    if (!row) return null;
    try {
        return JSON.parse(row.value);
    } catch (error) {
        return null;
    }
}
