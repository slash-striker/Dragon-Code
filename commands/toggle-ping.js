const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { getColor, formatTitle, isHighTech } = require('../systems/economy/uiStyleHelper');

/*
 * /toggle-ping ping:<work|fish|mine|slash|light>
 *
 * The caller specifies WHICH ping to flip. Turning a ping OFF does not refund
 * anything — ownership is permanent and the toggle just silences the
 * notification.
 *
 * Recipient pings (slash / light) belong to the user they notify:
 *   - Slash Ping  → the host (1466461677783351447) alone.
 *   - Light Ping  → Light (1543876836209991682), with host override.
 * Only allowedViewers may see or flip those options; everyone else who picks
 * one gets the host-owned notice. The subscription row is always stored under
 * the RECIPIENT's userId so the mentionWatcher reads one source of truth.
 */
const SLASH_USER_ID = '1466461677783351447';
const LIGHT_USER_ID = '1543876836209991682';

const PING_META = {
    work: { label: 'Work Ping', emoji: '💼', item: 'work_ping' },
    fish: { label: 'Fish Ping', emoji: '🎣', item: 'fish_ping' },
    mine: { label: 'Mine Ping', emoji: '⛏️', item: 'mine_ping' },
    slash: {
        label: 'Slash Ping', emoji: '🐉', item: null,
        recipientOnly: true, recipientId: SLASH_USER_ID,
        allowedViewers: [SLASH_USER_ID]
    },
    light: {
        label: 'Light Ping', emoji: '⚡', item: null,
        recipientOnly: true, recipientId: LIGHT_USER_ID,
        allowedViewers: [LIGHT_USER_ID, SLASH_USER_ID]
    }
};

function getState(userId) {
    const rows = db.prepare('SELECT command, enabled FROM ping_subscriptions WHERE userId = ?').all(userId);
    return new Map(rows.map(r => [r.command, Boolean(r.enabled)]));
}

// Recipient pings default to ON when no row exists yet (matches the
// mentionWatcher's "missing row = enabled" behaviour).
function effectiveOn(state, key) {
    return state.has(key) ? state.get(key) : true;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('toggle-ping')
        .setDescription('Turn one of your pings (work/fish/mine/all) — or the host\'s slash ping — on or off')
        .addStringOption(option => option
            .setName('ping')
            .setDescription('Which ping do you want to toggle?')
            .setRequired(true)
            .addChoices(
                { name: '💼 Work Ping', value: 'work' },
                { name: '🎣 Fish Ping', value: 'fish' },
                { name: '⛏️ Mine Ping', value: 'mine' },
                { name: '🐉 Slash Ping (host only)', value: 'slash' },
                { name: '⚡ Light Ping (Light & host only)', value: 'light' },
                { name: '🌐 All Pings (flip everything at once)', value: 'all' }
            )),

    async execute(interaction) {
        const userId = interaction.user.id;
        const cmd = interaction.options.getString('ping', true);
        const meta = PING_META[cmd];
        const useHighTech = isHighTech(userId);

        // Recipient pings (slash/light) can only be seen and flipped by their
        // allowed viewers — anyone else gets bounced here.
        // (meta is undefined for the 'all' choice — that branch is handled below,
        // after this gate, so the gate must not dereference it unguarded.)
        if (meta?.recipientOnly && !meta.allowedViewers.includes(userId)) {
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0xff5577)
                    .setTitle(`${meta.emoji} Recipient-Owned Ping`)
                    .setDescription(`The **${meta.emoji} ${meta.label}** delivers the summon notifications to <@${meta.recipientId}> — only they${meta.allowedViewers.length > 1 ? ' and the host' : ''} can turn it on or off.`)]
            });
        }

        /*
         * 🌐 ALL — one flip for every ping you're allowed to touch. Buying is
         * never required: unowned pings are seeded silently at cost of 0 and
         * listed as "now owned" so the toggle result matches the summary.
         * Only calls to this branch mutate more than one row.
         */
        if (cmd === 'all') {
            const userMeta = ['work', 'fish', 'mine'].map(key => PING_META[key]);
            // Recipient pings only join the flip when this caller may see them.
            const recipientMeta = [PING_META.slash, PING_META.light]
                .filter(m => m.allowedViewers.includes(userId));
            const flipping = [...userMeta, ...recipientMeta];
            if (!flipping.length) {
                return interaction.reply({ content: '❌ No pings available to flip.' });
            }

            // True toggle semantics: if ANYTHING you can control is currently
            // firing, "all" turns everything OFF; otherwise it turns it all ON.
            // User pings: owned-and-enabled counts as on. Recipient pings:
            // missing row = on (they fire by default).
            const ownState = getState(userId);
            const anyOn =
                ['work', 'fish', 'mine'].some(key => ownState.has(key) && Boolean(ownState.get(key))) ||
                recipientMeta.some(m => {
                    const key = m === PING_META.slash ? 'slash' : 'light';
                    return effectiveOn(getState(m.recipientId), key);
                });
            const turnOn = !anyOn;
            const after = turnOn ? 1 : 0;
            const upsert = db.prepare(`
                INSERT INTO ping_subscriptions (userId, command, enabled) VALUES (?, ?, ?)
                ON CONFLICT(userId, command) DO UPDATE SET enabled = excluded.enabled
            `);
            for (const m of flipping) {
                const key = m.recipientOnly ? (PING_META.slash === m ? 'slash' : 'light') : m.item.replace(/_ping$/, '');
                upsert.run(m.recipientOnly ? m.recipientId : userId, key, after);
            }

            const slashState = getState(SLASH_USER_ID);
            const lightState = getState(LIGHT_USER_ID);
            const canSeeLight = userId === LIGHT_USER_ID || userId === SLASH_USER_ID;
            const line = (key, m) => {
                if (m.recipientOnly) {
                    const rowState = key === 'slash' ? slashState : lightState;
                    return `${m.emoji} **${m.label}** — ${effectiveOn(rowState, key) ? '🟢 **ON**' : '🔴 **OFF**'}`;
                }
                return `${m.emoji} **${m.label}** — ${after ? '🟢 **ON**' : '🔴 **OFF**'}${turnOn ? ' (now owned)' : ''}`;
            };
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(getColor(userId))
                    .setTitle(formatTitle(
                        userId,
                        `🌐 ALL PINGS ${turnOn ? 'ENABLED' : 'MUTED'}`,
                        `All pings ${turnOn ? 'on' : 'off'}`
                    ))
                    .setDescription([
                        useHighTech ? '```NOTIFICATION GRID // BULK UPDATE```' : '**Your pings:**',
                        line('work', PING_META.work),
                        line('fish', PING_META.fish),
                        line('mine', PING_META.mine),
                        ...(recipientMeta.some(m => PING_META.slash === m) ? [line('slash', PING_META.slash)] : []),
                        ...(recipientMeta.some(m => PING_META.light === m) ? [line('light', PING_META.light)] : []),
                        '',
                        turnOn
                            ? '✅ **All pings are ON** — every notification you own (and may control) fires again.'
                            : '🔇 **All pings are OFF** — cooldown DMs and summon panels are muted. Flip them back on any time with `/toggle-ping`.'
                    ].join('\n'))]
            });
        }

        const state = getState(userId);
        // Recipient pings live under the recipient's row, not the caller's.
        const targetUserId = meta.recipientOnly ? meta.recipientId : userId;
        const targetState = meta.recipientOnly ? getState(targetUserId) : state;

        if (!targetState.has(cmd)) {
            if (meta.recipientOnly) {
                // First flip seeds the row as ON so the toggle below can flip it.
                db.prepare('INSERT INTO ping_subscriptions (userId, command, enabled) VALUES (?, ?, 1)')
                    .run(targetUserId, cmd);
                targetState.set(cmd, 1);
            } else {
                return interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setColor(0xff5577)
                        .setTitle('🔕 Ping Not Owned')
                        .setDescription([
                            `You do not own the **${meta.emoji} ${meta.label}** yet.`,
                            '',
                            `Buy it from the shop (\`/shop-buy\` → \`${meta.item}\`) — it DMs you the moment your **${cmd}** cooldown finishes.`
                        ].join('\n'))]
                });
            }
        }

        const before = targetState.get(cmd);
        const after = before ? 0 : 1;
        db.prepare('UPDATE ping_subscriptions SET enabled = ? WHERE userId = ? AND command = ?')
            .run(after, targetUserId, cmd);
        targetState.set(cmd, after);

        // Summary lines — each row is read from the account that owns it, and
        // recipient pings only show their real state to allowed viewers.
        const ownedState = state;
        const slashState = getState(SLASH_USER_ID);
        const lightState = getState(LIGHT_USER_ID);
        const canSeeLight = userId === LIGHT_USER_ID || userId === SLASH_USER_ID;

        const statusLine = (key, m) => {
            if (m.recipientOnly) {
                const viewer = key === 'slash'
                    ? userId === SLASH_USER_ID
                    : canSeeLight;
                if (!viewer) return `${m.emoji} **${m.label}** — _host-controlled_`;
                const rowState = key === 'slash' ? slashState : lightState;
                return `${m.emoji} **${m.label}** — ${effectiveOn(rowState, key) ? '🟢 **ON**' : '🔴 **OFF**'}`;
            }
            if (!ownedState.has(key)) return `${m.emoji} **${m.label}** — _not owned_ (shop: \`${m.item}\`)`;
            return `${m.emoji} **${m.label}** — ${ownedState.get(key) ? '🟢 **ON**' : '🔴 **OFF**'}`;
        };

        const embed = new EmbedBuilder()
            .setColor(getColor(userId))
            .setTitle(formatTitle(
                userId,
                `${meta.emoji} ${meta.label.toUpperCase()} ${after ? 'ENABLED' : 'MUTED'}`,
                `Ping ${after ? 'On' : 'Off'}`
            ))
            .setDescription([
                useHighTech ? '```NOTIFICATION GRID // UPDATED```' : '**Your pings:**',
                statusLine('work', PING_META.work),
                statusLine('fish', PING_META.fish),
                statusLine('mine', PING_META.mine),
                statusLine('slash', PING_META.slash),
                statusLine('light', PING_META.light),
                '',
                after
                    ? (meta.recipientOnly
                        ? (cmd === 'light'
                            ? `✅ **${meta.label} is ON** — "light"/"lightning" summon panels will fire again.`
                            : `✅ **${meta.label} is ON** — keyword summons ("slashy", "help me", …) and direct-mention panels will fire again.`)
                        : `✅ **${meta.label} is ON** — you will get a DM the next time your ${cmd} cooldown finishes.`)
                    : (meta.recipientOnly
                        ? (cmd === 'light'
                            ? `🔇 **${meta.label} is OFF** — Lightning summon panels are muted. Flip it back on any time with \`/toggle-ping\`.`
                            : `🔇 **${meta.label} is OFF** — slash/keyword pings are muted server-wide. Flip it back on any time with \`/toggle-ping\`.`)
                        : `🔇 **${meta.label} is OFF** — DMs for ${cmd} are muted. It stays owned; flip it back on any time with \`/toggle-ping\`.`)
            ].join('\n'));

        return interaction.reply({ embeds: [embed] });
    }
};
