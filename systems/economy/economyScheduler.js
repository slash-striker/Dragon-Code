/*
 * Economy scheduler — nightly interest + auto-deposit, monthly taxes,
 * work/fish/mine cooldown pings, and birthday announcements.
 *
 * A single minute-ticker started once from index.js. Every scheduled job is
 * idempotent against a bot_meta stamp so a restart mid-day can never re-run
 * it for the same day/month.
 *
 * Commands store their cooldown ready-at as an absolute timestamp in
 * command_cooldowns.expiresAt (work/fish) or mining_profile.mineCooldown
 * (mine), so pings fire when that timestamp passes.
 */
const { EmbedBuilder } = require('discord.js');
const db = require('../../database');
const { logTransaction } = require('./transactionLogger');

// ---- Config ---------------------------------------------------------------
const SLASHDRAGON_ID = '1505829367631183963'; // bot bank account, excluded from interest/tax
const INTEREST_MIN_BALANCE = 10;
const INTEREST_RATE = 0.01; // 1% of bank, once per day
const EXEMPT_INTEREST_ROLE = '1508482485313474643';
const TAX_RATE = 0.05; // 5% of monthly income

/*
 * Tax recipients are ROLES, not fixed users: everyone holding the role at
 * payout time splits that role's share evenly. Roles with no members are
 * skipped entirely and their share is redistributed across the roles that
 * do have members.
 */
const TAX_RECIPIENT_ROLES = [
    { id: '1504365030877954162', label: 'Owner', share: 0.10 },
    { id: '1523376328144060597', label: 'President', share: 0.30 },
    { id: '1504365030877954161', label: 'Police Officers', share: 0.10 },
    { id: '1527531274007220326', label: 'Vice-President', share: 0.20 },
    { id: '1538388202853896233', label: 'Treasury', share: 0.10 },
    { id: '1538395434765127810', label: 'Treasury', share: 0.10 }
]; // 90% assigned; empty-role shares are redistributed among active roles.

const GUILD_ID = '1504365030877954158';
const BIRTHDAY_CHANNEL = '1504365033071706315';
const BIRTHDAY_ROLE = '1508368729719832708';

function metaGet(key) {
    const row = db.prepare('SELECT value FROM bot_meta WHERE key = ?').get(key);
    return row ? row.value : null;
}

function metaSet(key, value) {
    db.prepare(`INSERT INTO bot_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

function monthKey() {
    return new Date().toISOString().slice(0, 7);
}

function startOfMonthMs() {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/*
 * Taxes are a MONTH-END event: only true on the last calendar day (UTC).
 * The monthly stamp then keeps the rest of that day's ticks from re-running
 * it — so the cycle fires exactly once, at the end of the month.
 */
function isEndOfMonthWindow() {
    const now = new Date();
    const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    return now.getUTCDate() === lastDay;
}

// ---- Cooldown pings ---------------------------------------------------------
const PING_COMMANDS = {
    work: { label: 'Work', emoji: '💼' },
    fish: { label: 'Fish', emoji: '🎣' },
    mine: { label: 'Mine', emoji: '⛏️' }
};

/*
 * Stamp per cooldown cycle (command + user + readyAt), not per day — work
 * repeats every 30 minutes, so each finished cycle deserves its own ping.
 */
function isCyclePinged(command, userId, readyAt) {
    return Boolean(metaGet(`ping:done:${command}:${userId}:${readyAt}`));
}

/*
 * Ping subscriptions live in ping_subscriptions (userId, command, enabled).
 * A missing row means the user never bought that ping — never DM them.
 * A row with enabled = 0 means the ping is owned but muted via /toggle-ping.
 */
function pingEnabled(command, userId) {
    const row = db.prepare(
        'SELECT enabled FROM ping_subscriptions WHERE userId = ? AND command = ?'
    ).get(userId, command);
    return Boolean(row && row.enabled);
}

/*
 * mine: mining keeps its ready-at in mining_profile.mineCooldown (absolute ms).
 */
function getReadyAt(command, userId) {
    if (command === 'mine') {
        const row = db.prepare('SELECT mineCooldown FROM mining_profile WHERE userId = ?').get(userId);
        if (!row || !row.mineCooldown) return null;
        return Number(row.mineCooldown) || null;
    }
    const row = db.prepare(
        'SELECT expiresAt FROM command_cooldowns WHERE userId = ? AND command = ?'
    ).get(userId, command);
    return row ? Number(row.expiresAt) || null : null;
}

function checkCooldownPings(client) {
    const now = Date.now();
    for (const [command, cfg] of Object.entries(PING_COMMANDS)) {
        // Which users currently have a (recently) finished cooldown?
        let userIds = [];
        if (command === 'mine') {
            userIds = db.prepare(
                'SELECT userId FROM mining_profile WHERE mineCooldown > ? AND mineCooldown <= ?'
            ).all(now - 24 * 60 * 60 * 1000, now).map(r => r.userId);
        } else {
            userIds = db.prepare(
                'SELECT userId FROM command_cooldowns WHERE command = ? AND expiresAt > ? AND expiresAt <= ?'
            ).all(command, now - 24 * 60 * 60 * 1000, now).map(r => r.userId);
        }

        for (const userId of userIds) {
            if (!pingEnabled(command, userId)) continue;

            const readyAt = getReadyAt(command, userId);
            // Skip stale entries: cooldown finished more than 12h ago.
            if (!readyAt || now - readyAt > 12 * 60 * 60 * 1000) continue;
            if (isCyclePinged(command, userId, readyAt)) continue;

            client.users.fetch(userId).then(user => {
                const embed = new EmbedBuilder()
                    .setColor(0x00e5ff)
                    .setTitle(`${cfg.emoji} ${cfg.label.toUpperCase()} COOLDOWN COMPLETE`)
                    .setDescription([
                        '```',
                        `STATUS ..... READY`,
                        `COMMAND .... /${command}`,
                        `SINCE ...... ${new Date(readyAt).toISOString().slice(11, 16)} UTC`,
                        '```',
                        `Your ${cfg.label.toLowerCase()} cooldown just finished — jump back in!`
                    ].join('\n'))
                    .setFooter({ text: 'Notification Grid • toggle with /toggle-ping' })
                    .setTimestamp();
                return user.send({ embeds: [embed] });
            }).catch(() => {});

            metaSet(`ping:done:${command}:${userId}:${readyAt}`, String(now));
        }
    }
}

// ---- Interest + auto-deposit (nightly) ---------------------------------------
async function runDailyEconomy(client, now = new Date()) {
    // The 60-second ticker can catch the completed UTC day shortly after reset.
    const completedDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
    // Retry while the process is within the first five minutes after midnight;
    // a per-day stamp makes the wider window idempotent across restarts.
    if (now.getUTCHours() !== 0 || now.getUTCMinutes() > 5) {
        return { skipped: true, reason: 'not-end-of-day', interest: 0, interestUsers: 0, deposits: 0 };
    }
    const stamp = `econ:daily:${completedDay}`;
    if (metaGet(stamp)) return { skipped: true, interest: 0, interestUsers: 0, deposits: 0 };

    const exempt = client && client.guilds
        ? await collectRoleMembers(client, EXEMPT_INTEREST_ROLE)
        : new Set();

    let interestPaid = 0;
    let interestUsers = 0;

    const result = db.transaction(() => {
        // 1) Interest for every user above the floor (except the bot account
        //    and members holding the exemption role).
        const users = db.prepare(`
            SELECT userId, bank FROM users
            WHERE userId != ? AND CAST(bank AS REAL) > ?
        `).all(SLASHDRAGON_ID, INTEREST_MIN_BALANCE);

        for (const u of users) {
            if (exempt.has(u.userId)) continue;
            const gain = Math.floor(u.bank * INTEREST_RATE);
            if (gain <= 0) continue;
            db.prepare('UPDATE users SET bank = bank + ? WHERE userId = ?').run(gain, u.userId);
            logTransaction(u.userId, 'interest', gain, `Daily 1% interest on bank`);
            interestPaid += gain;
            interestUsers += 1;
        }

        // 2) Auto-deposit subscriptions: sweep the whole wallet into the bank.
        //    The service takes a 5% cut of every sweep, credited to slashdragon.
        let deposits = 0;
        const subs = db.prepare(`
            SELECT userId FROM auto_deposit_subscriptions
            WHERE expiresAt > ?
        `).all(Date.now());
        for (const sub of subs) {
            const w = db.prepare('SELECT wallet FROM users WHERE userId = ?').get(sub.userId);
            if (!w || !(w.wallet > 0)) continue;
            const fee = Math.floor(w.wallet * 0.05);          // slashdragon's cut
            const swept = w.wallet - fee;                     // what actually lands in the bank
            if (swept <= 0) continue;
            db.prepare('UPDATE users SET bank = bank + ?, wallet = 0 WHERE userId = ?')
                .run(swept, sub.userId);
            if (fee > 0) {
                db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(SLASHDRAGON_ID);
                db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(fee, SLASHDRAGON_ID);
                logTransaction(SLASHDRAGON_ID, 'auto_deposit_fee', fee, `5% auto-deposit fee from ${sub.userId}`);
            }
            logTransaction(sub.userId, 'auto_deposit', swept, `Nightly wallet sweep to bank (5% service fee applied)`);
            deposits += 1;
        }
        return deposits;
    })();

    metaSet(stamp, String(Date.now()));
    return { skipped: false, interest: interestPaid, interestUsers, deposits: result };
}

// ---- Monthly taxes -------------------------------------------------------------
/*
 * Taxes are an END-OF-MONTH event: 5% of each member's income for the month,
 * collected on the last calendar day (UTC). The pot is paid to the members
 * BEHIND the recipient roles — every holder of a role splits that role's
 * share evenly. A role with no holders is skipped and its share is
 * redistributed across the roles that do have members.
 */
async function runMonthlyTaxes(client) {
    // Only ever run on the last day of the month.
    if (!isEndOfMonthWindow()) return { skipped: true, reason: 'not-month-end' };

    const stamp = `econ:tax:${monthKey()}`;
    if (metaGet(stamp)) return { skipped: true };

    const startMs = startOfMonthMs();
    const rows = db.prepare(`
        SELECT userId, SUM(amount) AS earned
        FROM transactions
        WHERE amount > 0 AND timestamp >= ?
        GROUP BY userId
    `).all(startMs);

    let pot = 0;
    let taxpayers = 0;

    db.transaction(() => {
        for (const row of rows) {
            if (row.userId === SLASHDRAGON_ID) continue;
            const tax = Math.floor(row.earned * TAX_RATE);
            if (tax <= 0) continue;
            const account = db.prepare('SELECT wallet, bank FROM users WHERE userId = ?').get(row.userId);
            if (!account) continue;

            // Wallet first, then bank — and never below zero.
            const fromWallet = Math.min(account.wallet, tax);
            let remaining = tax - fromWallet;
            const fromBank = Math.min(account.bank, remaining);
            remaining -= fromBank;
            const collected = tax - remaining;
            if (collected <= 0) continue;

            db.prepare('UPDATE users SET wallet = ?, bank = ? WHERE userId = ?')
                .run(account.wallet - fromWallet, account.bank - fromBank, row.userId);
            logTransaction(row.userId, 'tax_paid', -collected,
                `Monthly income tax (${Math.round(TAX_RATE * 100)}% of ${Number(row.earned).toLocaleString()} earned)`);
            pot += collected;
            taxpayers += 1;
        }
    })();

    /*
     * Resolve the real people behind each recipient role right now, so a
     * role nobody holds pays nobody and its share moves to active roles.
     */
    const activeRoles = [];
    for (const role of TAX_RECIPIENT_ROLES) {
        const members = await collectRoleMembers(client, role.id);
        if (members.size > 0) activeRoles.push({ ...role, members });
    }

    const payoutLines = [];
    if (activeRoles.length > 0 && pot > 0) {
        const totalShare = activeRoles.reduce((sum, r) => sum + r.share, 0);
        db.transaction(() => {
            let distributed = 0;
            for (const role of activeRoles) {
                const amount = Math.floor(pot * (role.share / totalShare));
                if (amount <= 0) continue;
                const each = Math.floor(amount / role.members.size);
                for (const memberId of role.members) {
                    db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(memberId);
                    db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(each, memberId);
                    logTransaction(memberId, 'tax_share', each,
                        `Monthly tax share — ${role.label} role (${role.members.size} holder${role.members.size === 1 ? '' : 's'})`);
                }
                distributed += each * role.members.size;
                payoutLines.push(
                    `> <@&${role.id}> — **${role.members.size}** holder${role.members.size === 1 ? '' : 's'} × 🪙 ${each.toLocaleString()}` +
                    ` = 🪙 ${(each * role.members.size).toLocaleString()} paid`
                );
            }
            // Rounding remainder goes to one holder of the largest active share.
            const remainder = pot - distributed;
            if (remainder > 0) {
                const top = activeRoles.reduce((a, b) => (b.share > a.share ? b : a));
                const first = [...top.members][0];
                db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(remainder, first);
                logTransaction(first, 'tax_share', remainder, 'Monthly tax rounding remainder');
            }
        })();
    }

    metaSet(stamp, String(Date.now()));

    // Announce the collection (with the actual payouts) in the economy channel.
    announceTaxRun(client, pot, taxpayers, payoutLines);
    return { skipped: false, pot, taxpayers };
}

function announceTaxRun(client, pot, taxpayers, payoutLines = []) {
    if (taxpayers === 0) return; // nothing collected, nothing to announce
    try {
        const channelId = '1504562791967756448';
        const channel = client?.channels?.cache?.get(channelId);
        if (!channel) return;
        const body = [
            '```',
            `COLLECTED .. 🪙 ${pot.toLocaleString()}`,
            `TAXPAYERS .. ${taxpayers}`,
            '```',
            '**Disbursement:**',
            ...(payoutLines.length ? payoutLines : ['> No eligible role holders — pot withheld.'])
        ].join('\n');
        const embed = new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle('🏛️ MONTHLY TAX CYCLE COMPLETE')
            .setDescription(body)
            .setFooter({ text: "SLASH's YT Server Revenue Service" })
            .setTimestamp();
        channel.send({ embeds: [embed] }).catch(() => {});
    } catch (error) {
        console.error('Tax announcement failed:', error);
    }
}

// ---- Birthdays -----------------------------------------------------------------
function birthdaysToday() {
    const now = new Date();
    const md = `${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    return db.prepare('SELECT userId, year, birthday, note FROM birthdays WHERE substr(birthday, 6, 5) = ?').all(md);
}

async function runBirthdayJob(client) {
    const stamp = `birthday:sent:${todayKey()}`;
    if (metaGet(stamp)) return;
    metaSet(stamp, String(Date.now()));

    const guild = client?.guilds?.cache?.get(GUILD_ID) || null;
    const channel = client?.channels?.cache?.get(BIRTHDAY_CHANNEL) || null;
    const todays = birthdaysToday();

    for (const person of todays) {
        const member = guild ? guild.members.cache.get(person.userId) : null;
        const age = person.year ? new Date().getUTCFullYear() - person.year : null;

        if (channel) {
            const embed = new EmbedBuilder()
                .setColor(0xff69b4)
                .setTitle('🎂 BIRTHDAY DETECTED IN THE GRID')
                .setDescription([
                    `## 🎉 Happy Birthday, <@${person.userId}>!`,
                    '',
                    `Another orbit complete — the whole server celebrates you today.`,
                    age ? `Born **${person.year}** → **${age}** years of experience points.` : null,
                    person.note ? `📝 _${person.note}_` : null,
                    '',
                    '_Cake calories do not count inside the simulation._'
                ].filter(Boolean).join('\n'))
                .setFooter({ text: 'Automated celebration protocol' })
                .setTimestamp();
            channel.send({ content: `🎂 <@${person.userId}>`, embeds: [embed] }).catch(() => {});
        }

        if (guild && member) {
            member.roles.add(BIRTHDAY_ROLE, 'Birthday protocol').catch(() => {});
            metaSet(`birthday:role:${person.userId}`, todayKey());
        }
    }

    // Strip yesterday's birthday roles (and any older leftovers).
    const prefix = 'birthday:role:';
    const expired = db.prepare("SELECT key, value FROM bot_meta WHERE key LIKE ? AND value != ?")
        .all(`${prefix}%`, todayKey());
    for (const row of expired) {
        const userId = row.key.slice(prefix.length);
        const member = guild ? guild.members.cache.get(userId) : null;
        if (member) member.roles.remove(BIRTHDAY_ROLE, 'Birthday over').catch(() => {});
        db.prepare('DELETE FROM bot_meta WHERE key = ?').run(row.key);
    }
}

// ---- Role-member lookup (cached, avoids huge REST sweeps) ----------------------
let roleMemberCache = { at: 0, roleId: null, members: new Set() };
async function collectRoleMembers(client, roleId) {
    const now = Date.now();
    if (roleMemberCache.roleId === roleId && now - roleMemberCache.at < 10 * 60 * 1000) {
        return roleMemberCache.members;
    }
    const members = new Set();
    try {
        const guild = client?.guilds?.cache?.get(GUILD_ID);
        if (guild) {
            // Warm the member cache so cached role sweeps see the whole guild.
            await guild.members.fetch().catch(() => {});
            for (const [, member] of guild.members.cache) {
                if (member.roles.cache.has(roleId)) members.add(member.id);
            }
        }
    } catch (error) {
        console.error('Interest exemption role lookup failed:', error.message);
    }
    roleMemberCache = { at: now, roleId, members };
    return members;
}

// ---- Dragon Code expansion: events, drops and ladders ---------------------------
/*
 * Everything added by the Dragon Code expansion that has to happen on a clock
 * lives here: fishing tournaments, contrarian market rounds, flash deals,
 * credit capsules, the weekly economy snapshot, the weekly dragon race, the
 * Tic-Tac-Toe Elo promotion and reminder delivery.
 *
 * Every job is idempotent against either a bot_meta stamp or its own table
 * state, so the 60-second tick can call them unconditionally and a restart
 * mid-cycle can never double-pay.
 */
const ECONOMY_CHANNEL = '1504562791967756448';
let dragonJobsStarted = false;

function economyChannel(client) {
    return client?.channels?.cache?.get(ECONOMY_CHANNEL) || null;
}

async function runReminderDelivery(client) {
    let reminders;
    try {
        reminders = require('./reminders');
    } catch (error) {
        return 0;
    }
    const due = reminders.getDueReminders();
    let delivered = 0;
    for (const reminder of due) {
        const built = reminders.buildDueEmbed(reminder);
        const embed = new EmbedBuilder()
            .setColor(0x00e5ff)
            .setTitle(built.title || '⏰ REMINDER')
            .setDescription(built.description || reminder.message)
            .setFooter({ text: 'Set with /remind • this message is a one-off' })
            .setTimestamp();
        let sent = false;
        try {
            const user = await client.users.fetch(reminder.userId);
            await user.send({ content: `⏰ <@${reminder.userId}>`, embeds: [embed] });
            sent = true;
        } catch (error) {
            // DMs closed — fall back to the channel the reminder was set in.
            if (reminder.channelId) {
                try {
                    const channel = client.channels.cache.get(reminder.channelId)
                        || await client.channels.fetch(reminder.channelId).catch(() => null);
                    if (channel?.isTextBased?.()) {
                        await channel.send({ content: `⏰ <@${reminder.userId}>`, embeds: [embed] });
                        sent = true;
                    }
                } catch (inner) {
                    sent = false;
                }
            }
        }
        reminders.markDelivered(reminder.reminderId);
        if (sent) delivered += 1;
    }
    return delivered;
}

async function runFishingTournamentJob(client) {
    let tournaments;
    try {
        tournaments = require('./fishingTournament');
    } catch (error) {
        return;
    }
    const settled = tournaments.closeExpired();
    if (!settled.length) return;
    const channel = economyChannel(client);
    for (const result of settled) {
        if (!channel) continue;
        const lines = result.winners.length
            ? result.winners.map(winner => `> #${winner.place} <@${winner.userId}> — **${winner.score.toLocaleString()}** pts → 🪙${winner.prize.toLocaleString()}`)
            : ['> Nobody scored — the pot is withheld.'];
        channel.send({
            embeds: [new EmbedBuilder()
                .setColor(0xffd166)
                .setTitle('🏆 FISHING TOURNAMENT RESULTS')
                .setDescription([
                    `The derby closed with **${result.entrants}** angler(s).`,
                    '',
                    ...lines,
                    '',
                    `Pot paid out: 🪙${Number(result.pot).toLocaleString()}`
                ].join('\n'))
                .setFooter({ text: 'NEON ANGLERS ASSOCIATION' })
                .setTimestamp()]
        }).catch(() => {});
    }
}

async function runMarketRoundJob(client) {
    let marketPvp;
    try {
        marketPvp = require('./marketPvp');
    } catch (error) {
        return;
    }
    const settled = marketPvp.closeAndSettleExpired();
    const channel = economyChannel(client);
    for (const result of settled) {
        if (channel) {
            const winners = result.winners.length
                ? result.winners.map(winner => `> <@${winner.userId}> — 🪙${Number(winner.payout).toLocaleString()}${winner.contrarian ? ' 👑 **lone contrarian**' : ''}`)
                : ['> Nobody called it. The losing pool is withheld.'];
            channel.send({
                embeds: [new EmbedBuilder()
                    .setColor(0x9b59b6)
                    .setTitle('📈 MARKET ROUND SETTLED')
                    .setDescription([
                        `**${String(result.oreId).replace(/_/g, ' ')}** — ${Number(result.startPrice).toFixed(2)} → **${Number(result.endPrice).toFixed(2)}**`,
                        `Outcome: **${String(result.outcome).toUpperCase()}** · losing pool 🪙${Number(result.losingPool || 0).toLocaleString()}`,
                        '',
                        ...winners
                    ].join('\n'))
                    .setFooter({ text: 'Trade with /invest • contrarian payouts favour the minority' })
                    .setTimestamp()]
            }).catch(() => {});
        }
    }
    // Always keep exactly one round open so /invest is never a dead end.
    if (!marketPvp.getOpenRound()) marketPvp.openRound({});
}

async function runCapsuleJob(client) {
    let capsules;
    try {
        capsules = require('./capsuleDrops');
    } catch (error) {
        return;
    }
    await capsules.expireCapsules(client);
    if (!capsules.isCapsuleDue()) return;
    await capsules.spawnCapsule(client);
}

async function runFlashDealJob() {
    try {
        require('./flashDeals').rollDailyDeals();
    } catch (error) {
        console.error('Flash deal roll failed:', error.message);
    }
}

async function runWeeklyJob(client) {
    let racing;
    let ttt;
    let snapshot;
    let season;
    try { racing = require('./dragonRacing'); } catch (error) { racing = null; }
    try { ttt = require('./tttElo'); } catch (error) { ttt = null; }
    try { snapshot = require('./weeklySnapshot'); } catch (error) { snapshot = null; }
    try { season = require('./seasonalEvents'); } catch (error) { season = null; }

    // 🏁 Dragon race: settle it the moment its window closes, then open the next.
    if (racing) {
        const settled = racing.settleIfDue();
        if (settled && settled.winner) {
            const channel = economyChannel(client);
            if (channel) {
                const track = racing.getTrack(settled.trackId);
                channel.send({
                    embeds: [new EmbedBuilder()
                        .setColor(0xa855f7)
                        .setTitle(`🏁 ${track?.name || 'DRAGON CIRCUIT'} — FINAL RESULTS`)
                        .setDescription([
                            `🏆 **${settled.winner.name}** (<@${settled.winner.userId}>) wins in ${Number(settled.winner.time || 0).toFixed(2)}s!`,
                            '',
                            ...(settled.standings || []).slice(0, 5).map((entry, index) =>
                                `> \`#${index + 1}\` ${entry.name} — ${Number(entry.time || 0).toFixed(2)}s`),
                            '',
                            ...(settled.log || []).slice(-4),
                            '',
                            `Pot: 🪙${Number(settled.pot).toLocaleString()} · stud fee to the champion's owner: 🪙${Number(settled.championPayout || 0).toLocaleString()}`
                        ].join('\n'))
                        .setFooter({ text: 'Enter and bet from /profile → Dragon Racing' })
                        .setTimestamp()]
                }).catch(() => {});
            }
        }
        if (!racing.getCurrentRace()) racing.openRaceForWeek();
    }

    // 🏆 Elo promotion — idempotent per week inside the engine.
    if (ttt) {
        const promotion = ttt.runWeeklyPromotion();
        if (promotion?.promoted?.length) {
            const channel = economyChannel(client);
            if (channel) {
                channel.send({
                    embeds: [new EmbedBuilder()
                        .setColor(0xffd166)
                        .setTitle('🏆 TIC-TAC-TOE LADDER — WEEKLY PROMOTION')
                        .setDescription([
                            ...promotion.promoted.map(entry => `> #${entry.rank} <@${entry.userId}> — **${entry.elo}** Elo, promoted this week.`),
                            '',
                            '_Top of the ladder takes the weekly title. Play rated matches from /games → 🏆 Tic-Tac-Toe Ladder._'
                        ].join('\n'))
                        .setTimestamp()]
                }).catch(() => {});
            }
        }
    }

    // 📊 Snapshot posting is owned by runDragonExpansionJobs' five-minute
    // reset window so it cannot be missed between minute ticks.
    if (snapshot?.isSnapshotDue()) {
        await snapshot.postWeeklySnapshot(client);
    }

    // 🎁 Seasonal flavour line posted once a day when a season is live.
    if (season) {
        try {
            const active = season.getActiveSeason();
            if (active) {
                const stamp = `season:announce:${active.id}:${pad2(new Date().getUTCMonth() + 1)}-${pad2(new Date().getUTCDate())}`;
                if (!metaGet(stamp)) {
                    metaSet(stamp, String(Date.now()));
                    const channel = economyChannel(client);
                    if (channel) {
                        channel.send({
                            embeds: [new EmbedBuilder()
                                .setColor(0xff6b35)
                                .setTitle(`${active.emoji} ${String(active.name).toUpperCase()} — DAY ${active.dayIndex}`)
                                .setDescription([
                                    `${active.theme || 'The grid is dressed for the season.'}`,
                                    '',
                                    `**Days remaining:** ${active.daysRemaining}`,
                                    `**Yield multiplier:** ×${season.getSeasonalMultiplier('yield')}`,
                                    `**Credit bonus:** ×${season.getSeasonalMultiplier('credits').toFixed(2)}`,
                                    '',
                                    active.dailyGift ? '_Claim today’s gift from the seasonal panel in /profile._' : null
                                ].filter(Boolean).join('\n'))
                                .setTimestamp()]
                        }).catch(() => {});
                    }
                }
            }
        } catch (error) {
            console.error('Seasonal announcement failed:', error.message);
        }
    }
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

async function runDragonExpansionJobs(client) {
    await runReminderDelivery(client);
    await runFishingTournamentJob(client);
    await runMarketRoundJob(client);
    await runCapsuleJob(client);
    await runFlashDealJob();
    await runWeeklyJob(client);
    try {
        const snapshot = require('./weeklySnapshot');
        if (snapshot.isSnapshotDue()) await snapshot.postWeeklySnapshot(client);
    } catch (error) {
        console.error('Weekly snapshot job failed:', error.message);
    }
    try {
        require('./tradeManager').expireStale();
    } catch (error) {
        /* trade expiry is best effort */
    }
}

// ---- Ticker --------------------------------------------------------------------
let tickerStarted = false;
/*
 * Legacy cleanup — very old tax code credited wallets keyed by ROLE IDs
 * (President/VP/Police/Treasury/Owner). Those accounts are not people and
 * hold stale balances; remove them on boot so they never resurface in
 * balances, leaderboards, or interest. One-time idempotent sweep.
 */
function purgeLegacyRoleAccounts() {
    const legacyRoleIds = [
        '1523376328144060597', // President (role)
        '1504365030877954162', // Owner (role)
        '1527531274007220326', // Vice-President (role)
        '1504365030877954161', // Police Officers (role)
        '1538388202853896233', // Treasury (role)
        '1538395434765127810'  // Treasury (role)
    ];
    const info = db.prepare(
        `DELETE FROM users WHERE userId IN (${legacyRoleIds.map(() => '?').join(',')})`
    ).run(...legacyRoleIds);
    if (info.changes > 0) {
        console.log(`🧹 Purged ${info.changes} legacy role-keyed account(s) from users.`);
    }
    return info;
}

function startEconomyScheduler(client) {
    if (tickerStarted) return;
    tickerStarted = true;

    purgeLegacyRoleAccounts();

    const tick = async () => {
        try {
            await runDailyEconomy(client);
            await runMonthlyTaxes(client);
            await runBirthdayJob(client);
            await checkCooldownPings(client);
        } catch (error) {
            console.error('Economy scheduler tick failed:', error);
        }
        try {
            await runDragonExpansionJobs(client);
        } catch (error) {
            console.error('Dragon expansion scheduler tick failed:', error);
        }
    };

    tick();
    setInterval(tick, 60 * 1000);
}

module.exports = {
    startEconomyScheduler,
    runDragonExpansionJobs,
    runReminderDelivery,
    runDailyEconomy,
    runMonthlyTaxes,
    runBirthdayJob,
    birthdaysToday,
    getReadyAt,
    checkCooldownPings,
    pingEnabled,
    purgeLegacyRoleAccounts
};
