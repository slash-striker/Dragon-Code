const db = require('../../database');

const SHOP_ITEMS = {
    coffee: {
        id: 'coffee',
        name: '☕ Coffee',
        description: 'If late to work, keeps salary normal. If early, doubles salary boost.',
        price: 100,
        limit: 999,
        category: 'work'
    },
    mobile_phone: {
        id: 'mobile_phone',
        name: '📱 Mobile Phone',
        description: 'Alerts you when someone tries to rob your bank.',
        price: 250000,
        limit: 3,
        category: 'protection'
    },
    watchdog: {
        id: 'watchdog',
        name: '🐕 Watchdog',
        description: 'Increases chance of catching robbers who try to steal from your wallet.',
        price: 100000,
        limit: 3,
        category: 'protection'
    },
    lucky_dice: {
        id: 'lucky_dice',
        name: '🎲 Lucky Dice',
        description: 'Improves luck in scratchcards, robbery, begging, and crime.',
        price: 300,
        limit: 999,
        category: 'luck'
    },
    energy_drink: {
        id: 'energy_drink',
        name: '⚡ Energy Drink',
        description: 'Gives +130-500 bonus coins when working. Stacks with coffee.',
        price: 150,
        limit: 999,
        category: 'work'
    },
    mystery_box: {
        id: 'mystery_box',
        name: '🎁 Mystery Box',
        description: 'Contains random items or money. Low chance for items, higher for money.',
        price: 500,
        limit: 3,
        category: 'box'
    },
    lucky_mystery: {
        id: 'lucky_mystery',
        name: '🎁 Lucky Mystery Box',
        description: 'Better chance for items and higher money rewards. Can give XP boosts.',
        price: 50000,
        limit: 3,
        category: 'box'
    },
    magic_fishing_hook: {
        id: 'magic_fishing_hook',
        name: '🎣 Magic Fishing Hook',
        description: 'Enhanced fishing capabilities.',
        price: 300,
        limit: 999,
        category: 'fishing'
    },
    custom_role: {
        id: 'custom_role',
        name: '👑 Custom Role',
        description: 'A custom role made for you, exactly how you want it. SLASH personally fulfils this — approved at purchase.',
        price: 100000000,
        limit: 1,
        category: 'premium'
    },
    custom_color_role: {
        id: 'custom_color_role',
        name: '🎨 Custom Color Role',
        description: 'A custom role in any color you choose. SLASH personally fulfils this — approved at purchase.',
        price: 75000000,
        limit: 1,
        category: 'services'
    },
    custom_channel: {
        id: 'custom_channel',
        name: '📺 Custom Channel',
        description: 'A custom text channel made for you (100M each; you may buy one of each space type — Channel, VC, and Category). SLASH personally fulfils this — approved at purchase.',
        price: 100000000,
        limit: 1,
        category: 'services'
    },
    custom_vc: {
        id: 'custom_vc',
        name: '🔊 Custom VC',
        description: 'A custom voice channel made for you (100M each; you may buy one of each space type — Channel, VC, and Category). SLASH personally fulfils this — approved at purchase.',
        price: 100000000,
        limit: 1,
        category: 'services'
    },
    custom_category: {
        id: 'custom_category',
        name: '📁 Custom Category',
        description: 'A custom category made for you (100M each; you may buy one of each space type — Channel, VC, and Category). SLASH personally fulfils this — approved at purchase.',
        price: 100000000,
        limit: 1,
        category: 'services'
    },
    space_bundle: {
        id: 'space_bundle',
        name: '🧩 Custom Space Bundle',
        description: 'The full package: one custom Channel + VC + Category together (250M, limit 1). SLASH personally fulfils this — approved at purchase.',
        price: 250000000,
        limit: 1,
        category: 'services'
    },
    private_option: {
        id: 'private_option',
        name: '🔒 Private Option',
        description: 'Makes your purchased custom space(s) private — only you (and staff) can see them. One per player.',
        price: 50000000,
        limit: 1,
        category: 'services'
    },
    custom_ping: {
        id: 'custom_ping',
        name: '🔔 Custom Ping',
        description: 'SLASH personally builds you a custom ping (sound/hook). Toggle it any time with /toggle-ping. SLASH fulfils this — approved at purchase.',
        price: 50000000,
        limit: 1,
        category: 'services'
    },
    auto_deposit: {
        id: 'auto_deposit',
        name: '🏦 Auto-Deposit (30 Days)',
        description: 'Every night, your whole wallet is swept into your bank automatically — nothing left out to rob. Stacks up to 3 months.',
        price: 60000000,
        limit: 3,
        category: 'services'
    },
    work_ping: {
        id: 'work_ping',
        name: '💼 Work Ping',
        description: 'DMs you the moment your /work cooldown finishes. Toggle any time with /toggle-ping.',
        price: 15000000,
        limit: 1,
        category: 'services'
    },
    fish_ping: {
        id: 'fish_ping',
        name: '🎣 Fish Ping',
        description: 'DMs you the moment your /fish cooldown finishes. Toggle any time with /toggle-ping.',
        price: 15000000,
        limit: 1,
        category: 'services'
    },
    mine_ping: {
        id: 'mine_ping',
        name: '⛏️ Mine Ping',
        description: 'DMs you the moment your /mine cooldown finishes. Toggle any time with /toggle-ping.',
        price: 15000000,
        limit: 1,
        category: 'services'
    },
    custom_emoji: {
        id: 'custom_emoji',
        name: '😀 Custom Emoji',
        description: 'A custom emoji added to the server. SLASH personally fulfils this — approved at purchase.',
        price: 25000000,
        limit: 1,
        category: 'premium'
    },
    xp_boost: {
        id: 'xp_boost',
        name: '⬆️ XP Boost',
        description: 'Grants the XP Boost role for 3 days: 2x XP from chat.',
        price: 150000,
        limit: 3,
        category: 'xp'
    },
    mega_xp_boost: {
        id: 'mega_xp_boost',
        name: '⬆️⬆️ Mega XP Boost',
        description: 'Grants the Mega XP Boost role for 7 days: 3x XP from chat.',
        price: 750000,
        limit: 3,
        category: 'xp'
    },
    streak_protection_day: {
        id: 'streak_protection_day',
        name: '🛡️ Streak Protection (1 Day)',
        description: 'Protects your /daily streak for one missed day. Banked until used.',
        price: 2000000,
        limit: 999,
        category: 'protection'
    },
    streak_protection_week: {
        id: 'streak_protection_week',
        name: '🛡️🛡️ Streak Protection (7 Days)',
        description: 'Protects your /daily streak for seven missed days. Banked until used.',
        price: 10000000,
        limit: 999,
        category: 'protection'
    },
    rob_insurance: {
        id: 'rob_insurance',
        name: '🛡️ Rob Insurance',
        description: 'Reimburses 67% of stolen money when robbed.',
        price: 2000,
        limit: 999,
        category: 'protection'
    },
    smi: {
        id: 'smi',
        name: '🕵️ SMI (Secret)',
        description: 'Secret Money Intelligence - 50% chance to block robberies. Hidden from others.',
        price: 10000,
        limit: 1,
        category: 'secret',
        hidden: true
    },
    dragon_egg_crate: {
        id: 'dragon_egg_crate',
        name: '🥚 Dragon Egg Crate',
        description: 'A sealed crate from the hatchery. It ALWAYS contains a dragon egg, with a real chance at a rare or better bloodline — including the mythic KnightFury and Bloodmaw lineages. The crate opens the moment you buy it.',
        price: 2500000,
        limit: 999,
        category: 'dragon'
    },
    incubation_accelerator: {
        id: 'incubation_accelerator',
        name: '⚡ Incubation Accelerator',
        description: 'Feeds an incubating egg a burst of thermal energy, instantly shaving 6 hours off its hatch timer. Apply it from /profile → Eggs.',
        price: 1200000,
        limit: 999,
        category: 'dragon'
    },
    streak_shield: {
        id: 'streak_shield',
        name: '🛡️ Streak Shield',
        description: 'Activates the moment you buy it: one missed /daily spends a shield instead of breaking your streak. Up to 7 can be banked at once.',
        price: 3000000,
        limit: 999,
        category: 'protection'
    }
};

// Helper function to get item by fuzzy match
function getItemByName(input) {
    const lowerInput = input.toLowerCase().replace(/[^a-z0-9_]/g, '');
    
    // Try exact match first. The cleaned NAME is included so items whose ids
    // collide on a shared prefix resolve correctly — asking for 'streak shield'
    // must return the Streak Shield, not the older Streak Protection day pack.
    for (const [key, item] of Object.entries(SHOP_ITEMS)) {
        if (key === lowerInput || item.id === lowerInput) {
            return item;
        }
        const cleanName = String(item.name || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (cleanName && cleanName === lowerInput) {
            return item;
        }
    }
    
    // Try partial match
    for (const [key, item] of Object.entries(SHOP_ITEMS)) {
        const itemName = item.name.toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (itemName.includes(lowerInput) || lowerInput.includes(itemName.substring(0, 4))) {
            return item;
        }
    }
    
    return null;
}

// Helper function to check if user has reached item limit
function hasReachedLimit(userId, itemId, db) {
    const item = SHOP_ITEMS[itemId];
    if (!item || item.limit === 999) return false;

    const row = db.prepare("SELECT quantity FROM inventory WHERE userId = ? AND itemId = ?").get(userId, itemId);
    const currentQuantity = row ? row.quantity : 0;

    return currentQuantity >= item.limit;
}

// Helper function to get user's item quantity
function getItemQuantity(userId, itemId, dbInstance = db) {
    const row = dbInstance.prepare("SELECT quantity FROM inventory WHERE userId = ? AND itemId = ?").get(userId, itemId);
    return row ? row.quantity : 0;
}

function removeItem(userId, itemId, quantity = 1, dbInstance = db) {
    if (!dbInstance || typeof dbInstance.prepare !== 'function') {
        throw new Error('A database instance is required to remove inventory items.');
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error('Item quantity must be a positive integer.');
    }

    const existing = dbInstance.prepare(
        "SELECT quantity FROM inventory WHERE userId = ? AND itemId = ?"
    ).get(userId, itemId);

    if (!existing) {
        return;
    }

    if (existing.quantity <= quantity) {
        dbInstance.prepare("DELETE FROM inventory WHERE userId = ? AND itemId = ?").run(userId, itemId);
        return;
    }

    dbInstance.prepare(
        "UPDATE inventory SET quantity = quantity - ? WHERE userId = ? AND itemId = ?"
    ).run(quantity, userId, itemId);
}

// All shop debits and inventory writes happen in one SQLite transaction. This
// prevents a duplicate purchase or a partial wallet/inventory update.
/*
 * SLASH services never enter the stackable inventory — one row per user in
 * service_purchases (implicit quantity cap of 1). auto_deposit and the
 * *_ping services additionally write their own subscription tables.
 */
const SERVICE_TABLES = {
    auto_deposit: 'auto_deposit_subscriptions',
    work_ping: 'ping_subscriptions',
    fish_ping: 'ping_subscriptions',
    mine_ping: 'ping_subscriptions'
};

/*
 * Streak Shield cap. Cover days already stack from the banked
 * streak_protection_day / _week items, but the shield is a repeatable 3M sink,
 * so it is capped to keep the safety net meaningful instead of infinite.
 */
const SHIELD_CAP = 7;

/* The dragon egg crate opens on purchase instead of sitting in the inventory. */
const INSTANT_OPEN_ITEMS = new Set(['dragon_egg_crate']);

function purchaseItem(userId, itemId, quantity = 1, options = {}) {
    const item = SHOP_ITEMS[itemId];
    if (!item || item.hidden) return { ok: false, message: 'That item is not available.' };
    const isService = item.category === 'services';
    if (isService) {
        const blocker = require('./slashServices').getServiceBlocker(userId, itemId);
        if (blocker) return { ok: false, message: blocker };
        if (itemId === 'auto_deposit') {
            const row = db.prepare('SELECT stacks, expiresAt FROM auto_deposit_subscriptions WHERE userId = ?').get(userId);
            if (row && row.stacks >= item.limit) {
                const days = Math.max(0, Math.ceil((row.expiresAt - Date.now()) / 86400000));
                return { ok: false, message: `You already hold ${row.stacks} months of Auto-Deposit (about ${days} days left). Wait for one to expire before stacking more.` };
            }
        } else if (SERVICE_TABLES[itemId] === 'ping_subscriptions') {
            const owned = db.prepare('SELECT 1 FROM ping_subscriptions WHERE userId = ? AND command = ?')
                .get(userId, itemId.replace(/_ping$/, ''));
            if (owned) return { ok: false, message: `You already own ${item.name} — toggle it with /toggle-ping instead of buying it twice.` };
        }
        quantity = 1;
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
        return { ok: false, message: 'Quantity must be a whole number from 1 to 10.' };
    }

    /*
     * Daily flash deals (systems/economy/flashDeals.js) change what a purchase
     * actually COSTS. Resolving the discount here is what makes the price
     * advertised in /shop real — a discount that only existed in the embed
     * would be a lie. Services and hidden items are never discounted.
     * Required lazily: flashDeals requires this module, so a top-level require
     * would risk an empty SHOP_ITEMS on the first load.
     */
    const deal = isService || item.hidden ? null : require('./flashDeals').getDeal(itemId);
    const unitPrice = deal ? require('./flashDeals').discountedPrice(item, deal) : item.price;
    const discount = deal ? Number(deal.discount) || 0 : 0;
    const totalCost = unitPrice * quantity;

    // Streak Shields auto-apply on purchase, so they are never dead weight.
    let shieldDays = null;
    if (itemId === 'streak_shield') {
        const current = require('./streakProtection').getCoverDays(userId);
        if (current >= SHIELD_CAP) {
            return { ok: false, message: `You already hold ${current} banked protection day(s) — the cap is ${SHIELD_CAP}. Spend some before buying more.` };
        }
    }

    const eggs = [];
    try {
        const result = db.transaction(() => {
            if (isService) {
                // Re-check inside the transaction so a race cannot double-buy.
                const blocker = require('./slashServices').getServiceBlocker(userId, itemId);
                if (blocker) throw new Error(blocker);
            } else {
                const current = getItemQuantity(userId, itemId);
                if (!options.autoOpen && current + quantity > item.limit) {
                    throw new Error(`You can only buy ${Math.max(0, item.limit - current)} more ${item.name}.`);
                }
            }
            const debit = db.prepare(
                'UPDATE users SET wallet = wallet - ?, moneySpent = COALESCE(moneySpent, 0) + ? WHERE userId = ? AND wallet >= ?'
            ).run(totalCost, totalCost, userId, totalCost);
            if (debit.changes !== 1) throw new Error(`You need 🪙${totalCost.toLocaleString()} in your wallet.`);
            if (isService) {
                if (itemId === 'auto_deposit') {
                    // Stacking subscription: each purchase extends expiry 30 days (limit 3 via inventory-free count below).
                    const row = db.prepare('SELECT expiresAt, stacks FROM auto_deposit_subscriptions WHERE userId = ?').get(userId);
                    const currentStacks = row ? row.stacks : 0;
                    if (currentStacks >= item.limit) {
                        throw new Error(`You can only hold ${item.limit} months of Auto-Deposit at once.`);
                    }
                    const base = row && row.expiresAt > Date.now() ? row.expiresAt : Date.now();
                    const expiresAt = base + 30 * 24 * 60 * 60 * 1000;
                    db.prepare(`
                        INSERT INTO auto_deposit_subscriptions (userId, expiresAt, stacks)
                        VALUES (?, ?, 1)
                        ON CONFLICT(userId) DO UPDATE SET
                            expiresAt = excluded.expiresAt,
                            stacks = stacks + 1
                    `).run(userId, expiresAt);
                } else if (SERVICE_TABLES[itemId] === 'ping_subscriptions') {
                    const already = db.prepare('SELECT 1 FROM ping_subscriptions WHERE userId = ? AND command = ?')
                        .get(userId, itemId.replace(/_ping$/, ''));
                    if (already) throw new Error(`You already own ${item.name}.`);
                    // Permanent ownership — /toggle-ping switches it on/off.
                    db.prepare(
                        'INSERT INTO ping_subscriptions (userId, command, enabled) VALUES (?, ?, 1)'
                    ).run(userId, itemId.replace(/_ping$/, ''));
                } else {
                    db.prepare(`
                        INSERT INTO service_purchases (userId, serviceId, price, purchasedAt)
                        VALUES (?, ?, ?, ?)
                    `).run(userId, itemId, item.price, new Date().toISOString());
                }
            } else if (!options.autoOpen && !INSTANT_OPEN_ITEMS.has(itemId)) db.prepare(`
                INSERT INTO inventory (userId, itemId, quantity) VALUES (?, ?, ?)
                ON CONFLICT(userId, itemId) DO UPDATE SET quantity = quantity + excluded.quantity
            `).run(userId, itemId, quantity);

            /*
             * Streak Shield: bank the cover days inside the same transaction as
             * the debit, so a failure can never charge for an unapplied shield.
             * Re-checked here as well as before the transaction for race safety.
             */
            if (itemId === 'streak_shield') {
                const sp = require('./streakProtection');
                const current = sp.getCoverDays(userId);
                if (current >= SHIELD_CAP) {
                    throw new Error(`You already hold ${current} banked protection day(s) — the cap is ${SHIELD_CAP}.`);
                }
                shieldDays = sp.addCoverDays(userId, quantity);
            }

            /*
             * Dragon Egg Crate: the crate is opened immediately, so the eggs
             * are rolled and handed over here instead of sitting unopened in the
             * inventory. The hatchery owns the drop table (systems/dragons);
             * if it is unavailable the crate still sells, just without eggs.
             */
            if (itemId === 'dragon_egg_crate') {
                try {
                    const hatchery = require('../dragons/dragonManager');
                    for (let index = 0; index < quantity; index += 1) {
                        const egg = hatchery.rollEggDrop(userId, { source: 'shop_crate', tierScore: 1 });
                        if (egg) eggs.push(egg);
                    }
                } catch (error) {
                    console.error('Dragon egg crate grant failed:', error.message);
                }
            }

            const slashDragonId = '1505829367631183963';
            db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(slashDragonId);
            db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(totalCost, slashDragonId);
            return db.prepare('SELECT wallet FROM users WHERE userId = ?').get(userId);
        })();
        require('./transactionLogger').logTransaction(userId, 'shop', -totalCost, `${quantity}x ${item.name}`);
        require('./transactionLogger').logTransaction('1505829367631183963', 'shop_revenue', totalCost, `${quantity}x ${item.name} purchased by ${userId}`);
        return {
            ok: true,
            item,
            quantity,
            totalCost,
            unitPrice,
            discount,
            shieldDays,
            eggs,
            wallet: result.wallet,
            isService,
            instantOpen: INSTANT_OPEN_ITEMS.has(itemId)
        };
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

module.exports = {
    SHOP_ITEMS,
    SHIELD_CAP,
    INSTANT_OPEN_ITEMS,
    getItemByName,
    hasReachedLimit,
    getItemQuantity,
    removeItem,
    purchaseItem
};
