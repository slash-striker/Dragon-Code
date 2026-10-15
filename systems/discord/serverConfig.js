const db = require('../../database');

db.exec(`
    CREATE TABLE IF NOT EXISTS guild_config (
        guildId TEXT NOT NULL,
        scope TEXT NOT NULL,
        setting TEXT NOT NULL,
        value TEXT NOT NULL,
        updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guildId, scope, setting)
    );
    CREATE TABLE IF NOT EXISTS guild_command_channels (
        guildId TEXT NOT NULL,
        commandName TEXT NOT NULL,
        channelId TEXT NOT NULL,
        updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guildId, commandName)
    )
`);

function get(guildId, scope, setting, fallback = null) {
    if (!guildId) return fallback;
    const row = db.prepare(
        'SELECT value FROM guild_config WHERE guildId = ? AND scope = ? AND setting = ?'
    ).get(String(guildId), String(scope), String(setting));
    return row ? row.value : fallback;
}

function set(guildId, scope, setting, value) {
    if (!guildId) throw new Error('Configuration must be set inside a server.');
    db.prepare(`
        INSERT INTO guild_config (guildId, scope, setting, value, updatedAt)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(guildId, scope, setting) DO UPDATE SET
            value = excluded.value, updatedAt = excluded.updatedAt
    `).run(String(guildId), String(scope), String(setting), String(value));
    return String(value);
}

function list(guildId) {
    if (!guildId) return [];
    return db.prepare(
        'SELECT scope, setting, value, updatedAt FROM guild_config WHERE guildId = ? ORDER BY scope, setting'
    ).all(String(guildId));
}

function getChannelId(guildId, setting, fallback) {
    return get(guildId, 'channel', setting, fallback);
}

function setCommandChannel(guildId, commandName, channelId) {
    if (!guildId) throw new Error('A command channel must be set inside a server.');
    db.prepare(`
        INSERT INTO guild_command_channels (guildId, commandName, channelId, updatedAt)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(guildId, commandName) DO UPDATE SET
            channelId = excluded.channelId, updatedAt = excluded.updatedAt
    `).run(String(guildId), String(commandName).toLowerCase(), String(channelId));
    return String(channelId);
}

function getCommandChannel(guildId, commandName, fallback) {
    if (!guildId) return fallback;
    const row = db.prepare('SELECT channelId FROM guild_command_channels WHERE guildId = ? AND commandName = ?')
        .get(String(guildId), String(commandName).toLowerCase());
    return row?.channelId || fallback;
}

function listCommandChannels(guildId) {
    if (!guildId) return [];
    return db.prepare('SELECT commandName, channelId, updatedAt FROM guild_command_channels WHERE guildId = ? ORDER BY commandName')
        .all(String(guildId));
}

function getRoleId(guildId, setting, fallback) {
    return get(guildId, 'role', setting, fallback);
}

function getServerValue(guildId, setting, fallback) {
    return get(guildId, 'server', setting, fallback);
}

module.exports = {
    get, set, list, getChannelId, getRoleId, getServerValue,
    setCommandChannel, getCommandChannel, listCommandChannels
};
