const { getUser, updateUser } = require('../systems/economy/userManager');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('prestige')
        .setDescription('Prestige after reaching required streak'),

    async execute(interaction) {

        const user = await getUser(interaction.user.id);

        // FIXED SAFE STRUCTURE (no nested user objects)
        const streak = user.dailyStreak || 0;

        if (streak < 30) {
            return interaction.reply({
                content: "🌌 You need a **30-day streak** to prestige." });
        }

        const newLevel = (user.prestigeLevel || 0) + 1;
        const newMultiplier = (user.prestigeMultiplier || 1) + 0.25;

        // reset progression
        user.dailyStreak = 0;
        user.dailyMissedDays = 0;

        user.prestigeLevel = newLevel;
        user.prestigeMultiplier = newMultiplier;

        updateUser({
            ...user,
            userId: user.userId
        });

        const embed = new EmbedBuilder()
            .setColor(0x7c4dff)
            .setTitle("🌠 PRESTIGE COMPLETE!")
            .setDescription(
                `You ascended beyond the cosmos.\n\n` +
                `✨ Prestige Level: **${newLevel}**\n` +
                `📈 Permanent Multiplier: **${newMultiplier.toFixed(2)}x**\n\n` +
                `🚀 Your journey resets... but you are stronger.`
            );

        return interaction.reply({ embeds: [embed] });
    }
};