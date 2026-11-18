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

const KINDS = {
    leave: {
        emoji: '📡', color: 0x00d4ff, title: 'CONNECTION TERMINATED // NODE LOST', tag: 'LEFT',
        feedTitle: 'Member Left', feedVerb: 'left the server'
    },
    kick: {
        emoji: '👢', color: 0xffa000, title: 'ACCESS REVOKED // MEMBER KICKED', tag: 'KICKED',
        feedTitle: 'Member Kicked', feedVerb: 'was kicked from the server'
    },
    ban: {
        emoji: '⛔', color: 0xed4245, title: 'NODE BLACKLISTED // MEMBER BANNED', tag: 'BANNED',
        feedTitle: 'Member Banned', feedVerb: 'was banned from the server'
    }
};

/*
 * Public departure feed — a clean, readable embed (no terminal panel, no
 * code blocks): who left, how long they stayed, the live member count and,
 * for removals, who did it and why.
 */
function buildFeedEmbed({ member, cfg, username, profileName, sessionLine, nodesLeft, entry }) {
    const embed = new EmbedBuilder()
        .setColor(cfg.color)
        .setAuthor({
            name: `${cfg.feedTitle} — ${profileName}`,
            iconURL: member.user?.displayAvatarURL({ extension: 'png', size: 128 }) || undefined
        })
        .setDescription(`${cfg.emoji} **${profileName}** \u0060${username}\u0060 ${cfg.feedVerb}.`)
        .addFields(
            { name: '⏱️ Stayed', value: sessionLine, inline: true },
            { name: '👥 Members now', value: nodesLeft, inline: true }
        );

    if (entry?.executor) {
        embed.addFields({ name: '🛡️ Action by', value: `${entry.executor.tag}\n<@${entry.executor.id}>`, inline: true });
    }
    if (entry?.reason) {
        embed.addFields({ name: '📄 Reason', value: String(entry.reason).slice(0, 1024), inline: false });
    }

    return embed
        .setFooter({ text: `${member.guild.name} · departure feed` })
        .setTimestamp();
}

module.exports = {
    name: Events.GuildMemberRemove,
    buildFeedEmbed,
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

            // The public feed gets its own, cleaner embed: no code-block
            // telemetry, just readable lines anyone can scan at a glance.
            const feedEmbed = buildFeedEmbed({
                member, cfg, username, profileName, sessionLine, nodesLeft, entry
            });

            let delivered = 0;
            for (const channelId of DEPARTURE_CHANNEL_IDS) {
                const channel = await getChannel(member.guild, channelId);
                if (!channel) {
                    console.warn(`Departure log skipped for ${channelId}: channel not found.`);
                    continue;
                }
                const isFeed = channelId === '1504365034216624192';
                const payload = { embeds: [isFeed ? feedEmbed : embed] };
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
