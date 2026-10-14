const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');

const WELCOME_CARD_CHANNEL_ID = '1504365032320798841';
const UNVERIFIED_ROLE_ID = '1520308932130639923';
const WELCOME_MESSAGE_CHANNEL_IDS = [
    '1504365032320798844',
    '1504365034216624192'
];
const WELCOME_MESSAGES = [
    '🤖 New user detected: {user}. Welcome to the network. We now have {memberCount} members.',
    '🧠 Neural network updated. {user} has joined. Current population: {memberCount}.',
    '⚡ Incoming connection established: {user}. Network population: {memberCount} members.',
    '🔌 {user} has plugged into the system. Connected users: {memberCount}.',
    '💻 User `{user}` successfully authenticated. System population: {memberCount}.',
    '🛰️ Signal received from {user}. The network now contains {memberCount} members.',
    '⚙️ Creating new user instance: `{user}`... Success. Members online: {memberCount}.',
    '🔐 Identity verified. Access granted to {user}. Server population: {memberCount}.',
    '🌌 Welcome, {user}. Your journey through the network begins now. Travelers: {memberCount}.',
    '🚀 Warp drive engaged. {user} has arrived. Crew size: {memberCount}.',
    '🌐 Welcome to the grid, {user}. Grid population: {memberCount}.',
    '✨ A new consciousness has entered the simulation: {user}. Conscious entities: {memberCount}.',
    '🛸 Unknown lifeform detected: `{user}`. Lifeforms registered: {memberCount}.',
    '🔭 Scanning... `{user}` detected. Total detected users: {memberCount}.',
    '🪐 {user} has entered our orbit. Orbital population: {memberCount}.',
    '💀 ACCESS GRANTED // Welcome, {user}. Network population: {memberCount}.',
    '🔓 Firewall bypassed. Welcome to the underground, {user}. Connected nodes: {memberCount}.',
    '⚠️ INTRUDER DETECTED // Just kidding. Welcome, {user}. System population: {memberCount}.',
    '🕶️ Welcome to the grid, {user}. Grid population: {memberCount}.',
    '💻 Connecting to darknet node... `{user}` connected. Active nodes: {memberCount}.',
    '🔐 Encryption handshake complete. Welcome, {user}. Encrypted users: {memberCount}.',
    '🌃 Welcome to the neon network, {user}. Neon network population: {memberCount}.',
    '⚡ Cyberlink established. `{user}` is online. Online users: {memberCount}.',
    '🔴 TRACE COMPLETE // Identity: `{user}` // Status: FRIENDLY // Users: {memberCount}',
    '🟢 ACCESS LEVEL: MEMBER // USER: `{user}` // MEMBERS: {memberCount}',
    '📡 Encrypted transmission received from `{user}`. Network size: {memberCount}.',
    '💿 Boot sequence complete. Welcome, `{user}`. Booted users: {memberCount}.',
    '⚙️ System override complete. `{user}` has entered. System population: {memberCount}.',
    '🖥️ Bootloader message: `{user}` detected during startup. Booted users: {memberCount}.',
    '🔧 Running `initializeUser({user})`... complete. Active instances: {memberCount}.',
    '📡 Packet received from `{user}`. Packet routing table contains {memberCount} endpoints.',
    '🔗 `{user}` has been linked to the community graph. Connected nodes: {memberCount}.',
    '🔐 Session created for `{user}`. Active sessions: {memberCount}.',
    '🧠 Cache warmed for `{user}`. Cached personalities: {memberCount}.',
    '🧬 `{user}` has been compiled into the community. Compiled members: {memberCount}.',
    '🚨 `{user}` has joined. Everybody act like we know what we are doing. Members: {memberCount}.',
    '🐛 `{user}` joined the server. Is this a feature or a bug? Either way, members: {memberCount}.',
    '🔥 `{user}` has entered production. Good luck, everyone. Production population: {memberCount}.',
    '💀 `{user}` joined. The server will never be the same. Current survivors: {memberCount}.',
    '☕ `{user}` joined. Somebody get the coffee. Caffeine-dependent members: {memberCount}.',
    '🚀 `{user}` has successfully deployed to production. Production users: {memberCount}.',
    '🎮 New challenger approaching: `{user}`. Challenger roster: {memberCount}.',
    '⚔️ `{user}` has entered the battlefield. Combatants registered: {memberCount}.',
    '🏆 `{user}` has unlocked the achievement: **Joined the Server**. Achievement holders: {memberCount}.',
    '🧿 Reality engine has registered {user}. Simulated inhabitants: {memberCount}.',
    '⚛️ Quantum state changed after {user} entered the system. Quantum entities: {memberCount}.',
    '🤖 Android registry updated: {user} has been classified as probably human. Registered beings: {memberCount}.',
    '🌐 Multiverse gateway confirms {user} is from Universe-???. Current entities: {memberCount}.',
    '🧪 Reality laboratory reports successful materialization of {user}. Materialized subjects: {memberCount}.',
    '🫡 Attention everyone: {user} has joined. Please pretend we have our lives together. Population: {memberCount}.',
    "🦆 The council has reviewed {user}'s application and has decided... sure. Council size: {memberCount}.",
    '🛸 A suspiciously normal spaceship delivered {user}. Suspicious passengers: {memberCount}.',
    '🪄 MAGIC! {user} has appeared from thin air. Magical beings present: {memberCount}.',
    '🎰 The server RNG has selected {user}. RNG participants: {memberCount}.'
];

let createCanvas;
let loadImage;

function normalizeAvatarSource(source) {
    if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
        const tempPath = path.join(os.tmpdir(), `avatar-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
        fs.writeFileSync(tempPath, Buffer.from(source));
        return tempPath;
    }

    if (typeof source === 'string' && source.startsWith('data:image/')) {
        const match = source.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/i);
        if (match) {
            const tempPath = path.join(os.tmpdir(), `avatar-${Date.now()}-${Math.random().toString(16).slice(2)}.${match[1] || 'png'}`);
            fs.writeFileSync(tempPath, Buffer.from(match[2], 'base64'));
            return tempPath;
        }
    }

    return String(source || '');
}

async function safeLoadAvatar(source, label = 'A') {
    const avatarSource = normalizeAvatarSource(source);

    try {
        return await loadImage(avatarSource);
    } catch (error) {
        if (typeof createCanvas !== 'function') {
            return null;
        }

        const fallback = createCanvas(256, 256);
        const context = fallback.getContext('2d');
        const gradient = context.createLinearGradient(0, 0, fallback.width, fallback.height);
        gradient.addColorStop(0, '#0ea5e9');
        gradient.addColorStop(1, '#7c3aed');
        context.fillStyle = gradient;
        context.fillRect(0, 0, fallback.width, fallback.height);

        context.beginPath();
        context.arc(128, 128, 92, 0, Math.PI * 2);
        context.fillStyle = 'rgba(15, 23, 42, 0.45)';
        context.fill();

        context.fillStyle = '#f8fafc';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.font = 'bold 110px sans-serif';
        context.fillText(String(label).slice(0, 1).toUpperCase(), 128, 135);

        return fallback;
    }
}

try {
    ({ createCanvas, loadImage } = require('@napi-rs/canvas'));
} catch (error) {
    // Leave fallback mode available for restricted environments; this path is only hit if the native package is unavailable.
}

async function createWelcomeCard(member) {
    if (typeof createCanvas !== 'function' || typeof loadImage !== 'function') {
        return null;
    }

    const canvas = createCanvas(1000, 500);
    const ctx = canvas.getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#050505');
    gradient.addColorStop(0.5, '#110000');
    gradient.addColorStop(1, '#050505');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(255,0,0,0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }

    const columns = Math.floor(canvas.width / 20);
    for (let i = 0; i < columns; i++) {
        const y = Math.random() * canvas.height;
        for (let j = 0; j < 20; j++) {
            ctx.fillStyle = `rgba(255, 0, 0, ${0.05 + Math.random() * 0.4})`;
            ctx.font = '18px monospace';
            ctx.fillText(Math.random() < 0.5 ? '0' : '1', i * 20, y + j * 20);
        }
    }

    ctx.font = '18px monospace';
    ctx.fillStyle = '#ff3b3b';
    ctx.textAlign = 'left';
    ['01001001', '10110110', '11001001', '00110111', '11100010', '01011101', '10010100', '01101011']
        .forEach((text, index) => ctx.fillText(text, 20, 80 + index * 55));
    ctx.textAlign = 'right';
    ['CORE://ACTIVE', 'NET://STABLE', 'GPU://READY', 'CACHE://SYNCED', 'FIREWALL://LOCKED', 'PACKETS://FLOW', 'AUTH://VERIFIED', 'LINK://SECURE']
        .forEach((text, index) => ctx.fillText(text, canvas.width - 20, 80 + index * 55));

    const memberCount = Number(member?.guild?.memberCount || 0);
    ctx.textAlign = 'center';
    ctx.shadowColor = '#00ffff';
    ctx.shadowBlur = 25;
    ctx.font = 'bold 42px sans-serif';
    ctx.fillStyle = '#00ffff';
    ctx.fillText(`MEMBER #${memberCount}`, canvas.width / 2, 58);
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`MEMBER #${memberCount}`, canvas.width / 2, 60);

    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(0,255,255,0.6)';
    ctx.lineWidth = 2;
    for (const [start, end] of [[300, 390], [610, 700]]) {
        ctx.beginPath();
        ctx.moveTo(start, 60);
        ctx.lineTo(end, 60);
        ctx.stroke();
    }

    const avatarSource = member.user?.displayAvatarURL?.({ extension: 'png', size: 512 }) ?? null;
    const avatar = await safeLoadAvatar(avatarSource, member?.user?.username || 'A');
    const cx = canvas.width / 2;
    const cy = 200;
    const radius = 100;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(avatar, cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();

    for (const [offsetX, color] of [[0, '#ff0000'], [2, 'rgba(0,255,255,0.4)'], [-2, 'rgba(255,0,255,0.4)']]) {
        ctx.beginPath();
        ctx.arc(cx + offsetX, cy, radius + 6, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 5;
        ctx.stroke();
    }

    ctx.beginPath();
    ctx.shadowColor = '#ff0000';
    ctx.shadowBlur = 25;
    ctx.font = 'bold 54px sans-serif';
    ctx.fillStyle = '#ff2d2d';
    ctx.fillText('W E L C O M E', canvas.width / 2, 385);

    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,0,0,0.7)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2 - 140, 407);
    ctx.lineTo(canvas.width / 2 + 140, 407);
    ctx.stroke();

    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 12;
    ctx.font = 'bold 38px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(member?.user?.username || 'Player').toUpperCase(), canvas.width / 2, 460);

    ctx.shadowBlur = 0;
    ctx.font = '22px sans-serif';
    ctx.fillStyle = '#9e9e9e';
    const guildName = String(member?.guild?.name || 'Server');
    ctx.fillText(guildName.toUpperCase(), canvas.width / 2, 495);

    return canvas.toBuffer('image/png');
}

async function getChannel(guild, channelId) {
    return guild.channels.cache.get(channelId) ||
        await guild.channels.fetch(channelId).catch(() => null);
}

module.exports = {
    name: Events.GuildMemberAdd,
    createWelcomeCard,
    async execute(member) {
        try {
            if (!member || !member.guild) return;

            // Live counter VCs (+1 Total / Members-or-Bots / Goal on humans).
            try { require('../systems/discord/liveCounters').scheduleRefresh(member.client); } catch {}

            try {
                await member.roles.add(UNVERIFIED_ROLE_ID);
            } catch (error) {
                console.error(`Unable to assign unverified role to new member ${member.id}: ${error.message}`);
            }

            const profileName = member.displayName ||
                member.user?.globalName ||
                member.user?.username ||
                'New member';
            const serverName = member.guild.name;
            /*
             * Cinematic multi-stage boot animation in the DM: one message is
             * edited through a terminal boot sequence (lines appear, progress
             * bar fills), then resolves into a polished welcome panel with a
             * replay button. Falls back to a static message if any edit fails
             * (rate limits, deleted DM, etc.).
             */
            const sendDmWelcome = async () => {
                const dm = await member.createDM();
                const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
                const width = 20;
                const bar = percent => {
                    const filled = Math.round(width * percent);
                    return `\`${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}\` **${Math.round(percent * 100)}%**`;
                };
                const memberTag = `**${profileName}**`;
                const memberCount = (member.guild.memberCount ?? 0).toLocaleString();

                const bootLines = [
                    '⚙️  kernel ............... ONLINE',
                    '🔐  identity handshake .. VERIFIED',
                    '🛡️  firewall ............ BYPASSED (friendly)',
                    '🧬  profile ............. SYNCHRONIZED',
                    '🌌  gateway ............. UNLOCKED'
                ];

                const stages = [
                    {
                        delay: 800,
                        build: () => `⚡ **INCOMING TRANSMISSION // ${serverName}**\n\n> \`establishing secure channel to ${profileName}...\`\n\n${bar(0.1)}`
                    },
                    {
                        delay: 900,
                        build: () => `⚡ **INCOMING TRANSMISSION // ${serverName}**\n\n> \`boot sequence initiated...\`\n\n${bootLines.slice(0, 2).join('\n')}\n\n${bar(0.4)}`
                    },
                    {
                        delay: 900,
                        build: () => `⚡ **INCOMING TRANSMISSION // ${serverName}**\n\n> \`boot sequence 62%...\`\n\n${bootLines.slice(0, 4).join('\n')}\n\n${bar(0.72)}`
                    },
                    {
                        delay: 0,
                        build: () => null // final embed handled below
                    }
 ];

                const finalBuild = () => ({
                    embeds: [new EmbedBuilder()
                        .setColor(0x00d4ff)
                        .setTitle('🚀 ACCESS GRANTED // WELCOME ABOARD')
                        .setDescription(
                            `> \`STATUS\` ......... \`🟢 ONLINE\`\n` +
                            `> \`OPERATIVE\` ...... ${memberTag}\n` +
                            `> \`NODE #\` ......... \`${memberCount}\`\n` +
                            `> \`SERVER\` ......... \`${serverName}\`\n\n` +
                            'Your connection is live. The network is yours to explore.')
                        .addFields(
                            { name: '🎯 First Missions', value: '📖 Read `/server-rules`\n✅ Complete verification\n🎮 Check `/commands-list`', inline: true },
                            { name: '💎 Start Earning', value: '🪙 `/daily` for streak rewards\n⛏️ `/mine` for ore & credits\n🎣 `/fish` the neon waters', inline: true }
                        )
                        .setFooter({ text: `${serverName} · orientation uplink v2` })
                        .setTimestamp()],
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('welcome:restart').setLabel('Replay Boot Sequence').setEmoji('🔄').setStyle(ButtonStyle.Primary)
                    )]
                });

                const message = await dm.send({ content: stages[0].build() });
                try {
                    for (const stage of stages.slice(1)) {
                        await sleep(stage.delay);
                        await message.edit({ content: stage.build() });
                    }
                    await sleep(900);
                    await message.edit(finalBuild());
                } catch (error) {
                    // Rate limit or DM hiccup mid-animation — land on the final panel.
                    await message.edit(finalBuild()).catch(() => {});
                }

                const runAnimation = async () => {
                    for (const stage of stages.slice(0, 3)) {
                        await message.edit({ content: stage.build() }).catch(() => {});
                        await sleep(stage.delay || 800);
                    }
                    await message.edit(finalBuild()).catch(() => {});
                };
                const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 15 * 60 * 1000 });
                collector.on('collect', async button => {
                    if (button.user.id !== member.id) return button.reply({ content: 'This welcome show belongs to the new member.' });
                    await button.deferUpdate();
                    await runAnimation();
                });
            };
            try {
                await sendDmWelcome();
            } catch (error) {
                console.warn(`Welcome DM could not be sent to ${member.id}:`, error.message);
            }

            const cardChannel = await getChannel(member.guild, WELCOME_CARD_CHANNEL_ID);
            if (!cardChannel) {
                console.warn(`Welcome card skipped: channel ${WELCOME_CARD_CHANNEL_ID} was not found.`);
                return;
            }

            const cardBuffer = await createWelcomeCard(member);
            if (cardBuffer) {
                const sent = await cardChannel.send({
                    content: `⚡ Welcome **${profileName}** to **${serverName}**!`,
                    files: [{ attachment: cardBuffer, name: 'welcome.png' }]
                });
                for (const emoji of ['👋', '👍', '🔥', '🎉']) {
                    await sent.react(emoji);
                }

            } else {
                await cardChannel.send({
                    content: `⚡ Welcome **${profileName}** to **${serverName}**!`
                });
            }

            const selectedMessage = WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)]
                .replaceAll('{user}', profileName)
                .replaceAll('{memberCount}', member.guild.memberCount.toLocaleString())
                .replaceAll('{server}', serverName);
            const welcomeMessage = `${selectedMessage}\n🏠 Server: **${serverName}**`;
            for (const channelId of WELCOME_MESSAGE_CHANNEL_IDS) {
                const channel = await getChannel(member.guild, channelId);
                if (!channel) {
                    console.warn(`Welcome message skipped: channel ${channelId} was not found.`);
                    continue;
                }
                await channel.send(welcomeMessage);
            }
        } catch (error) {
            console.error('Welcome card error:', error);
        }
    }
};
