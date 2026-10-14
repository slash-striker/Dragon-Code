// const { SlashCommandBuilder } = require('discord.js');

// module.exports = {
//     data: new SlashCommandBuilder()
//         .setName('say')
//         .setDescription('Makes the bot say something')
//         .addStringOption(option =>
//             option
//                 .setName('message')
//                 .setDescription('The message to send')
//                 .setRequired(true)
//         ),

//     async execute(interaction) {
//         const message = interaction.options.getString('message');

//         await interaction.reply({
//             content: 'Message sent!',
//             ephemeral: true,
//         });

//         await interaction.channel.send(message);
//     },
// };
const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags
} = require('discord.js');
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

module.exports = {
    // Hidden from members + runtime-gated, like every other admin command.
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('say')
        .setDescription('[ADMIN ONLY] 📢 Make the bot send a message.')
        .addStringOption(option =>
            option
                .setName('message')
                .setDescription('The message to send')
                .setRequired(true)
        ),

    async execute(interaction) {

        const hasStaffRole = isAdminUser(interaction);

        if (!hasStaffRole) {
            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor('#ED4245')
                        .setTitle('🚫 Access Denied')
                        .setDescription(
                            'You must be a **staff member** to use this command.'
                        )
                ] });
        }

        const message = interaction.options.getString('message');

        /*
         * The delivered message goes ONLY to the staff member who ran the
         * command — as a private (ephemeral) confirmation carrying the exact
         * text that was posted, so the channel isn't spammed with a
         * "Message sent!" placeholder. The admin log entry (index.js) still
         * records the full message content via adminCommandDetails.
         */
        interaction.adminCommandDetails =
            `Channel: <#${interaction.channelId}>\n` +
            `Message: ${message}`;

        await interaction.reply({
            flags: MessageFlags.Ephemeral,
            embeds: [
                new EmbedBuilder()
                    .setColor('#57F287')
                    .setTitle('✅ Message Sent')
                    .setDescription(
                        `Your announcement has been posted in <#${interaction.channelId}>.\n\n` +
                        `📢 **Delivered message:**\n\u00AB ${message} \u00BB`
                    )
                    .setFooter({
                        text: `Requested by ${interaction.user.tag}`
                    })
                    .setTimestamp()
            ] });

        // Send the message
        await interaction.channel.send(message);
    }
};