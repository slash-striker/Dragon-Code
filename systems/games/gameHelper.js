const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const casino = require('../casino/casinoManager');
const cooldowns = require('../economy/cooldownManager');
const db = require('../../database');

function rows(buttons) {
    const normalized = buttons.map(({ id, label, style = ButtonStyle.Secondary, disabled = false }) =>
        new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled));
    return Array.from({ length: Math.ceil(normalized.length / 5) }, (_, index) =>
        new ActionRowBuilder().addComponents(normalized.slice(index * 5, index * 5 + 5))
    );
}

async function startGame(interaction, { key, title, description, buttons, onClick, onTimeout, initialState }) {
    const remaining = cooldowns.getRemainingTime(interaction.user.id, key);
    if (remaining > 0) {
        return interaction.reply({ content: `You can play again ${cooldowns.formatRemainingTime(remaining)}.` });
    }
    const state = initialState || { ended: false };
    const message = await interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x00d4ff).setTitle(title).setDescription(description(state))],
        components: rows(buttons(state)),
        fetchReply: true
    });
    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 5 * 60 * 1000 });
    collector.on('collect', async button => {
        if (button.user.id !== interaction.user.id) {
            return button.reply({ content: 'This is not your game.' });
        }
        if (state.ended) return button.reply({ content: 'This game has ended.' });
        await onClick({ button, state, message, collector, end: () => collector.stop('finished') });
        if (!state.ended && !button.replied && !button.deferred) {
            await button.update({
                embeds: [new EmbedBuilder().setColor(0x00d4ff).setTitle(title).setDescription(description(state))],
                components: rows(buttons(state))
            });
        }
    });
    collector.on('end', async (_, reason) => {
        if (!state.ended) {
            state.ended = true;
            cooldowns.setCooldown(interaction.user.id, key);
            if (onTimeout) await onTimeout({ message, reason, state });
            else await message.edit({
                embeds: [new EmbedBuilder().setColor(0xff5577).setTitle(`${title} — Timed out`).setDescription('This game expired before it was completed.')],
                components: []
            });
        }
    });
    return message;
}

async function payout(userId, game, amount, message, text) {
    db.prepare(`
        INSERT INTO mini_game_stats (userId, game, gamesPlayed, gamesWon, creditsEarned, bestPayout)
        VALUES (?, ?, 1, ?, ?, ?)
        ON CONFLICT(userId, game) DO UPDATE SET
            gamesPlayed = gamesPlayed + 1,
            gamesWon = gamesWon + excluded.gamesWon,
            creditsEarned = creditsEarned + excluded.creditsEarned,
            bestPayout = MAX(bestPayout, excluded.bestPayout)
    `).run(userId, game, amount > 0 ? 1 : 0, amount, amount);
    if (amount > 0) casino.creditWallet(userId, game, amount, 'payout', `${game} win`);
    /* 📋 Quest board hook — every minigame funnels through payout(), so one
       call here credits 'Win N minigames' quests for all of them. */
    if (amount > 0) {
        try {
            require('../economy/questManager').recordQuestEvent(userId, 'game_win', 1, { game });
        } catch (error) {
            console.error('Minigame quest hook failed:', error.message);
        }
    }
    await message.edit({
        embeds: [new EmbedBuilder().setColor(amount > 0 ? 0x00e5a8 : 0xff5577).setTitle(text).setDescription(`Reward: **🪙${amount.toLocaleString()}**`)],
        components: []
    });
}

async function showStats(interaction, game, title) {
    const stats = db.prepare('SELECT * FROM mini_game_stats WHERE userId = ? AND game = ?').get(interaction.user.id, game);
    return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x00d4ff).setTitle(title)
            .setDescription(stats
                ? `Games played: **${stats.gamesPlayed}**\nGames won: **${stats.gamesWon}**\nCredits earned: **🪙${Number(stats.creditsEarned).toLocaleString()}**\nBest payout: **🪙${Number(stats.bestPayout).toLocaleString()}**`
                : 'No games recorded yet.')]
    });
}

module.exports = { rows, startGame, payout, showStats };
