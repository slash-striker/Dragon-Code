const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

async function confirmAction(interaction, prompt, key = 'confirm') {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`confirm:${key}:${interaction.user.id}:yes`)
            .setLabel('Confirm')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`confirm:${key}:${interaction.user.id}:no`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );
    const message = await interaction.reply({
        content: `⚠️ **${prompt}**\nThis action cannot be undone.`,
        components: [row],
        fetchReply: true
    });
    const choice = await message.awaitMessageComponent({
        filter: button => button.user.id === interaction.user.id,
        time: 30_000
    }).catch(() => null);
    if (!choice) {
        await interaction.editReply({ content: '⌛ Confirmation expired. No changes were made.', components: [] });
        return false;
    }
    if (choice.customId.endsWith(':no')) {
        await choice.update({ content: '✅ Reset cancelled. No changes were made.', components: [] });
        return false;
    }
    await choice.update({ content: '🔄 Reset confirmed. Applying changes...', components: [] });
    return true;
}

module.exports = { confirmAction };
