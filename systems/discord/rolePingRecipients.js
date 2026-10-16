async function buildRoleRecipientPings(guild, roleIds, excludedUserId, limit = 70, isAsleep = null) {
    if (guild?.members?.fetch) {
        try {
            await guild.members.fetch();
        } catch (error) {
            console.warn('Could not fetch role-ping recipients:', error.message);
        }
    }
    if (!guild?.members?.cache) {
        return {
            content: 'Eligible role members could not be loaded; no ping was sent.',
            allowedMentions: { parse: [], users: [] },
            recipientIds: []
        };
    }
    const recipientIds = new Set();
    for (const roleId of roleIds || []) {
        const role = guild?.roles?.cache?.get(String(roleId));
        for (const [userId] of role?.members || []) {
            if (userId === excludedUserId) continue;
            // Members inside their own sleep window are never pinged.
            if (isAsleep && isAsleep(userId)) continue;
            recipientIds.add(userId);
        }
    }

    const all = [...recipientIds].sort();
    const selected = all.slice(0, limit);
    const overflow = all.length - selected.length;
    const mentions = selected.map(userId => `<@${userId}>`).join(' ');
    const content = [mentions, overflow > 0 ? `(+${overflow} more eligible members were not pinged; safety limit ${limit})` : '']
        .filter(Boolean)
        .join(' ')
        .slice(0, 2000);

    return {
        content: content || 'No other members with the selected role are available to notify.',
        allowedMentions: { parse: [], users: selected },
        recipientIds: selected
    };
}

module.exports = { buildRoleRecipientPings };
