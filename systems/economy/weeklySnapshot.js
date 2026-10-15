/*
 * Weekly snapshot — "the week in Dragon Economy".
 *
 * Posted every Sunday night by the economy scheduler: credits moved, the
 * richest player, the most-robbed regular, the biggest fish, the strongest
 * mining guild, the top dragon, the good-vs-evil standings and the bounty
 * pool. Everything is a cheap aggregate query and every query is wrapped so a
 * missing table or column degrades to a null/zero line instead of throwing.
 *
 * Caveat worth knowing: logTransaction() trims each user's history to the last
 * 40 rows, so `creditsMoved` is a floor on real volume, not an exact total.
 * `snapshot:channel` (bot_meta) picks the target channel and
 * `snapshot:posted:<weekKey>` makes posting idempotent per week.
 */
const db = require('../../database');
const { EmbedBuilder } = require('discord.js');

const SNAPSHOT_CHANNEL_DEFAULT = '1504562791967756448';
const BOT_ACCOUNT_ID = '1505829367631183963';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function metaGet(key) {
    try {
        const row = db.prepare('SELECT value FROM bot_meta WHERE key = ?').get(key);
        return row ? row.value : null;
    } catch {
        return null;
    }
}

function metaSet(key, value) {
    try {
        db.prepare(`INSERT INTO bot_meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
    } catch (error) {
        console.error('Snapshot meta write failed:', error.message);
    }
}

function getSnapshotChannel() {
    return metaGet('snapshot:channel') || SNAPSHOT_CHANNEL_DEFAULT;
}

function setSnapshotChannel(channelId) {
    metaSet('snapshot:channel', channelId);
    return getSnapshotChannel();
}

/* ISO-ish week key: 'YYYY-Www' — stable for a whole week regardless of polls. */
function weekKey(date = new Date()) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function seasonKey(date = new Date()) {
    return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function safeGet(sql, params = []) {
    try {
        return db.prepare(sql).get(...params) || null;
    } catch {
        return null;
    }
}

function safeAll(sql, params = []) {
    try {
        return db.prepare(sql).all(...params);
    } catch {
        return [];
    }
}

function buildWeeklySnapshot(now = Date.now()) {
    const snapshotDate = new Date(now);
    const end = snapshotDate.getUTCDay() === 1 && snapshotDate.getUTCHours() === 0
        ? Date.UTC(snapshotDate.getUTCFullYear(), snapshotDate.getUTCMonth(), snapshotDate.getUTCDate())
        : now;
    const since = end - WEEK_MS;
    const sinceIso = new Date(since).toISOString();

    const moved = safeGet(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE amount > 0 AND timestamp >= ? AND timestamp < ?',
        [since, end]
    );

    const richest = safeGet(`
        SELECT userId, wallet, bank
        FROM users
        WHERE userId != ?
        ORDER BY (CAST(wallet AS INTEGER) + CAST(bank AS INTEGER)) DESC
        LIMIT 1
    `, [BOT_ACCOUNT_ID]);

    const robbed = safeGet(`
        SELECT userId, COUNT(*) AS hits, COALESCE(SUM(amount), 0) AS amount
        FROM transactions
        WHERE amount < 0 AND timestamp >= ? AND timestamp < ?
          AND (LOWER(COALESCE(type, '')) LIKE '%rob%' OR LOWER(COALESCE(description, '')) LIKE '%rob%')
        GROUP BY userId
        ORDER BY hits DESC
        LIMIT 1
    `, [since, end]);

    const biggestFish = safeGet(`
        SELECT userId, name, rarity, value, caughtAt
        FROM fishing_inventory
        WHERE caughtAt >= ? AND caughtAt < ?
        ORDER BY value DESC
        LIMIT 1
    `, [sinceIso, new Date(end).toISOString()]);

    const bestMiningGuild = safeGet(`
        SELECT name, totalOre, totalCredits
        FROM mining_guilds
        ORDER BY totalOre DESC
        LIMIT 1
    `);

    const topDragon = safeGet(`
        SELECT userId, name, speciesId, side, level, xp
        FROM dragons
        ORDER BY level DESC, xp DESC
        LIMIT 1
    `);

    const sideRows = safeAll('SELECT side, COUNT(*) AS total FROM dragons GROUP BY side');
    const sideStandings = { good: 0, evil: 0 };
    for (const row of sideRows) {
        if (row.side === 'good') sideStandings.good = Number(row.total || 0);
        if (row.side === 'evil') sideStandings.evil = Number(row.total || 0);
    }

    const weekEndingDate = new Date(end - 1);
    const week = weekKey(weekEndingDate);
    const season = seasonKey(weekEndingDate);

    const topMiners = safeAll(`
        SELECT userId, oreMined
        FROM mining_season_stats
        WHERE season = ?
        ORDER BY oreMined DESC
        LIMIT 3
    `, [season]);

    const bountyRow = safeGet('SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS holders FROM bounties');

    return {
        week,
        season,
        since,
        until: end,
        creditsMoved: Number(moved?.total || 0),
        richest: richest
            ? {
                userId: richest.userId,
                total: Number(richest.wallet || 0) + Number(richest.bank || 0)
            }
            : null,
        mostRobbed: robbed
            ? { userId: robbed.userId, hits: Number(robbed.hits || 0), amount: Math.abs(Number(robbed.amount || 0)) }
            : null,
        biggestFish: biggestFish
            ? {
                userId: biggestFish.userId,
                name: biggestFish.name,
                rarity: biggestFish.rarity,
                value: Number(biggestFish.value || 0)
            }
            : null,
        bestMiningGuild: bestMiningGuild
            ? {
                name: bestMiningGuild.name,
                totalOre: Number(bestMiningGuild.totalOre || 0),
                totalCredits: Number(bestMiningGuild.totalCredits || 0)
            }
            : null,
        topDragon: topDragon
            ? {
                userId: topDragon.userId,
                name: topDragon.name,
                speciesId: topDragon.speciesId,
                side: topDragon.side,
                level: Number(topDragon.level || 0)
            }
            : null,
        sideStandings,
        topMiners: topMiners.map(row => ({ userId: row.userId, oreMined: Number(row.oreMined || 0) })),
        bountyPool: {
            total: Number(bountyRow?.total || 0),
            holders: Number(bountyRow?.holders || 0)
        }
    };
}

function medal(index) {
    return ['🥇', '🥈', '🥉'][index] || '▪️';
}

/*
 * Plain-object embed payload (no discord.js) so the numbers can be unit
 * tested without a Discord client.
 */
function buildSnapshotEmbed(snapshot) {
    const lines = [
        `## 📊 Week ${snapshot.week} in the Dragon Economy`,
        '',
        `**🪙 ${snapshot.creditsMoved.toLocaleString()}** credits changed hands this week.`,
        '',
        snapshot.richest
            ? `👑 <@${snapshot.richest.userId}> sits on the largest hoard at **🪙 ${snapshot.richest.total.toLocaleString()}**.`
            : '👑 Nobody has banked a hoard yet — the throne is still empty.',
        snapshot.mostRobbed
            ? `🥷 <@${snapshot.mostRobbed.userId}> was robbed **${snapshot.mostRobbed.hits}** time(s), losing **🪙 ${snapshot.mostRobbed.amount.toLocaleString()}**. Watch your wallet.`
            : '🥷 A quiet week — nobody got robbed.',
        snapshot.topDragon
            ? `${snapshot.topDragon.side === 'evil' ? '👹' : '🐉'} The apex pet is **${snapshot.topDragon.name}** (Lv.${snapshot.topDragon.level}, <@${snapshot.topDragon.userId}>).`
            : '🥚 No dragons have hatched yet — the hatchery is still cold.'
    ];

    const fields = [];

    fields.push({
        name: '⚔️ Good vs Evil',
        value: `🐉 Dragonflight **${snapshot.sideStandings.good}** · 👹 Onslaught **${snapshot.sideStandings.evil}**`,
        inline: false
    });

    if (snapshot.biggestFish) {
        fields.push({
            name: '🎣 Biggest catch',
            value: `${snapshot.biggestFish.rarity} **${snapshot.biggestFish.name}** — 🪙 ${snapshot.biggestFish.value.toLocaleString()} by <@${snapshot.biggestFish.userId}>`,
            inline: false
        });
    }

    if (snapshot.bestMiningGuild) {
        fields.push({
            name: '⛏️ Best mining guild',
            value: `**${snapshot.bestMiningGuild.name}** — ${snapshot.bestMiningGuild.totalOre.toLocaleString()} ore banked (🪙 ${snapshot.bestMiningGuild.totalCredits.toLocaleString()})`,
            inline: false
        });
    }

    if (snapshot.topMiners.length) {
        fields.push({
            name: `🏆 Top miners — ${snapshot.season}`,
            value: snapshot.topMiners
                .map((miner, index) => `${medal(index)} <@${miner.userId}> — ${miner.oreMined.toLocaleString()} ore`)
                .join('\n'),
            inline: false
        });
    }

    fields.push({
        name: '💠 Bounty pool',
        value: snapshot.bountyPool.total > 0
            ? `🪙 ${snapshot.bountyPool.total.toLocaleString()} riding on ${snapshot.bountyPool.holders} head(s).`
            : 'No open bounties — everyone is being suspiciously nice.',
        inline: false
    });

    return {
        title: '📊 THE WEEK IN DRAGON ECONOMY',
        description: lines.join('\n'),
        fields
    };
}

/*
 * Post the snapshot once per week. Returns { ok:false, message } instead of
 * throwing whenever the channel is unavailable or the week already went out.
 */
async function postWeeklySnapshot(client, now = Date.now()) {
    const week = buildWeeklySnapshot(now).week;
    if (metaGet(`snapshot:posted:${week}`)) {
        return { ok: false, message: `The ${week} snapshot was already posted.`, week };
    }

    let channel = null;
    try {
        channel = await client?.channels?.fetch(getSnapshotChannel());
    } catch {
        channel = null;
    }
    if (!channel || !channel.isTextBased?.()) {
        return { ok: false, message: 'The snapshot channel is unavailable.', week };
    }

    const snapshot = buildWeeklySnapshot(now);
    const payload = buildSnapshotEmbed(snapshot);
    const embed = new EmbedBuilder()
        .setColor(0xffaa00)
        .setTitle(payload.title)
        .setDescription(payload.description)
        .setFooter({ text: `Week ${week} • Dragon Economy Core` })
        .setTimestamp();
    if (payload.fields.length) embed.addFields(payload.fields);

    try {
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
        return { ok: false, message: `Could not post the snapshot: ${error.message}`, week };
    }

    metaSet(`snapshot:posted:${week}`, String(now));
    return { ok: true, message: `Posted the ${week} snapshot.`, week };
}

/* Monday 00:00 UTC reset boundary; report the week that just ended. */
function isSnapshotDue(now = Date.now(), date = new Date(now)) {
    if (date.getUTCDay() !== 1 || date.getUTCHours() !== 0 || date.getUTCMinutes() > 59) return false;
    return !metaGet(`snapshot:posted:${weekKey(new Date(date.getTime() - 1))}`);
}

module.exports = {
    SNAPSHOT_CHANNEL_DEFAULT,
    BOT_ACCOUNT_ID,
    getSnapshotChannel,
    setSnapshotChannel,
    weekKey,
    seasonKey,
    buildWeeklySnapshot,
    buildSnapshotEmbed,
    postWeeklySnapshot,
    isSnapshotDue
};
