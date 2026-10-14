/*
 * SLASH services shop — permanent "cosmetic perk" items.
 *
 * These do nothing automatic: buying one simply records the request, pings
 * SLASH (1466461677783351447) in the purchase channel with what was bought,
 * and appends the approval footer:
 *   "I will make these things happen. I am SLASH, and I approve of this message."
 *
 * Purchase rules (enforced in shopItems.purchaseItem via the `limit` field,
 * plus `perChoice` exclusivity here):
 *   - Custom Channel / VC / Category — 25,000,000 each, limit 3.
 *     Buying one choice locks THAT choice, but the other two stay buyable.
 *   - Channel/VC/Category Bundle — 90,000,000, limit 1.
 *     (Bundle includes one of each, so it also locks all three singles.)
 *   - Private option — 10,000,000, limit 1.
 *   - Custom Role / Custom Color Role / Custom Emoji — as priced below.
 */
const db = require('../../database');

const SLASH_USER_ID = '1466461677783351447';

const SERVICES = {
    custom_channel: {
        id: 'custom_channel',
        name: '📺 Custom Channel',
        description: 'A custom text channel made for you (25M).',
        price: 25000000,
        limit: 1,
        category: 'services',
        service: {
            kind: 'space_choice',
            label: 'Custom Channel'
        }
    },
    custom_vc: {
        id: 'custom_vc',
        name: '🔊 Custom VC',
        description: 'A custom voice channel made for you (25M).',
        price: 25000000,
        limit: 1,
        category: 'services',
        service: {
            kind: 'space_choice',
            label: 'Custom VC'
        }
    },
    custom_category: {
        id: 'custom_category',
        name: '📁 Custom Category',
        description: 'A custom category with channels made for you (25M).',
        price: 25000000,
        limit: 1,
        category: 'services',
        service: {
            kind: 'space_choice',
            label: 'Custom Category'
        }
    },
    space_bundle: {
        id: 'space_bundle',
        name: '🧩 Channel/VC/Category Bundle',
        description: 'One custom channel + VC + category together (90M). Includes all three singles.',
        price: 90000000,
        limit: 1,
        category: 'services',
        service: {
            kind: 'space_bundle',
            label: 'Channel/VC/Category Bundle'
        }
    },
    private_option: {
        id: 'private_option',
        name: '🔒 Private Option',
        description: 'Make your custom space(s) private — visible to you and staff only (10M).',
        price: 10000000,
        limit: 1,
        category: 'services',
        service: {
            kind: 'private',
            label: 'Private Option'
        }
    },
    custom_role: {
        id: 'custom_role',
        name: '👑 Custom Role',
        description: 'A custom role created for you.',
        price: 1000000,
        limit: 1,
        category: 'premium',
        service: {
            kind: 'role',
            label: 'Custom Role'
        }
    },
    custom_color_role: {
        id: 'custom_color_role',
        name: '🎨 Custom Color Role',
        description: 'A custom role in any color you choose.',
        price: 1000000,
        limit: 1,
        category: 'services',
        service: {
            kind: 'role',
            label: 'Custom Color Role'
        }
    },
    custom_emoji: {
        id: 'custom_emoji',
        name: '😀 Custom Emoji',
        description: 'A custom emoji added to the server.',
        price: 500000,
        limit: 1,
        category: 'premium',
        service: {
            kind: 'emoji',
            label: 'Custom Emoji'
        }
    },
    custom_ping: {
        id: 'custom_ping',
        name: '🔔 Custom Ping',
        description: 'SLASH personally builds you a custom ping (sound/hook).',
        price: 5000000,
        limit: 1,
        category: 'services',
        service: {
            kind: 'ping',
            label: 'Custom Ping'
        }
    }
};

/*
 * Automatic services are bought-and-active the moment purchaseItem commits:
 * ping subscriptions (work/fish/mine) and auto-deposit write their own
 * tables and never need a human. Everything in SERVICES above needs SLASH
 * to personally build/deliver it. Shop flows use this to decide whether a
 * purchase should summon SLASH or just print a receipt.
 */
const AUTOMATIC_SERVICE_IDS = new Set(['auto_deposit', 'work_ping', 'fish_ping', 'mine_ping']);

function hasServiceSupport(itemId) {
    return Boolean(SERVICES[itemId]) && !AUTOMATIC_SERVICE_IDS.has(itemId);
}

/*
 * A user can own each service id at most once, so bought services never land
 * in the stackable inventory — ownership is tracked in service_purchases.
 */
function getServicePurchase(userId, serviceId) {
    return db.prepare(
        'SELECT * FROM service_purchases WHERE userId = ? AND serviceId = ?'
    ).get(userId, serviceId) || null;
}

function getUserServicePurchases(userId) {
    return db.prepare(
        'SELECT * FROM service_purchases WHERE userId = ? ORDER BY purchasedAt ASC'
    ).all(userId);
}

/*
 * Each service can be bought once per player (primary-key ownership rows).
 * The three custom space singles are independent — buying custom_channel
 * locks ONLY custom_channel, and custom_vc/custom_category stay buyable.
 * The 90M bundle INCLUDES all three singles, so it conflicts with them:
 * it cannot be bought once any single is owned, and singles cannot be
 * bought once the bundle is owned (both would double up the same space).
 * Returns null when allowed, else a refusal message.
 */
function getServiceBlocker(userId, serviceId) {
    const svc = SERVICES[serviceId];
    if (!svc) return null;

    if (getServicePurchase(userId, serviceId)) {
        return `You already own ${svc.name} — each ${svc.service.label} can only be bought once.`;
    }

    if (svc.service.kind === 'space_bundle') {
        const ownedSingle = ['custom_channel', 'custom_vc', 'custom_category']
            .find(id => getServicePurchase(userId, id));
        if (ownedSingle) {
            return `You already bought the ${SERVICES[ownedSingle].service.label} — the bundle includes it, so buying the bundle would double it up.`;
        }
    }

    if (svc.service.kind === 'space_choice' && getServicePurchase(userId, 'space_bundle')) {
        return 'Your Custom Space Bundle already includes this — no need to buy it separately.';
    }

    return null;
}

/*
 * SLASH approval footer, appended to the purchase confirmation.
 */
function buildSlashApproval(item, quantity, totalCost) {
    const parts = [
        `**SLASH has been notified.** <@${SLASH_USER_ID}>`,
        `_“I will make these things happen. I am SLASH, and I approve of this message.”_`
    ];
    return parts.join('\n');
}

module.exports = {
    SLASH_USER_ID,
    SERVICES,
    hasServiceSupport,
    getServicePurchase,
    getUserServicePurchases,
    getServiceBlocker,
    buildSlashApproval
};
