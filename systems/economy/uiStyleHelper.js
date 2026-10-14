const { getUser } = require('./userManager');

/**
 * Get a user's UI style preference
 * @param {string} userId - The user's ID
 * @returns {string} - 'hightech' or 'normal'
 */
function getUserUIStyle(userId) {
    const user = userId ? getUser(userId) : null;
    return user?.uiStyle || 'hightech';
}

/**
 * Format an embed title based on UI style
 * @param {string} userId - The user's ID
 * @param {string} hightechTitle - Title for high-tech mode
 * @param {string} normalTitle - Title for normal mode (optional, defaults to hightech without emojis/tech terms)
 * @returns {string} - Formatted title
 */
function formatTitle(userId, hightechTitle, normalTitle) {
    const style = getUserUIStyle(userId);
    if (style === 'hightech') {
        return hightechTitle;
    }
    if (normalTitle) return normalTitle;
    
    // Fallback: remove emojis and replace high-tech terms
    return hightechTitle
        .replace(/[⚡🛒🎰💼👤🌐🔧⚙️💎📦🌟✨🎮🎪🎭🎨🎬🎵🎶🎹🎺🎻🎸🥁🎤🎧🎼🎵📱💻🖥️🖨️📠📺📷📸📹🎥📼📀💿📼📽️🎞️📟📠📺📻🎙️🎚️🎛️🧮🎰🎲🎯🎳🎮🕹️🎗️🎟️🎫🎪🎭🩰🎨🎬📽️🎞️📽️🎞️📽️🎞️🎞️]/g, '')
        .replace(/🌐/g, '')
        .replace(/NEURAL/g, '')
        .replace(/TERMINAL/g, '')
        .replace(/MATRIX/g, '')
        .replace(/SYSTEM/g, '')
        .replace(/NODE/g, '')
        .replace(/GRID/g, '')
        .replace(/CORE/g, '')
        .replace(/ACCESS/g, '')
        .replace(/AUTH/g, '')
        .replace(/SYNCED/g, '')
        .replace(/ACTIVE/g, '')
        .replace(/ONLINE/g, '')
        .replace(/SCAN/g, '')
        .replace(/LINK/g, '')
        .replace(/SECURE/g, '')
        .replace(/FIREWALL/g, '')
        .replace(/PROTOCOL/g, '')
        .replace(/NETWORK/g, '')
        .replace(/STATUS/g, '')
        .replace(/DATA/g, '')
        .replace(/OUTPUT/g, '')
        .replace(/INPUT/g, '')
        .replace(/RESULT/g, '')
        .replace(/QUANTUM/g, '')
        .replace(/ENCRYPTED/g, '')
        .replace(/DARKNET/g, '')
        .replace(/TRACE/g, '')
        .replace(/BYPASS/g, '')
        .replace(/INJECT/g, '')
        .replace(/PAYLOAD/g, '')
        .replace(/DETECT/g, '')
        .replace(/COUNTER/g, '')
        .replace(/MEASURE/g, '')
        .replace(/SIGNAL/g, '')
        .replace(/ROUTING/g, '')
        .replace(/MESSAGE/g, '')
        .replace(/LOG/g, '')
        .replace(/LEDGER/g, '')
        .replace(/WALLET/g, '')
        .replace(/BANK/g, '')
        .replace(/STASH/g, '')
        .replace(/INVENTORY/g, '')
        .replace(/PROFILE/g, '')
        .replace(/STATS/g, '')
        .replace(/ECONOMY/g, '')
        .replace(/CREDIT/g, '')
        .replace(/COIN/g, '')
        .replace(/MONEY/g, '')
        .replace(/CASH/g, '')
        .replace(/BALANCE/g, '')
        .replace(/XP/g, '')
        .replace(/LEVEL/g, '')
        .replace(/RANK/g, '')
        .replace(/STREAK/g, '')
        .replace(/DAILY/g, '')
        .replace(/WEEKLY/g, '')
        .replace(/WORK/g, '')
        .replace(/JOB/g, '')
        .replace(/SHIFT/g, '')
        .replace(/EARNINGS/g, '')
        .replace(/CRIME/g, '')
        .replace(/HEIST/g, '')
        .replace(/LOBBY/g, '')
        .replace(/PARTICIPANT/g, '')
        .replace(/PLAYER/g, '')
        .replace(/TARGET/g, '')
        .replace(/STOLE/g, '')
        .replace(/SHARED/g, '')
        .replace(/INSURANCE/g, '')
        .replace(/REIMBURSED/g, '')
        .replace(/FISH/g, '')
        .replace('◢', '')
        .replace('◣', '')
        .replace('◈', '')
        .replace('◇', '')
        .replace('◆', '');
}

/**
 * Format a description based on UI style
 * @param {string} userId - The user's ID
 * @param {string} hightechDesc - Description for high-tech mode
 * @param {string} normalDesc - Description for normal mode (optional)
 * @returns {string} - Formatted description
 */
function formatDescription(userId, hightechDesc, normalDesc) {
    const style = getUserUIStyle(userId);
    if (style === 'hightech') {
        return hightechDesc;
    }
    if (normalDesc) return normalDesc;
    
    // Fallback: remove high-tech terms from description
    return hightechDesc
        .replace(/NEURAL/g, '')
        .replace(/TERMINAL/g, '')
        .replace(/MATRIX/g, '')
        .replace(/SYSTEM/g, '')
        .replace(/NODE/g, '')
        .replace(/GRID/g, '')
        .replace(/CORE/g, '')
        .replace(/ACCESS/g, '')
        .replace(/AUTH/g, '')
        .replace(/SYNCED/g, '')
        .replace(/ACTIVE/g, '')
        .replace(/ONLINE/g, '')
        .replace(/SCAN/g, '')
        .replace(/LINK/g, '')
        .replace(/SECURE/g, '')
        .replace(/FIREWALL/g, '')
        .replace(/PROTOCOL/g, '')
        .replace(/NETWORK/g, '')
        .replace(/STATUS/g, '')
        .replace(/DATA/g, '')
        .replace(/OUTPUT/g, '')
        .replace(/INPUT/g, '')
        .replace(/RESULT/g, '')
        .replace(/QUANTUM/g, '')
        .replace(/ENCRYPTED/g, '')
        .replace(/DARKNET/g, '')
        .replace(/TRACE/g, '')
        .replace(/BYPASS/g, '')
        .replace(/INJECT/g, '')
        .replace(/PAYLOAD/g, '')
        .replace(/DETECT/g, '')
        .replace(/COUNTER/g, '')
        .replace(/MEASURE/g, '')
        .replace(/SIGNAL/g, '')
        .replace(/ROUTING/g, '')
        .replace(/MESSAGE/g, '')
        .replace(/LOG/g, '')
        .replace(/LEDGER/g, '')
        .replace(/WALLET/g, '')
        .replace(/BANK/g, '')
        .replace(/STASH/g, '')
        .replace(/INVENTORY/g, '')
        .replace(/PROFILE/g, '')
        .replace(/STATS/g, '')
        .replace(/ECONOMY/g, '')
        .replace(/CREDIT/g, '')
        .replace(/COIN/g, '')
        .replace(/MONEY/g, '')
        .replace(/CASH/g, '')
        .replace(/BALANCE/g, '')
        .replace(/XP/g, '')
        .replace(/LEVEL/g, '')
        .replace(/RANK/g, '')
        .replace(/STREAK/g, '')
        .replace(/DAILY/g, '')
        .replace(/WEEKLY/g, '')
        .replace(/WORK/g, '')
        .replace(/JOB/g, '')
        .replace(/SHIFT/g, '')
        .replace(/EARNINGS/g, '')
        .replace(/CRIME/g, '')
        .replace(/HEIST/g, '')
        .replace(/LOBBY/g, '')
        .replace(/PARTICIPANT/g, '')
        .replace(/PLAYER/g, '')
        .replace(/TARGET/g, '')
        .replace(/STOLE/g, '')
        .replace(/SHARED/g, '')
        .replace(/INSURANCE/g, '')
        .replace(/REIMBURSED/g, '')
        .replace(/FISH/g, '')
        .replace(/[⚡🛒🎰💼👤🌐🔧⚙️💎📦🌟✨🎮🎪🎭🎨🎬🎵🎶🎹🎺🎻🎸🥁🎤🎧🎼🎵📱💻🖥️🖨️📠📺📷📸📹🎥📼📀💿📼📽️🎞️📟📠📺📻🎙️🎚️🎛️🧮🎰🎲🎯🎳🎮🕹️🎗️🎟️🎫🎪🎭🩰🎨🎬📽️🎞️📽️🎞️📽️🎞️🎞️]/g, '')
        .replace('◢', '')
        .replace('◣', '')
        .replace('◈', '')
        .replace('◇', '')
        .replace('◆', '');
}

/**
 * Get embed color based on UI style and category
 * @param {string} userId - The user's ID
 * @param {number} categoryColor - Category-specific color for high-tech mode
 * @returns {number} - Color hex code
 */
function getColor(userId, categoryColor = 0x00d4ff) {
    const style = getUserUIStyle(userId);
    return style === 'hightech' ? categoryColor : 0x00d4ff;
}

/**
 * Format a field name based on UI style
 * @param {string} userId - The user's ID
 * @param {string} hightechName - Field name for high-tech mode
 * @param {string} normalName - Field name for normal mode (optional)
 * @returns {string} - Formatted field name
 */
function formatFieldName(userId, hightechName, normalName) {
    const style = getUserUIStyle(userId);
    if (style === 'hightech') {
        return hightechName;
    }
    if (normalName) return normalName;
    
    // Fallback: remove emojis and replace high-tech terms
    return hightechName
        .replace(/[⚡🛒🎰💼👤🌐🔧⚙️💎📦🌟✨🎮🎪🎭🎨🎬🎵🎶🎹🎺🎻🎸🥁🎤🎧🎼🎵📱💻🖥️🖨️📠📺📷📸📹🎥📼📀💿📼📽️🎞️📟📠📺📻🎙️🎚️🎛️🧮🎰🎲🎯🎳🎮🕹️🎗️🎟️🎫🎪🎭🩰🎨🎬📽️🎞️📽️🎞️🎞️]/g, '')
        .replace(/🌐/g, '')
        .replace(/NEURAL/g, '')
        .replace(/TERMINAL/g, '')
        .replace(/MATRIX/g, '')
        .replace(/SYSTEM/g, '')
        .replace(/NODE/g, '')
        .replace(/GRID/g, '')
        .replace(/CORE/g, '')
        .replace(/ACCESS/g, '')
        .replace(/AUTH/g, '')
        .replace(/SYNCED/g, '')
        .replace(/ACTIVE/g, '')
        .replace(/ONLINE/g, '')
        .replace(/SCAN/g, '')
        .replace(/LINK/g, '')
        .replace(/SECURE/g, '')
        .replace(/FIREWALL/g, '')
        .replace(/PROTOCOL/g, '')
        .replace(/NETWORK/g, '')
        .replace(/STATUS/g, '')
        .replace(/DATA/g, '')
        .replace(/OUTPUT/g, '')
        .replace(/INPUT/g, '')
        .replace(/RESULT/g, '')
        .replace(/QUANTUM/g, '')
        .replace(/ENCRYPTED/g, '')
        .replace(/DARKNET/g, '')
        .replace(/TRACE/g, '')
        .replace(/BYPASS/g, '')
        .replace(/INJECT/g, '')
        .replace(/PAYLOAD/g, '')
        .replace(/DETECT/g, '')
        .replace(/COUNTER/g, '')
        .replace(/MEASURE/g, '')
        .replace(/SIGNAL/g, '')
        .replace(/ROUTING/g, '')
        .replace(/MESSAGE/g, '')
        .replace(/LOG/g, '')
        .replace(/LEDGER/g, '')
        .replace(/WALLET/g, '')
        .replace(/BANK/g, '')
        .replace(/STASH/g, '')
        .replace(/INVENTORY/g, '')
        .replace(/PROFILE/g, '')
        .replace(/STATS/g, '')
        .replace(/ECONOMY/g, '')
        .replace(/CREDIT/g, '')
        .replace(/COIN/g, '')
        .replace(/MONEY/g, '')
        .replace(/CASH/g, '')
        .replace(/BALANCE/g, '')
        .replace(/XP/g, '')
        .replace(/LEVEL/g, '')
        .replace(/RANK/g, '')
        .replace(/STREAK/g, '')
        .replace(/DAILY/g, '')
        .replace(/WEEKLY/g, '')
        .replace(/WORK/g, '')
        .replace(/JOB/g, '')
        .replace(/SHIFT/g, '')
        .replace(/EARNINGS/g, '')
        .replace(/CRIME/g, '')
        .replace(/HEIST/g, '')
        .replace(/LOBBY/g, '')
        .replace(/PARTICIPANT/g, '')
        .replace(/PLAYER/g, '')
        .replace(/TARGET/g, '')
        .replace(/STOLE/g, '')
        .replace(/SHARED/g, '')
        .replace(/INSURANCE/g, '')
        .replace(/REIMBURSED/g, '')
        .replace(/FISH/g, '')
        .replace('◢', '')
        .replace('◣', '')
        .replace('◈', '')
        .replace('◇', '')
        .replace('◆', '');
}

/**
 * Format a button label based on UI style
 * @param {string} userId - The user's ID
 * @param {string} hightechLabel - Button label for high-tech mode
 * @param {string} normalLabel - Button label for normal mode (optional)
 * @returns {string} - Formatted button label
 */
function formatButtonLabel(userId, hightechLabel, normalLabel) {
    const style = getUserUIStyle(userId);
    if (style === 'hightech') {
        return hightechLabel;
    }
    if (normalLabel) return normalLabel;
    
    // Fallback: remove emojis and replace high-tech terms
    return hightechLabel
        .replace(/[⚡🛒🎰💼👤🌐🔧⚙️💎📦🌟✨🎮🎪🎭🎨🎬🎵🎶🎹🎺🎻🎸🥁🎤🎧🎼🎵📱💻🖥️🖨️📠📺📷📸📹🎥📼📀💿📼📽️🎞️📟📠📺📻🎙️🎚️🎛️🧮🎰🎲🎯🎳🎮🕹️🎗️🎟️🎫🎪🎭🩰🎨🎬📽️🎞️📽️🎞️🎞️]/g, '')
        .replace(/🌐/g, '')
        .replace(/NEURAL/g, '')
        .replace(/TERMINAL/g, '')
        .replace(/MATRIX/g, '')
        .replace(/SYSTEM/g, '')
        .replace(/NODE/g, '')
        .replace(/GRID/g, '')
        .replace(/CORE/g, '')
        .replace(/ACCESS/g, '')
        .replace(/AUTH/g, '')
        .replace(/SYNCED/g, '')
        .replace(/ACTIVE/g, '')
        .replace(/ONLINE/g, '')
        .replace(/SCAN/g, '')
        .replace(/LINK/g, '')
        .replace(/SECURE/g, '')
        .replace(/FIREWALL/g, '')
        .replace(/PROTOCOL/g, '')
        .replace(/NETWORK/g, '')
        .replace(/STATUS/g, '')
        .replace(/DATA/g, '')
        .replace(/OUTPUT/g, '')
        .replace(/INPUT/g, '')
        .replace(/RESULT/g, '')
        .replace(/QUANTUM/g, '')
        .replace(/ENCRYPTED/g, '')
        .replace(/DARKNET/g, '')
        .replace(/TRACE/g, '')
        .replace(/BYPASS/g, '')
        .replace(/INJECT/g, '')
        .replace(/PAYLOAD/g, '')
        .replace(/DETECT/g, '')
        .replace(/COUNTER/g, '')
        .replace(/MEASURE/g, '')
        .replace(/SIGNAL/g, '')
        .replace(/ROUTING/g, '')
        .replace(/MESSAGE/g, '')
        .replace(/LOG/g, '')
        .replace(/LEDGER/g, '')
        .replace(/WALLET/g, '')
        .replace(/BANK/g, '')
        .replace(/STASH/g, '')
        .replace(/INVENTORY/g, '')
        .replace(/PROFILE/g, '')
        .replace(/STATS/g, '')
        .replace(/ECONOMY/g, '')
        .replace(/CREDIT/g, '')
        .replace(/COIN/g, '')
        .replace(/MONEY/g, '')
        .replace(/CASH/g, '')
        .replace(/BALANCE/g, '')
        .replace(/XP/g, '')
        .replace(/LEVEL/g, '')
        .replace(/RANK/g, '')
        .replace(/STREAK/g, '')
        .replace(/DAILY/g, '')
        .replace(/WEEKLY/g, '')
        .replace(/WORK/g, '')
        .replace(/JOB/g, '')
        .replace(/SHIFT/g, '')
        .replace(/EARNINGS/g, '')
        .replace(/CRIME/g, '')
        .replace(/HEIST/g, '')
        .replace(/LOBBY/g, '')
        .replace(/PARTICIPANT/g, '')
        .replace(/PLAYER/g, '')
        .replace(/TARGET/g, '')
        .replace(/STOLE/g, '')
        .replace(/SHARED/g, '')
        .replace(/INSURANCE/g, '')
        .replace(/REIMBURSED/g, '')
        .replace(/FISH/g, '')
        .replace('◢', '')
        .replace('◣', '')
        .replace('◈', '')
        .replace('◇', '')
        .replace('◆', '');
}

/**
 * Check if user has high-tech UI enabled
 * @param {string} userId - The user's ID
 * @returns {boolean} - True if high-tech mode is enabled
 */
function isHighTech(userId) {
    return getUserUIStyle(userId) === 'hightech';
}

module.exports = {
    getUserUIStyle,
    formatTitle,
    formatDescription,
    getColor,
    formatFieldName,
    formatButtonLabel,
    isHighTech
};
