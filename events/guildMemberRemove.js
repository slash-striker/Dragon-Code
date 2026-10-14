const { Events, AuditLogEvent, EmbedBuilder } = require('discord.js');

// Departure telemetry is mirrored to both channels — the mod log and the
// public departure feed. Each send is independent so one dead channel
// can never suppress the other.
const DEPARTURE_CHANNEL_IDS = [
    '1504365033637806134', // moderation log
    '1504365034216624192'  // departure feed
];

async function getChannel(guild, channelId) {
    return guild.channels.cache.get(channelId) ||
        await guild.channels.fetch(channelId).catch(() => null);
}

async function getRecentAuditEntry(guild, type, memberId) {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    return logs.entries.find(entry =>
        entry.target?.id === memberId &&
        Date.now() - entry.createdTimestamp < 15_000
    );
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return 'unknown';
    const minutes = Math.floor(ms / 60_000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

/*
 * Futuristic terminal readout for the embed description. Deliberately contains
 * no mentions/timestamps — those never render inside code blocks — the live
 * ones go in the fields below the panel.
 */
function buildTracePanel({ kind, sessionLine, accountLine, nodesLeft }) {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const rows = [
        `> ${stamp} :: node telemetry`,
        `> tracing socket ............ CLOSED`,
        `> identity record ........... ${kind === 'ban' ? 'BLACKLISTED' : kind === 'kick' ? 'REVOKED' : 'ARCHIVED'}`,
        `> session duration .......... ${sessionLine}`,
        `> account age ............... ${accountLine}`,
        `> remaining nodes ........... ${nodesLeft}`,
        `> gateway ................... SECURE`
    ];
    return ['```', ...rows, '```'].join('\n');
}

/*
 * Prefixes for the PLAIN cyber-punk text sent to the public departure
 * feed (no embed there — the fancy embed only goes to the mod log).
 */
const FEED_PREFIX = {
    leave: '📡 NODE LOST',
    kick: '👢 ACCESS REVOKED',
    ban: '⛔ NODE BLACKLISTED'
};

const KINDS = {
    leave: { emoji: '📡', color: 0x00d4ff, title: 'CONNECTION TERMINATED // NODE LOST', tag: 'LEFT' },
    kick: { emoji: '👢', color: 0xffa000, title: 'ACCESS REVOKED // MEMBER KICKED', tag: 'KICKED' },
    ban: { emoji: '⛔', color: 0xed4245, title: 'NODE BLACKLISTED // MEMBER BANNED', tag: 'BANNED' }
};

module.exports = {
    name: Events.GuildMemberRemove,
    async execute(member) {
        try {
            if (!member?.guild) return;

            // Live counter VCs recompute after the departure lands.
            try { require('../systems/discord/liveCounters').scheduleRefresh(member.client); } catch {}

            const username = member.user?.tag || member.user?.username || 'A member';
            const profileName = member.displayName || member.user?.globalName || member.user?.username || 'Unknown';
            const serverName = member.guild.name;

            const kickEntry = await getRecentAuditEntry(member.guild, AuditLogEvent.MemberKick, member.id)
                .catch(() => null);
            const banEntry = await getRecentAuditEntry(member.guild, AuditLogEvent.MemberBanAdd, member.id)
                .catch(() => null);
            const kind = banEntry ? 'ban' : kickEntry ? 'kick' : 'leave';
            const cfg = KINDS[kind];
            const entry = banEntry || kickEntry;

            const sessionLine = formatDuration(member.joinedTimestamp ? Date.now() - member.joinedTimestamp : NaN);
            const accountLine = formatDuration(member.user?.createdTimestamp ? Date.now() - member.user.createdTimestamp : NaN);
            const nodesLeft = (member.guild.memberCount ?? 0).toLocaleString();

            const embed = new EmbedBuilder()
                .setColor(cfg.color)
                .setTitle(`${cfg.emoji} ${cfg.title}`)
                .setDescription(buildTracePanel({ kind, sessionLine, accountLine, nodesLeft }))
                .setThumbnail(member.user?.displayAvatarURL({ extension: 'png', size: 128 }) || null)
                .addFields(
                    { name: '🧬 Node', value: `<@${member.id}>\n\`${username}\``, inline: true },
                    { name: '🆔 Socket ID', value: `\`${member.id}\``, inline: true },
                    { name: '🛰️ Server', value: serverName, inline: true }
                );

            if (entry) {
                embed.addFields(
                    { name: '⚔️ Operative', value: entry.executor ? `${entry.executor.tag}\n<@${entry.executor.id}>` : 'Unknown', inline: true },
                    { name: '📜 Reason', value: (entry.reason || 'No reason provided').slice(0, 1024), inline: false }
                );
            }

            embed.setFooter({ text: `SLASH's YT Server · node telemetry · ${cfg.tag}` })
                .setTimestamp();

            // Plain cyber-punk line for the public departure feed.
            const feedLine = [
                `${FEED_PREFIX[kind]} :: <@${member.id}>`,
                `\`${username}\` · session ${sessionLine} · ${nodesLeft} nodes online`,
                entry?.reason ? `> reason: ${String(entry.reason).slice(0, 200)}` : null
            ].filter(Boolean).join('\n');

            // Fan out — the mod log gets the full telemetry embed, the
            // public feed gets a simple one-line cyber-punk message.
            let delivered = 0;
            for (const channelId of DEPARTURE_CHANNEL_IDS) {
                const channel = await getChannel(member.guild, channelId);
                if (!channel) {
                    console.warn(`Departure log skipped for ${channelId}: channel not found.`);
                    continue;
                }
                const isFeed = channelId === '1504365034216624192';
                const payload = isFeed ? { content: feedLine } : { embeds: [embed] };
                await channel.send(payload)
                    .then(() => { delivered++; })
                    .catch(error => console.error(`Departure log failed for ${channelId}:`, error));
            }
            if (delivered === 0) {
                console.warn('Departure log: no channel accepted the message.');
            }
        } catch (error) {
            console.error('Leave message error:', error);
        }
    }
};
