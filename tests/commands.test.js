/*
 * Command-layer tests for the Dragon Code expansion.
 *
 * The engine-level suites (expansion.test.js) prove the data layer is right.
 * These drive the REAL exported command handlers with a stubbed discord.js
 * interaction, so a routing, rendering or confirmation regression shows up
 * here instead of on the host.
 *
 * Every test purges its throwaway users before AND after it runs, so an
 * interrupted run can never poison the next one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../database');
const shop = require('../commands/shop');
const trade = require('../commands/trade');
const trades = require('../systems/economy/tradeManager');
const flashDeals = require('../systems/economy/flashDeals');
const { SHOP_ITEMS } = require('../systems/economy/shopItems');

const CHANNEL = '1504562791967756448';
const A = 'cmdtest-trade-a';
const B = 'cmdtest-trade-b';
const S = 'cmdtest-shop';
const IDS = [A, B, S];

/* Child tables a throwaway user can leave a row in. */
const CHILD_TABLES = [
    'dragon_incubators', 'dragon_feed_log', 'dragon_season_stats', 'dragon_race_bets',
    'quest_progress', 'quest_stats', 'badges', 'cosmetic_titles', 'inventory',
    'mining_inventory', 'fishing_inventory', 'market_bets', 'market_pvp_stats',
    'seasonal_claims', 'reminders', 'ttt_elo', 'ttt_matches', 'ttt_promotions'
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
 * Erase every trace of the throwaway users. The shop logs its revenue against
 * the OWNER account rather than the buyer, so those rows are matched by the
 * buyer id appearing in the transaction description.
 */
function purge() {
    for (const id of IDS) {
        for (const table of CHILD_TABLES) safeRun('DELETE FROM ' + table + ' WHERE userId = ?', id);
        safeRun('DELETE FROM dragon_race_records WHERE dragonId IN (SELECT dragonId FROM dragons WHERE userId = ?)', id);
        safeRun('DELETE FROM dragons WHERE userId = ?', id);
        safeRun('DELETE FROM dragon_eggs WHERE userId = ?', id);
        safeRun('DELETE FROM trades WHERE initiatorId = ? OR partnerId = ?', id, id);
        safeRun('DELETE FROM transactions WHERE userId = ? OR description LIKE ?', id, '%' + id + '%');
        db.prepare('DELETE FROM users WHERE userId = ?').run(id);
    }
    safeRun("DELETE FROM bot_meta WHERE key LIKE 'trade:request:%'");
}

function seed() {
    purge();
    db.prepare('INSERT INTO users (userId, wallet, bank, mining_bank) VALUES (?, ?, ?, 0)').run(A, 50_000_000, 5_000_000);
    db.prepare('INSERT INTO users (userId, wallet, bank, mining_bank) VALUES (?, ?, ?, 0)').run(B, 5_000_000, 0);
    db.prepare('INSERT INTO users (userId, wallet, bank, mining_bank) VALUES (?, ?, ?, 0)').run(S, 50_000_000, 0);
    db.prepare("INSERT INTO inventory (userId, itemId, quantity) VALUES (?, 'coffee', 5)").run(A);
}

function walletOf(id) {
    return Number(db.prepare('SELECT wallet FROM users WHERE userId = ?').get(id)?.wallet || 0);
}

function eggCountOf(id) {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM dragon_eggs WHERE userId = ?').get(id).n);
}

// ------------------------------------------------------------------ stubs
function base(userId) {
    const calls = [];
    const payload = {
        user: { id: userId, displayName: 'Tester', username: 'tester', tag: 'tester#0001' },
        channelId: CHANNEL,
        member: { roles: { cache: { has: () => false } } },
        guild: null,
        client: {
            channels: { fetch: async () => null },
            users: { fetch: async () => ({ send: async () => {} }) }
        },
        deferred: false,
        replied: false,
        reply: async body => { payload.replied = true; calls.push({ via: 'reply', body }); return {}; },
        deferReply: async () => { payload.deferred = true; calls.push({ via: 'deferReply' }); return {}; },
        editReply: async body => { calls.push({ via: 'editReply', body }); return {}; },
        followUp: async body => { calls.push({ via: 'followUp', body }); return {}; },
        update: async body => { calls.push({ via: 'update', body }); return {}; },
        showModal: async modal => { calls.push({ via: 'showModal', modal }); return {}; },
        deferUpdate: async () => { calls.push({ via: 'deferUpdate' }); return {}; }
    };
    return { payload, calls };
}

function slash(optionsObj, userId) {
    const { payload, calls } = base(userId);
    payload.commandName = 'command';
    payload.isChatInputCommand = () => true;
    payload.isButton = () => false;
    payload.isStringSelectMenu = () => false;
    payload.isModalSubmit = () => false;
    payload.options = {
        getUser: () => optionsObj.user || null,
        getString: name => (name in optionsObj ? optionsObj[name] : null),
        getInteger: name => (name in optionsObj ? optionsObj[name] : null),
        getFocused: () => ''
    };
    return { interaction: payload, calls };
}

function component(customId, userId, { values = null, modalFields = null } = {}) {
    const { payload, calls } = base(userId);
    payload.customId = customId;
    payload.values = values || [];
    payload.isButton = () => !values && !modalFields;
    payload.isStringSelectMenu = () => Boolean(values);
    payload.isModalSubmit = () => Boolean(modalFields);
    payload.isChatInputCommand = () => false;
    payload.fields = {
        getTextInputValue: key => (modalFields && key in modalFields ? modalFields[key] : '')
    };
    return { interaction: payload, calls };
}

function embedOf(calls, via) {
    const list = via ? calls.filter(entry => entry.via === via) : calls;
    if (!list.length) return null;
    return list[list.length - 1].body?.embeds?.[0] || null;
}

function titleOf(calls, via) {
    return embedOf(calls, via)?.data?.title ?? null;
}

function fieldNames(calls, via) {
    return (embedOf(calls, via)?.data?.fields || []).map(field => field.name);
}

// ------------------------------------------------------------------ /trade
test('command layer: /trade opens a trade, gates on both confirmations and moves items + credits', async () => {
    seed();

    // The initiator opens the trade with an offer and a wish list.
    const opened = slash({
        user: { id: B },
        'give-items': 'coffee x2',
        'give-credits': 10_000,
        'give-account': 'wallet',
        'want-items': 'lucky_dice',
        'want-credits': 0
    }, A);
    await trade.execute(opened.interaction);

    const open = trades.listOpenTradesFor(A);
    assert.equal(open.length, 1, 'execute should open exactly one trade');
    const tradeId = open[0].tradeId;

    assert.equal(titleOf(opened.calls, 'editReply'), '🤝 TRADE ' + tradeId, 'the panel should name the trade');
    const componentIds = (opened.calls.find(entry => entry.via === 'editReply').body.components || [])
        .flatMap(row => (row.components || []).map(inner => inner.data.custom_id));
    assert.ok(componentIds.includes('trade:confirm:' + tradeId), 'the panel must expose a confirm button');
    assert.ok(componentIds.includes('trade:offer:' + tradeId), 'the panel must expose an edit-offer button');

    const openedRow = trades.getTrade(tradeId);
    assert.equal(Number(openedRow.giveCredits), 10_000, 'the initiator offer must be recorded');
    assert.ok(
        JSON.parse(openedRow.giveItems || '[]').some(item => item.itemId === 'coffee' && Number(item.quantity) === 2),
        'the free-text offer "coffee x2" must parse into the offer'
    );

    // One confirmation moves nothing.
    const firstConfirm = component('trade:confirm:' + tradeId, A);
    await trade.handleComponent(firstConfirm.interaction);
    assert.equal(trades.getTrade(tradeId).status, 'open', 'one confirmation must not execute the trade');
    assert.equal(walletOf(A), 50_000_000, 'no credits may move on one confirmation');
    assert.ok(firstConfirm.calls.some(entry => entry.via === 'update'), 'the confirm button should repaint the panel');

    // The partner builds their side through the modal.
    const offerClick = component('trade:offer:' + tradeId, B);
    await trade.handleComponent(offerClick.interaction);
    const modal = offerClick.calls.find(entry => entry.via === 'showModal')?.modal;
    assert.ok(modal, 'the edit-offer button must open a modal');
    assert.equal(modal.data.custom_id, 'trade:modal:' + tradeId + ':receive', 'the modal must target the partner side');

    const submit = component('trade:modal:' + tradeId + ':receive', B, {
        modalFields: { items: '', credits: '4000', account: 'wallet' }
    });
    await trade.handleModal(submit.interaction);
    assert.equal(Number(trades.getTrade(tradeId).receiveCredits), 4000, 'the modal must save the partner offer');
    assert.ok(submit.calls.some(entry => entry.via === 'update'), 'the modal should repaint the panel');

    // Both sides confirmed -> the swap executes.
    await trade.handleComponent(component('trade:confirm:' + tradeId, A).interaction);
    const finalConfirm = component('trade:confirm:' + tradeId, B);
    await trade.handleComponent(finalConfirm.interaction);

    assert.equal(trades.getTrade(tradeId).status, 'done', 'both confirmations must execute the trade');
    assert.equal(titleOf(finalConfirm.calls, 'update'), '✅ TRADE COMPLETE', 'the trade must end on a completion panel');

    const aCoffee = db.prepare("SELECT quantity FROM inventory WHERE userId = ? AND itemId = 'coffee'").get(A);
    const bCoffee = db.prepare("SELECT quantity FROM inventory WHERE userId = ? AND itemId = 'coffee'").get(B);
    assert.equal(Number(aCoffee?.quantity || 0), 3, 'the initiator gave away 2 coffee');
    assert.equal(Number(bCoffee?.quantity || 0), 2, 'the partner received 2 coffee');
    assert.equal(walletOf(A), 50_000_000 - 6000, 'the initiator paid the net credits');
    assert.equal(walletOf(B), 5_000_000 + 6000, 'the partner received the net credits');

    purge();
});

// ------------------------------------------------------------------- /shop
test('command layer: /shop sells a Dragon Egg Crate and honours a flash deal', async () => {
    seed();
    const crate = SHOP_ITEMS.dragon_egg_crate;
    const today = new Date().toISOString().slice(0, 10);
    safeRun('DELETE FROM flash_deals WHERE dateKey = ?', today);

    // ---- plain purchase: the crate always yields an egg ----
    const before = walletOf(S);
    const plain = slash({ action: 'buy', item: 'dragon_egg_crate', quantity: 1 }, S);
    await shop.execute(plain.interaction);

    const gotReceipt = plain.calls.some(entry => entry.via === 'reply');
    assert.ok(gotReceipt, 'a purchase must reply with a receipt');
    const receipt = plain.calls.find(entry => entry.via === 'reply')?.body;
    assert.match(String(titleOf(plain.calls, 'reply')), /PURCHASE/i,
        'the receipt should confirm the purchase, got ' + JSON.stringify(receipt));
    assert.ok(eggCountOf(S) >= 1, 'the crate must always grant an egg');
    assert.ok(
        fieldNames(plain.calls, 'reply').some(name => /Crate contents/.test(name)),
        'the receipt must list the crate contents'
    );
    assert.ok(
        !fieldNames(plain.calls, 'reply').some(name => /Flash deal/.test(name)),
        'there must be no flash-deal field when no deal is running'
    );
    assert.equal(before - walletOf(S), crate.price, 'the full crate price must be charged');

    // ---- flash deal: receipt shows it and the charge is discounted ----
    safeRun('DELETE FROM dragon_eggs WHERE userId = ?', S);
    safeRun('INSERT INTO flash_deals (itemId, discount, dateKey, startsAt, endsAt) VALUES (?, 50, ?, ?, ?)',
        'dragon_egg_crate', today, Date.now() - 1000, Date.now() + 3_600_000);
    assert.ok(
        flashDeals.getActiveDeals().some(deal => deal.itemId === 'dragon_egg_crate'),
        'the flash deal should be live for the crate'
    );

    const beforeDeal = walletOf(S);
    const deal = slash({ action: 'buy', item: 'dragon_egg_crate', quantity: 1 }, S);
    await shop.execute(deal.interaction);

    const fields = embedOf(deal.calls, 'reply')?.data?.fields || [];
    const dealField = fields.find(field => /Flash deal/.test(field.name));
    assert.ok(dealField, 'the receipt must show the flash deal');
    assert.match(String(dealField.value), /50% off/, 'the deal field must name the discount');
    assert.equal(beforeDeal - walletOf(S), Math.floor(crate.price / 2), 'the discounted price must be charged');
    assert.ok(eggCountOf(S) >= 1, 'a discounted crate must still grant an egg');

    safeRun('DELETE FROM flash_deals WHERE dateKey = ?', today);
    purge();
});

test('command layer: no throwaway users remain', () => {
    purge();
    const pattern = 'cmdtest-%';
    const leftovers = db.prepare('SELECT COUNT(*) AS n FROM users WHERE userId LIKE ?').get(pattern).n;
    assert.equal(Number(leftovers), 0, leftovers + ' command-layer test user(s) were not cleaned up');
    const strayRevenue = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE description LIKE ?').get(pattern).n;
    assert.equal(Number(strayRevenue), 0, strayRevenue + ' shop-revenue row(s) outlived the test');
});
