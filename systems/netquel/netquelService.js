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
 *   - the in-game top-right table per server (Cloud/2, Cloud/3, …), read by
 *     opening that server's own host (4.netquel.com is Cloud/4).
 *
 * The scrape renders netquel.com in a headless browser. The day/week/all
 * tables only matter as history, so they reload once a day on their own timer.
 * The live data is the in-game server boards: by default every (mode, server)
 * keeps a joined tab and reads the HUD every couple of seconds, and the older
 * page-load-per-board sweep remains available as the fallback. Both merge into
 * one snapshot, so a single board message carries both.
 *
 * A finished board is published the moment it is read, so new rows reach
 * Discord before the rest of the pass has finished. Profile cards are captured
 * by a separate, slower pass: clicking every name used to cost more than the
 * boards themselves.
 *
 * The site tables run on their own resident browser (warm profile, one visible
 * tab) and never join the shared browser queue, so a server sweep cannot delay
 * them. The sweep keeps the queue to itself: two software-rendered game
 * clients starve each other, and a manual full /reload joins it.
 *
 * Alerts are deduplicated per enemy + board for ALERT_COOLDOWN_MS, so a name
 * that stays on the board does not spam every refresh. Only a per-server board
 * — which exists solely inside a live match — pings the role. The site's
 * day/week/all tables keep a name for hours after it logs off, so those post a
 * quiet "was on the board" notice instead.
 *
 * A role ping is at most one per enemy per 10 minutes across every board, and
 * an AFK sighting never pings (its message still posts). Separately, any live
 * server-board score of 50,000+ pings once per visit, whether or not the name
 * is on the enemy list.
 */

const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const source = require('./netquelSource');
const { ensureChrome } = require('../../scripts/install-netquel-chrome');
const store = require('./netquelStore');
const {
    PERIODS,
    MODES,
    boardIdentity,
    boardLabel,
    createCoalescer,
    findEnemyHits,
    findHighScoreRows,
    HIGH_SCORE_PING_THRESHOLD,
    fitLines,
    formatScore,
    matchesServer,
    mergeBoard,
    mergeBoardGroup,
    nameMatches,
    newestFetchedAt,
    periodLabel,
    relativeStamp,
    verifyEnemy,
    filterTierRosters,
    rosterTierFor,
    rosterTierLookup,
    serverName,
    normalizeName
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

/*
 * Site tables: the day/week/all boards are history, not live standings, so
 * once a day is plenty. The resident browser still makes that pass cheap
 * (~3s), and the per-server sweep never waits for it either way.
 *
 * Both env spellings stay supported for a host that wants a different cadence;
 * 15s is the floor, because below that the tracker would ask netquel.com for a
 * page it has not repainted yet.
 */
const SITE_REFRESH_SECONDS = (() => {
    const seconds = Number(process.env.NETQUEL_SITE_REFRESH_SECONDS);
    if (Number.isFinite(seconds) && seconds > 0) return Math.max(15, Math.round(seconds));
    const minutes = Number(process.env.NETQUEL_SITE_REFRESH_MINUTES);
    if (Number.isFinite(minutes) && minutes > 0) return Math.max(15, Math.round(minutes * 60));
    return 24 * 60 * 60;
})();
const SITE_REFRESH_MINUTES = SITE_REFRESH_SECONDS / 60;
const SITE_REFRESH_LABEL = (() => {
    if (SITE_REFRESH_SECONDS < 90) return `${SITE_REFRESH_SECONDS}s`;
    if (SITE_REFRESH_SECONDS < 90 * 60) return `${Math.round(SITE_REFRESH_MINUTES)} min`;
    if (SITE_REFRESH_SECONDS < 24 * 60 * 60) return `${Math.round(SITE_REFRESH_SECONDS / 3600)}h`;
    const days = Math.round(SITE_REFRESH_SECONDS / 86400);
    return `${days} day${days === 1 ? '' : 's'}`;
})();
/*
 * The sweep cadence, the resident board-edit cadence, and the resident
 * health-check interval. Resident mode no longer re-enters the game per
 * board, so this is both the backstop that repairs a dead tab and the cap on
 * Discord edits per mode (20s floor).
 */
const SERVER_REFRESH_SECONDS = (() => {
    const seconds = Number(process.env.NETQUEL_SERVER_REFRESH_SECONDS);
    if (Number.isFinite(seconds) && seconds > 0) return Math.max(20, Math.round(seconds));
    const minutes = Number(process.env.NETQUEL_REFRESH_MINUTES);
    if (Number.isFinite(minutes) && minutes > 0) return Math.max(20, Math.round(minutes * 60));
    return 30;
})();
const SERVER_REFRESH_MINUTES = SERVER_REFRESH_SECONDS / 60;
const SERVER_REFRESH_DELAY_MS = SERVER_REFRESH_SECONDS * 1000;
const SERVER_REFRESH_LABEL = `every ${SERVER_REFRESH_SECONDS}s`;
/*
 * The Lobby roster tour: one client switches through every FFA tier of the
 * three servers. This is deliberately slower than the HUD boards because
 * each tier costs a settings switch and a respawn; it never joins the resident
 * tabs, so the existing per-server boards keep their own cadence.
 */
const ROSTER_TIERS = [
    { tier: '0', label: 'FFA', color: 0x5865f2 },
    { tier: 'A', label: 'FFA/A', color: 0x57f287 },
    { tier: 'B', label: 'FFA/B', color: 0xed4245 }
];
const ROSTER_SERVERS = ['Cloud/2', 'Cloud/4', 'Cloud/3'];
const ROSTER_REFRESH_SECONDS = (() => {
    const seconds = Number(process.env.NETQUEL_ROSTER_REFRESH_SECONDS);
    if (Number.isFinite(seconds) && seconds > 0) return Math.max(120, Math.round(seconds));
    const minutes = Number(process.env.NETQUEL_ROSTER_REFRESH_MINUTES);
    if (Number.isFinite(minutes) && minutes > 0) return Math.max(120, Math.round(minutes * 60));
    return 5 * 60;
})();
const ROSTER_REFRESH_DELAY_MS = ROSTER_REFRESH_SECONDS * 1000;
const ROSTER_REFRESH_LABEL = `every ${Math.round(ROSTER_REFRESH_SECONDS / 60)} min`;
/* How old a Lobby scan may be before its board tier tags are dropped. */
const ROSTER_TAG_MAX_AGE_MS = 15 * 60_000;
/*
 * Profile cards are enrichment, not the board: the fast pass only clicks
 * tracked enemies, and this slower pass fills in everyone else.
 */
const CARD_REFRESH_MINUTES = Number(process.env.NETQUEL_CARD_REFRESH_MINUTES) > 0
    ? Number(process.env.NETQUEL_CARD_REFRESH_MINUTES)
    : 10;
const CARD_REFRESH_DELAY_MS = CARD_REFRESH_MINUTES * 60_000;
/*
 * Live per-server boards. `sweep` is the old page-load-per-board path.
 * `resident` keeps one tab per (mode, server) in an arena and reads the HUD
 * on a short poll, so a refresh costs a DOM read instead of a re-join.
 */
const BOARD_MODE = (() => {
    const value = String(process.env.NETQUEL_BOARD_MODE ?? '').trim().toLowerCase();
    if (value === 'resident' || value === 'sweep') return value;
    return 'resident';
})();
const RESIDENT_ENABLED = BOARD_MODE === 'resident';
const RESIDENT_LIMIT = (() => {
    const value = Number(process.env.NETQUEL_RESIDENT_LIMIT);
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : 6;
})();
const RESIDENT_POLL_SECONDS = (() => {
    const value = Number(process.env.NETQUEL_RESIDENT_POLL_SECONDS);
    return Number.isFinite(value) && value > 0 ? Math.max(0.5, value) : 2;
})();
const RESIDENT_FPS = (() => {
    const value = Number(process.env.NETQUEL_RESIDENT_FPS);
    return Number.isFinite(value) && value >= 0 ? Math.min(60, Math.round(value)) : 5;
})();
const PUBLISH_MIN_MS = (() => {
    const value = Number(process.env.NETQUEL_PUBLISH_MIN_MS);
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : 2_000;
})();
/* Scores repaint constantly; the players table only needs a periodic touch. */
const RESIDENT_SAVE_MIN_MS = 15_000;
const RETRY_MINUTES = 2;
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/* A role ping is suppressed for this long per enemy, across every board. */
const ENEMY_PING_COOLDOWN_MS = 10 * 60 * 1000;
/* How long a high-score alert survives after the name leaves the boards. */
const SCORE_ALERT_GRACE_MS = 10 * 60 * 1000;
const BOOT_DELAY_MS = 15_000;
/* Discord's limits, minus a little headroom for the extra notice lines. */
const DESC_LIMIT = 4000;
const FIELD_LIMIT = 1000;

const COLOR = 0x6c5ce7;

let snapshot = null;
let inFlight = null;
let siteInFlight = null;
let serverInFlight = null;
let cardInFlight = null;
let cardOffset = 0;
let siteTimer = null;
let serverTimer = null;
let rosterTimer = null;
let rosterInFlight = null;
let rosterSnapshot = null;
let rosterSnapshotLoaded = false;
let cardTimer = null;
let residentPool = null;
let residentCheckTimer = null;
let clientRef = null;

/*
 * Every scrape shares one browser queue: Netquel runs a software-rendered
 * client, and two at once starve each other badly enough that the server
 * sweep's wall approach misses hops.
 */
let browserQueue = Promise.resolve();
let browserInstall = null;
let disabledReason = null;

/*
 * Hosts without a console can still read what happened: every boot line and
 * scrape failure is appended here as well as printed.
 */
const LOG_PATH = path.join(__dirname, '..', '..', 'netquel-tracker.log');
const LOG_LIMIT_BYTES = 512 * 1024;

function record(message, level = 'log') {
    (console[level] || console.log)(message);
    try {
        if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_LIMIT_BYTES) {
            fs.writeFileSync(LOG_PATH, '');
        }
        fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
        // A read-only or full disk must never take the bot down.
    }
}

/*
 * A missing or unusable browser will not fix itself between two ticks, so the
 * tracker stops after the first one instead of failing every two minutes.
 */
const FATAL_BROWSER_ERROR = /no chrome, edge or chromium|browser exited during startup|never exposed a debugging target|could not be started|shared librar|cannot open shared object/i;

function noteFatalBrowserError(error) {
    const message = String(error?.message ?? '');
    if (!FATAL_BROWSER_ERROR.test(message)) return false;
    stopNetquelTracker();
    disabledReason = message;
    record(
        '🛰️ Netquel tracker stopped — the browser could not start.\n'
        + `   ${message}\n`
        + `   Fix it and restart (NETQUEL-HOSTING.md); diagnostics in ${LOG_PATH}.`,
        'warn'
    );
    return true;
}

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
    return Boolean(inFlight || siteInFlight || serverInFlight || rosterInFlight);
}

function boardFromSnapshot(mode, period) {
    return snapshot?.boards?.find(board => board.mode === mode && board.period === period) ?? null;
}

function serverBoardsFor(mode) {
    return (snapshot?.boards ?? []).filter(board => board.mode === mode && board.server);
}

/*
 * The one message shape each board channel gets (3 site boards + servers).
 * Keeping both in one message means a finished sweep is a single edit; a
 * separate site message would not make either refresh any sooner.
 */
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
    const roster = activeRosterTiers(mode);
    const fields = boards.map(board => {
        const lines = fitLines(board.rows, FIELD_LIMIT, row => {
            const enemy = enemies.some(entry => nameMatches(entry.displayName, row.name));
            return `**${row.rank}.** ${row.name} — ${formatScore(row.score)}${tierSuffix(roster, board, row)}${enemy ? ' 🔴' : ''}`;
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
            `**Updated ${relativeStamp(updated)}** — ${RESIDENT_ENABLED
                ? `resident live boards, polled every ${RESIDENT_POLL_SECONDS}s`
                : `server sweep ${SERVER_REFRESH_LABEL}`}`,
            'Live top-right board in each server (read directly from its own host).',
            ...(roster ? [`Entry/A/B = last Lobby scan ${relativeStamp(roster.fetchedAt)}.`] : [])
        ].join('\n'))
        .addFields(fields)
        .setFooter({ text: '🔴 = tracked enemy' });
}

function serverBoardEmbedFor(mode, server) {
    const board = serverBoardsFor(mode).find(entry => matchesServer(entry, server));
    if (!board) return null;

    const enemies = store.listEnemies();
    const roster = activeRosterTiers(mode);
    const lines = fitLines(board.rows, DESC_LIMIT, row => {
        const enemy = enemies.some(entry => nameMatches(entry.displayName, row.name));
        return `**${row.rank}.** ${row.name} — ${formatScore(row.score)}${tierSuffix(roster, board, row)}${enemy ? ' 🔴' : ''}`;
    });
    const description = [`**Updated ${relativeStamp(board.fetchedAt)}**`];
    if (roster) description.push(`Entry/A/B = last Lobby scan ${relativeStamp(roster.fetchedAt)}.`);
    description.push(lines.join('\n') || '_The board is empty right now._');

    return new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`🛰️ ${mode} · ${board.server} leaderboard`)
        .setDescription(description.join('\n'))
        .setFooter({ text: '🔴 = tracked enemy' });
}

/*
 * Tier tags on the live per-server boards. The HUD is server-wide: it merges
 * every FFA tier and carries no tier column, so the Lobby roster tour is the
 * only public source. A row is tagged only when the last tour saw that name on
 * the same server — the tag is "last seen in", not proof of the live frame.
 */
function currentRosterSnapshot() {
    if (!rosterSnapshotLoaded) {
        rosterSnapshotLoaded = true;
        rosterSnapshot = store.getRosterSnapshot();
    }
    return rosterSnapshot;
}

function activeRosterTiers(mode) {
    if (String(mode).toLowerCase() !== 'ffa') return null;
    const latest = currentRosterSnapshot();
    const fetchedAt = Number(latest?.fetchedAt);
    if (!Array.isArray(latest?.entries) || !latest.entries.length) return null;
    if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > ROSTER_TAG_MAX_AGE_MS) return null;
    return { lookup: rosterTierLookup(latest.entries), fetchedAt };
}

function tierSuffix(roster, board, row) {
    if (!roster) return '';
    const tier = rosterTierFor(roster.lookup, board?.serverId || board?.server, row?.name);
    return tier ? ` · ${tier}` : '';
}

/*
 * Publishes are queued and each payload is built when its turn comes, so two
 * passes finishing together can never post an older snapshot over a newer one
 * — the last edit always shows the newest boards.
 */
let publishQueue = Promise.resolve();

/*
 * Discord message objects are kept between passes. A sweep that just finished
 * should cost one edit call, not a channel fetch, a message fetch and an edit;
 * a failed edit drops the entry so the next pass re-reads the saved id.
 */
const boardMessages = new Map();

function publishBoards(modes = MODES) {
    const run = publishQueue.then(() => publishNow(modes), () => publishNow(modes));
    publishQueue = run.then(() => {}, () => {});
    return run;
}

/*
 * Post the boards once, then edit that message. Every caller only runs after a
 * finished scrape, so an unchanged board is still edited: the "Updated" stamp
 * must say when the data was read, and a per-server sweep should reach Discord
 * the moment it lands.
 */
async function publishNow(modes = MODES) {
    if (!clientRef) return 0;

    let updated = 0;
    for (const mode of modes) {
        const channelId = BOARD_CHANNELS[mode];
        if (!channelId) continue;

        let channel = clientRef.channels.cache.get(channelId) ?? null;
        if (!channel) channel = await clientRef.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) {
            record(`Netquel ${mode} board channel ${channelId} is missing or not text-based.`, 'warn');
            continue;
        }

        const payload = modePayload(mode);
        const cached = boardMessages.get(mode);
        let existing = cached?.channelId === channel.id ? cached.message : null;

        if (!existing) {
            const saved = store.getBoardMessage(mode);
            if (saved?.messageId && saved.channelId === channel.id) {
                existing = await channel.messages.fetch(saved.messageId).catch(() => null);
                if (existing) boardMessages.set(mode, { channelId: channel.id, message: existing });
            }
        }

        if (existing) {
            const edited = await existing.edit(payload).catch(error => {
                boardMessages.delete(mode);
                record(`Netquel ${mode} board edit failed: ${error.message}`, 'warn');
                return null;
            });
            if (edited) updated += 1;
            continue;
        }

        const posted = await channel.send(payload).catch(error => {
            record(`Netquel ${mode} board post failed: ${error.message}`, 'warn');
            return null;
        });
        if (!posted) continue;
        store.setBoardMessage(mode, channelId, posted.id);
        boardMessages.set(mode, { channelId: channel.id, message: posted });
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
        /*
         * An AFK sighting gets its own message slot. It still posts, but it
         * must not spend the same 6-hour slot as a later active sighting on
         * that board, or the active ping would never get a chance to fire.
         */
        const alertKey = hit.afk ? `${hit.board}|afk` : hit.board;
        if (!store.shouldAlert(hit.name, alertKey, ALERT_COOLDOWN_MS)) continue;

        const live = Boolean(hit.server);

        /*
         * An enemy added by name alone is a name watch. One added with a join
         * date and/or high score is a person watch: the card captured on the
         * live board has to agree, or this is somebody wearing the alias.
         */
        /*
         * The card captured while reading this very board is the freshest
         * proof of who the name belongs to; the stored row is only a fallback
         * for when that click did not open a card.
         */
        const profile = live ? (hit.profile ?? store.getPlayer(hit.name)) : null;
        const verdict = live ? verifyEnemy(enemy, profile) : { status: 'ok', reason: null };
        const kind = !live ? 'historic' : verdict.status === 'ok' ? 'live' : 'warn';
        const key = `${enemy.channelId}|${kind}`;
        if (!groups.has(key)) groups.set(key, { channelId: enemy.channelId, kind, hits: [] });
        groups.get(key).hits.push({ ...hit, reason: verdict.reason, profile, alertKey });
    }

    const TITLES = {
        live: '🎯 ENEMY SIGHTED ON NETQUEL',
        warn: '⚠️ TRACKED NAME — PROFILE DOES NOT MATCH',
        historic: '🕘 ENEMY WAS ON NETQUEL'
    };
    const INTROS = {
        live: null,
        warn: 'The name matches a tracked enemy, but their join date / high score does not, so this is **not** a confirmed sighting. Nobody was pinged.',
        historic: 'From the day/week/all-time boards — the name was there, but the player may not be online now.'
    };

    let sent = 0;
    for (const { channelId, kind, hits: groupHits } of groups.values()) {
        const channel = await clientRef.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) continue;

        const lines = groupHits.map(hit => {
            /* Rank, streak and clan come from the captured card, so the alert
             * says who the name belongs to, not just where it sits on a board. */
            const bits = [];
            /*
             * The HUD marks a verified account with italics and an AFK player
             * with a dimmed row, so every sighting says which is which.
             */
            if (kind !== 'historic') {
                bits.push(hit.verified ? '✅ verified' : '⬜ not verified');
                bits.push(hit.afk ? '💤 AFK' : '🏃 active');
            }
            if (kind !== 'historic' && hit.profile) {
                if (hit.profile.isPrivate || hit.profile.private) {
                    bits.push('private profile');
                } else {
                    bits.push(hit.profile.rankName ?? hit.profile.rank ?? 'Unranked');
                    if (hit.profile.streak) bits.push(hit.profile.streak);
                    if (hit.profile.clan) bits.push(`clan ${hit.profile.clan}`);
                }
            }
            const card = bits.length ? ` · ${bits.join(', ')}` : '';
            const base = kind === 'historic'
                ? `**${hit.displayName}** — was on **${hit.label}** · rank **#${hit.rank}** · ${formatScore(hit.score)} pts`
                : `**${hit.displayName}** — ${hit.label} · rank **#${hit.rank}** · ${formatScore(hit.score)} pts${card}`;
            return kind === 'warn' && hit.reason ? `${base} — ${hit.reason}` : base;
        });

        /*
         * A private card hides the join date and high score, so it can never
         * confirm a pinned enemy. Saying "does not match" there is wrong: the
         * card simply has nothing to compare, and the name alone is not proof.
         */
        const privateOnly = kind === 'warn'
            && groupHits.every(hit => /private/i.test(hit.reason ?? ''));
        /*
         * An AFK row still gets its message, but never the ping. A live group
         * pings only when at least one non-AFK enemy has been quiet for the
         * full 10-minute cooldown; otherwise the sighting posts quietly.
         */
        const allAfk = kind === 'live' && groupHits.every(hit => hit.afk);
        const activeHits = groupHits.filter(hit => !hit.afk);
        const ping = kind === 'live'
            && activeHits.some(hit => store.canPing(hit.name, ENEMY_PING_COOLDOWN_MS));
        const title = allAfk
            ? '💤 ENEMY SIGHTED — AFK'
            : privateOnly ? '⚠️ TRACKED NAME — PROFILE IS PRIVATE' : TITLES[kind];
        const intro = allAfk
            ? 'This tracked enemy is **AFK**, so this post does not ping. They are still on the live board.'
            : privateOnly
                ? 'Their profile is private, so the card shows no join date or high score and can not confirm them. Nobody was pinged.'
                : INTROS[kind];

        const embed = new EmbedBuilder()
            .setColor(kind === 'live' ? COLOR : kind === 'warn' ? 0xffb020 : 0x95a5a6)
            .setTitle(title)
            .setDescription([
                intro,
                lines.join('\n'),
                `Detected ${snapshotStamp()}`
            ].filter(Boolean).join('\n\n').slice(0, 4000))
            .setFooter({
                text: kind === 'live'
                    ? ping
                        ? 'Netquel tracker'
                        : allAfk ? 'AFK · no ping' : 'Ping cooldown (10 min) · no ping'
                    : kind === 'warn' ? 'Unverified · no ping' : 'Historic board · no ping'
            });

        const payload = { embeds: [embed] };
        if (ping) payload.content = `<@&${STAFF_ROLE_ID}>`;

        const message = await channel.send(payload).catch(error => {
            console.warn(`Netquel alert failed in ${channelId}:`, error.message);
            return null;
        });
        if (!message) continue;

        sent += 1;
        for (const hit of groupHits) store.recordAlert(hit.name, hit.alertKey ?? hit.board);
        /* Only an actual ping starts the 10-minute clock. */
        if (ping) {
            for (const hit of activeHits) store.recordPing(hit.name);
        }
    }
    return sent;
}

/*
 * A 50,000+ score on a live server board is its own alert: it pings once per
 * visit, then stays quiet while the name remains. Once the player has been
 * gone for the grace period the row is pruned, so a later session pings again.
 */
async function sendHighScoreAlerts(rows) {
    if (!clientRef) return 0;

    const byName = new Map();
    for (const row of rows) {
        if (!row.key) continue;
        if (!byName.has(row.key)) {
            byName.set(row.key, { key: row.key, name: row.name, rows: [] });
        }
        byName.get(row.key).rows.push(row);
    }

    store.pruneScoreAlerts(new Set(byName.keys()), SCORE_ALERT_GRACE_MS);
    if (!byName.size) return 0;

    let sent = 0;
    for (const group of byName.values()) {
        if (store.hasScoreAlert(group.key)) continue;

        const first = group.rows[0];
        const channelId = BOARD_CHANNELS[first.mode];
        if (!channelId) continue;
        const channel = await clientRef.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) continue;

        const lines = group.rows.map(row => [
            `**${row.name}** — ${formatScore(row.score)} on **${row.label}**`,
            `rank **#${row.rank}**`,
            row.verified ? '✅ verified' : '⬜ not verified',
            row.afk ? '💤 AFK' : '🏃 active'
        ].join(' · '));

        const embed = new EmbedBuilder()
            .setColor(0xffd23f)
            .setTitle('🔥 HIGH SCORER ON NETQUEL')
            .setDescription([
                `A live server board just showed **${formatScore(HIGH_SCORE_PING_THRESHOLD)}+**. This pings once per visit.`,
                lines.join('\n'),
                `Detected ${snapshotStamp()}`
            ].join('\n\n').slice(0, 4000))
            .setFooter({ text: 'Live server board · one ping per visit' });

        const message = await channel
            .send({ content: `<@&${STAFF_ROLE_ID}>`, embeds: [embed] })
            .catch(error => {
                record(`Netquel high-score alert failed in ${channelId}: ${error.message}`, 'warn');
                return null;
            });
        if (!message) continue;

        sent += 1;
        store.recordScoreAlert({
            name: group.key,
            displayName: first.name,
            server: first.server,
            score: first.score
        });
    }
    return sent;
}

/*
 * The site tick and the server sweep now run side by side. The alert cooldown
 * is checked before a send, so two checks at once could both see "not alerted
 * yet" and post the same sighting twice. Alerts therefore keep a queue of
 * their own — scrapes never wait behind it.
 */
/* One alert timer: a board asks for a check soon, not one per board row. */
let alertTimer = null;

function scheduleEnemyCheck() {
    if (alertTimer) return;
    alertTimer = setTimeout(() => {
        alertTimer = null;
        checkEnemies().catch(error => console.warn('Netquel enemy check failed:', error.message));
    }, 2500);
    if (typeof alertTimer.unref === 'function') alertTimer.unref();
}

let alertQueue = Promise.resolve();

function checkEnemies() {
    const run = alertQueue.then(runEnemyCheck, runEnemyCheck);
    alertQueue = run.then(() => {}, () => {});
    return run;
}

async function runEnemyCheck() {
    if (!snapshot?.boards?.length) return 0;

    /* High-score pings are independent of the enemy list. */
    const highScoreAlerts = await sendHighScoreAlerts(
        findHighScoreRows(snapshot.boards, HIGH_SCORE_PING_THRESHOLD)
    );

    const enemies = store.listEnemies();
    if (!enemies.length) return highScoreAlerts;
    const hits = findEnemyHits(enemies, snapshot.boards);
    return highScoreAlerts + await sendAlerts(hits);
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

/*
 * Store every player the board saw, not just the ones whose card opened:
 * lastSeen / verified / AFK are board data and stay current even on a
 * board-only pass. Missing card fields keep their stored values.
 */
function savePlayers(boards) {
    const entries = [];
    let cards = 0;
    for (const board of boards || []) {
        for (const row of board.rows || []) {
            if (!row.name) continue;
            const hasCard = Boolean(row.profile);
            if (hasCard) cards += 1;
            entries.push({
                name: row.name,
                mode: board.mode,
                server: board.server,
                verified: Boolean(row.verified),
                afk: Boolean(row.afk),
                hasCard,
                ...(row.profile || {})
            });
        }
    }
    if (!entries.length) return { saved: 0, cards: 0 };

    /* A tracked enemy's card is always stored, even on their first day. */
    const tracked = new Set(store.listEnemies().map(enemy => enemy.name));
    return { saved: store.recordPlayers(entries, tracked), cards };
}

/*
 * On-demand card refresh for the staff commands. It joins the browser queue,
 * so it waits for a running sweep instead of opening a second client.
 */
function refreshPlayerCards(names, modes = MODES) {
    return enqueueBrowserTask(async () => {
        const result = await source.refreshPlayerCards(names, modes);
        const entries = result.cards.map(entry => ({
            name: entry.name,
            mode: entry.mode,
            server: entry.server,
            verified: entry.verified,
            afk: entry.afk,
            ...entry.card
        }));
        let saved = 0;
        if (entries.length) {
            const tracked = new Set(store.listEnemies().map(enemy => enemy.name));
            saved = store.recordPlayers(entries, tracked);
        }
        return { saved, cards: result.cards, errors: result.errors };
    });
}

/*
 * On-demand live check for staff tooling. It joins the browser queue, so a running
 * sweep is never starved by a second game client, and its timeout starts only
 * once the check owns the browser (waiting for a sweep does not count).
 */
function scrapeLive(mode, name = null, { timeoutMs = 0 } = {}) {
    return enqueueBrowserTask(async () => {
        const controller = new AbortController();
        const timer = timeoutMs > 0
            ? setTimeout(() => controller.abort(), timeoutMs)
            : null;
        if (typeof timer?.unref === 'function') timer.unref();
        try {
            return await source.scrapeLive(mode, name, { signal: controller.signal });
        } catch (error) {
            if (controller.signal.aborted) {
                throw new Error(`${mode} live check timed out after ${Math.round(timeoutMs / 1000)}s`);
            }
            throw error;
        } finally {
            if (timer) clearTimeout(timer);
        }
    });
}

function boardCounts(boards) {
    const site = boards.filter(board => !board.server).length;
    return `${site} site + ${boards.length - site} server boards`;
}

/*
 * Daily pass: the site's day/week/all tables only, on the resident site
 * browser. They are history rather than live standings, so one pass a day is
 * enough and it never competes with the server sweep for the queue. The enemy
 * check still runs over the merged snapshot afterwards.
 */
function refreshSite() {
    if (siteInFlight) return siteInFlight;

    siteInFlight = (async () => {
        try {
            const data = await source.scrapeSiteBoards();
            const changed = [...new Set(data.boards.map(board => board.mode))];

            mergeIncoming(data.boards, { server: false });
            if (snapshot) snapshot.durationMs = data.durationMs;

            const published = await publishBoards(changed).catch(error => {
                record(`Netquel site board publish failed: ${error.message}`, 'warn');
                return 0;
            });
            const alerts = await checkEnemies().catch(error => {
                console.warn('Netquel enemy check failed:', error.message);
                return 0;
            });

            for (const warning of data.errors ?? []) {
                console.warn(`Netquel site partial refresh — ${warning}`);
            }
            const line = `🛰️ Netquel site boards reloaded in ${((data.durationMs ?? 0) / 1000).toFixed(1)}s `
                + `(${boardCounts(data.boards)}; ${published} channel(s) updated, ${alerts} alert(s)).`;
            /* Digest-skip ticks stay off the file; a real edit goes in it. */
            if (published > 0) record(line); else console.log(line);
            return { ok: true, snapshot, alerts, published };
        } catch (error) {
            if (snapshot) snapshot.error = error.message;
            record(`Netquel site board refresh failed: ${error.message}`, 'warn');
            noteFatalBrowserError(error);
            return { ok: false, error };
        }
    })().finally(() => { siteInFlight = null; });

    return siteInFlight;
}

/* Replace exactly one board, so a fresh server never wipes its siblings. */
function mergeBoardIntoSnapshot(board) {
    snapshot = {
        ...(snapshot ?? {}),
        boards: mergeBoard(snapshot?.boards ?? [], board),
        fetchedAt: Date.now(),
        errors: snapshot?.errors ?? []
    };
}

/*
 * Sweep pass: the per-server boards for NETQUEL_BOARD_MODE=sweep and manual
 * reloads. Each server is its own host, so a board is one page load; every
 * board is published as soon as it lands.
 */
function refreshServers() {
    if (serverInFlight) return serverInFlight;

    serverInFlight = enqueueBrowserTask(async () => {
        let cards = 0;
        try {
            const tracked = store.listEnemies().map(enemy => enemy.displayName);
            const data = await source.scrapeServerBoards(MODES, {
                /* Only a tracked enemy's card is worth a click in the fast pass,
                 * and only a couple per board, so the pass stays quick. */
                cards: tracked.length ? 'tracked' : 'none',
                tracked,
                cardLimit: 3,
                cardBudgetMs: 3_000,
                onBoard: board => {
                    cards += savePlayers([board]).cards;
                    mergeBoardIntoSnapshot(board);
                    publishBoards([board.mode]).catch(error => {
                        record(`Netquel server board publish failed: ${error.message}`, 'warn');
                    });
                    scheduleEnemyCheck();
                }
            });
            const changed = [...new Set(data.boards.map(board => board.mode))];
            if (snapshot) snapshot.durationMs = data.durationMs;

            /* The per-board edits are already queued; this one reports the
             * final snapshot and gives the log an accurate channel count. */
            const published = await publishBoards(changed).catch(error => {
                record(`Netquel server board publish failed: ${error.message}`, 'warn');
                return 0;
            });
            if (alertTimer) {
                clearTimeout(alertTimer);
                alertTimer = null;
            }
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
            const line = `🛰️ Netquel server boards refreshed in ${((data.durationMs ?? 0) / 1000).toFixed(0)}s `
                + `(${boardCounts(data.boards)} — ${servers}; `
                + `${published} channel(s) updated, ${alerts} alert(s), ${cards} profile card(s)).`;
            if (published > 0) record(line); else console.log(line);
            return { ok: true, snapshot, alerts, published };
        } catch (error) {
            if (snapshot) snapshot.error = error.message;
            record(`Netquel server board refresh failed: ${error.message}`, 'warn');
            noteFatalBrowserError(error);
            return { ok: false, error };
        }
    }).finally(() => { serverInFlight = null; });

    return serverInFlight;
}

/*
 * The public roster path: join a server, use the settings select to switch
 * entry -> A -> B, and read the Lobby Players list in each tier. The HUD is
 * server-wide; the Lobby tab is the scene-local source. Names repeated across
 * tiers are chat/global rows and are removed by filterTierRosters().
 */
async function collectTierRosters() {
    const startedAt = Date.now();
    const reloader = source.getSweepReloader();
    const page = await reloader.ensurePage();
    const byKey = new Map();
    const errors = [];

    for (const serverId of ROSTER_SERVERS) {
        for (const { tier } of ROSTER_TIERS) {
            byKey.set(`${serverId}:${tier}`, {
                serverId,
                server: serverName(serverId),
                tier,
                names: [],
                online: null,
                error: null
            });
        }
    }

    try {
        for (const serverId of ROSTER_SERVERS) {
            try {
                await page.joinServer('FFA', serverId);
                const options = await page.readTierOptions().catch(() => []);
                const onlineFor = tier => options.find(option => option.serverId === serverId
                    && option.mode === 'FFA' && option.tier === tier)?.online ?? null;

                for (const { tier } of ROSTER_TIERS) {
                    const entry = byKey.get(`${serverId}:${tier}`);
                    try {
                        await page.enterTier(serverId, tier);
                        const alias = await page.readLocalAlias();
                        const names = await page.readLobbyNames();
                        entry.names = alias
                            ? names.filter(name => normalizeName(name) !== normalizeName(alias))
                            : names;
                        entry.online = onlineFor(tier);
                    } catch (error) {
                        entry.error = error.message;
                        errors.push(`${serverId}/${tier}: ${error.message}`);
                        await page.respawn(15_000).catch(() => {});
                    }
                }
            } catch (error) {
                errors.push(`${serverId}: ${error.message}`);
                for (const { tier } of ROSTER_TIERS) {
                    const entry = byKey.get(`${serverId}:${tier}`);
                    if (!entry.names.length) entry.error = error.message;
                }
            }
        }
    } finally {
        await reloader.park().catch(() => {});
    }

    const real = [...byKey.values()];
    return {
        entries: filterTierRosters(real),
        fetchedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        errors
    };
}

function refreshRosters() {
    if (rosterInFlight) return rosterInFlight;

    rosterInFlight = enqueueBrowserTask(async () => {
        const startedAt = Date.now();
        try {
            const data = await collectTierRosters();
            rosterSnapshot = data;
            rosterSnapshotLoaded = true;
            /* Keep the last scan so board tier tags survive a restart. */
            try {
                store.saveRosterSnapshot(data);
            } catch (error) {
                record(`Netquel roster history save failed: ${error.message}`, 'warn');
            }
            /* The tour is only a tier source; re-render the FFA board with it. */
            const published = await publishBoards(['FFA']);
            const counts = data.entries
                .map(entry => `${entry.server}/${entry.tier}:${entry.names.length}`)
                .join(', ');
            const line = `🛰️ Netquel player locations refreshed in `
                + `${((Date.now() - startedAt) / 1000).toFixed(0)}s (${counts}; `
                + `${published} FFA board edit(s)).`;
            for (const warning of data.errors ?? []) {
                console.warn(`Netquel roster partial refresh — ${warning}`);
            }
            if (published > 0) record(line); else console.log(line);
            return { ok: true, ...data, published };
        } catch (error) {
            record(`Netquel player locations refresh failed: ${error.message}`, 'warn');
            noteFatalBrowserError(error);
            return { ok: false, error };
        }
    }).finally(() => { rosterInFlight = null; });

    return rosterInFlight;
}

function scheduleRosters(delayMs = ROSTER_REFRESH_DELAY_MS) {
    if (rosterTimer) return;
    rosterTimer = setTimeout(async () => {
        rosterTimer = null;
        const result = await refreshRosters();
        scheduleRosters(result.ok ? ROSTER_REFRESH_DELAY_MS : RETRY_MINUTES * 60_000);
    }, delayMs);
    if (typeof rosterTimer.unref === 'function') rosterTimer.unref();
}

/*
 * Resident boards: a joined tab per (mode, server) pushes each HUD change to
 * the snapshot. Discord edits are capped at one per mode per server-refresh
 * window, while the snapshot, alerts and lastSeen stay on the 2s read cadence.
 * A quiet mode still gets a heartbeat edit so its Updated stamp stays current.
 */
const residentPublisher = createCoalescer({
    delayMs: PUBLISH_MIN_MS,
    /* One board edit per server-refresh window per channel. HUD reads and
     * alerts stay at the 2s poll cadence; only Discord is throttled. */
    minIntervalMs: SERVER_REFRESH_DELAY_MS,
    run: async modes => {
        try {
            await publishBoards(modes);
        } catch (error) {
            record(`Netquel server board publish failed: ${error.message}`, 'warn');
        }
    }
});

const lastResidentSave = new Map();

function handleResidentBoard(board) {
    if (!board?.mode) return;
    mergeBoardIntoSnapshot(board);

    const key = boardIdentity(board);
    const now = Date.now();
    if (now - (lastResidentSave.get(key) ?? 0) >= RESIDENT_SAVE_MIN_MS) {
        lastResidentSave.set(key, now);
        savePlayers([board]);
    }

    scheduleEnemyCheck();
    residentPublisher.push(board.mode);
}

function startResidentBoards() {
    if (residentPool) return residentPool;
    residentPool = source.startResidentBoards({
        modes: MODES,
        limit: RESIDENT_LIMIT,
        pollMs: RESIDENT_POLL_SECONDS * 1000,
        fps: RESIDENT_FPS,
        /* Quiet boards still republish this often, so the Updated stamp and
         * lastSeen reflect that the HUD was read. */
        publishMs: SERVER_REFRESH_DELAY_MS,
        /* The backstop cadence: a dead tab is repaired this often. */
        healthMs: Math.max(10_000, SERVER_REFRESH_DELAY_MS),
        onBoard: handleResidentBoard,
        onError: (message, level) => record(message, level)
    });
    return residentPool;
}

function stopResidentBoards() {
    if (residentCheckTimer) clearInterval(residentCheckTimer);
    residentCheckTimer = null;
    residentPublisher.flush().catch(() => {});
    const pool = residentPool;
    residentPool = null;
    if (pool) pool.stop().catch(() => {});
    lastResidentSave.clear();
}

/*
 * Card pass: profile enrichment on its own slower timer. It reads one server
 * per queue slot, so a due board pass runs between cards instead of waiting
 * for a whole sweep; each run clicks a rolling few names per server.
 */
function refreshCards() {
    if (cardInFlight) return cardInFlight;

    cardInFlight = (async () => {
        const startedAt = Date.now();
        let cards = 0;
        const errors = [];
        try {
            /* Hop-only mode has no per-server route; fall back to one whole pass. */
            if (!source.directServersEnabled()) {
                const data = await enqueueBrowserTask(() => source.scrapeServerBoards(MODES, {
                    cards: 'all',
                    cardLimit: 10,
                    cardBudgetMs: 12_000
                }));
                const counts = savePlayers(data.boards);
                const line = `🛰️ Netquel card pass captured ${counts.cards} card(s) `
                    + `in ${((data.durationMs ?? 0) / 1000).toFixed(0)}s (${boardCounts(data.boards)}).`;
                if (counts.cards > 0) record(line); else console.log(line);
                return { ok: true, ...counts };
            }

            const servers = await source.knownServers();
            /* One server per queue slot: a due board pass runs between these,
             * so cards never hold the live boards behind a whole sweep. */
            for (const mode of MODES) {
                if (!clientRef) break;
                for (const serverId of servers) {
                    if (!clientRef) break;
                    try {
                        const board = await enqueueBrowserTask(() => source.readServerBoard(mode, serverId, {
                            cards: 'all',
                            cardLimit: 3,
                            cardBudgetMs: 3_000,
                            cardOffset
                        }));
                        cards += savePlayers([board]).cards;
                    } catch (error) {
                        errors.push(`${mode} ${serverId}: ${error.message}`);
                    }
                }
            }
            cardOffset = (cardOffset + 3) % 10;

            const line = `🛰️ Netquel card pass captured ${cards} card(s) `
                + `in ${((Date.now() - startedAt) / 1000).toFixed(0)}s `
                + `(${servers.length * MODES.length} server boards).`;
            if (cards > 0) record(line); else console.log(line);
            for (const warning of errors) {
                console.warn(`Netquel card pass partial — ${warning}`);
            }
            return { ok: true, cards, errors };
        } catch (error) {
            record(`Netquel card pass failed: ${error.message}`, 'warn');
            noteFatalBrowserError(error);
            return { ok: false, error };
        }
    })().finally(() => { cardInFlight = null; });

    return cardInFlight;
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
            savePlayers(data.boards.filter(board => board.server));
            if (snapshot) {
                snapshot.errors = data.errors ?? [];
                snapshot.durationMs = data.durationMs;
            }

            const published = await publishBoards().catch(error => {
                record(`Netquel board publish failed: ${error.message}`, 'warn');
                return 0;
            });
            const alerts = await checkEnemies().catch(error => {
                console.warn('Netquel enemy check failed:', error.message);
                return 0;
            });

            for (const warning of data.errors ?? []) {
                console.warn(`Netquel partial refresh — ${warning}`);
            }
            const line = `🛰️ Netquel boards refreshed in ${((data.durationMs ?? 0) / 1000).toFixed(0)}s `
                + `(${boardCounts(data.boards)}; ${published} channel(s) updated, ${alerts} alert(s)).`;
            if (published > 0) record(line); else console.log(line);
            return { ok: true, snapshot, alerts, published };
        } catch (error) {
            if (snapshot) snapshot.error = error.message;
            record(`Netquel board refresh failed: ${error.message}`, 'warn');
            noteFatalBrowserError(error);
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
        scheduleSite(result.ok ? SITE_REFRESH_SECONDS * 1000 : RETRY_MINUTES * 60_000);
    }, delayMs);
    if (typeof siteTimer.unref === 'function') siteTimer.unref();
}

function scheduleServers(delayMs) {
    if (serverTimer) clearTimeout(serverTimer);
    serverTimer = setTimeout(async () => {
        const startedAt = Date.now();
        const result = await refreshServers();
        /* The interval is between pass starts, not a rest after each pass; a
         * 24s pass is followed by a 6s wait, not a 30s one. */
        const remaining = SERVER_REFRESH_DELAY_MS - (Date.now() - startedAt);
        scheduleServers(result.ok ? Math.max(1_000, remaining) : RETRY_MINUTES * 60_000);
    }, delayMs);
    if (typeof serverTimer.unref === 'function') serverTimer.unref();
}

function scheduleCards(delayMs) {
    if (cardTimer) clearTimeout(cardTimer);
    cardTimer = setTimeout(async () => {
        const result = await refreshCards();
        scheduleCards(result.ok ? CARD_REFRESH_DELAY_MS : RETRY_MINUTES * 60_000);
    }, delayMs);
    if (typeof cardTimer.unref === 'function') cardTimer.unref();
}

/* Site tables first: the board message exists within seconds, and the slower
 * server sweep fills its per-server embed when it lands. */
function armTracker() {
    scheduleSite(5_000);
    if (RESIDENT_ENABLED) {
        startResidentBoards();
        /* A quiet board still needs its high-score alerts pruned. */
        residentCheckTimer = setInterval(() => scheduleEnemyCheck(), 5 * 60_000);
        if (typeof residentCheckTimer.unref === 'function') residentCheckTimer.unref();
    } else {
        scheduleServers(BOOT_DELAY_MS);
    }
    /* Let the resident tabs finish joining before the card pass competes. */
    scheduleCards(RESIDENT_ENABLED ? 5 * 60_000 : 60_000);
    /* First roster tour runs after the game browser has settled. */
    scheduleRosters(2 * 60_000);
    /* Warm the resident browser now, so the first tick is a warm reload too. */
    source.getSiteReloader().warm().catch(error => {
        record(`Netquel site browser warm-up failed: ${error.message}`, 'warn');
    });
    /* The card pass still borrows the sweep browser in either mode. */
    source.getSweepReloader().warm()
        .then(() => record('🛰️ Netquel game browser warm.'))
        .catch(error => record(`Netquel game browser warm-up failed: ${error.message}`, 'warn'));
    record(
        `🛰️ Netquel tracker armed — site tables every ${SITE_REFRESH_LABEL}, `
        + `server boards ${RESIDENT_ENABLED ? `resident (poll ${RESIDENT_POLL_SECONDS}s)` : SERVER_REFRESH_LABEL}, `
        + `cards every ${CARD_REFRESH_MINUTES} min.`
    );
}

/*
 * A manual /reload already paid for a pass, so the pending timer tick is
 * pushed out instead of fetching the same tables seconds later.
 */
function rescheduleSite() {
    if (siteTimer) scheduleSite(SITE_REFRESH_SECONDS * 1000);
}

function reportMissingBrowser(detail) {
    record(
        '🛰️ Netquel tracker disabled — no Chrome/Chromium found on this host.\n'
        + `   ${detail}\n`
        + '   Install one (for example `npx puppeteer browsers install chrome`) and set\n'
        + '   NETQUEL_CHROME_PATH to the binary, then restart. Everything else still runs.\n'
        + `   Diagnostics: ${LOG_PATH} — NETQUEL-HOSTING.md shows the no-console routes.`,
        'warn'
    );
}

/*
 * Hosts frequently ship without a browser, and panels that only restart the
 * process never run `npm install`, so the postinstall hook alone is not enough.
 * On boot with no browser at all we try the same installer once ourselves;
 * if it lands, the tracker arms without a second restart.
 */
function startNetquelTracker(client) {
    clientRef = client;

    const found = source.locateChrome();
    if (found) {
        record(`🛰️ Netquel browser: ${found}`);
        armTracker();
        return;
    }

    if (process.platform !== 'linux') {
        reportMissingBrowser(`Nothing was installed: this host is ${process.platform}, so the local download is skipped.`);
        return;
    }

    record('🛰️ Netquel tracker: no browser found — downloading one now (this can take a minute).', 'warn');
    browserInstall = ensureChrome(message => record(`🛰️ ${message}`))
        .then(result => {
            if (result.ok && result.path) {
                record(`🛰️ Netquel browser ready: ${result.path}`);
                armTracker();
                return;
            }
            disabledReason = result.message;
            reportMissingBrowser(result.message);
        })
        .catch(error => {
            disabledReason = String(error?.message ?? error);
            reportMissingBrowser(`Install attempt failed: ${disabledReason}`);
        })
        .finally(() => { browserInstall = null; });
}

function stopNetquelTracker() {
    if (siteTimer) clearTimeout(siteTimer);
    if (serverTimer) clearTimeout(serverTimer);
    if (cardTimer) clearTimeout(cardTimer);
    if (alertTimer) clearTimeout(alertTimer);
    if (rosterTimer) clearTimeout(rosterTimer);
    siteTimer = null;
    serverTimer = null;
    cardTimer = null;
    alertTimer = null;
    rosterTimer = null;
    stopResidentBoards();
    clientRef = null;
    /* The resident browsers and their caches go with the tracker. */
    source.closeSiteReloader().catch(() => {});
    source.closeSweepReloader().catch(() => {});
    source.closeResidentBoards().catch(() => {});
}

module.exports = {
    STAFF_ROLE_ID,
    BOT_OWNER_ID,
    COLOR,
    MODES,
    PERIODS,
    BOARD_CHANNELS,
    SITE_REFRESH_SECONDS,
    SITE_REFRESH_MINUTES,
    SITE_REFRESH_LABEL,
    SERVER_REFRESH_SECONDS,
    SERVER_REFRESH_MINUTES,
    SERVER_REFRESH_LABEL,
    BOARD_MODE,
    RESIDENT_ENABLED,
    RESIDENT_LIMIT,
    RESIDENT_POLL_SECONDS,
    RESIDENT_FPS,
    PUBLISH_MIN_MS,
    CARD_REFRESH_MINUTES,
    ROSTER_TIERS,
    ROSTER_REFRESH_SECONDS,
    ROSTER_REFRESH_LABEL,
    ALERT_COOLDOWN_MS,
    ENEMY_PING_COOLDOWN_MS,
    HIGH_SCORE_PING_THRESHOLD,
    SCORE_ALERT_GRACE_MS,
    startNetquelTracker,
    stopNetquelTracker,
    netquelLogPath: LOG_PATH,
    trackerDisabledReason: () => disabledReason,
    refresh,
    refreshSite,
    refreshServers,
    refreshCards,
    refreshRosters,
    rescheduleSite,
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
    refreshPlayerCards,
    scrapeLive,
    isNetquelStaff,
    boardIdentity,
    boardLabel,
    formatScore,
    periodLabel
};
