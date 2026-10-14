const { getUser } = require('../economy/userManager');

function ensureUser(userId) {
    return getUser(userId);
}

module.exports = { ensureUser };
