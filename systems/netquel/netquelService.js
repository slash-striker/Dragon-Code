/*
 * Netquel leaderboard tracker.
 *
 * Refreshes the FFA/Forge boards on a timer, keeps the newest snapshot in
 * memory for the commands, edits the two public board channels in place, and
 * watches the enemy list: a tracked name on a live server board pings the
 * Owner role, while a hit on a day/week/all-time table posts without a ping.
 *
 * Boards come from two places:
 *   - the site's three tables per mode (day/week/all),
 *   - the in-game top-right table per server (Cloud/2, Cloud/3, …), collected
 *     by pressing Play and flying right into the wall to hop servers.
 *
 * The scrape renders netquel.com in a headless browser. The day/week/all
 * tables cost seconds, so they refresh on their own fast timer; the in-game
 * server sweep costs minutes (a match join and two wall hops per mode) and
 * keeps the slow timer. Both merge into one snapshot, so a single board
 * message carries both. Browser work is serialised — two software-rendered
 * clients starve each other — and a manual /reload joins the queue instead of
 * opening a second browser.
 *
 * Alerts are deduplicated per enemy + board for ALERT_COOLDOWN_MS, so a name
 * that stays on the board does not spam every refresh. Only a per-server board
 * — which exists solely inside a live match — pings the role. The site's
 * day/week/all tables keep a name for hours after it logs off, so those post a
 * quiet "was on the board" notice instead.
 */

const { EmbedBuilder } = require('discord.js');
const source = require('./netquelSource');
const store = require('./netquelStore');
const {
    PERIODS,
    MODES,
    boardIdentity,
    boardLabel,
    findEnemyHits,
    fitLines,
    formatScore,
    matchesServer,
    mergeBoardGroup,
    nameMatches,
    newestFetchedAt,
    periodLabel,
    relativeStamp
} = require('./netquelLogic');

// Only this role (and the bot owner) may see or use the Netquel commands.
const STAFF_ROLE_ID = '1504365030877954162';
const BOT_OWNER_ID = '1466461677783351447';

/*
 * Where the auto-refreshing boards are posted. One message per mode, edited on
 * every refresh so the channels stay readable instead of filling with posts.
 */
const BOARD_CHANNELS = {
    FFA: process.env.NETQUEL_FFA_CHANNEL_ID || '1572462227598876753',
    Forge: process.env.NETQUEL_FORGE_CHANNEL_ID || '1572462538237673583'
};

/* Site tables: seconds to scrape, so they refresh every couple of minutes. */
const SITE_REFRESH_MINUTES = Number(process.env.NETQUEL_SITE_REFRESH_MINUTES) > 0
    ? Number(process.env.NETQUEL_SITE_REFRESH_MINUTES)
    : 2;
/* In-game server sweep: minutes of hops, so it keeps the slow timer. */
const SERVER_REFRESH_MINUTES = Number(process.env.NETQUEL_REFRESH_MINUTES) > 0
    ? Number(process.env.NETQUEL_REFRESH_MINUTES)
    : 10;
const RETRY_MINUTES = 2;
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 15_000;
/* Discord's limits, minus a little headroom for the extra notice lines. */
const DESC_LIMIT = 4000;
const FIELD_LIMIT = 1000;

const COLOR = 0x6c5ce7;

let snapshot = null;
let inFlight = null;
let siteInFlight = null;
let serverInFlight = null;
let siteTimer = null;
let serverTimer = null;
let clientRef = null;

/*
 * Every scrape shares one browser queue: Netquel runs a software-rendered
 * client, and two at once starve each other badly enough that the server
 * sweep's wall approach misses hops.
 */
let browserQueue = Promise.resolve();

function isNetquelStaff(interaction) {
    if (interaction.user?.id === BOT_OWNER_ID) return true;
    return Boolean(interaction.member?.roles?.cache?.has(STAFF_ROLE_ID));
}

function getSnapshot() {
    return snapshot;
}

/*
 * When the snapshot was taken, as Discord's own timestamp markup, so every
 * client shows it in their own timezone ("Scraped 6 minutes ago") and the
 * text updates itself instead of freezing the age at post time.
 */
function snapshotStamp(fetchedAt = snapshot?.fetchedAt) {
    return relativeStamp(fetchedAt);
}

function snapshotClock(fetchedAt = snapshot?.fetchedAt) {
    if (!fetchedAt) return 'never';
    return `<t:${Math.floor(fetchedAt / 1000)}:f>`;
}

function isRefreshing() {
    return Boolean(inFlight || siteInFlight || serverInFlight);
}

function boardFromSnapshot(mode, period) {
    return snapshot?.boards?.find(board => board.mode === mode && board.period === period) ?? null;
}

function serverBoardsFor(mode) {
    return (snapshot?.boards ?? []).filter(board => board.mode === mode && board.server);
}

/* The one message shape each board channel gets (3 site boards + servers). */
function modePayload(mode) {
    return {
        embeds: [
            boardEmbed(mode, 'day'),
            boardEmbed(mode, 'week'),
            boardEmbed(mode, 'all'),
            serverBoardEmbed(mode)
        ]
    };
}

function emptyBoard(mode, period) {
    return new EmbedBuilder()
        .setColor(0xff7675)
        .setTitle(`🛰️ ${mode} · ${periodLabel(period)} leaderboard`)
        .setDescription('No snapshot yet — the first scrape may still be running. Try `/reload`.')
        .setFooter({ text: 'Netquel tracker' });
}

function boardEmbed(mode, period) {
    const board = boardFromSnapshot(mode, period);
    if (!board) return emptyBoard(mode, period);

    const enemies = store.listEnemies();
    const lines = fitLines(board.rows, DESC_LIMIT, row => {
        const enemy = enemies.some(entry => nameMatches(entry.displayName, row.name));
        return `**${row.rank}.** ${row.name} — ${formatScore(row.score)}${enemy ? ' 🔴' : ''}`;
    });

    /*
     * Discord does not parse <t:…> in footers — it prints the markup — so the
     * "Updated …" line lives in the description, above the rows.
     */
    return new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`🛰️ ${mode} · ${periodLabel(period)} leaderboard`)
        .setDescription([
            `**Updated ${relativeStamp(board.fetchedAt)}**`,
            lines.join('\n') || '_The board is empty right now._'
        ].join('\n'))
        .setFooter({ text: '🔴 = tracked enemy' });
}

function serverBoardEmbed(mode) {
    const boards = serverBoardsFor(mode);
    if (!boards.length) {
        return new EmbedBuilder()
            .setColor(0xff7675)
            .setTitle(`🛰️ ${mode} · per-server boards`)
            .setDescription(
                'No server board in the snapshot — the tracker has to start a match and hop '
                + 'servers for these, so the first refresh can miss them. Try `/reload`.'
            )
            .setFooter({ text: 'Netquel tracker' });
    }

    const enemies = store.listEnemies();
    const fields = boards.map(board => {
        const lines = fitLines(board.rows, FIELD_LIMIT, row => {
            const enemy = enemies.some(entry => nameMatches(entry.displayName, row.name));
            return `**${row.rank}.** ${row.name} — ${formatScore(row.score)}${enemy ? ' 🔴' : ''}`;
        });
        return {
            name: `${board.server} — ${board.rows.length} player${board.rows.length === 1 ? '' : 's'}`,
            value: lines.join('\n') || '_Empty right now._',
            inline: false
        };
    });

    const updated = newestFetchedAt(boards);

    return new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`🛰️ ${mode} · per-server leaderboards`)
        .setDescription([
            `**Updated ${relativeStamp(updated)}** — server sweep every ${SERVER_REFRESH_MINUTES} min`,
            'Live top-right board in each server (hops through every server).'
        ].join('\n'))
        .addFields(fields)
        .setFooter({ text: '🔴 = tracked enemy' });
}

function serverBoardEmbedFor(mode, server) {
    const board = serverBoardsFor(mode).find(entry => matchesServer(entry, server));
    if (!board) return null;

    const enemies = store.listEnemies();
    const lines = fitLines(board.rows, DESC_LIMIT, row => {
        const enemy = enemies.some(entry => nameMatches(entry.displayName, row.name));
        return `**${row.rank}.** ${row.name} — ${formatScore(row.score)}${enemy ? ' 🔴' : ''}`;
    });

    return new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`🛰️ ${mode} · ${board.server} leaderboard`)
        .setDescription([
            `**Updated ${relativeStamp(board.fetchedAt)}**`,
            lines.join('\n') || '_The board is empty right now._'
        ].join('\n'))
        .setFooter({ text: '🔴 = tracked enemy' });
}

/* Post the boards once, then edit that message on every refresh. */
async function publishBoards(modes = MODES) {
    if (!clientRef) return 0;

    let updated = 0;
    for (const mode of modes) {
        const channelId = BOARD_CHANNELS[mode];
        if (!channelId) continue;

        const channel = await clientRef.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) {
            console.warn(`Netquel ${mode} board channel ${channelId} is missing or not text-based.`);
            continue;
        }

        const payload = modePayload(mode);
        const saved = store.getBoardMessage(mode);
        let existing = null;
        if (saved?.messageId && saved.channelId === channelId) {
            existing = await channel.messages.fetch(saved.messageId).catch(() => null);
        }

        if (existing) {
            const edited = await existing.edit(payload).catch(error => {
                console.warn(`Netquel ${mode} board edit failed:`, error.message);
                return null;
            });
            if (edited) updated += 1;
            continue;
        }

        const posted = await channel.send(payload).catch(error => {
            console.warn(`Netquel ${mode} board post failed:`, error.message);
            return null;
        });
        if (!posted) continue;
        store.setBoardMessage(mode, channelId, posted.id);
        updated += 1;
    }
    return updated;
}

/*
 * Alerts are split by what the board proves. A per-server board only exists
 * inside a live match, so that is a sighting and pings the role. The site's
 * day/week/all tables keep names long after they log off, so those post a
 * "was there" notice with no mention.
 */
async function sendAlerts(hits) {
    if (!clientRef || !hits.length) return 0;

    const groups = new Map();
    for (const hit of hits) {
        const enemy = store.getEnemy(hit.name);
        if (!enemy?.channelId) continue;
        if (!store.shouldAlert(hit.name, hit.board, ALERT_COOLDOWN_MS)) continue;

        const live = Boolean(hit.server);
        const key = `${enemy.channelId}|${live ? 'live' : 'historic'}`;
        if (!groups.has(key)) groups.set(key, { channelId: enemy.channelId, live, hits: [] });
        groups.get(key).hits.push(hit);
    }

    let sent = 0;
    for (const { channelId, live, hits: groupHits } of groups.values()) {
        const channel = await clientRef.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) continue;

        const lines = groupHits.map(hit => live
            ? `**${hit.displayName}** — ${hit.label} · rank **#${hit.rank}** · ${formatScore(hit.score)} pts`
            : `**${hit.displayName}** — was on **${hit.label}** · rank **#${hit.rank}** · ${formatScore(hit.score)} pts`);

        const embed = new EmbedBuilder()
            .setColor(live ? COLOR : 0x95a5a6)
            .setTitle(live ? '🎯 ENEMY SIGHTED ON NETQUEL' : '🕘 ENEMY WAS ON NETQUEL')
            .setDescription([
                live ? null : 'From the day/week/all-time boards — the name was there, but the player may not be online now.',
                lines.join('\n'),
                `Detected ${snapshotStamp()}`
            ].filter(Boolean).join('\n\n').slice(0, 4000))
            .setFooter({ text: live ? 'Netquel tracker' : 'Historic board · no ping' });

        const payload = { embeds: [embed] };
        if (live) payload.content = `<@&${STAFF_ROLE_ID}>`;

        const message = await channel.send(payload).catch(error => {
            console.warn(`Netquel alert failed in ${channelId}:`, error.message);
            return null;
        });
        if (!message) continue;

        sent += 1;
        for (const hit of groupHits) store.recordAlert(hit.name, hit.board);
    }
    return sent;
}

async function checkEnemies() {
    const enemies = store.listEnemies();
    if (!enemies.length || !snapshot?.boards?.length) return 0;
    const hits = findEnemyHits(enemies, snapshot.boards);
    return sendAlerts(hits);
}

/* ----------------------------- snapshot merge ----------------------------- */

/*
 * Replace only the board groups a scrape actually produced. A mode that
 * failed, or the server sweep still running while the site tables refresh,
 * must never blank rows it did not touch.
 */
function mergeIncoming(incoming, { server }) {
    let boards = snapshot?.boards ?? [];
    for (const mode of new Set(incoming.map(board => board.mode))) {
        boards = mergeBoardGroup(
            boards,
            incoming.filter(board => board.mode === mode),
            { mode, server }
        );
    }
    snapshot = { boards, fetchedAt: Date.now(), errors: snapshot?.errors ?? [] };
}

/* One browser queue; two Netquel clients at once starve each other. */
function enqueueBrowserTask(task) {
    const run = browserQueue.then(task, task);
    browserQueue = run.then(() => {}, () => {});
    return run;
}

function boardCounts(boards) {
    const site = boards.filter(board => !board.server).length;
    return `${site} site + ${boards.length - site} server boards`;
}

/*
 * Fast pass: the site's day/week/all tables only. This is the timer that keeps
 * the board message current — seconds, not minutes — and it also runs the
 * enemy check, so a name that shows up on the daily board pings quickly.
 */
function refreshSite() {
    if (siteInFlight) return siteInFlight;

    siteInFlight = enqueueBrowserTask(async () => {
        try {
            const data = await source.scrapeSiteBoards();
            const changed = [...new Set(data.boards.map(board => board.mode))];

            mergeIncoming(data.boards, { server: false });

            const published = await publishBoards(changed).catch(error => {
                console.warn('Netquel site board publish failed:', error.message);
                return 0;
            });
            const alerts = await checkEnemies().catch(error => {
                console.warn('Netquel enemy check failed:', error.message);
                return 0;
            });

            for (const warning of data.errors ?? []) {
                console.warn(`Netquel site partial refresh — ${warning}`);
            }
            console.log(
                `🛰️ Netquel site boards refreshed in ${((data.durationMs ?? 0) / 1000).toFixed(0)}s `
                + `(${boardCounts(data.boards)}; ${published} channel(s) updated, ${alerts} alert(s)).`
            );
            return { ok: true, snapshot, alerts, published };
        } catch (error) {
            if (snapshot) snapshot.error = error.message;
            console.warn('Netquel site board refresh failed:', error.message);
            return { ok: false, error };
        }
    }).finally(() => { siteInFlight = null; });

    return siteInFlight;
}

/*
 * Slow pass: the per-server boards, which only exist inside a live match and
 * cost a match join plus two wall hops per mode. It edits the same board
 * message as the fast pass.
 */
function refreshServers() {
    if (serverInFlight) return serverInFlight;

    serverInFlight = enqueueBrowserTask(async () => {
        try {
            const data = await source.scrapeServerBoards();
            const changed = [...new Set(data.boards.map(board => board.mode))];

            mergeIncoming(data.boards, { server: true });

            const published = await publishBoards(changed).catch(error => {
                console.warn('Netquel server board publish failed:', error.message);
                return 0;
            });
            const alerts = await checkEnemies().catch(error => {
                console.warn('Netquel enemy check failed:', error.message);
                return 0;
            });

            const servers = MODES
                .map(mode => {
                    const names = data.boards
                        .filter(board => board.mode === mode && board.server)
                        .map(board => board.server);
                    return `${mode}: ${names.length ? names.join(', ') : 'none'}`;
                })
                .join(' | ');
            for (const warning of data.errors ?? []) {
                console.warn(`Netquel server partial refresh — ${warning}`);
            }
            console.log(
                `🛰️ Netquel server boards refreshed in ${((data.durationMs ?? 0) / 1000).toFixed(0)}s `
                + `(${boardCounts(data.boards)} — ${servers}; `
                + `${published} channel(s) updated, ${alerts} alert(s)).`
            );
            return { ok: true, snapshot, alerts, published };
        } catch (error) {
            if (snapshot) snapshot.error = error.message;
            console.warn('Netquel server board refresh failed:', error.message);
            return { ok: false, error };
        }
    }).finally(() => { serverInFlight = null; });

    return serverInFlight;
}

/*
 * Manual /reload: one browser pass that reads both the site tables and the
 * per-server boards, merged into the same snapshot. Concurrent callers share
 * the promise, so a second /reload rides along instead of opening a browser.
 */
function refresh() {
    if (inFlight) return inFlight;

    inFlight = enqueueBrowserTask(async () => {
        try {
            const data = await source.scrapeBoards();

            mergeIncoming(data.boards.filter(board => !board.server), { server: false });
            mergeIncoming(data.boards.filter(board => board.server), { server: true });
            if (snapshot) snapshot.errors = data.errors ?? [];

            const published = await publishBoards().catch(error => {
                console.warn('Netquel board publish failed:', error.message);
                return 0;
            });
            const alerts = await checkEnemies().catch(error => {
                console.warn('Netquel enemy check failed:', error.message);
                return 0;
            });

            for (const warning of data.errors ?? []) {
                console.warn(`Netquel partial refresh — ${warning}`);
            }
            console.log(
                `🛰️ Netquel boards refreshed in ${((data.durationMs ?? 0) / 1000).toFixed(0)}s `
                + `(${boardCounts(data.boards)}; ${published} channel(s) updated, ${alerts} alert(s)).`
            );
            return { ok: true, snapshot, alerts, published };
        } catch (error) {
            if (snapshot) snapshot.error = error.message;
            console.warn('Netquel board refresh failed:', error.message);
            return { ok: false, error };
        }
    }).finally(() => { inFlight = null; });

    return inFlight;
}

/*
 * Each pass owns a recursive timeout rather than an interval: a slow sweep
 * pushes the next tick out instead of stacking queued scrapes behind it.
 * Both keep running even while the other one holds the browser queue.
 */
function scheduleSite(delayMs) {
    if (siteTimer) clearTimeout(siteTimer);
    siteTimer = setTimeout(async () => {
        const result = await refreshSite();
        scheduleSite(result.ok ? SITE_REFRESH_MINUTES * 60_000 : RETRY_MINUTES * 60_000);
    }, delayMs);
    if (typeof siteTimer.unref === 'function') siteTimer.unref();
}

function scheduleServers(delayMs) {
    if (serverTimer) clearTimeout(serverTimer);
    serverTimer = setTimeout(async () => {
        const result = await refreshServers();
        scheduleServers(result.ok ? SERVER_REFRESH_MINUTES * 60_000 : RETRY_MINUTES * 60_000);
    }, delayMs);
    if (typeof serverTimer.unref === 'function') serverTimer.unref();
}

function startNetquelTracker(client) {
    clientRef = client;
    // Site tables first: the board message exists within seconds, and the
    // slower server sweep fills its per-server embed when it lands.
    scheduleSite(5_000);
    scheduleServers(BOOT_DELAY_MS);
    console.log(
        `🛰️ Netquel tracker armed — site tables every ${SITE_REFRESH_MINUTES} minute(s), `
        + `server sweep every ${SERVER_REFRESH_MINUTES} minute(s).`
    );
}

function stopNetquelTracker() {
    if (siteTimer) clearTimeout(siteTimer);
    if (serverTimer) clearTimeout(serverTimer);
    siteTimer = null;
    serverTimer = null;
}

module.exports = {
    STAFF_ROLE_ID,
    BOT_OWNER_ID,
    COLOR,
    MODES,
    PERIODS,
    BOARD_CHANNELS,
    SITE_REFRESH_MINUTES,
    SERVER_REFRESH_MINUTES,
    startNetquelTracker,
    stopNetquelTracker,
    refresh,
    refreshSite,
    refreshServers,
    isRefreshing,
    getSnapshot,
    snapshotStamp,
    snapshotClock,
    boardFromSnapshot,
    boardEmbed,
    serverBoardsFor,
    serverBoardEmbed,
    serverBoardEmbedFor,
    modePayload,
    publishBoards,
    checkEnemies,
    isNetquelStaff,
    boardIdentity,
    boardLabel,
    formatScore,
    periodLabel
};
