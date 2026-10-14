/*
 * Live server counters — voice channels renamed to reflect server size.
 *
 *   1549223175903252523 → 〘Total Users: N〙     (everyone: humans + bots)
 *   1549222233514446900 → 〘All Members: N〙    (humans only)
 *   1549222581737881620 → 〘All Bots: N〙       (bots/applications only)
 *   1554188177328054322 → 〘Goal: N/100〙       (humans only, toward 100)
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
 * Owners pad the channel names with "_" and spaces for alignment. Discord
 * SANITIZES the stored name (trailing spaces trimmed etc.), so comparing the
 * freshly built name against what the API reports back never matches — that
 * mismatch used to trigger a pointless rename on every member leave (and
 * wiped the padding cuts). Normalize BOTH sides to alphanumerics before
 * comparing: if the visible content is already correct, never rename.
 */
function normalizedName(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9/]/g, '');
}

function currentNameMatches(current, built) {
    if (!current) return false;
    return normalizedName(current) === normalizedName(built);
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const lastNames = new Map(); // channelId -> last name we wrote (raw)

function humanCount(guild) {
    return guild.members.cache.filter(member => !member.user.bot).size;
}

function botCount(guild) {
    return guild.members.cache.filter(member => member.user.bot).size;
}

async function renameCounter(guild, counter, count) {
    const name = counter.build(count);
    if (lastNames.get(counter.channelId) === name) return;

    const channel = guild.channels.cache.get(counter.channelId) ||
        await guild.channels.fetch(counter.channelId).catch(() => null);
    if (!channel || !channel.setName) return;

    //ickname: Owner's "_" padding may make the stored name differ cosmetically;
    // only actually rename when the DATA (digits) changed.
    if (currentNameMatches(channel.name, name)) {
        lastNames.set(counter.channelId, channel.name);
        return;
    }

    try {
        await channel.setName(name, 'Live member counter');
        lastNames.set(counter.channelId, name);
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

module.exports = { startLiveCounters, refreshCounters, scheduleRefresh, COUNTERS };
