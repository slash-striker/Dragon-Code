const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    ComponentType
} = require('discord.js');

const db = require('../database');
const tttElo = require('../systems/economy/tttElo');

/*
 * 🎮 /games — one slash slot for all eight minigames.
 *
 *   /games                → lounge embed with a BUTTON per game
 *   /games game:5dice …   → power path, straight into the engine with options
 *
 * Each lounge button opens that game's SETUP PANEL embed — its own buttons
 * for every difficulty/mode/preset it supports — plus a "🚀 Custom settings"
 * dialog for the fiddly options and a "◀ Back" button. Clicking any setup
 * button starts the game instantly via the same delegation facade as before:
 *   - reply()        → followUp()      (legal after deferReply/deferUpdate)
 *   - deferReply()   → no-op           (this hub already acknowledged)
 *   - everything else passes straight through (user/options/editReply/…)
 * Engines never read interaction.commandName, so they cannot tell the
 * difference. Engines are lazy-required so the hub only loads one engine
 * per play. All component ids are restart-safe: every click routes through
 * index.js to handleComponent/handleModal — the collectors on the messages
 * only disable stale buttons on timeout.
 */

const GAME_CHOICES = [
    { name: '🎲 5 Dice — roll, keep, and reroll five dice', value: '5dice' },
    { name: '☠️ Hangman — guess the hidden word', value: 'hangman' },
    { name: '📈 High/Low — bet on the next card', value: 'highlow' },
    { name: '💡 Lights Out — switch off every light', value: 'lightsout' },
    { name: '🧠 Mastermind — crack the hidden color code', value: 'mastermind' },
    { name: '🧩 Match Pairs — find all the hidden pairs', value: 'matchpairs' },
    { name: '✊ RPS — rock paper scissors', value: 'rps' },
    { name: '⭕ Tic-Tac-Toe — beat the bot', value: 'tictactoe' },
    { name: '🏆 Tic-Tac-Toe Ladder — rated player-vs-player Elo', value: 'tttladder' }
];

const BTN = {
    primary: ButtonStyle.Primary,
    secondary: ButtonStyle.Secondary,
    success: ButtonStyle.Success,
    danger: ButtonStyle.Danger
};

/*
 * Setup-panel button data per game. `overrides` are injected through the
 * facade so engines read them exactly like slash options. Buttons are
 * grouped into rows; every panel also gets 🚀 Custom settings + ◀ Back.
 */
const GAME_DEFS = {
    '5dice': {
        engine: './5dice',
        emoji: '🎲',
        name: '5 Dice',
        tagline: 'Yahtzee-style — roll, keep what you like, reroll the rest.',
        buttons: [[
            { id: 'play', label: '▶ Play', style: BTN.primary, overrides: {} },
            { id: 'daily', label: '📅 Daily', style: BTN.secondary, overrides: { mode: 'daily' } },
            { id: 'stats', label: '📊 Stats', style: BTN.secondary, overrides: { mode: 'stats' } }
        ]]
    },
    hangman: {
        engine: './hangman',
        emoji: '☠️',
        name: 'Hangman',
        tagline: 'Guess the hidden word one letter at a time — before the drawing finishes.',
        buttons: [
            [{ id: 'play', label: '▶ Play (medium)', style: BTN.primary, overrides: {} }],
            [
                { id: 'easy', label: '🟢 Easy', style: BTN.secondary, overrides: { difficulty: 'easy' } },
                { id: 'medium', label: '🟡 Medium', style: BTN.secondary, overrides: { difficulty: 'medium' } },
                { id: 'hard', label: '🔴 Hard', style: BTN.secondary, overrides: { difficulty: 'hard' } },
                { id: 'extreme', label: '💀 Extreme', style: BTN.secondary, overrides: { difficulty: 'extreme' } }
            ],
            [
                { id: 'animals', label: '🐾 Animals', style: BTN.secondary, overrides: { category: 'animals' } },
                { id: 'food', label: '🍕 Food', style: BTN.secondary, overrides: { category: 'food' } },
                { id: 'nature', label: '🌿 Nature', style: BTN.secondary, overrides: { category: 'nature' } },
                { id: 'hstats', label: '📊 Stats', style: BTN.secondary, overrides: { mode: 'stats' } }
            ]
        ]
    },
    highlow: {
        engine: './highlow',
        emoji: '📈',
        name: 'High/Low',
        tagline: 'Will the next card be higher or lower? Bet and ride the streak.',
        buttons: [
            [
                { id: 'safe100', label: '🛡️ Safe · 🪙100', style: BTN.secondary, overrides: { bet: 100, preset: 'safe' } },
                { id: 'classic100', label: '⚖️ Classic · 🪙100', style: BTN.primary, overrides: { bet: 100, preset: 'classic' } },
                { id: 'aggr100', label: '🔥 Aggressive · 🪙100', style: BTN.secondary, overrides: { bet: 100, preset: 'aggressive' } }
            ],
            [
                { id: 'safe500', label: '🛡️ Safe · 🪙500', style: BTN.secondary, overrides: { bet: 500, preset: 'safe' } },
                { id: 'classic500', label: '⚖️ Classic · 🪙500', style: BTN.primary, overrides: { bet: 500, preset: 'classic' } },
                { id: 'aggr500', label: '🔥 Aggressive · 🪙500', style: BTN.secondary, overrides: { bet: 500, preset: 'aggressive' } }
            ],
            [
                { id: 'max', label: '💸 Go big — 🪙1000 aggressive', style: BTN.danger, overrides: { bet: 1000, preset: 'aggressive' } },
                { id: 'pvp', label: '👥 PvP lobby', style: BTN.secondary, overrides: { bet: 100, preset: 'classic', mode: 'pvp' } }
            ]
        ]
    },
    lightsout: {
        engine: './lightsout',
        emoji: '💡',
        name: 'Lights Out',
        tagline: 'Flip switches until every light is off — every move toggles its neighbours too.',
        buttons: [
            [
                { id: 'play', label: '▶ Play (normal)', style: BTN.primary, overrides: {} },
                { id: 'daily', label: '📅 Daily', style: BTN.secondary, overrides: { action: 'daily' } },
                { id: 'challenge', label: '⚡ Challenge', style: BTN.secondary, overrides: { action: 'challenge' } }
            ],
            [
                { id: 'easy', label: '🟢 Easy 3×3', style: BTN.secondary, overrides: { action: 'play', difficulty: 'easy' } },
                { id: 'normal', label: '🟡 Normal 4×4', style: BTN.secondary, overrides: { action: 'play', difficulty: 'normal' } },
                { id: 'hard', label: '🔴 Hard 5×5', style: BTN.secondary, overrides: { action: 'play', difficulty: 'hard' } }
            ],
            [
                { id: 'hint', label: '💡 Hint', style: BTN.secondary, overrides: { action: 'hint' } },
                { id: 'undo', label: '↩️ Undo', style: BTN.secondary, overrides: { action: 'undo' } },
                { id: 'lstats', label: '📊 Stats', style: BTN.secondary, overrides: { action: 'stats' } },
                { id: 'lboard', label: '🏆 Leaderboard', style: BTN.secondary, overrides: { action: 'leaderboard' } }
            ]
        ]
    },
    mastermind: {
        engine: './mastermind',
        emoji: '🧠',
        name: 'Mastermind',
        tagline: 'Crack the hidden color code — 🟢 right spot, 🟡 right color wrong spot.',
        buttons: [
            [{ id: 'play', label: '▶ Play (easy)', style: BTN.primary, overrides: {} }],
            [
                { id: 'easy', label: '🟢 Easy', style: BTN.secondary, overrides: { difficulty: 'easy' } },
                { id: 'normal', label: '🟡 Normal', style: BTN.secondary, overrides: { difficulty: 'normal' } },
                { id: 'hard', label: '🔴 Hard', style: BTN.secondary, overrides: { difficulty: 'hard' } },
                { id: 'expert', label: '💀 Expert', style: BTN.secondary, overrides: { difficulty: 'expert' } }
            ],
            [
                { id: 'dupes-on', label: '🎭 Duplicates ON', style: BTN.secondary, overrides: { difficulty: 'hard', duplicates: true } },
                { id: 'mstats', label: '📊 Stats', style: BTN.secondary, overrides: { mode: 'stats' } }
            ]
        ]
    },
    matchpairs: {
        engine: './matchpairs',
        emoji: '🧩',
        name: 'Match Pairs',
        tagline: 'Flip tiles on a 5×4 grid and remember where every signal hides.',
        buttons: [[
            { id: 'play', label: '▶ Play', style: BTN.primary, overrides: {} },
            { id: 'mstats', label: '📊 Stats', style: BTN.secondary, overrides: { mode: 'stats' } }
        ]]
    },
    rps: {
        engine: './rps',
        emoji: '✊',
        name: 'RPS',
        tagline: 'Quickfire rock paper scissors against the bot.',
        buttons: [[
            { id: 'play', label: '▶ Play', style: BTN.primary, overrides: {} },
            { id: 'rstats', label: '📊 Stats', style: BTN.secondary, overrides: { mode: 'stats' } }
        ]]
    },
    tictactoe: {
        engine: './tictactoe',
        emoji: '⭕',
        name: 'Tic-Tac-Toe',
        tagline: 'The classic three-in-a-row — outsmart the bot.',
        buttons: [[
            { id: 'play', label: '▶ Play', style: BTN.primary, overrides: {} },
            { id: 'tstats', label: '📊 Stats', style: BTN.secondary, overrides: { mode: 'stats' } }
        ]]
    }
};

const HIGHLOW_BET_MAX = 1000;

/*
 * Difficulty alias guard — the hub's shared difficulty option is a superset
 * (easy/medium/normal/hard/extreme), but the engines disagree on their
 * ladders: mastermind + lightsout use "normal" (no medium/extreme), hangman
 * uses "medium" (no normal). Crossing the ladders used to crash the engines
 * with `DIFFICULTY[...]` undefined, so remap crossed values here.
 */
const DIFFICULTY_ALIASES = {
    mastermind: { medium: 'normal', extreme: 'hard' },
    lightsout: { medium: 'normal', extreme: 'hard' },
    hangman: { normal: 'medium' }
};

function effectiveDifficulty(game, difficulty) {
    return (difficulty && DIFFICULTY_ALIASES[game]?.[difficulty]) || difficulty;
}

/*
 * Delegation facade — see the header comment. Getters for deferred/replied
 * so engine error paths observe the REAL interaction state. optionOverrides
 * let setup buttons inject defaults (High/Low quick buttons carry their bet).
 * getUser() is stubbed for engines that lazily ensure an account.
 * Modal submits (games:cfgmodal) arrive WITHOUT an `options` payload on the
 * real interaction, so every getter guards for its absence instead of
 * throwing `Cannot read properties of undefined (reading 'getString')`.
 */
const FRESH_OPTIONS_FALLBACK = {
    getString: () => null,
    getInteger: () => null,
    getBoolean: () => null,
    getUser: () => null
};

function facadeFor(interaction, optionOverrides = {}) {
    // Real slash interactions carry `.options`; modal submits may not.
    const realOptions = interaction.options || FRESH_OPTIONS_FALLBACK;
    const optionsApi = {
        getString: name => (name in optionOverrides ? optionOverrides[name] : realOptions.getString(name)),
        getInteger: name => (name in optionOverrides ? optionOverrides[name] : realOptions.getInteger(name)),
        getBoolean: name => (name in optionOverrides ? optionOverrides[name] : realOptions.getBoolean(name)),
        getUser: name => (name in optionOverrides ? optionOverrides[name] : realOptions.getUser(name))
    };
    return {
        user: interaction.user,
        member: interaction.member,
        guild: interaction.guild,
        client: interaction.client,
        channel: interaction.channel,
        channelId: interaction.channelId,
        options: optionsApi,
        customId: interaction.customId,
        get deferred() { return interaction.deferred; },
        get replied() { return interaction.replied; },
        // This hub already acknowledged before the engine runs.
        deferReply: async () => {},
        // A fresh reply is impossible after an ack — followUp instead.
        reply: (...args) => interaction.followUp(...args),
        fetchReply: (...args) => interaction.fetchReply(...args),
        editReply: (...args) => interaction.editReply(...args),
        followUp: (...args) => interaction.followUp(...args),
        deferUpdate: (...args) => interaction.deferUpdate(...args),
        update: (...args) => interaction.update(...args)
    };
}

/* ---------- Lounge + panel rendering ---------- */

function loungeEmbed(user) {
    return new EmbedBuilder()
        .setColor(0x00d4ff)
        .setTitle('🎮 GAME LOUNGE')
        .setDescription(
            '**Eight minigames, one command.** Hit a game\'s button below to open its setup panel — every difficulty, mode and bet lives on that panel\'s own buttons.\n\n' +
            Object.values(GAME_DEFS).map(g => `${g.emoji} **${g.name}** — ${g.tagline}`).join('\n') +
            '\n\n**⚡ Speedrun?** `/games game:Hangman difficulty:hard` (and every other option combo) still skips straight into the game.\n' +
            '**🏆 Tic-Tac-Toe Ladder** — rated player-vs-player Elo with a weekly promotion for the top rating.\n' +
            '**✋ No inputs? Totally fine.** Slash options are ALL optional — a bare `/games` is enough; the buttons do the rest.'
        )
        .setFooter({ text: `${user.tag ?? user.username ?? 'Player'} • buttons stay live across restarts` })
        .setTimestamp();
}

function buildLoungeRows() {
    const ids = Object.keys(GAME_DEFS);
    const rows = [];
    for (let i = 0; i < ids.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(ids.slice(i, i + 5).map(id =>
            new ButtonBuilder()
                .setCustomId(`games:open:${id}`)
                .setLabel(GAME_DEFS[id].name)
                .setEmoji(GAME_DEFS[id].emoji)
                .setStyle(ButtonStyle.Primary))));
    }
    // The ranked ladder has no bot engine, so it is not in GAME_DEFS — the
    // lounge gets one extra button for it instead.
    const ladderButton = new ButtonBuilder()
        .setCustomId('games:ladder')
        .setLabel('Tic-Tac-Toe Ladder')
        .setEmoji('🏆')
        .setStyle(ButtonStyle.Success);
    const lastRow = rows[rows.length - 1];
    if (lastRow && lastRow.components.length < 5) lastRow.addComponents(ladderButton);
    else rows.push(new ActionRowBuilder().addComponents(ladderButton));
    return rows;
}

function disabledLoungeRows() {
    return buildLoungeRows().map(row =>
        new ActionRowBuilder().addComponents(row.components.map(c => ButtonBuilder.from(c).setDisabled(true))));
}

function gamePanelEmbed(game, user) {
    const def = GAME_DEFS[game];
    return new EmbedBuilder()
        .setColor(0x00d4ff)
        .setTitle(`${def.emoji} ${def.name.toUpperCase()} — SETUP`)
        .setDescription(
            `${def.tagline}\n\n` +
            `⚙️ **Setting buttons start the game instantly** — anything you don't pick falls back to the game's own defaults.\n` +
            `✋ **No slash inputs needed** — buttons cover everything; leaving the slash options empty is normal.\n` +
            `🚀 **Custom settings** opens a dialog for the fiddly options (all fields optional unless marked required).\n` +
            `↩️ **Back to lounge** returns to the game list.` +
            (game === 'highlow'
                ? `\n\n📈 High/Low quick buttons start at their shown bet; open the dialog for any wager 10-1000.`
                : ''))
        .setFooter({ text: `${user.tag ?? user.username ?? 'Player'} • panels stay live across restarts` })
        .setTimestamp();
}

function buildPanelRows(game) {
    const def = GAME_DEFS[game];
    const rows = def.buttons.map(group => new ActionRowBuilder().addComponents(group.map(btn =>
        new ButtonBuilder().setCustomId(`games:go:${game}:${btn.id}`).setLabel(btn.label).setStyle(btn.style))));
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`games:cfg:${game}`).setLabel('🚀 Custom settings').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`games:back:${game}`).setLabel('◀ Back to lounge').setStyle(ButtonStyle.Secondary)
    ));
    return rows;
}

/* ---------- Launch plumbing ---------- */

async function startGame(interaction, game, overrides = {}) {
    const def = GAME_DEFS[game];
    if (!def) return interaction.deferUpdate().catch(() => {});
    await interaction.deferUpdate().catch(() => {});
    const effective = { ...overrides };
    if (game === 'highlow' && effective.bet == null) effective.bet = 100;
    if (effective.difficulty) effective.difficulty = effectiveDifficulty(game, effective.difficulty);
    // Lazy require so the hub only loads one engine per play.
    const engine = require(def.engine);
    await engine.execute(facadeFor(interaction, effective));
}

function showConfigModal(interaction, game) {
    const def = GAME_DEFS[game];
    const modal = new ModalBuilder()
        .setCustomId(`games:cfgmodal:${game}`)
        .setTitle(`${def.name} — settings`.slice(0, 45));
    const field = (id, label, required = false, maxLength = 32) =>
        new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId(id).setLabel(label)
                .setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(maxLength));

    if (game === 'highlow') modal.addComponents(field('bet', 'Bet (10-1000)', true, 4));
    if (game === 'hangman') {
        modal.addComponents(field('difficulty', 'Difficulty: easy/medium/hard/extreme', false, 12));
        modal.addComponents(field('category', 'Category: general/animals/food/nature', false, 12));
    }
    if (game === 'lightsout') modal.addComponents(field('difficulty', 'Difficulty: easy/normal/hard', false, 12));
    if (game === 'mastermind') {
        modal.addComponents(field('difficulty', 'Difficulty: easy/normal/hard/expert', false, 12));
        modal.addComponents(field('duplicates', 'Duplicates: yes / no', false, 3));
    }
    if (game === '5dice') modal.addComponents(field('mode', 'Mode: play/daily/stats', false, 12));
    if (game === 'matchpairs' || game === 'rps' || game === 'tictactoe') {
        modal.addComponents(field('mode', 'Mode: play/stats', false, 12));
    }
    return interaction.showModal(modal);
}

async function handleModal(interaction) {
    const [, verb, game] = interaction.customId.split(':');
    if (verb !== 'cfgmodal' || !GAME_DEFS[game]) {
        return interaction.reply({ content: '❌ Unknown setup dialog.', ephemeral: true }).catch(() => {});
    }
    const overrides = {};
    const get = id => {
        try { return interaction.fields.getTextInputValue(id)?.trim() || ''; }
        catch { return ''; }
    };
    const betRaw = get('bet');
    if (betRaw) {
        const bet = Number(betRaw);
        if (Number.isFinite(bet) && bet > 0) overrides.bet = Math.max(10, Math.min(HIGHLOW_BET_MAX, Math.floor(bet)));
    }
    const difficulty = get('difficulty').toLowerCase();
    if (['easy', 'medium', 'normal', 'hard', 'extreme', 'expert'].includes(difficulty)) overrides.difficulty = difficulty;
    const category = get('category').toLowerCase();
    if (['general', 'animals', 'food', 'nature'].includes(category)) {
        overrides.category = category;
    }
    const mode = get('mode').toLowerCase();
    if (['play', 'daily', 'speedrun', 'stats', 'solo', 'pvp'].includes(mode)) overrides.mode = mode;
    const dupes = get('duplicates').toLowerCase();
    if (['yes', 'y', 'true', 'on', '1'].includes(dupes)) overrides.duplicates = true;
    if (['no', 'n', 'false', 'off', '0'].includes(dupes)) overrides.duplicates = false;
    if (overrides.difficulty) overrides.difficulty = effectiveDifficulty(game, overrides.difficulty);

    await interaction.deferReply();
    const engine = require(GAME_DEFS[game].engine);
    return engine.execute(facadeFor(interaction, overrides));
}

/* ---------- Fresh /games (no game argument) — the lounge panel ---------- */

async function runLounge(interaction) {
    const embed = loungeEmbed(interaction.user);
    const rows = buildLoungeRows();

    /*
     * Same pattern as the /mining hub: the collector exists ONLY to disable
     * the buttons when it expires — ALL actual clicks route through index.js
     * to handleComponent below, so the panel survives bot restarts and a
     * click can never be handled twice.
     */
    await interaction.reply({ embeds: [embed], components: rows });
    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 15 * 60 * 1000
    });

    collector.on('end', async () => {
        try {
            await message.edit({ components: disabledLoungeRows() });
        } catch (error) {
            if (error?.code !== 10008) console.error('Unable to close game lounge:', error);
        }
    });
}

function buildGamesData() {
    return new SlashCommandBuilder()
        .setName('games')
        .setDescription('All minigames: 5dice · hangman · highlow · lightsout · mastermind · matchpairs · rps · tictactoe')
        .addStringOption(opt => opt
            .setName('game')
            .setDescription('Which game to play (leave empty for the lounge panels)')
            .setRequired(false)
            .addChoices(...GAME_CHOICES))
        .addIntegerOption(opt => opt
            .setName('bet')
            .setDescription('High/Low only: amount to wager (10-1000)')
            .setMinValue(10)
            .setMaxValue(1000))
        .addStringOption(opt => opt
            .setName('category')
            .setDescription('Hangman only: word category')
            .addChoices(
                { name: '📚 General', value: 'general' },
                { name: '🐾 Animals', value: 'animals' },
                { name: '🍕 Food', value: 'food' },
                { name: '🌿 Nature', value: 'nature' }
            ))
        .addStringOption(opt => opt
            .setName('difficulty')
            .setDescription('Hangman/Lights Out/Mastermind: difficulty')
            .addChoices(
                { name: 'Easy', value: 'easy' },
                { name: 'Normal', value: 'normal' },
                { name: 'Medium', value: 'medium' },
                { name: 'Hard', value: 'hard' },
                { name: 'Extreme', value: 'extreme' }
            ))
        .addStringOption(opt => opt
            .setName('preset')
            .setDescription('High/Low only: game preset')
            .addChoices(
                { name: 'Safe', value: 'safe' },
                { name: 'Classic', value: 'classic' },
                { name: 'Aggressive', value: 'aggressive' }
            ))
        .addStringOption(opt => opt
            .setName('mode')
            .setDescription('Mode — per game: Play/Daily/Speedrun/Stats or Solo/PvP (High/Low)')
            .addChoices(
                { name: 'Play', value: 'play' },
                { name: 'Daily', value: 'daily' },
                { name: 'Speedrun', value: 'speedrun' },
                { name: 'Stats', value: 'stats' },
                { name: 'Solo', value: 'solo' },
                { name: 'PvP', value: 'pvp' }
            ))
        .addStringOption(opt => opt
            .setName('action')
            .setDescription('Lights Out only: what to do')
            .addChoices(
                { name: '🎮 Play — puzzle with a difficulty choice', value: 'play' },
                { name: '📅 Daily — today’s seeded puzzle', value: 'daily' },
                { name: '⚡ Challenge — high-reward puzzle', value: 'challenge' },
                { name: '💡 Hint — hint for your active game', value: 'hint' },
                { name: '↩️ Undo — undo your last move', value: 'undo' },
                { name: '🔄 Reset — reset your active board', value: 'reset' },
                { name: '🚪 Quit — end your active game', value: 'quit' },
                { name: '📊 Stats — your record', value: 'stats' },
                { name: '🏆 Leaderboard — top solvers', value: 'leaderboard' }
            ))
        .addBooleanOption(opt => opt
            .setName('duplicates')
            .setDescription('Mastermind only: allow duplicate colors'))
        .addUserOption(opt => opt
            .setName('opponent')
            .setDescription('Tic-Tac-Toe Ladder only: who to challenge to a rated match'));
}

/* ---------- 🏆 Tic-Tac-Toe Elo ladder (player vs player) ---------- */
/*
 * The vs-bot game above is untouched; this is the RANKED side of
 * Tic-Tac-Toe — two players, one board, Elo on the line.
 *
 * EVERYTHING IS DURABLE. A pending invite and a live match are rows in
 * bot_meta (ttt:challenge:<challengerId> and ttt:match:<matchKey>) instead of
 * in-memory collectors, for two reasons that both matter here:
 *   1. this bot restarts, and a collector dies with the process;
 *   2. BOTH players click the SAME message, so a collector created from one
 *      player's interaction could never serve the other player's clicks.
 * Rows are deleted as soon as they are consumed, and anything older than its
 * TTL is refused with a friendly message rather than throwing.
 */
const LADDER_GAME = 'tttladder';
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const BOARD_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

function metaGet(key) {
    const row = db.prepare('SELECT value FROM bot_meta WHERE key = ?').get(key);
    return row ? row.value : null;
}

function metaSet(key, value) {
    db.prepare(`
        INSERT INTO bot_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
}

function metaDel(key) {
    db.prepare('DELETE FROM bot_meta WHERE key = ?').run(key);
}

/* Cosmetic titles are another slice of this batch — never let them break the ladder. */
function titleTagFor(userId) {
    try {
        const titles = require('../systems/economy/titleManager');
        if (titles && typeof titles.formatTitleTag === 'function') return titles.formatTitleTag(userId) || null;
        return null;
    } catch (error) {
        return null;
    }
}

function markCell(value) {
    if (value === 'X') return '❌';
    if (value === 'O') return '⭕';
    return '⬜';
}

function boardText(board) {
    return [board.slice(0, 3), board.slice(3, 6), board.slice(6, 9)]
        .map(row => row.map(markCell).join(' '))
        .join('\n');
}

function winnerMark(board) {
    for (const line of BOARD_LINES) {
        const [a, b, c] = line;
        if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
    }
    return null;
}

function turnPlayerId(match) {
    return match.turn === 'X' ? String(match.x) : String(match.o);
}

function matchRows(matchKey, board) {
    const cells = board.map((value, index) => new ButtonBuilder()
        .setCustomId(`ttt:move:${matchKey}:${index}`)
        .setLabel(value ? value : String(index + 1))
        .setStyle(value === 'X' ? ButtonStyle.Danger : value === 'O' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(Boolean(value)));
    return [
        new ActionRowBuilder().addComponents(cells.slice(0, 3)),
        new ActionRowBuilder().addComponents(cells.slice(3, 6)),
        new ActionRowBuilder().addComponents(cells.slice(6, 9))
    ];
}

function ladderRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ttt:challenge').setLabel('Challenge a player').setEmoji('⚔️').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('ttt:refresh').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('games:open:tictactoe').setLabel('Play the bot').setEmoji('🤖').setStyle(ButtonStyle.Primary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('games:back:tictactoe').setLabel('Back to lounge').setEmoji('◀').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('ttt:close').setLabel('Close').setEmoji('✖').setStyle(ButtonStyle.Danger)
        )
    ];
}

function ladderPanelPayload(userId) {
    const record = tttElo.getRecord(userId) || {};
    const rank = tttElo.getRank(userId);
    const ladder = tttElo.getLadder(10);
    const history = tttElo.getMatchHistory(userId, 5);
    const promotion = tttElo.getPromotions(1)[0] || null;
    const tag = titleTagFor(userId);

    const ladderLines = ladder.length
        ? ladder.map(entry => {
            const medal = entry.rank === 1 ? '🥇' : entry.rank === 2 ? '🥈' : entry.rank === 3 ? '🥉' : '#' + entry.rank;
            const entryTag = titleTagFor(entry.userId);
            const streak = Number(entry.streak) > 1 ? ' 🔥' + entry.streak : '';
            return medal + ' <@' + entry.userId + '> — **' + entry.elo + '** Elo (' +
                entry.wins + 'W/' + entry.losses + 'L/' + entry.draws + 'D)' + streak +
                (entryTag ? ' ' + entryTag : '');
        }).join('\n')
        : '_Nobody has a rated match yet — challenge someone to open the ladder._';

    const historyLines = history.length
        ? history.map(match => {
            const isChallenger = String(match.challengerId) === String(userId);
            const opponentId = isChallenger ? match.opponentId : match.challengerId;
            const delta = Number(isChallenger ? match.challengerDelta : match.opponentDelta) || 0;
            const verdict = !match.winnerId
                ? '🤝 drew with'
                : String(match.winnerId) === String(userId) ? '✅ beat' : '❌ lost to';
            return verdict + ' <@' + opponentId + '> — ' + (delta >= 0 ? '+' : '') + delta + ' Elo';
        }).join('\n')
        : '_No rated matches played yet._';

    const promotionLine = promotion
        ? '👑 Last weekly promotion: <@' + promotion.userId + '> — **' + promotion.elo + '** Elo (week ' + promotion.weekKey + ')'
        : '👑 No weekly promotion has been awarded yet.';

    const embed = new EmbedBuilder()
        .setColor(0xa855f7)
        .setTitle('🏆 TIC-TAC-TOE ELO LADDER')
        .setDescription([
            '**Your rating:** **' + (Number(record.elo) || tttElo.START_ELO) + '** Elo' +
                (rank ? ' · rank **#' + rank + '**' : '') + (tag ? ' · ' + tag : ''),
            '**Record:** ' + (Number(record.wins) || 0) + 'W / ' + (Number(record.losses) || 0) + 'L / ' +
                (Number(record.draws) || 0) + 'D · current streak **' + (Number(record.streak) || 0) +
                '** · best **' + (Number(record.bestStreak) || 0) + '**',
            '_Start rating ' + tttElo.START_ELO + ' · K-factor ' + tttElo.K + ' · a draw only moves each side half._',
            '',
            '**🥇 TOP 10**',
            ladderLines,
            '',
            '**📜 YOUR RECENT MATCHES**',
            historyLines,
            '',
            promotionLine
        ].join('\n').slice(0, 3900))
        .setFooter({ text: 'Challenge a player below — the board appears the moment they accept' })
        .setTimestamp();

    return { embeds: [embed], components: ladderRows() };
}

/* ---------- durable invites ---------- */
function challengeKey(challengerId) {
    return 'ttt:challenge:' + challengerId;
}

function createChallenge(challengerId, opponentId, channelId) {
    metaSet(challengeKey(challengerId), JSON.stringify({
        opponentId: String(opponentId),
        channelId: channelId || null,
        expiresAt: Date.now() + CHALLENGE_TTL_MS
    }));
}

function readChallenge(challengerId) {
    const raw = metaGet(challengeKey(challengerId));
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.opponentId) return null;
        if (Number(parsed.expiresAt) < Date.now()) {
            metaDel(challengeKey(challengerId));
            return null;
        }
        return parsed;
    } catch (error) {
        return null;
    }
}

function clearChallenge(challengerId) {
    metaDel(challengeKey(challengerId));
}

function challengePayload(challengerId, opponentId) {
    const embed = new EmbedBuilder()
        .setColor(0x00d4ff)
        .setTitle('⚔️ RANKED TIC-TAC-TOE CHALLENGE')
        .setDescription([
            '<@' + challengerId + '> has challenged <@' + opponentId + '> to a **rated** match.',
            '',
            '**' + Number(tttElo.getElo(challengerId)) + '** Elo vs **' + Number(tttElo.getElo(opponentId)) + '** Elo',
            'A win moves the rating hard; a draw moves both sides only half.',
            '',
            '<@' + opponentId + '> — hit **Accept** to open the board. The invite expires in 10 minutes.'
        ].join('\n'))
        .setFooter({ text: 'NEON GRID LEAGUE' })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ttt:accept:' + challengerId).setLabel('Accept').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('ttt:decline:' + challengerId).setLabel('Decline').setEmoji('❌').setStyle(ButtonStyle.Danger)
    );

    return { embeds: [embed], components: [row] };
}

/* ---------- durable matches ---------- */
function matchKey(matchKeyValue) {
    return 'ttt:match:' + matchKeyValue;
}

function newMatchKey() {
    return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function createMatch(challengerId, opponentId) {
    const key = newMatchKey();
    const match = {
        x: String(challengerId),
        o: String(opponentId),
        challengerId: String(challengerId),
        opponentId: String(opponentId),
        board: Array(9).fill(''),
        turn: 'X',
        status: 'live',
        createdAt: Date.now()
    };
    metaSet(matchKey(key), JSON.stringify(match));
    return { matchKey: key, match };
}

function readMatch(key) {
    const raw = metaGet(matchKey(key));
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.board) || parsed.board.length !== 9) return null;
        return parsed;
    } catch (error) {
        return null;
    }
}

function writeMatch(key, match) {
    metaSet(matchKey(key), JSON.stringify(match));
}

function clearMatch(key) {
    metaDel(matchKey(key));
}

function matchPayload(key, match, note) {
    const xId = String(match.x);
    const oId = String(match.o);
    const current = turnPlayerId(match);
    const embed = new EmbedBuilder()
        .setColor(0x00d4ff)
        .setTitle('⭕ RANKED TIC-TAC-TOE')
        .setDescription([
            boardText(match.board),
            '',
            '❌ <@' + xId + '> — **' + Number(tttElo.getElo(xId)) + '** Elo',
            '⭕ <@' + oId + '> — **' + Number(tttElo.getElo(oId)) + '** Elo',
            '',
            '🎯 <@' + current + '> to move — playing **' + match.turn + '**'
        ].join('\n'))
        .setFooter({ text: 'Only the player whose turn it is can move' })
        .setTimestamp();
    if (note) embed.addFields({ name: 'ℹ️ Match', value: note });
    return { embeds: [embed], components: matchRows(key, match.board) };
}

function resultPayload(match, elo) {
    const xId = String(match.x);
    const oId = String(match.o);
    const winnerId = elo.outcome === 'challenger' ? xId : elo.outcome === 'opponent' ? oId : null;
    const isDraw = !winnerId;
    const embed = new EmbedBuilder()
        .setColor(isDraw ? 0xffd166 : 0x00e5a8)
        .setTitle(isDraw ? '🤝 RANKED MATCH — DRAW' : '🏆 RANKED MATCH — VICTORY')
        .setDescription([
            boardText(match.board),
            '',
            '❌ <@' + xId + '> — **' + elo.challengerElo + '** Elo (' + (elo.challengerDelta >= 0 ? '+' : '') + elo.challengerDelta + ')',
            '⭕ <@' + oId + '> — **' + elo.opponentElo + '** Elo (' + (elo.opponentDelta >= 0 ? '+' : '') + elo.opponentDelta + ')',
            '',
            isDraw ? 'Both players keep half the move — no rating was farmed.' : '<@' + winnerId + '> takes the rating.'
        ].join('\n'))
        .setFooter({ text: 'NEON GRID LEAGUE' })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ttt:rematch:' + xId + ':' + oId).setLabel('Rematch').setEmoji('🔁').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('games:ladder').setLabel('Back to ladder').setEmoji('🏆').setStyle(ButtonStyle.Primary)
    );
    return { embeds: [embed], components: [row] };
}

/* ---------- ladder component router ---------- */
async function handleLadderComponent(interaction) {
    const parts = String(interaction.customId || '').split(':');
    const verb = parts[0] === 'games' ? 'panel' : (parts[1] || 'panel');
    const userId = String(interaction.user.id);

    if (verb === 'panel' || verb === 'refresh' || verb === 'ladder') {
        return interaction.update(ladderPanelPayload(userId)).catch(() => {});
    }

    if (verb === 'close') {
        return interaction.update({ content: '🏆 Ladder closed.', embeds: [], components: [] }).catch(() => {});
    }

    if (verb === 'challenge') {
        const challengers = tttElo.getLadder(15)
            .filter(entry => String(entry.userId) !== userId)
            .slice(0, 24)
            .map(entry => ({
                label: (entry.elo + ' Elo — ' + entry.wins + 'W/' + entry.losses + 'L').slice(0, 100),
                description: ('Rank #' + entry.rank + ' — challenge this player').slice(0, 100),
                value: String(entry.userId)
            }));
        challengers.push({
            label: 'Someone else',
            description: 'Use /games game:Tic-Tac-Toe Ladder opponent:@user to invite anyone',
            value: 'manual'
        });

        const embed = new EmbedBuilder()
            .setColor(0x00d4ff)
            .setTitle('⚔️ PICK AN OPPONENT')
            .setDescription([
                'Pick a rated player below, or invite anyone at all with:',
                '',
                '**/games game:Tic-Tac-Toe Ladder opponent:@user**'
            ].join('\n'));

        return interaction.update({
            embeds: [embed],
            components: [
                new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('ttt:pickopponent')
                        .setPlaceholder('Choose who to challenge')
                        .addOptions(challengers)
                ),
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('ttt:refresh').setLabel('Back to ladder').setEmoji('◀').setStyle(ButtonStyle.Secondary)
                )
            ]
        }).catch(() => {});
    }

    if (verb === 'pickopponent') {
        const value = interaction.values ? interaction.values[0] : null;
        if (!value || value === 'manual') {
            return interaction.reply({
                content: 'Use **/games game:Tic-Tac-Toe Ladder opponent:@user** to invite any member to a rated match.',
                ephemeral: true
            }).catch(() => {});
        }
        if (String(value) === userId) {
            return interaction.reply({ content: 'You cannot challenge yourself.', ephemeral: true }).catch(() => {});
        }
        createChallenge(userId, value, interaction.channelId);
        return interaction.update(challengePayload(userId, value)).catch(() => {});
    }

    if (verb === 'accept') {
        const challengerId = parts[2];
        const challenge = readChallenge(challengerId);
        if (!challenge) {
            return interaction.reply({ content: '⌛ That challenge has expired — ask them to invite you again.', ephemeral: true }).catch(() => {});
        }
        if (userId === String(challengerId)) {
            return interaction.reply({ content: 'You cannot accept your own challenge.', ephemeral: true }).catch(() => {});
        }
        if (userId !== String(challenge.opponentId)) {
            return interaction.reply({ content: 'That invite is for someone else.', ephemeral: true }).catch(() => {});
        }
        clearChallenge(challengerId);
        const created = createMatch(challengerId, userId);
        return interaction.update(matchPayload(
            created.matchKey,
            created.match,
            '<@' + created.match.x + '> plays ❌ and goes first.'
        )).catch(() => {});
    }

    if (verb === 'decline') {
        const challengerId = parts[2];
        const challenge = readChallenge(challengerId);
        if (!challenge) {
            return interaction.reply({ content: '⌛ That challenge has expired.', ephemeral: true }).catch(() => {});
        }
        if (userId !== String(challenge.opponentId) && userId !== String(challengerId)) {
            return interaction.reply({ content: 'That invite is not yours to decline.', ephemeral: true }).catch(() => {});
        }
        clearChallenge(challengerId);
        return interaction.update({
            embeds: [new EmbedBuilder()
                .setColor(0xff5577)
                .setTitle('❌ CHALLENGE DECLINED')
                .setDescription('<@' + userId + '> declined the rated match.')],
            components: []
        }).catch(() => {});
    }

    if (verb === 'rematch') {
        const xId = parts[2];
        const oId = parts[3];
        if (userId !== String(xId) && userId !== String(oId)) {
            return interaction.reply({ content: 'Only the two players from that match can rematch.', ephemeral: true }).catch(() => {});
        }
        createChallenge(xId, oId, interaction.channelId);
        return interaction.update(challengePayload(xId, oId)).catch(() => {});
    }

    if (verb === 'move') {
        const key = parts[2];
        const cell = Number(parts[3]);
        const match = readMatch(key);
        if (!match || match.status !== 'live') {
            return interaction.reply({ content: '⌛ That match is already over.', ephemeral: true }).catch(() => {});
        }
        if (userId !== String(match.x) && userId !== String(match.o)) {
            return interaction.reply({ content: 'You are not in this match.', ephemeral: true }).catch(() => {});
        }
        if (userId !== turnPlayerId(match)) {
            return interaction.reply({ content: '⏳ Not your turn — wait for the other player.', ephemeral: true }).catch(() => {});
        }
        if (!Number.isInteger(cell) || cell < 0 || cell > 8 || match.board[cell]) {
            return interaction.reply({ content: 'That square is already taken.', ephemeral: true }).catch(() => {});
        }

        match.board[cell] = match.turn;
        const mark = winnerMark(match.board);
        const full = match.board.every(Boolean);

        if (!mark && !full) {
            match.turn = match.turn === 'X' ? 'O' : 'X';
            writeMatch(key, match);
            return interaction.update(matchPayload(key, match)).catch(() => {});
        }

        match.status = 'finished';
        const winnerId = mark === 'X' ? String(match.x) : mark === 'O' ? String(match.o) : null;
        let elo = null;
        try {
            elo = tttElo.applyResult({ challengerId: match.challengerId, opponentId: match.opponentId, winnerId });
        } catch (error) {
            elo = null;
        }
        if (winnerId) {
            try {
                require('../systems/economy/questManager').recordQuestEvent(winnerId, 'ttt_win', 1);
            } catch (error) {
                /* quests are optional flavour — a rating must never fail because of them */
            }
        }
        clearMatch(key);

        if (!elo) {
            return interaction.update({
                embeds: [new EmbedBuilder()
                    .setColor(0x00e5a8)
                    .setTitle('🏆 RANKED MATCH OVER')
                    .setDescription(boardText(match.board) + '\n\n_Rating could not be updated — the result stands._')],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('games:ladder').setLabel('Back to ladder').setEmoji('🏆').setStyle(ButtonStyle.Primary)
                )]
            }).catch(() => {});
        }
        return interaction.update(resultPayload(match, elo)).catch(() => {});
    }

    return interaction.deferUpdate().catch(() => {});
}

module.exports = {
    data: buildGamesData(),

    GAME_CHOICES,
    GAME_DEFS,
    facadeFor,
    startGame,
    effectiveDifficulty,

    async execute(interaction) {
        const game = interaction.options.getString('game');
        if (!game) {
            // Bare /games — open the lounge panel and let them pick.
            return runLounge(interaction);
        }
        if (game === LADDER_GAME) {
            // Ranked Tic-Tac-Toe lives outside GAME_DEFS: it has no bot engine.
            const opponent = interaction.options.getUser('opponent');
            if (!opponent) {
                await interaction.deferReply();
                return interaction.editReply(ladderPanelPayload(interaction.user.id));
            }
            if (opponent.bot || opponent.id === interaction.user.id) {
                return interaction.reply({ content: '🤖 Pick a real opponent — not yourself, not a bot.', ephemeral: true });
            }
            await interaction.deferReply();
            createChallenge(interaction.user.id, opponent.id, interaction.channelId);
            return interaction.editReply({
                content: '<@' + opponent.id + '>',
                ...challengePayload(interaction.user.id, opponent.id)
            });
        }
        if (!GAME_DEFS[game]) {
            return interaction.reply({ content: '❌ Unknown game — pick one from the list.' });
        }
        if (game === 'highlow' && !interaction.options.getInteger('bet')) {
            return interaction.reply({ content: '📈 High/Low needs a bet — add `bet:10-1000`, e.g. `/games game:High/Low bet:100`.' });
        }
        // Acknowledge before any engine does its DB work — several engines
        // build canvases/embeds slowly enough to hit the 3-second wall.
        await interaction.deferReply();
        // Lazy require so the hub never loads every engine on boot.
        const engine = require(GAME_DEFS[game].engine);
        // Remap crossed difficulty ladders (e.g. Mastermind has no "medium").
        const rawDifficulty = interaction.options.getString('difficulty');
        const overrides = rawDifficulty ? { difficulty: effectiveDifficulty(game, rawDifficulty) } : {};
        await engine.execute(facadeFor(interaction, overrides));
    },

    /*
     * Restart-safe lounge + panel clicks. index.js routes every games: AND
     * ttt: component here. Custom ids:
     *   games:open:<game>                → open that game's setup panel
     *   games:go:<game>:<button>         → start with that button's overrides
     *   games:cfg:<game>                 → open the custom-settings modal
     *   games:cfgmodal:<game>            → (modal submit) start with dialog values
     *   games:back:<game>                → back to the lounge embed
     *   games:ladder                     → open the ranked Tic-Tac-Toe ladder
     *   ttt:challenge | ttt:refresh | ttt:close
     *   ttt:pickopponent                 → (select) challenge a rated player
     *   ttt:accept:<challengerId> | ttt:decline:<challengerId>
     *   ttt:move:<matchKey>:<cell>       → play a square on a live rated board
     *   ttt:rematch:<xId>:<oId>          → invite the same opponent again
     */
    async handleComponent(interaction) {
        const rawId = String(interaction.customId || '');
        // Ranked Tic-Tac-Toe ladder (player vs player) — see handleLadderComponent.
        if (rawId.startsWith('ttt:')) return handleLadderComponent(interaction);
        const [, verb, game, btnId] = rawId.split(':');
        // The lounge's 🏆 button carries no game segment.
        if (verb === 'ladder') return handleLadderComponent(interaction);
        if (!game || !GAME_DEFS[game]) return interaction.deferUpdate().catch(() => {});

        if (verb === 'open') {
            return interaction.update({
                embeds: [gamePanelEmbed(game, interaction.user)],
                components: buildPanelRows(game)
            }).catch(() => {});
        }
        if (verb === 'back') {
            return interaction.update({
                embeds: [loungeEmbed(interaction.user)],
                components: buildLoungeRows()
            }).catch(() => {});
        }
        if (verb === 'cfg') return showConfigModal(interaction, game);
        if (verb === 'go') {
            const btn = GAME_DEFS[game].buttons.flat().find(b => b.id === btnId);
            if (!btn) return interaction.deferUpdate().catch(() => {});
            return startGame(interaction, game, btn.overrides);
        }
        return interaction.deferUpdate().catch(() => {});
    },

    handleModal
};
