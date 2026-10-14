const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');
const { isAdminUser, hideFromMembers } = require('../systems/admin/adminVisibility');

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('server-rules')
        .setDescription('[ADMIN ONLY] Displays the server rules'),

    async execute(interaction) {
        // Runtime gate — non-admins cannot run it even via permission overrides.
        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ This command is restricted to administrators.' });
        }
        const embed = new EmbedBuilder()
            .setColor('#00d4ff')
            .setTitle('📜 Server Rules')
            .setDescription(
                'Welcome to the server. The rules below are short, clear, and apply to everyone. ' +
                'Ignorance of the rules is not an excuse — please read them fully.'
            )
            .addFields(
                {
                    name: '1 · Respect Everyone',
                    value:
                        'Treat every member with respect. Harassment, bullying, hate speech, and deliberate ' +
                        'toxicity are not tolerated. Friendly jokes are fine — targeted ones are not.'
                },
                {
                    name: '2 · No Spam',
                    value:
                        'Spamming messages, attachments, mentions, channels, or links is not allowed. ' +
                        'The only exception is **#spams**, where message, attachment, and (safe) link spam are permitted. ' +
                        'Mass-pinging members is never allowed, even there.'
                },
                {
                    name: '3 · Use the Right Channels',
                    value:
                        'Keep conversations in the channels made for them:\n' +
                        '• **#game-invites** — inviting others to games\n' +
                        '• **#screenshots** — posting screenshots (and talking about them)\n\n' +
                        'Off-topic conversation is always welcome in **#general** — just not everywhere else.'
                },
                {
                    name: '4 · Keep Content Clean',
                    value:
                        'No NSFW content, no PG-13+ material, and no malicious links. Nothing of that kind may ' +
                        'be posted anywhere in the server.'
                },
                {
                    name: '5 · No Advertising',
                    value:
                        'Server invites, self-promotion, unauthorized links, and advertising require **staff approval** ' +
                        'before posting — any Police Officer or staff member can approve it. When in doubt, ask first.'
                },
                {
                    name: '6 · No Swearing',
                    value:
                        'There will be **no swearing of any kind**. All swearing messages will be deleted. ' +
                        'It still counts as swearing even if it is not directed at anyone.'
                },
                {
                    name: '7 · Be Honest',
                    value:
                        'No impersonation, fake accounts, malicious links, or malicious intent. ' +
                        'Please read and follow [Discord\'s Terms of Service and Community Guidelines](https://discord.com/terms).'
                },
                {
                    name: '8 · Respect Privacy',
                    value:
                        'Hacking, leaking other people\'s conversations or DMs, sharing private information, and ' +
                        'posting screenshots of personal or private messages are strictly prohibited. ' +
                        'Violations are removed immediately.'
                },
                {
                    name: '9 · Voice Channels',
                    value:
                        'Use voice channels with respect for others: no intentional interruptions and no mic abuse. ' +
                        'Keep noise levels reasonable and let everyone speak.'
                },
                {
                    name: '10 · Report Issues the Right Way',
                    value:
                        'If a member breaks a rule, **create a ticket** to get it sorted, or DM the owner directly. ' +
                        'You can also ping the owner in the server if it is not sensitive. ' +
                        'The goal is not to snitch — it is to make this a better community.'
                },
                {
                    name: '11 · Disputes & Court Cases',
                    value:
                        'If another member wrongs you, or you believe action should be taken on someone\'s behalf, ' +
                        '**create a ticket**. Serious cases may be handled as a formal court case.'
                },
                {
                    name: '12 · Think Before You Act',
                    value:
                        'Pause before posting, saying, or doing anything unnecessary. Anger will not help the situation — ' +
                        'patience will.'
                },
                {
                    name: '13 · Take Care of Yourself',
                    value:
                        'Get enough sleep. Drink water. Give school and work your full attention, and don\'t spend all day gaming. ' +
                        'The server will still be here when you get back.\n\n' +
                        '**Respect others · Stay safe · Have fun**'
                },
                {
                    name: '⚖️ Enforcement',
                    value:
                        'Punishments are applied at staff discretion and scale with severity and repeat offenses:\n' +
                        '🟡 Warning → 🟠 Timeout → 🔴 Kick → ⛔ Ban'
                },
                {
                    name: '🛡 The Police Team',
                    value:
                        'Our **Police Officers** keep the server safe and handle reports. ' +
                        'They are regular members with extra responsibility — treat them with the same respect they show you.'
                }
            )
            .setFooter({ text: 'Last updated: September 2026 • Rules apply to all members' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};
