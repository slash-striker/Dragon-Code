const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const casino = require('../casino/casinoManager');
const cooldowns = require('../economy/cooldownManager');
const db = require('../../database');
const neonUI = require('./neonUI');
const { isHighTech } = require('../economy/uiStyleHelper');

/*
 * Shared mini-game embed for the games built on this helper (rps, tictactoe).
 * High-tech players get the `◢ ═══ TITLE ═══ ◣` frame around an ANSI panel;
 * normal players get the plain title and the same body as ordinary text.
 */
function gameEmbed(userId, title, description, color = neonUI.NEON.cyan, footer) {
    const body = String(description ?? '');
    const highTech = isHighTech(userId);
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(highTech ? neonUI.neonTitle(title) : title)
        .setDescription(highTech ? neonUI.panel(...neonUI.panelLines(body)) : body);
    if (footer) embed.setFooter({ text: footer });
    return embed;
}

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
    const userId = interaction.user.id;
    const message = await interaction.reply({
        embeds: [gameEmbed(userId, title, description(state))],
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
                embeds: [gameEmbed(userId, title, description(state))],
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
                embeds: [gameEmbed(userId, `${title} — Timed out`, 'This game expired before it was completed.', neonUI.NEON.red)],
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
        embeds: [gameEmbed(userId, text, `Reward: **🪙${amount.toLocaleString()}**`, amount > 0 ? neonUI.NEON.green : neonUI.NEON.red)],
        components: []
    });
}

async function showStats(interaction, game, title) {
    const stats = db.prepare('SELECT * FROM mini_game_stats WHERE userId = ? AND game = ?').get(interaction.user.id, game);
    const body = stats
        ? `Games played: **${stats.gamesPlayed}**\nGames won: **${stats.gamesWon}**\nCredits earned: **🪙${Number(stats.creditsEarned).toLocaleString()}**\nBest payout: **🪙${Number(stats.bestPayout).toLocaleString()}**`
        : 'No games recorded yet.';
    return interaction.reply({ embeds: [gameEmbed(interaction.user.id, title, body)] });
}

module.exports = { rows, startGame, payout, showStats, gameEmbed };
