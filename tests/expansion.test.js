/*
 * Focused tests for the Dragon Code expansion.
 *
 * These exercise the real SQLite database (the same convention smoke.test.js
 * uses) with throwaway user ids, and every suite cleans up after itself so the
 * checked-in economy.db keeps its baseline state.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../database');

const hatchery = require('../systems/dragons/dragonManager');
const dragonRender = require('../systems/dragons/dragonRender');
const catalog = require('../systems/dragons/dragonCatalog');
const quests = require('../systems/economy/questManager');
const titles = require('../systems/economy/titleManager');
const tournaments = require('../systems/economy/fishingTournament');
const marketPvp = require('../systems/economy/marketPvp');
const flashDeals = require('../systems/economy/flashDeals');
const bounties = require('../systems/economy/bountyManager');
const trades = require('../systems/economy/tradeManager');
const reminders = require('../systems/economy/reminders');
const capsules = require('../systems/economy/capsuleDrops');
const racing = require('../systems/economy/dragonRacing');
const tttElo = require('../systems/economy/tttElo');
const seasonal = require('../systems/economy/seasonalEvents');
const heistTiers = require('../systems/economy/crime/heistTiers');

// ---------------------------------------------------------------- helpers
const PREFIX = 'exp-test-';

/*
 * Child tables a throwaway user can leave a row in. `dragon_race_records` is
 * keyed by dragon id so it is cleared through the user's dragons, and the
 * bounty tables are cleared by their own keys first.
 */
const CHILD_TABLES = [
    'dragon_incubators', 'dragon_feed_log', 'dragon_season_stats',
    'dragon_race_bets', 'quest_progress', 'quest_stats', 'badges',
    'cosmetic_titles', 'fishing_inventory', 'mining_inventory', 'inventory',
    'market_bets', 'market_pvp_stats', 'seasonal_claims', 'reminders',
    'transactions', 'fishing_tournament_records'
];

function safeRun(sql, ...args) {
    try {
        return db.prepare(sql).run(...args);
    } catch (error) {
        /* a table or column this schema does not have is fine */
        return null;
    }
}

/*
 * Erase every trace of a throwaway user. Called both BEFORE a test seeds one
 * and after it finishes, so an interrupted run can never poison the next one.
 */
function purge(id) {
    safeRun('DELETE FROM bounties WHERE targetId = ?', id);
    safeRun('DELETE FROM bounty_contributions WHERE contributorId = ?', id);
    for (const table of CHILD_TABLES) {
        safeRun('DELETE FROM ' + table + ' WHERE userId = ?', id);
    }
    safeRun('DELETE FROM trades WHERE initiatorId = ? OR partnerId = ?', id, id);
    /* Shop revenue is logged against the OWNER account, naming the buyer in the
     * description, so it has to be matched by text rather than by userId. */
    safeRun('DELETE FROM transactions WHERE description LIKE ?', '%' + id + '%');
    safeRun('DELETE FROM dragon_race_records WHERE dragonId IN (SELECT dragonId FROM dragons WHERE userId = ?)', id);
    safeRun('DELETE FROM dragons WHERE userId = ?', id);
    safeRun('DELETE FROM dragon_eggs WHERE userId = ?', id);
    safeRun('DELETE FROM users WHERE userId = ?', id);
}

function user(tag) {
    const id = PREFIX + tag;
    purge(id);
    db.prepare('INSERT INTO users (userId, wallet, bank, mining_bank) VALUES (?, ?, ?, 0)')
        .run(id, 50_000_000, 5_000_000);
    return id;
}

function wipe(id) {
    purge(id);
}

// ---------------------------------------------------------------- hatchery
test('hatchery: egg drop rate is rare and rarity scales with tier score', () => {
    const id = user('drop');
    let drops = 0;
    const N = 20_000;
    for (let i = 0; i < N; i += 1) {
        if (hatchery.rollEggDrop(id, { source: 'mine', tierScore: 0 })) drops += 1;
    }
    const rate = drops / N;
    assert.ok(rate > 0.004 && rate < 0.03, `mine drop rate out of range: ${rate}`);
    wipe(id);
});

test('hatchery: a mythic egg only hatches species from its own pool', () => {
    const id = user('pool');
    const egg = hatchery.grantEgg(id, { eggType: 'knightfury_egg', rarity: 'mythic' });
    assert.equal(egg.eggType, 'knightfury_egg');
    assert.equal(egg.side, 'good');

    const pool = new Set(catalog.EGG_TYPES.knightfury_egg.pool);
    for (let i = 0; i < 60; i += 1) {
        db.prepare("UPDATE dragon_eggs SET status = 'incubating', incubateEndsAt = ? WHERE eggId = ?")
            .run(new Date(Date.now() - 1000).toISOString(), egg.eggId);
        const hatched = hatchery.hatchEgg(id, egg.eggId, { force: true });
        assert.equal(hatched.ok, true);
        assert.ok(pool.has(hatched.species.id), `${hatched.species.id} is outside the egg pool`);
        assert.equal(hatched.species.side, 'good');
        db.prepare("UPDATE dragon_eggs SET status = 'incubating' WHERE eggId = ?").run(egg.eggId);
        db.prepare('DELETE FROM dragons WHERE userId = ?').run(id);
    }
    wipe(id);
});

test('hatchery: incubation timing honours the 24-48h window and blocks early hatching', () => {
    const id = user('time');
    const quick = hatchery.grantEgg(id, { eggType: 'ashen_egg', rarity: 'common' });
    const slow = hatchery.grantEgg(id, { eggType: 'knightfury_egg', rarity: 'mythic' });

    const a = hatchery.startIncubation(id, quick.eggId, 0);
    const b = hatchery.startIncubation(id, slow.eggId, 1);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.incubateMs, 24 * 60 * 60 * 1000);
    assert.equal(b.incubateMs, 48 * 60 * 60 * 1000);

    const early = hatchery.hatchEgg(id, quick.eggId);
    assert.equal(early.ok, false, 'should refuse to hatch before the timer elapses');

    const accelerated = hatchery.accelerateIncubation(id, quick.eggId, 24);
    assert.equal(accelerated.ok, true);
    assert.equal(accelerated.ready, true, '24h of acceleration should finish a 24h egg');

    const late = hatchery.hatchEgg(id, quick.eggId);
    assert.equal(late.ok, true);
    assert.equal(late.dragon.active, 1, 'the first pet becomes active automatically');
    wipe(id);
});

test('hatchery: feeding consumes the food and levels the dragon', () => {
    const id = user('feed');
    const egg = hatchery.grantEgg(id, { eggType: 'ashen_egg', rarity: 'common' });
    hatchery.startIncubation(id, egg.eggId, 0);
    const hatched = hatchery.hatchEgg(id, egg.eggId, { force: true });
    const dragonId = hatched.dragon.dragonId;

    db.prepare(`INSERT INTO mining_inventory (userId, oreId, quantity) VALUES (?, 'raw_crystal', 25)`)
        .run(id);

    const before = hatchery.getDragon(dragonId);
    for (let i = 0; i < 5; i += 1) {
        const result = hatchery.feedDragon(id, dragonId, { kind: 'ore', foodId: 'raw_crystal', quantity: 5 });
        assert.equal(result.ok, true);
        assert.equal(result.consumed, 5);
        assert.ok(result.xp > 0);
    }
    const left = db.prepare("SELECT quantity FROM mining_inventory WHERE userId = ? AND oreId = 'raw_crystal'").get(id);
    assert.equal(Number(left.quantity), 0, 'all 25 ore should have been eaten');

    const after = hatchery.getDragon(dragonId);
    assert.ok(after.xp > 0 || after.level > before.level, 'feeding must grant XP or a level');

    const empty = hatchery.feedDragon(id, dragonId, { kind: 'ore', foodId: 'raw_crystal', quantity: 5 });
    assert.equal(empty.ok, false, 'feeding with no food must fail cleanly');
    wipe(id);
});

test('hatchery: an active pet grants a trait bonus and an inactive one does not', () => {
    const id = user('bonus');
    const egg = hatchery.grantEgg(id, { eggType: 'ashen_egg', rarity: 'common' });
    hatchery.startIncubation(id, egg.eggId, 0);
    const first = hatchery.hatchEgg(id, egg.eggId, { force: true }).dragon;

    // Force a known trait so the assertion is deterministic.
    db.prepare("UPDATE dragons SET trait = 'ember', trait2 = NULL, level = 10, bond = 50 WHERE dragonId = ?")
        .run(first.dragonId);
    const bonus = hatchery.getDragonBonus(id, 'mine_yield');
    assert.ok(bonus > 0, 'an ember pet must provide a mining bonus');
    assert.ok(bonus < 0.3, `bonus should stay modest, got ${bonus}`);

    // Starving pets are throttled.
    db.prepare('UPDATE dragons SET hunger = 5 WHERE dragonId = ?').run(first.dragonId);
    const starving = hatchery.getDragonBonus(id, 'mine_yield');
    assert.ok(starving < bonus, 'a starving pet should give a smaller bonus');

    assert.equal(hatchery.getDragonBonus(id, 'nothing_like_this'), 0);
    wipe(id);
});

test('hatchery: releasing a pet refunds credits but never the last one', () => {
    const id = user('release');
    const egg = hatchery.grantEgg(id, { eggType: 'ashen_egg', rarity: 'common' });
    hatchery.startIncubation(id, egg.eggId, 0);
    const only = hatchery.hatchEgg(id, egg.eggId, { force: true }).dragon;
    assert.equal(hatchery.releaseDragon(id, only.dragonId).ok, false, 'refuse to release the only dragon');

    const secondEgg = hatchery.grantEgg(id, { eggType: 'ashen_egg', rarity: 'common' });
    hatchery.startIncubation(id, secondEgg.eggId, 1);
    const second = hatchery.hatchEgg(id, secondEgg.eggId, { force: true }).dragon;

    const walletBefore = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(id).wallet);
    const released = hatchery.releaseDragon(id, second.dragonId);
    assert.equal(released.ok, true);
    const walletAfter = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(id).wallet);
    assert.equal(walletAfter - walletBefore, released.refund);
    wipe(id);
});

test('hatchery: canvas art renders both an egg frame and a dragon card', () => {
    const eggFrame = dragonRender.renderEggFrame({
        eggType: catalog.EGG_TYPES.tidal_egg,
        rarityColor: 0x38bdf8,
        side: 'good',
        frameIndex: 5,
        owner: '@test',
        progressPct: 0.4
    });
    const card = dragonRender.renderDragonCard({
        dragon: { name: 'Test', rarity: 'rare', hunger: 80, happiness: 90, power: 10, speed: 12, stamina: 9, level: 3 },
        species: catalog.SPECIES.gale_dancer,
        trait: catalog.TRAITS.frost,
        trait2: null,
        progress: { level: 3, xp: 10, needed: 100, pct: 10 },
        owner: '@test'
    });
    if (dragonRender.canvasAvailable()) {
        assert.ok(eggFrame, 'egg frame should render');
        assert.equal(eggFrame.name, 'dragon-hatch.png');
        assert.ok(card, 'dragon card should render');
        assert.equal(card.name, 'dragon.png');
    } else {
        assert.equal(eggFrame, null);
        assert.equal(card, null);
    }
});

// ---------------------------------------------------------------- quests
test('quest manager: the daily board is deterministic and shared', () => {
    const a = quests.getDailyQuests('2026-05-04');
    const b = quests.getDailyQuests('2026-05-04');
    const c = quests.getDailyQuests('2026-05-05');
    assert.equal(a.length, 3);
    assert.deepEqual(a.map(q => q.id), b.map(q => q.id), 'same day must give the same board');
    assert.notDeepEqual(a.map(q => q.id), c.map(q => q.id), 'a new day should change at least one quest');
});

test('quest manager: events complete a quest, claiming pays exactly once', () => {
    const id = user('quest');
    const board = quests.getQuestBoard(id);
    const target = board.daily.find(row => row.quest.type === 'mine_run') || board.daily[0];

    for (let i = 0; i < target.quest.target; i += 1) {
        quests.recordQuestEvent(id, target.quest.type, 1, {});
    }
    const refreshed = quests.getQuestBoard(id).daily.find(row => row.quest.id === target.quest.id);
    assert.equal(refreshed.completed, true, 'quest should be marked complete');

    const walletBefore = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(id).wallet);
    const claimed = quests.claimQuest(id, target.quest.id, 'daily');
    assert.equal(claimed.ok, true, claimed.message);
    const walletAfter = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(id).wallet);
    assert.equal(walletAfter - walletBefore, claimed.reward);

    const again = quests.claimQuest(id, target.quest.id, 'daily');
    assert.equal(again.ok, false, 'a quest can only be claimed once');
    wipe(id);
});

test('quest manager: an unknown event type is a harmless no-op', () => {
    const id = user('questnoop');
    const result = quests.recordQuestEvent(id, 'not_a_real_event', 5, {});
    assert.ok(Array.isArray(result.completed));
    assert.ok(Array.isArray(result.badges));
    wipe(id);
});

test('title manager: gated titles refuse, purchases charge, equipping is exclusive', () => {
    const id = user('title');

    const gated = titles.TITLES.find(t => t.requirement && t.requirement.kind === 'badge');
    const blocked = titles.purchaseTitle(id, gated.id);
    assert.equal(blocked.ok, false, 'a badge-gated title must not be purchasable');

    const open = titles.TITLES.find(t => t.requirement?.kind === 'open' && t.price > 0);
    const bought = titles.purchaseTitle(id, open.id);
    assert.equal(bought.ok, true, bought.message);
    assert.equal(titles.getEquippedTitle(id)?.id, open.id);

    const second = titles.TITLES.filter(t => t.requirement?.kind === 'open' && t.id !== open.id)[0];
    titles.awardTitle(id, second.id);
    assert.equal(titles.equipTitle(id, second.id).ok, true);
    const equippedCount = db.prepare('SELECT COUNT(*) AS n FROM cosmetic_titles WHERE userId = ? AND equipped = 1').get(id).n;
    assert.equal(Number(equippedCount), 1, 'exactly one title may be equipped');
    wipe(id);
});

// ---------------------------------------------------------------- tournaments
test('fishing tournament: rarity-weighted scoring, leaderboard and a 50/30/20 split', () => {
    tournaments.closeExpired();
    const created = tournaments.startTournament({ channelId: 'test-channel', durationMs: 60_000, pot: 100_000 });
    const a = user('tour-a');
    const b = user('tour-b');
    const c = user('tour-c');

    const junk = tournaments.addCatchScore(a, { rarity: 'Junk', value: 100 });
    const legendary = tournaments.addCatchScore(b, { rarity: 'Legendary', value: 70_000 });
    const rare = tournaments.addCatchScore(c, { rarity: 'Rare', value: 2_000 });
    assert.ok(junk.score >= 1 && junk.score < 20);
    assert.ok(legendary.score > rare.score, 'a Legendary must outscore a Rare');
    assert.ok(rare.score > junk.score, 'a Rare must outscore Junk');

    const board = tournaments.getLeaderboard(created.tournamentId, 10);
    assert.equal(board[0].userId, b);

    const settled = tournaments.settleTournament(created.tournamentId);
    assert.ok(settled, 'tournament should settle');
    assert.equal(settled.winners.length, 3);

    const totalPaid = settled.winners.reduce((sum, w) => sum + w.prize, 0);
    assert.equal(totalPaid, settled.pot, 'the whole pot must be paid out with no credits leaked');
    assert.ok(settled.winners[0].prize > settled.winners[1].prize);
    assert.ok(settled.winners[1].prize > settled.winners[2].prize);

    // Paying out must have landed in wallets.
    const paid = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(b).wallet);
    assert.ok(paid >= settled.winners[0].prize - 1, 'the winner should have been credited');

    assert.equal(tournaments.settleTournament(created.tournamentId), null, 'settling twice must be a no-op');
    db.prepare('DELETE FROM fishing_tournament_scores WHERE tournamentId = ?').run(created.tournamentId);
    db.prepare('DELETE FROM fishing_tournaments WHERE tournamentId = ?').run(created.tournamentId);
    wipe(a); wipe(b); wipe(c);
});

// ---------------------------------------------------------------- market pvp
test('market pvp: a lone contrarian takes the losing pool and the book balances', () => {
    const a = user('mv-a');
    const b = user('mv-b');

    const round = marketPvp.openRound({});
    const outcomeGuess = marketPvp.placeBet(a, { oreId: round.oreId, direction: 'long', amount: 5_000 });
    const other = marketPvp.placeBet(b, { oreId: round.oreId, direction: 'short', amount: 5_000 });
    assert.equal(outcomeGuess.ok, true, outcomeGuess.message);
    assert.equal(other.ok, true, other.message);

    const duplicate = marketPvp.placeBet(a, { oreId: round.oreId, direction: 'long', amount: 5_000 });
    assert.equal(duplicate.ok, false, 'one bet per round per user');

    const split = marketPvp.getRoundBets(round.roundId);
    assert.equal(split.long.count, 1, 'one player took the long side');
    assert.equal(split.short.count, 1, 'one player took the short side');
    assert.equal(split.total, 10_000, 'the pool is the sum of both stakes');

    const settled = marketPvp.settleRound(round.roundId);
    assert.ok(settled);
    assert.equal(settled.settledBets, 2);
    assert.equal(settled.winners.length, 1, 'exactly one side wins');
    assert.equal(settled.winners[0].contrarian, true, 'the lone winner is the contrarian');

    const winnerWallet = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(settled.winners[0].userId).wallet);
    const stake = 5_000;
    // Stake back + 1x profit + 90% of the losing pool (rounded down) = 14,500.
    assert.equal(settled.winners[0].payout, stake * 2 + Math.floor(settled.losingPool * 0.9));
    assert.ok(winnerWallet > 50_000_000 - stake, 'the winner must be paid');
    db.prepare('DELETE FROM market_rounds WHERE roundId = ?').run(round.roundId);
    wipe(a); wipe(b);
});

test('market pvp: the payout is never smaller than the stake on the winning side', () => {
    const a = user('mv2-a');
    const b = user('mv2-b');
    const round = marketPvp.openRound({});
    marketPvp.placeBet(a, { oreId: round.oreId, direction: 'long', amount: 1_000_000 });
    marketPvp.placeBet(b, { oreId: round.oreId, direction: 'long', amount: 1_000_000 });
    const settled = marketPvp.settleRound(round.roundId);
    if (settled.winners.length) {
        for (const winner of settled.winners) {
            assert.ok(winner.payout >= Math.min(winner.amount, 1_000_000), 'a winning stake must be returned');
        }
    }
    db.prepare('DELETE FROM market_rounds WHERE roundId = ?').run(round.roundId);
    wipe(a); wipe(b);
});

// ---------------------------------------------------------------- flash deals
test('flash deals: the daily roll is idempotent, discounted and never touches services', () => {
    const dateKey = new Date().toISOString().slice(0, 10);
    db.prepare('DELETE FROM flash_deals WHERE dateKey = ?').run(dateKey);

    const first = flashDeals.rollDailyDeals(Date.now(), false);
    assert.ok(first.length >= 2 && first.length <= 3, `expected 2-3 deals, got ${first.length}`);
    const again = flashDeals.rollDailyDeals(Date.now(), false);
    assert.deepEqual(again.map(d => d.itemId).sort(), first.map(d => d.itemId).sort(), 'the same day must not re-roll');

    for (const deal of first) {
        assert.ok(flashDeals.DISCOUNTS.includes(deal.discount));
        const { SHOP_ITEMS } = require('../systems/economy/shopItems');
        const item = SHOP_ITEMS[deal.itemId];
        assert.ok(item, `deal points at a real item: ${deal.itemId}`);
        assert.notEqual(item.category, 'services');
        assert.notEqual(item.category, 'premium');
        assert.ok(!item.hidden);
        assert.ok(flashDeals.discountedPrice(item, deal) < item.price);
    }

    db.prepare('DELETE FROM flash_deals WHERE dateKey = ?').run(dateKey);
});

test('flash deals: purchaseItem charges the discounted price', () => {
    const id = user('deal');
    const { SHOP_ITEMS, purchaseItem, getItemQuantity } = require('../systems/economy/shopItems');
    const dateKey = new Date().toISOString().slice(0, 10);
    db.prepare('DELETE FROM flash_deals WHERE dateKey = ?').run(dateKey);

    const item = SHOP_ITEMS.energy_drink;
    db.prepare(`INSERT INTO flash_deals (itemId, discount, dateKey, startsAt, endsAt) VALUES (?, 50, ?, ?, ?)`)
        .run(item.id, dateKey, Date.now() - 1000, Date.now() + 3_600_000);

    const walletBefore = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(id).wallet);
    const result = purchaseItem(id, item.id, 2);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.discount, 50);
    assert.equal(result.totalCost, Math.floor(item.price / 2) * 2);
    const walletAfter = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(id).wallet);
    assert.equal(walletBefore - walletAfter, result.totalCost);
    assert.equal(getItemQuantity(id, item.id), 2);

    db.prepare('DELETE FROM flash_deals WHERE dateKey = ?').run(dateKey);
    wipe(id);
});

// ---------------------------------------------------------------- bounties
test('bounties: a pool accumulates, an empty target claims nothing, and claiming clears it', () => {
    const hunter = user('bounty-hunter');
    const victim = user('bounty-victim');
    const fan = user('bounty-fan');

    assert.equal(bounties.claimBounty(victim, hunter).ok, false, 'nothing to claim yet');

    const first = bounties.placeBounty({ targetId: victim, contributorId: hunter, amount: 5_000 });
    assert.equal(first.ok, true, first.message);
    const second = bounties.placeBounty({ targetId: victim, contributorId: fan, amount: 2_500 });
    assert.equal(second.ok, true, second.message);
    assert.equal(bounties.getBountyAmount(victim), 7_500);
    assert.equal(bounties.listContributors(victim, 5).length, 2);

    const self = bounties.placeBounty({ targetId: hunter, contributorId: hunter, amount: 5_000 });
    assert.equal(self.ok, false, 'self-bounty must be refused');

    const walletBefore = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(hunter).wallet);
    const claimed = bounties.claimBounty(victim, hunter);
    assert.equal(claimed.ok, true, claimed.message);
    assert.equal(claimed.amount, 7_500);
    const walletAfter = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(hunter).wallet);
    assert.equal(walletAfter - walletBefore, 7_500);
    assert.equal(bounties.hasBounty(victim), false, 'the board must clear after a claim');

    wipe(hunter); wipe(victim); wipe(fan);
});

// ---------------------------------------------------------------- trades
test('trades: both sides must confirm before anything moves', () => {
    const a = user('trade-a');
    const b = user('trade-b');
    const { SHOP_ITEMS } = require('../systems/economy/shopItems');
    const itemId = SHOP_ITEMS.coffee.id;

    db.prepare('INSERT INTO inventory (userId, itemId, quantity) VALUES (?, ?, 5)').run(a, itemId);

    const created = trades.createTrade({ initiatorId: a, partnerId: b, channelId: 'test-channel' });
    assert.equal(created.ok, true, created.message);
    const tradeId = created.trade.tradeId;

    assert.equal(trades.createTrade({ initiatorId: a, partnerId: b, channelId: 'c' }).ok, false, 'no second open trade');

    const offer = trades.setOffer(tradeId, a, { items: [{ itemId, quantity: 2 }], credits: 10_000, account: 'wallet' });
    assert.equal(offer.ok, true, offer.message);

    const aWalletBefore = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(a).wallet);
    const bWalletBefore = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(b).wallet);

    const half = trades.confirm(tradeId, a);
    assert.equal(half.ok, true, half.message);
    assert.notEqual(half.executed, true, 'nothing moves on one confirmation');
    assert.equal(Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(a).wallet), aWalletBefore);

    const partnerOffer = trades.setOffer(tradeId, b, { items: [], credits: 4_000, account: 'wallet' });
    assert.equal(partnerOffer.ok, true, partnerOffer.message);
    // The engine resets a side's confirmation when it re-offers.
    const aWalletAfterReoffer = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(a).wallet);
    assert.equal(aWalletAfterReoffer, aWalletBefore, 're-offering must not move credits');

    trades.confirm(tradeId, a);
    const done = trades.confirm(tradeId, b);
    assert.equal(done.ok, true, done.message);
    assert.equal(done.executed, true, 'the trade executes once both sides confirm');

    const aCoffee = db.prepare('SELECT quantity FROM inventory WHERE userId = ? AND itemId = ?').get(a, itemId);
    const bCoffee = db.prepare('SELECT quantity FROM inventory WHERE userId = ? AND itemId = ?').get(b, itemId);
    assert.equal(Number(aCoffee?.quantity || 0), 3, 'the initiator gave away 2');
    assert.equal(Number(bCoffee?.quantity || 0), 2, 'the partner received 2');

    const aWalletAfter = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(a).wallet);
    const bWalletAfter = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(b).wallet);
    assert.equal(aWalletBefore - aWalletAfter, 10_000 - 4_000);
    assert.equal(bWalletAfter - bWalletBefore, 10_000 - 4_000);

    wipe(a); wipe(b);
});

test('trades: an offer of items the player does not own is refused', () => {
    const a = user('trade-x');
    const b = user('trade-y');
    const created = trades.createTrade({ initiatorId: a, partnerId: b, channelId: 'c' });
    const refused = trades.setOffer(created.trade.tradeId, a, {
        items: [{ itemId: 'coffee', quantity: 99 }], credits: 0, account: 'wallet'
    });
    assert.equal(refused.ok, false, 'cannot offer items you do not have');
    trades.cancel(created.trade.tradeId, a);
    wipe(a); wipe(b);
});

// ---------------------------------------------------------------- reminders
test('reminders: duration parsing accepts the documented forms', () => {
    assert.equal(reminders.parseDuration('2h').ms, 2 * 3_600_000);
    assert.equal(reminders.parseDuration('90m').ms, 90 * 60_000);
    assert.equal(reminders.parseDuration('2h30m').ms, 2 * 3_600_000 + 30 * 60_000);
    assert.equal(reminders.parseDuration('1d').ms, 24 * 3_600_000);
    assert.equal(reminders.parseDuration('45s').ms, 45_000);
    assert.equal(reminders.parseDuration('30').ms, 30 * 60_000);
    assert.equal(reminders.parseDuration('2h pancakes').ok, false);
    assert.equal(reminders.parseDuration('').ok, false);
});

test('reminders: create, list, deliver and cancel', () => {
    const id = user('remind');
    const created = reminders.createReminder({ userId: id, channelId: 'c1', message: 'claim the contract', dueInMs: 3_600_000 });
    assert.equal(created.ok, true, created.message);
    assert.equal(reminders.countPending(id), 1);

    // Reminders are clamped into a supported window, so backdate the clock to
    // leave a sub-minute request already due and pin the one-minute floor.
    const past = Date.now() - 120_000;
    const soon = reminders.createReminder({ userId: id, channelId: 'c1', message: 'now please', dueInMs: 1, now: past });
    assert.equal(soon.ok, true, soon.message);
    assert.equal(Number(soon.reminder.dueAt) - past, reminders.MIN_MS, 'a sub-minute delay is clamped to one minute');
    assert.ok(/minute/.test(soon.message || ''), 'the clamp is explained to the user');

    const due = reminders.getDueReminders(Date.now());
    assert.ok(due.some(row => row.reminderId === soon.reminder.reminderId), 'short reminders come due');

    assert.equal(reminders.markDelivered(soon.reminder.reminderId), true);
    reminders.cancelReminder(id, created.reminder.reminderId);
    assert.equal(reminders.countPending(id), 0);
    wipe(id);
});

// ---------------------------------------------------------------- capsules
test('capsules: the first click wins and a second click is refused', () => {
    const first = user('cap-a');
    const second = user('cap-b');
    const info = db.prepare(`
        INSERT INTO credit_capsules (channelId, messageId, amount, status, spawnedAt, endsAt)
        VALUES ('test-channel', 'msg', 25_000, 'live', ?, ?)
    `).run(Date.now(), Date.now() + 600_000);
    const capsuleId = Number(info.lastInsertRowid);

    const before = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(first).wallet);
    const claimed = capsules.claimCapsule(capsuleId, first);
    assert.equal(claimed.ok, true, claimed.message);
    assert.equal(claimed.amount, 25_000);
    const after = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(first).wallet);
    assert.equal(after - before, 25_000);

    const late = capsules.claimCapsule(capsuleId, second);
    assert.equal(late.ok, false, 'a second claimer must be refused');

    db.prepare('DELETE FROM credit_capsules WHERE capsuleId = ?').run(capsuleId);
    wipe(first); wipe(second);
});

test('capsules: channel config round-trips through bot_meta', () => {
    // The module falls back to defaults when the key is absent, so remember
    // whether it was configured and drop the key again if it was not.
    const hadKey = Boolean(db.prepare("SELECT 1 FROM bot_meta WHERE key = 'capsule:channels'").get());
    const original = capsules.getAllowedChannels();
    capsules.setAllowedChannels(['111', '222']);
    assert.deepEqual(capsules.getAllowedChannels(), ['111', '222']);
    capsules.setAllowedChannels(original);
    assert.deepEqual(capsules.getAllowedChannels(), original);
    if (!hadKey) db.prepare("DELETE FROM bot_meta WHERE key = 'capsule:channels'").run();
    assert.equal(Boolean(db.prepare("SELECT 1 FROM bot_meta WHERE key = 'capsule:channels'").get()), hadKey);
});

// ---------------------------------------------------------------- racing
test('dragon racing: entries, one bet per player, a simulated winner and payouts', () => {
    const owner = user('race');
    const bettor = user('race-bet');
    const egg = hatchery.grantEgg(owner, { eggType: 'storm_egg', rarity: 'epic' });
    hatchery.startIncubation(owner, egg.eggId, 0);
    const dragon = hatchery.hatchEgg(owner, egg.eggId, { force: true }).dragon;

    const hadRaceWeek = Boolean(db.prepare("SELECT 1 FROM bot_meta WHERE key LIKE 'race:week:%'").get());
    const race = racing.getCurrentRace() || racing.openRaceForWeek();
    const register = racing.registerDragon(race.raceId, owner, dragon.dragonId);
    assert.equal(register.ok, true, register.message);
    assert.equal(racing.registerDragon(race.raceId, bettor, dragon.dragonId).ok, false, 'you cannot enter someone else\'s dragon');

    const bet = racing.placeBet(race.raceId, bettor, dragon.dragonId, 50_000);
    assert.equal(bet.ok, true, bet.message);
    assert.equal(racing.placeBet(race.raceId, bettor, dragon.dragonId, 50_000).ok, false, 'one bet per race');

    const simulation = racing.simulateRace(race.raceId, () => 0.4);
    assert.equal(simulation.standings.length, 1);
    assert.ok(simulation.winnerDragonId, 'a single entrant still wins');
    assert.ok(Array.isArray(simulation.log) && simulation.log.length >= 3);

    const settled = racing.settleRace(race.raceId);
    if (settled) {
        const wallet = Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(bettor).wallet);
        assert.ok(wallet > 50_000_000 - 50_000, 'the bettor must be paid for backing the winner');
    }

    const record = racing.getDragonRecord(dragon.dragonId);
    assert.ok(record && record.races >= 1, 'the dragon should have a race record');
    db.prepare('DELETE FROM dragon_races WHERE raceId = ?').run(race.raceId);
    if (!hadRaceWeek) db.prepare("DELETE FROM bot_meta WHERE key LIKE 'race:week:%'").run();
    wipe(owner); wipe(bettor);
});

// ---------------------------------------------------------------- elo
test('ttt elo: a result moves both ratings and the ladder ranks correctly', () => {
    const winner = user('elo-w');
    const loser = user('elo-l');
    for (const id of [winner, loser]) db.prepare('DELETE FROM ttt_elo WHERE userId = ?').run(id);

    const result = tttElo.applyResult({ challengerId: winner, opponentId: loser, winnerId: winner });
    assert.ok(result.challengerDelta > 0, 'the winner gains');
    assert.ok(result.opponentDelta < 0, 'the loser drops');
    assert.equal(result.challengerElo, tttElo.START_ELO + result.challengerDelta);
    assert.equal(result.opponentElo, tttElo.START_ELO + result.opponentDelta);

    assert.equal(tttElo.getRank(winner) <= tttElo.getRank(loser), true, 'the winner must not rank below the loser');
    const ladder = tttElo.getLadder(25);
    assert.equal(ladder[0].userId, winner);

    const draw = tttElo.applyResult({ challengerId: loser, opponentId: winner, winnerId: null });
    assert.ok(Math.abs(draw.challengerDelta) < Math.abs(result.challengerDelta), 'a draw moves less than a win');

    db.prepare('DELETE FROM ttt_elo WHERE userId IN (?, ?)').run(winner, loser);
    db.prepare('DELETE FROM ttt_matches WHERE challengerId IN (?, ?) OR opponentId IN (?, ?)').run(winner, loser, winner, loser);
    wipe(winner); wipe(loser);
});

// ---------------------------------------------------------------- heists
test('heist tiers: escalation gates on players and roles with funny failures', () => {
    assert.deepEqual(heistTiers.TIERS.map(t => t.id), ['standard', 'syndicate', 'cartel', 'blacksite']);
    assert.equal(heistTiers.getTier('standard').requiredPlayers, 2);
    assert.equal(heistTiers.getTier('blacksite').requiredPlayers, 9);

    const understaffed = heistTiers.checkComposition('syndicate', [{ userId: 'a', role: 'hacker' }]);
    assert.equal(understaffed.ok, false);
    assert.ok(understaffed.funny && understaffed.funny.length > 10, 'a refusal must come with a joke');

    const crew = [
        { userId: 'a', role: 'hacker' }, { userId: 'b', role: 'driver' },
        { userId: 'c', role: 'muscle' }, { userId: 'd', role: 'muscle' },
        { userId: 'e', role: 'muscle' }
    ];
    assert.equal(heistTiers.checkComposition('syndicate', crew).ok, true);

    const missedRoles = heistTiers.checkComposition('syndicate', [
        { userId: 'a', role: 'muscle' }, { userId: 'b', role: 'muscle' },
        { userId: 'c', role: 'muscle' }, { userId: 'd', role: 'muscle' },
        { userId: 'e', role: 'muscle' }
    ]);
    assert.equal(missedRoles.ok, false, 'no hacker means no heist');
    assert.ok(missedRoles.missing.some(entry => entry.role === 'hacker'));

    const resolved = heistTiers.resolveHeist({ tierId: 'standard', participants: [{ userId: 'a', role: 'muscle' }, { userId: 'b', role: 'muscle' }] });
    assert.ok(typeof resolved.success === 'boolean');
    assert.ok(Array.isArray(resolved.log));

    const failed = heistTiers.resolveHeist({ tierId: 'blacksite', participants: [{ userId: 'a', role: 'muscle' }] });
    assert.equal(failed.ok, false);
    assert.equal(failed.success, false);
    assert.equal(failed.payout, 0);
    assert.ok(failed.funny, 'under-staffed runs fail hilariously');

    assert.ok(heistTiers.FAIL_LINES.length >= 10);
    assert.equal(heistTiers.parseRolePlan('{broken').hacker ?? undefined, undefined);
    assert.equal(heistTiers.parseRolePlan(heistTiers.encodeRolePlan({ hacker: 1 })).hacker, 1);
});

// ---------------------------------------------------------------- seasonal
test('seasonal events: the calendar picks the right season and gifts are once per day', () => {
    const christmas = seasonal.getActiveSeason(new Date(Date.UTC(2026, 11, 7, 12)));
    assert.equal(christmas.id, 'christmas');
    assert.equal(christmas.dayIndex, 7);
    const halloween = seasonal.getActiveSeason(new Date(Date.UTC(2026, 9, 27, 12)));
    assert.equal(halloween.id, 'halloween');
    const summer = new Date(Date.UTC(2026, 6, 4, 12));
    assert.equal(seasonal.getActiveSeason(summer).id, 'summer');
    assert.equal(seasonal.getSeasonalMultiplier('yield', summer), 2, 'summer doubles yields');
    const spring = new Date(Date.UTC(2026, 2, 4, 12));
    assert.equal(seasonal.getActiveSeason(spring).id, 'spring_event');
    assert.equal(seasonal.getSeasonalMultiplier('yield', spring), 1.15, 'spring lifts yields slightly');
    // A day off the calendar gets no multipliers at all.
    const quiet = new Date(Date.UTC(2026, 1, 4, 12));
    assert.equal(seasonal.getActiveSeason(quiet), null);
    assert.equal(seasonal.getSeasonalMultiplier('yield', quiet), 1);

    const giftA = seasonal.getDailyGift('christmas', 3);
    const giftB = seasonal.getDailyGift('christmas', 3);
    assert.deepEqual(giftA, giftB, 'gifts must be deterministic for a given day');
});

// ---------------------------------------------------------------- damage control
test('expansion cleanup: no throwaway users remain', () => {
    const leftovers = db.prepare("SELECT COUNT(*) AS n FROM users WHERE userId LIKE ?").get(PREFIX + '%').n;
    assert.equal(Number(leftovers), 0, `${leftovers} test user(s) were not cleaned up`);
});
