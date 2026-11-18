/*
 * Live server counters — voice channels renamed to reflect server size.
 *
 *   1549223175903252523 → 〘Total Users: N〙     (everyone: humans + bots)
 *   1549222233514446900 → 〘All Members: N〙    (humans only)
 *   1549222581737881620 → 〘All Bots: N〙       (bots/applications only)
 *   1554188177328054322 → 〘Goal: N/100〙       (humans only, toward 100)
 *
 * ONLY THE NUMBER MOVES. The owner decorates the names by hand
 * (〘___ Boosts: 0 ___〙) and the old code rebuilt the whole name from a
 * template on every join/leave, wiping the 〘〙, the "___" padding and any
 * other wording. Now the new name is derived FROM the channel's current name
 * by swapping its first run of digits, so the decoration never changes.
 *
 * `guild.memberCount` is the authoritative total. The member cache is only a
 * PARTIAL roster (Discord does not ship the full member list unless chunks
 * were requested), so counting humans with a cache filter undershot — with
 * 37 real members the counter sometimes showed 20-ish. Instead: bots are
 * counted from the cache (bots always make it into chunks/presences) and
 * humans are derived as `memberCount − bots`. Renames are debounced
 * per channel (only when the name actually changed) so Discord's 2-request
 * per-10-minutes channel-edit limit can never be tripped.
 */

const COUNTERS = [
    { channelId: '1549223175903252523', kind: 'total', build: n => `〘Total Users: ${n}〙` },
    { channelId: '1549222233514446900', kind: 'humans', build: n => `〘All Members: ${n}〙` },
    { channelId: '1549222581737881620', kind: 'bots', build: n => `〘All Bots: ${n}〙` },
    { channelId: '1554188177328054322', kind: 'humans', build: n => `〘Goal: ${n}/100〙` }
];

/*
 * Swap the counter's value inside an existing name, keeping everything else
 * byte-for-byte:
 *   〘___ Boosts: 0 ___〙  → 〘___ Boosts: 12 ___〙
 *   〘Goal: 37/100〙       → 〘Goal: 41/100〙   (only the FIRST number moves)
 * A name with no digits gets one slotted in before the closing 〙 so the
 * decoration still survives.
 */
function withCount(name, count) {
    const text = String(name ?? '');
    const match = /\d+/.exec(text);
    if (!match) {
        // No number yet: slot one in before the closing decoration.
        const tail = /([\s_]*〙)\s*$/.exec(text);
        if (tail) {
            return `${text.slice(0, tail.index).replace(/\s+$/, '')} ${count}${tail[1]}`;
        }
        return `${text} ${count}`.trim();
    }
    return text.slice(0, match.index) + String(count) + text.slice(match.index + match[0].length);
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function humanCount(guild) {
    return guild.members.cache.filter(member => !member.user.bot).size;
}

function botCount(guild) {
    return guild.members.cache.filter(member => member.user.bot).size;
}

async function renameCounter(guild, counter, count) {
    const channel = guild.channels.cache.get(counter.channelId) ||
        await guild.channels.fetch(counter.channelId).catch(() => null);
    if (!channel || !channel.setName) return;

    /*
     * Derive the target from the channel's CURRENT name (never from the
     * template) so the owner's decoration is preserved, and skip the edit
     * entirely when the digits are already right — that keeps us far away
     * from Discord's 2-renames-per-10-minutes channel limit.
     */
    const target = withCount(channel.name ?? counter.build(count), count);
    if (target === channel.name) return;

    try {
        await channel.setName(target, 'Live member counter');
    } catch (error) {
        // Rate limit / missing perms — the next tick retries.
        console.warn(`Counter rename failed for ${counter.channelId}: ${error.message}`);
    }
}

/** Recompute every counter. Humans = memberCount − bots (cache-proof). */
async function refreshCounters(client) {
    const guild = client.guilds.cache.get('1504365030877954158');
    if (!guild) return;

    // Top up the roster in the background so the bot tally is exact on the
    // next pass; humans are already correct without it.
    if (guild.members.cache.size < guild.memberCount) {
        guild.members.fetch().catch(() => {});
    }

    const bots = botCount(guild);
    const total = guild.memberCount || (humanCount(guild) + bots);
    const humans = Math.max(0, total - bots);
    const byKind = { humans, bots, total };

    for (const counter of COUNTERS) {
        await renameCounter(guild, counter, byKind[counter.kind]);
    }
}

function startLiveCounters(client) {
    refreshCounters(client).catch(() => {});
    setInterval(() => refreshCounters(client).catch(() => {}), REFRESH_INTERVAL_MS);
}

/*
 * Join/leave bursts (raids, bot sweeps) collapse into one refresh: the first
 * event schedules a refresh 10s out, later events inside that window are
 * free. The 5-minute ticker is the safety net either way.
 */
let pendingRefresh = null;

function scheduleRefresh(client, delayMs = 10 * 1000) {
    if (pendingRefresh) return;
    pendingRefresh = setTimeout(() => {
        pendingRefresh = null;
        refreshCounters(client).catch(() => {});
    }, delayMs);
}

module.exports = { startLiveCounters, refreshCounters, scheduleRefresh, COUNTERS, withCount };
