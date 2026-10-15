/*
 * /dragon-admin — one admin command for every system added in the Dragon Code
 * expansion: the hatchery, fishing tournaments, contrarian market rounds,
 * seasonal events, flash deals, credit capsules, weekly snapshots, dragon
 * racing, the Tic-Tac-Toe Elo ladder, quests/badges/titles, bounties and
 * reminders.
 *
 * Deliberately ONE slash command with option groups instead of a dozen admin
 * commands, so the deployed command list stays short. Hidden from members via
 * DefaultMemberPermissions and gated again at runtime with isAdminUser().
 */
const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');

const db = require('../database');
const adminVisibility = require('../systems/admin/adminVisibility');
const { isAdminUser, hideFromMembers } = adminVisibility;
const { ensureUser } = require('../systems/utils/ensureUser');
const hatchery = require('../systems/dragons/dragonManager');
const tournaments = require('../systems/economy/fishingTournament');
const marketPvp = require('../systems/economy/marketPvp');
const flashDeals = require('../systems/economy/flashDeals');
const seasonal = require('../systems/economy/seasonalEvents');
const capsules = require('../systems/economy/capsuleDrops');
const snapshot = require('../systems/economy/weeklySnapshot');
const racing = require('../systems/economy/dragonRacing');
const ttt = require('../systems/economy/tttElo');
const quests = require('../systems/economy/questManager');
const titles = require('../systems/economy/titleManager');
const bounties = require('../systems/economy/bountyManager');
const reminders = require('../systems/economy/reminders');
const trades = require('../systems/economy/tradeManager');
const streak = require('../systems/economy/streakProtection');
const serverConfig = require('../systems/discord/serverConfig');

const COLOR = 0x9b59b6;

function ok(title, lines) {
    return new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`🛠️ ${title}`)
        .setDescription(lines.filter(Boolean).join('\n').slice(0, 4000))
        .setFooter({ text: 'DRAGON ADMIN • privileged action' })
        .setTimestamp();
}

function targetUser(interaction) {
    return interaction.options.getUser('user', true);
}

function resolveOreId(input) {
    if (!input) return null;
    const clean = String(input).trim().toLowerCase().replace(/\s+/g, '_');
    const oreIds = Object.keys(require('../systems/mining/oreTables').BASE_ORE_VALUES || {});
    return oreIds.includes(clean) ? clean : null;
}

function adaptActionInteraction(interaction, action) {
    const original = interaction.options;
    const aliases = {
        user: 'target',
        action: 'mode',
        setting: 'setting-name',
        'trade-id': 'details',
        type: 'value', species: 'value', badge: 'value', title: 'value', ore: 'value', item: 'value',
        source: 'extra', trait: 'details',
        dragon: 'amount', egg: 'amount', days: 'amount', minutes: 'amount', min: 'amount',
        level: 'amount2', pot: 'amount2', max: 'amount2',
        'clear-lock': 'toggle', force: 'toggle', remove: 'toggle', enabled: 'toggle',
        channel1: 'channel'
    };

    const options = new Proxy(original, {
        get(target, property) {
            const methods = ['getString', 'getInteger', 'getBoolean', 'getUser', 'getRole', 'getChannel'];
            if (methods.includes(property)) {
                return (name, required) => {
                    const mapped = aliases[name] || name;
                    const value = target[property](mapped, false);
                    if (required && (value === null || value === undefined)) {
                        throw new Error(`Missing required /dragon-admin option '${name}' for ${action}.`);
                    }
                    return value;
                };
            }
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
    return new Proxy(interaction, {
        get(target, property) {
            if (property === '__dragonAdminAction') return action;
            if (property === 'options') return options;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
}

const DRAGON_ADMIN_ACTIONS = [
    { name: 'Hatchery · grant egg', value: 'hatchery.grant-egg' },
    { name: 'Hatchery · give dragon', value: 'hatchery.give-dragon' },
    { name: 'Hatchery · hatch egg', value: 'hatchery.hatch' },
    { name: 'Hatchery · set level', value: 'hatchery.set-level' },
    { name: 'Hatchery · delete dragon', value: 'hatchery.delete' },
    { name: 'Hatchery · list dragons', value: 'hatchery.list' },
    { name: 'Run · tournament', value: 'run.tournament' },
    { name: 'Run · settle tournament', value: 'run.settle-tournament' },
    { name: 'Run · open market round', value: 'run.market-round' },
    { name: 'Run · settle market', value: 'run.settle-market' },
    { name: 'Run · flash deals', value: 'run.flash-deals' },
    { name: 'Run · drop capsule', value: 'run.capsule' },
    { name: 'Run · snapshot', value: 'run.snapshot' },
    { name: 'Run · open race', value: 'run.race-open' },
    { name: 'Run · settle race', value: 'run.race-settle' },
    { name: 'Run · Elo promotion', value: 'run.elo-promotion' },
    { name: 'Reward · badge', value: 'reward.badge' },
    { name: 'Reward · title', value: 'reward.title' },
    { name: 'Reward · streak shield', value: 'reward.streak-shield' },
    { name: 'Reward · seasonal gift', value: 'reward.seasonal-gift' },
    { name: 'View · status', value: 'view.status' },
    { name: 'View · bounties', value: 'view.bounties' },
    { name: 'View · clear bounty', value: 'view.clear-bounty' },
    { name: 'View · reminders', value: 'view.reminders' },
    { name: 'View · capsules', value: 'view.capsules' },
    { name: 'View · trades', value: 'view.trades' },
    { name: 'View · ladder', value: 'view.ladder' },
    { name: 'View · races', value: 'view.races' },
    { name: 'Config · capsule channels', value: 'config.capsule-channels' },
    { name: 'Config · capsule range', value: 'config.capsule-range' },
    { name: 'Config · snapshot channel', value: 'config.snapshot-channel' },
    { name: 'Config · reset Elo', value: 'config.reset-elo' },
    { name: 'Config · cancel trade', value: 'config.cancel-trade' },
    { name: 'Config · admin roles', value: 'config.admin-roles' },
    { name: 'Config · admin log', value: 'config.admin-log' },
    { name: 'Config · server settings', value: 'config.server' },
    { name: 'Config · list server settings', value: 'config.server-list' },
    { name: 'Config · command channel', value: 'config.command-channel' },
    { name: 'Config · list command channels', value: 'config.command-channels' }
];

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('dragon-admin')
        .setDescription('[ADMIN] Manage dragons, economy systems, roles, and server settings')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(o => o.setName('action').setDescription('Choose an admin operation').setRequired(true).setAutocomplete(true))
        .addUserOption(o => o.setName('target').setDescription('Target player'))
        .addStringOption(o => o.setName('value').setDescription('Primary value: item, type, ID, or setting key').setAutocomplete(true))
        .addStringOption(o => o.setName('details').setDescription('Secondary value: note, trait, setting key, trade id, or command name'))
        .addStringOption(o => o.setName('setting-value').setDescription('Text value for a server setting'))
        .addStringOption(o => o.setName('setting-name').setDescription('Server setting key').setAutocomplete(true))
        .addStringOption(o => o.setName('server-setting').setDescription('Server configuration key'))
        .addStringOption(o => o.setName('server-value').setDescription('Server value for this setting'))
        .addStringOption(o => o.setName('setting-kind').setDescription('Setting to configure').addChoices(
            { name: 'Server setting', value: 'server' },
            { name: 'Command channel', value: 'command-channel' },
            { name: 'Game-ping role', value: 'game-ping-role' },
            { name: 'Staff sender role', value: 'staff-sender-role' },
            { name: 'Staff recipient role 1', value: 'staff-recipient-1' },
            { name: 'Staff recipient role 2', value: 'staff-recipient-2' },
            { name: 'Staff recipient role 3', value: 'staff-recipient-3' }
        ))
        .addRoleOption(o => o.setName('ping-role').setDescription('Role for a staff/game ping'))
        .addStringOption(o => o.setName('extra').setDescription('Source text or value for a server setting'))
        .addIntegerOption(o => o.setName('amount').setDescription('Primary number: id, days, minutes, or minimum'))
        .addIntegerOption(o => o.setName('amount2').setDescription('Secondary number: level, pot, or maximum'))
        .addBooleanOption(o => o.setName('toggle').setDescription('Optional action toggle (remove, force, clear-lock)'))
        .addStringOption(o => o.setName('mode').setDescription('Admin role action: list, add, remove'))
        .addStringOption(o => o.setName('scope').setDescription('Admin role or server-setting scope').addChoices(
            { name: 'Admin-command roles', value: 'admin' },
            { name: 'Audit-log roles', value: 'audit' },
            { name: 'Channel setting', value: 'channel' },
            { name: 'Role setting', value: 'role' },
            { name: 'Server value setting', value: 'server' }
        ))
        .addChannelOption(o => o.setName('channel').setDescription('Channel setting or first capsule channel'))
        .addChannelOption(o => o.setName('channel2').setDescription('Second capsule channel'))
        .addChannelOption(o => o.setName('channel3').setDescription('Third capsule channel'))
        .addRoleOption(o => o.setName('role').setDescription('Role to configure')),
    async autocomplete(interaction) {
        if (!isAdminUser(interaction)) return interaction.respond([]);
        const focused = interaction.options.getFocused(true);
        const action = focused.name === 'action'
            ? String(focused.value || '')
            : String(interaction.options.getString('action') || '');
        let choices = [];

        if (focused.name === 'action') {
            choices = DRAGON_ADMIN_ACTIONS;
        } else if (focused.name === 'setting-name') {
            choices = ['mining', 'fishing', 'economy', 'counting', 'capsules', 'snapshot', 'admin-log']
                .map(name => ({ name, value: name }));
        } else if (focused.name === 'setting-value' || focused.name === 'value') {
            const [group, sub] = action.split('.');
            if (group === 'hatchery' && sub === 'grant-egg') {
                choices = Object.values(hatchery.EGG_TYPES).map(egg => ({ name: `${egg.name} (${egg.rarity}, ${egg.side})`, value: egg.id }));
            } else if (group === 'hatchery' && sub === 'give-dragon') {
                choices = Object.values(hatchery.SPECIES).map(species => ({ name: `${species.name} (${species.rarity}, ${species.side})`, value: species.id }));
            } else if (group === 'reward' && sub === 'badge') {
                choices = (quests.BADGES || []).map(badge => ({ name: `${badge.name} — ${badge.id}`, value: badge.id }));
            } else if (group === 'reward' && sub === 'title') {
                choices = titles.TITLES.map(title => ({ name: `${title.name} — ${title.id}`, value: title.id }));
            } else if (group === 'run' && sub === 'market-round') {
                choices = Object.keys(require('../systems/mining/oreTables').BASE_ORE_VALUES || {}).map(ore => ({ name: ore.replace(/_/g, ' '), value: ore }));
            }
        }

        const query = String(focused.value || '').toLowerCase();
        return interaction.respond(choices
            .filter(choice => !query || choice.name.toLowerCase().includes(query) || String(choice.value).toLowerCase().includes(query))
            .slice(0, 25)
            .map(choice => ({ name: choice.name.slice(0, 100), value: choice.value })));
    },

    async execute(interaction) {
        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ This command is restricted to administrators.', flags: 64 });
        }
        await interaction.deferReply({ flags: 64 });

        const selected = interaction.options.getString('action', true);
        const [group, sub] = selected.split('.');
        const adapted = adaptActionInteraction(interaction, selected);
        try {
            if (group === 'hatchery') return await runHatchery(adapted, sub);
            if (group === 'run') return await runSystems(adapted, sub);
            if (group === 'reward') return await runReward(adapted, sub);
            if (group === 'view') return await runView(adapted, sub);
            if (group === 'config') return await runConfig(adapted, sub);
            return interaction.editReply({ embeds: [ok('Dragon Admin', ['Choose an available action.'])] });
        } catch (error) {
            console.error('dragon-admin failed:', error);
            return interaction.editReply({
                embeds: [ok('Dragon Admin — ERROR', [`${error.message || error}`])]
            });
        }
    }
};

// ==================================================
// HATCHERY
// ==================================================
async function runHatchery(interaction, sub) {
    if (sub === 'grant-egg') {
        const user = targetUser(interaction);
        const type = interaction.options.getString('type');
        const source = interaction.options.getString('source') || 'admin';
        ensureUser(user.id);
        let egg;
        if (type) {
            const eggType = hatchery.EGG_TYPES[type];
            if (!eggType) return interaction.editReply({ embeds: [ok('Grant egg', [`❌ Unknown egg type '${type}'.`])] });
            egg = hatchery.grantEgg(user.id, { eggType: type, rarity: eggType.rarity, source });
        } else {
            egg = hatchery.grantEgg(user.id, { rarity: 'rare', source });
        }
        const kind = hatchery.EGG_TYPES[egg.eggType];
        return interaction.editReply({
            embeds: [ok('Egg granted', [
                `👤 <@${user.id}>`,
                `🥚 **${kind?.name || egg.eggType}** — ${kind?.rarity} · ${kind?.side === 'evil' ? '🩸 Onslaught' : '🌌 Dragonflight'}`,
                `Egg id: '${egg.eggId}' · incubation ${Math.round((kind?.incubateMs || 0) / 3_600_000)}h`,
                `They can incubate it from '/profile' → **Eggs**.`
            ])]
        });
    }

    if (sub === 'give-dragon') {
        const user = targetUser(interaction);
        const speciesId = interaction.options.getString('species', true);
        const traitId = interaction.options.getString('trait');
        const species = hatchery.SPECIES[speciesId];
        if (!species) return interaction.editReply({ embeds: [ok('Give dragon', [`❌ Unknown species '${speciesId}'.`])] });
        ensureUser(user.id);

        const trait = hatchery.TRAITS[traitId] ? traitId : hatchery.TRAIT_IDS[Math.floor(Math.random() * hatchery.TRAIT_IDS.length)];
        const owned = db.prepare('SELECT COUNT(*) AS count FROM dragons WHERE userId = ?').get(user.id)?.count || 0;
        const info = db.prepare(`
            INSERT INTO dragons
                (userId, speciesId, name, side, rarity, trait, trait2, level, xp, hunger, happiness,
                 power, speed, stamina, bond, active, hatchedAt)
            VALUES (?, ?, ?, ?, ?, ?, NULL, 1, 0, 100, 100, ?, ?, ?, 0, ?, ?)
        `).run(
            user.id, species.id, species.name, species.side, species.rarity, trait,
            species.base.power, species.base.speed, species.base.stamina,
            owned === 0 ? 1 : 0, new Date().toISOString()
        );
        return interaction.editReply({
            embeds: [ok('Dragon granted', [
                `👤 <@${user.id}>`,
                `🐉 **${species.name}** — Lv 1 · ${species.rarity} · ${species.side === 'evil' ? '🩸 Onslaught' : '🌌 Dragonflight'}`,
                `Trait: ${hatchery.TRAITS[trait].emoji} ${hatchery.TRAITS[trait].name}`,
                `Dragon id: '${Number(info.lastInsertRowid)}'${owned === 0 ? ' · set active automatically' : ''}`
            ])]
        });
    }

    if (sub === 'hatch') {
        const eggId = interaction.options.getInteger('egg', true);
        const egg = hatchery.getEgg(eggId);
        if (!egg) return interaction.editReply({ embeds: [ok('Force hatch', [`❌ No egg with id '${eggId}'.`])] });
        if (egg.status !== 'incubating') {
            const started = hatchery.startIncubation(egg.userId, eggId, 0);
            if (!started.ok) return interaction.editReply({ embeds: [ok('Force hatch', [`❌ ${started.message}`])] });
        }
        const result = hatchery.hatchEgg(egg.userId, eggId, { force: true });
        if (!result.ok) return interaction.editReply({ embeds: [ok('Force hatch', [`❌ ${result.message}`])] });
        return interaction.editReply({
            embeds: [ok('Egg force-hatched', [
                `👤 <@${egg.userId}>`,
                `🐉 **${result.species.name}** (${result.species.rarity}) — trait ${hatchery.TRAITS[result.traits.primary].name}`,
                `They can see it with '/profile'.`
            ])]
        });
    }

    if (sub === 'set-level') {
        const dragonId = interaction.options.getInteger('dragon', true);
        const level = interaction.options.getInteger('level', true);
        const dragon = hatchery.getDragon(dragonId);
        if (!dragon) return interaction.editReply({ embeds: [ok('Set level', [`❌ No dragon with id '${dragonId}'.`])] });
        const scale = 1 + (level - dragon.level) * 3;
        db.prepare(`
            UPDATE dragons SET level = ?, xp = 0,
                power = MAX(1, power + ?), speed = MAX(1, speed + ?), stamina = MAX(1, stamina + ?)
            WHERE dragonId = ?
        `).run(level, scale, scale, scale, dragonId);
        return interaction.editReply({
            embeds: [ok('Level updated', [`🐉 **${dragon.name}** is now level **${level}**.`])]
        });
    }

    if (sub === 'delete') {
        const dragonId = interaction.options.getInteger('dragon', true);
        const dragon = hatchery.getDragon(dragonId);
        if (!dragon) return interaction.editReply({ embeds: [ok('Delete dragon', [`❌ No dragon with id '${dragonId}'.`])] });
        db.prepare('DELETE FROM dragons WHERE dragonId = ?').run(dragonId);
        return interaction.editReply({
            embeds: [ok('Dragon deleted', [`🗑️ Removed **${dragon.name}** (Lv ${dragon.level}) from <@${dragon.userId}>.`])]
        });
    }

    if (sub === 'list') {
        const user = targetUser(interaction);
        const summary = hatchery.getHatcherySummary(user.id);
        const eggLines = summary.eggs.length
            ? summary.eggs.map(egg => `• ${hatchery.describeEgg(egg)} '#${egg.eggId}'`).join('\n')
            : '_none_';
        const dragonLines = summary.dragons.length
            ? summary.dragons.map(dragon => `• ${hatchery.describeDragon(dragon).replace(/\n/g, ' ')} '#${dragon.dragonId}'`).join('\n')
            : '_none_';
        return interaction.editReply({
            embeds: [ok(`Hatchery — <@${user.id}>`, [
                `**🥚 Eggs (${summary.eggs.length})**`,
                eggLines.slice(0, 1500),
                '',
                `**🐉 Dragons (${summary.dragons.length})**`,
                dragonLines.slice(0, 1800)
            ])]
        });
    }
}

// ==================================================
// RUN A SYSTEM NOW
// ==================================================
async function runSystems(interaction, sub) {
    if (sub === 'tournament') {
        const minutes = interaction.options.getInteger('minutes') || 30;
        const pot = interaction.options.getInteger('pot') || 0;
        const result = tournaments.startTournament({
            channelId: interaction.channelId,
            durationMs: minutes * 60 * 1000,
            pot,
            name: 'Neon Fishing Derby'
        });
        // Announce it — the whole point of the tournament is that people see it.
        const embed = new EmbedBuilder()
            .setColor(0x00d4ff)
            .setTitle('🎣 FISHING TOURNAMENT OPEN')
            .setDescription([
                `**${result.name}** is live for **${minutes} minutes**.`,
                '',
                'Every fish you land is scored by rarity — Junk is 1 point, a Legendary is 45.',
                'The pot splits **50 / 30 / 20** across the top three anglers.',
                '',
                `Pot: 🪙${Number(result.pot).toLocaleString()} · Closes <t:${Math.floor(result.endsAt / 1000)}:R>`,
                '',
                'Cast with `/fish` — the hub shows the live leaderboard.'
            ].join('\n'))
            .setFooter({ text: 'NEON ANGLERS ASSOCIATION' })
            .setTimestamp();
        await interaction.channel.send({ embeds: [embed] }).catch(() => {});
        return interaction.editReply({
            embeds: [ok('Tournament started', [
                `Id '${result.tournamentId}' · ${minutes} min · pot 🪙${pot.toLocaleString()}`,
                'Announcement posted in this channel.'
            ])]
        });
    }

    if (sub === 'settle-tournament') {
        const live = tournaments.getActiveTournament();
        if (!live) return interaction.editReply({ embeds: [ok('Settle tournament', ['No live tournament.'])] });
        const result = tournaments.settleTournament(live.tournamentId);
        if (!result) return interaction.editReply({ embeds: [ok('Settle tournament', ['That tournament was already settled.'])] });
        const lines = result.winners.length
            ? result.winners.map(winner => `#${winner.place} <@${winner.userId}> — **${winner.score}** pts → 🪙${winner.prize.toLocaleString()}`)
            : ['Nobody scored — the pot is withheld.'];
        await interaction.channel.send({
            embeds: [new EmbedBuilder()
                .setColor(0xffd166)
                .setTitle('🏆 FISHING TOURNAMENT RESULTS')
                .setDescription([...lines, '', `Pot: 🪙${Number(result.pot).toLocaleString()}`].join('\n'))
                .setTimestamp()]
        }).catch(() => {});
        return interaction.editReply({ embeds: [ok('Tournament settled', lines)] });
    }

    if (sub === 'market-round') {
        const ore = resolveOreId(interaction.options.getString('ore'));
        const round = marketPvp.openRound({ oreId: ore || undefined });
        return interaction.editReply({
            embeds: [ok('Market round open', [
                `Round '${round.roundId}' — **${round.oreId}**`,
                `Start price: **${Number(round.startPrice).toFixed(2)}**`,
                `Closes <t:${Math.floor(Number(round.endsAt) / 1000)}:R> (~${marketPvp.ROUND_MS_HOURS}h)`,
                'Players join with `/invest`.'
            ])]
        });
    }

    if (sub === 'settle-market') {
        const open = marketPvp.getOpenRound();
        if (!open) return interaction.editReply({ embeds: [ok('Settle market', ['No open round.'])] });
        const result = marketPvp.settleRound(open.roundId);
        if (!result) return interaction.editReply({ embeds: [ok('Settle market', ['That round was already settled.'])] });
        const lines = result.winners.length
            ? result.winners.map(winner => `<@${winner.userId}> — 🪙${Number(winner.payout).toLocaleString()}${winner.contrarian ? ' 👑 **contrarian**' : ''}`)
            : ['Nobody called it. The pool is withheld.'];
        return interaction.editReply({
            embeds: [ok('Market round settled', [
                `**${result.oreId}** — ${Number(result.startPrice).toFixed(2)} → **${Number(result.endPrice).toFixed(2)}** · outcome **${result.outcome.toUpperCase()}**`,
                ...lines
            ])]
        });
    }

    if (sub === 'flash-deals') {
        const force = interaction.options.getBoolean('force') ?? true;
        const deals = flashDeals.rollDailyDeals(Date.now(), force);
        return interaction.editReply({
            embeds: [ok('Flash deals rolled', flashDeals.describeDeals().length ? flashDeals.describeDeals() : deals.map(deal => `${deal.itemId} −${deal.discount}%`))]
        });
    }

    if (sub === 'capsule') {
        const result = await capsules.spawnCapsule(interaction.client);
        return interaction.editReply({
            embeds: [ok('Capsule drop', result.ok
                ? [`💠 Capsule '${result.capsuleId}' for 🪙${Number(result.amount).toLocaleString()} in <#${result.channelId}>.`]
                : [`❌ ${result.message}`])]
        });
    }

    if (sub === 'snapshot') {
        const result = await snapshot.postWeeklySnapshot(interaction.client);
        if (result.ok) return interaction.editReply({ embeds: [ok('Snapshot posted', [`Week **${result.week}** posted to <#${snapshot.getSnapshotChannel()}>.`])] });
        const built = snapshot.buildWeeklySnapshot();
        const preview = snapshot.buildSnapshotEmbed(built);
        return interaction.editReply({
            embeds: [ok('Snapshot preview', [`⚠️ ${result.message}`, '', `**${preview.title}**`, preview.description, ...(preview.fields || []).flatMap(field => [`**${field.name}**`, field.value])])]
        });
    }

    if (sub === 'race-open') {
        const race = racing.openRaceForWeek();
        const track = racing.getTrack(race.trackId);
        return interaction.editReply({
            embeds: [ok('Race open', [
                `🏁 Round '${race.raceId}' on ${track?.emoji || ''} **${track?.name}** (${track?.terrain})`,
                `Closes <t:${Math.floor(Number(race.endsAt) / 1000)}:R>`,
                'Players enter and bet from `/profile` → **Dragon Racing**.'
            ])]
        });
    }

    if (sub === 'race-settle') {
        const race = racing.getCurrentRace();
        if (!race) return interaction.editReply({ embeds: [ok('Settle race', ['No open race.'])] });
        const result = racing.settleRace(race.raceId);
        if (!result) return interaction.editReply({ embeds: [ok('Settle race', ['That race was already settled.'])] });
        const lines = (result.standings || []).slice(0, 6).map((entry, index) =>
            `'#${index + 1}' ${entry.name} — ${Number(entry.time || 0).toFixed(2)}s`);
        await interaction.channel.send({
            embeds: [new EmbedBuilder()
                .setColor(0xa855f7)
                .setTitle(`🏁 ${racing.getTrack(result.trackId)?.name || 'RACE'} — RESULTS`)
                .setDescription([`🏆 **${result.winner?.name}** wins!`, '', ...lines, '', ...(result.log || []).slice(-4)].join('\n').slice(0, 3800))
                .setTimestamp()]
        }).catch(() => {});
        return interaction.editReply({ embeds: [ok('Race settled', [`🏆 ${result.winner?.name} won with ${Number(result.winner?.time || 0).toFixed(2)}s.`])] });
    }

    if (sub === 'elo-promotion') {
        const result = ttt.runWeeklyPromotion();
        return interaction.editReply({
            embeds: [ok('Elo promotion', result.promoted?.length
                ? result.promoted.map(entry => `#${entry.rank} <@${entry.userId}> — ${entry.elo} Elo got the weekly title.`)
                : ['Nobody had a ladder record to promote.'])]
        });
    }
}

// ==================================================
// REWARDS
// ==================================================
async function runReward(interaction, sub) {
    if (sub === 'badge') {
        const user = targetUser(interaction);
        const badgeId = interaction.options.getString('badge', true);
        const remove = interaction.options.getBoolean('remove') ?? false;
        const badge = (quests.BADGES || []).find(entry => entry.id === badgeId);
        if (!badge) return interaction.editReply({ embeds: [ok('Badge', [`❌ Unknown badge '${badgeId}'.`])] });

        if (remove) {
            const info = db.prepare('DELETE FROM badges WHERE userId = ? AND badgeId = ?').run(user.id, badgeId);
            return interaction.editReply({ embeds: [ok('Badge revoked', [`${badge.emoji} ${badge.name} removed from <@${user.id}> (${info.changes} row).`])] });
        }
        const granted = quests.awardBadge(user.id, badgeId);
        return interaction.editReply({
            embeds: [ok('Badge awarded', [`${badge.emoji} **${badge.name}** → <@${user.id}>${granted ? '' : ' (already owned)'}`])]
        });
    }

    if (sub === 'title') {
        const user = targetUser(interaction);
        const titleId = interaction.options.getString('title', true);
        const remove = interaction.options.getBoolean('remove') ?? false;
        const title = titles.getTitle(titleId);
        if (!title) return interaction.editReply({ embeds: [ok('Title', [`❌ Unknown title '${titleId}'.`])] });

        if (remove) {
            const info = db.prepare('DELETE FROM cosmetic_titles WHERE userId = ? AND titleId = ?').run(user.id, titleId);
            return interaction.editReply({ embeds: [ok('Title revoked', [`🎖️ ${title.name} removed from <@${user.id}> (${info.changes} row).`])] });
        }
        const granted = titles.awardTitle(user.id, titleId);
        return interaction.editReply({
            embeds: [ok('Title granted', [`🎖️ **${title.name}** → <@${user.id}>${granted ? '' : ' (already owned)'}\nThey can equip it from '/profile' → **Titles**.`])]
        });
    }

    if (sub === 'streak-shield') {
        const user = targetUser(interaction);
        const days = interaction.options.getInteger('days', true);
        ensureUser(user.id);
        const total = streak.addCoverDays(user.id, days);
        return interaction.editReply({
            embeds: [ok('Streak shield', [`🛡️ <@${user.id}> now holds **${total}** protection day(s) (${days >= 0 ? '+' : ''}${days}).`])]
        });
    }

    if (sub === 'seasonal-gift') {
        const user = targetUser(interaction);
        const clearLock = interaction.options.getBoolean('clear-lock') ?? false;
        ensureUser(user.id);
        const active = seasonal.getActiveSeason();
        if (!active) return interaction.editReply({ embeds: [ok('Seasonal gift', ['No seasonal event is active right now.'])] });

        if (clearLock) {
            db.prepare('DELETE FROM seasonal_claims WHERE userId = ? AND event = ? AND dayKey = ?')
                .run(user.id, active.id, active.dateKey);
        }
        const result = seasonal.claimDailyGift(user.id);
        return interaction.editReply({
            embeds: [ok('Seasonal gift', [
                `${active.emoji} **${active.name}** — day ${active.dayIndex}`,
                result.ok ? `✅ ${result.message}` : `⚠️ ${result.message}`
            ])]
        });
    }
}

// ==================================================
// INSPECT
// ==================================================
async function runView(interaction, sub) {
    if (sub === 'status') {
        const activeT = tournaments.getActiveTournament();
        const round = marketPvp.getOpenRound();
        const race = racing.getCurrentRace();
        const deals = flashDeals.getActiveDeals();
        const capsulesLive = capsules.getActiveCapsules();
        const standings = hatchery.getSideStandings();
        const nextCapsule = capsules.getNextSpawnAt();
        const season = seasonal.getActiveSeason();

        return interaction.editReply({
            embeds: [ok('System status', [
                `**🐉 Hatchery** — season ${standings.season} · 🌌 ${standings.good} vs 🩸 ${standings.evil} · ${standings.eggs} eggs found, ${standings.hatched} hatched`,
                `**🎣 Tournament** — ${activeT ? `live, closes <t:${Math.floor(Number(activeT.endsAt) / 1000)}:R>, pot 🪙${Number(activeT.pot).toLocaleString()}` : 'none live'}`,
                `**📈 Market round** — ${round ? `'${round.oreId}' open, closes <t:${Math.floor(Number(round.endsAt) / 1000)}:R>` : 'none open'}`,
                `**🏁 Dragon race** — ${race ? `'${race.raceId}' on ${racing.getTrack(race.trackId)?.name}, closes <t:${Math.floor(Number(race.endsAt) / 1000)}:R>` : 'none open'}`,
                `**🔥 Flash deals** — ${deals.length ? deals.map(deal => `${deal.itemId} −${deal.discount}%`).join(', ') : 'none active'}`,
                `**💠 Capsules** — ${capsulesLive.length} live · next <t:${Math.floor(nextCapsule / 1000)}:R>`,
                `**🎁 Season** — ${season ? seasonal.describeSeason() : 'none active'}`,
                `**🎯 Bounties** — total pool 🪙${Number(bounties.totalBountyPool()).toLocaleString()}`,
                `**⏰ Reminders pending** — ${db.prepare('SELECT COUNT(*) AS c FROM reminders WHERE delivered = 0').get().c}`,
                `**🤝 Open trades** — ${db.prepare("SELECT COUNT(*) AS c FROM trades WHERE status = 'open'").get().c}`
            ])]
        });
    }

    if (sub === 'bounties') {
        const top = bounties.topBounties(10);
        return interaction.editReply({
            embeds: [ok('Open bounties', top.length
                ? top.map((entry, index) => `'#${index + 1}' <@${entry.targetId}> — 🪙${Number(entry.amount).toLocaleString()}`)
                : ['No open bounties.'])]
        });
    }

    if (sub === 'clear-bounty') {
        const user = targetUser(interaction);
        const amount = bounties.getBountyAmount(user.id);
        db.prepare('DELETE FROM bounties WHERE targetId = ?').run(user.id);
        db.prepare('DELETE FROM bounty_contributions WHERE targetId = ?').run(user.id);
        return interaction.editReply({
            embeds: [ok('Bounty cleared', [`🎯 Removed 🪙${Number(amount).toLocaleString()} of bounty from <@${user.id}> (not refunded).`])]
        });
    }

    if (sub === 'reminders') {
        const user = targetUser(interaction);
        const pending = reminders.listPending(user.id);
        return interaction.editReply({
            embeds: [ok(`Reminders — <@${user.id}>`, pending.length
                ? pending.map(reminder => `'#${reminder.reminderId}' <t:${Math.floor(Number(reminder.dueAt) / 1000)}:R> — ${String(reminder.message).slice(0, 90)}`)
                : ['None pending.'])]
        });
    }

    if (sub === 'capsules') {
        const live = capsules.getActiveCapsules();
        const channels = capsules.getAllowedChannels();
        return interaction.editReply({
            embeds: [ok('Credit capsules', [
                `**Allowed channels:** ${channels.map(id => `<#${id}>`).join(', ') || 'none'}`,
                `**Range:** 🪙${Number(capsules.minCapsuleValue()).toLocaleString()} – 🪙${Number(capsules.maxCapsuleValue()).toLocaleString()}`,
                `**Next spawn:** <t:${Math.floor(capsules.getNextSpawnAt() / 1000)}:R>`,
                '',
                live.length
                    ? live.map(capsule => `'#${capsule.capsuleId}' <#${capsule.channelId}> — 🪙${Number(capsule.amount).toLocaleString()} · expires <t:${Math.floor(Number(capsule.endsAt) / 1000)}:R>`).join('\n')
                    : '_No live capsules._'
            ])]
        });
    }

    if (sub === 'trades') {
        const user = targetUser(interaction);
        const open = trades.listOpenTradesFor(user.id);
        return interaction.editReply({
            embeds: [ok(`Open trades — <@${user.id}>`, open.length
                ? open.map(trade => `'${trade.tradeId}' — <@${trade.initiatorId}> ⇄ <@${trade.partnerId}> · confirmed ${trade.initiatorConfirmed ? '✅' : '⬜'}/${trade.partnerConfirmed ? '✅' : '⬜'}`)
                : ['None open.'])]
        });
    }

    if (sub === 'ladder') {
        const ladder = ttt.getLadder(10);
        return interaction.editReply({
            embeds: [ok('Tic-Tac-Toe Elo ladder', ladder.length
                ? ladder.map(entry => `'#${entry.rank}' <@${entry.userId}> — **${entry.elo}** (${entry.wins}W/${entry.losses}L/${entry.draws}D)${entry.streak > 1 ? ` 🔥${entry.streak}` : ''}`)
                : ['Nobody has played a rated match yet.'])]
        });
    }

    if (sub === 'races') {
        const history = racing.getRaceHistory(5);
        return interaction.editReply({
            embeds: [ok('Recent dragon races', history.length
                ? history.map(race => {
                    const track = racing.getTrack(race.trackId);
                    const winner = race.winnerDragonId ? hatchery.getDragon(race.winnerDragonId) : null;
                    return `'${race.raceId}' ${track?.name || 'track'} — ${race.status} · ${winner ? `🏆 **${winner.name}** (<@${winner.userId}>)` : 'no winner'}`;
                })
                : ['No races have been run yet.'])]
        });
    }
}

// ==================================================
// CONFIG
// ==================================================
async function runConfig(interaction, sub) {
    if (sub === 'capsule-channels') {
        const ids = ['channel1', 'channel2', 'channel3']
            .map(name => interaction.options.getChannel(name))
            .filter(Boolean)
            .map(channel => channel.id);
        capsules.setAllowedChannels(ids);
        return interaction.editReply({
            embeds: [ok('Capsule channels set', [`Capsules will spawn in: ${ids.map(id => `<#${id}>`).join(', ')}`])]
        });
    }

    if (sub === 'capsule-range') {
        const min = interaction.options.getInteger('min', true);
        const max = interaction.options.getInteger('max', true);
        if (max < min) return interaction.editReply({ embeds: [ok('Capsule range', ['❌ Maximum must be at least the minimum.'])] });
        const setMeta = (key, value) => db.prepare(`
            INSERT INTO bot_meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(key, String(value));
        setMeta('capsule:min', min);
        setMeta('capsule:max', max);
        return interaction.editReply({
            embeds: [ok('Capsule range set', [`Capsules will hold 🪙${min.toLocaleString()} – 🪙${max.toLocaleString()}.`])]
        });
    }

    if (sub === 'snapshot-channel') {
        const channel = interaction.options.getChannel('channel', true);
        snapshot.setSnapshotChannel(channel.id);
        return interaction.editReply({
            embeds: [ok('Snapshot channel set', [`The weekly snapshot will post to <#${channel.id}>.`])]
        });
    }

    if (sub === 'reset-elo') {
        const user = targetUser(interaction);
        db.prepare(`
            INSERT INTO ttt_elo (userId, elo, wins, losses, draws, streak, bestStreak, peakElo, updatedAt)
            VALUES (?, ?, 0, 0, 0, 0, 0, ?, ?)
            ON CONFLICT(userId) DO UPDATE SET elo = ?, wins = 0, losses = 0, draws = 0,
                streak = 0, bestStreak = 0, peakElo = ?, updatedAt = excluded.updatedAt
        `).run(user.id, ttt.START_ELO, ttt.START_ELO, new Date().toISOString(), ttt.START_ELO, ttt.START_ELO);
        return interaction.editReply({
            embeds: [ok('Elo reset', [`📉 <@${user.id}> is back to **${ttt.START_ELO}** Elo.`])]
        });
    }

    if (sub === 'cancel-trade') {
        const tradeId = interaction.options.getString('trade-id', true);
        const trade = trades.getTrade(tradeId);
        if (!trade) return interaction.editReply({ embeds: [ok('Cancel trade', [`❌ No trade '${tradeId}'.`])] });
        const result = trades.cancel(tradeId, trade.initiatorId);
        return interaction.editReply({
            embeds: [ok('Cancel trade', [result.ok
                ? `🛑 Trade '${tradeId}' cancelled.`
                : `❌ ${result.message}`])]
        });
    }

    if (sub === 'server') {
        if (!interaction.guildId) return interaction.editReply({ embeds: [ok('Server configuration', ['❌ This only works inside a server.'])] });
        const scope = interaction.options.getString('scope', true);
        if (!['channel', 'role', 'server'].includes(scope)) {
            return interaction.editReply({ embeds: [ok('Server configuration', ['❌ Scope must be channel, role, or server.'])] });
        }
        const settingKind = interaction.options.getString('setting-kind') || 'server';
        if (settingKind === 'command-channel') {
            const commandName = String(interaction.options.getString('details', true)).trim().toLowerCase().replace(/^\//, '');
            const commandChannel = interaction.options.getChannel('channel', true);
            if (!/^[a-z0-9-]{1,32}$/.test(commandName)) {
                return interaction.editReply({ embeds: [ok('Command channel', ['❌ Enter a valid slash-command name.'])] });
            }
            serverConfig.setCommandChannel(interaction.guildId, commandName, commandChannel.id);
            return interaction.editReply({ embeds: [ok('Command channel saved', [`**/${commandName}** → <#${commandChannel.id}>`])] });
        }
        const setting = String(settingKind === 'server'
            ? interaction.options.getString('server-setting', true)
            : settingKind.replace('-role', '').replace('staff-recipient-', 'staff-ping-recipient-').replace('staff-sender', 'staff-ping-sender'))
            .trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const channel = interaction.options.getChannel('channel');
        const role = interaction.options.getRole('role');
        const serverValue = interaction.options.getString('server-value');
        const pingRole = interaction.options.getRole('ping-role');
        let selectedValue = scope === 'channel' ? channel?.id : scope === 'role' ? (pingRole?.id || role?.id) : serverValue;
        if (!setting || !selectedValue) {
            return interaction.editReply({ embeds: [ok('Server configuration', ['❌ Choose a setting key and provide the matching channel, role, or server value.'])] });
        }
        serverConfig.set(interaction.guildId, scope, setting, selectedValue);
        const display = scope === 'channel' ? `<#${selectedValue}>` : scope === 'role' ? `<@&${selectedValue}>` : `\`${selectedValue}\``;
        return interaction.editReply({ embeds: [ok('Server configuration saved', [`**${scope}.${setting}** → ${display}`, 'Saved for this server and available through the shared serverConfig module.'])] });
    }

    if (sub === 'server-list') {
        if (!interaction.guildId) return interaction.editReply({ embeds: [ok('Server configuration', ['❌ This only works inside a server.'])] });
        const settings = serverConfig.list(interaction.guildId);
        const commandChannels = serverConfig.listCommandChannels(interaction.guildId);
        const lines = [
            ...settings.map(row => `**${row.scope}.${row.setting}** → ${row.scope === 'channel' ? `<#${row.value}>` : row.scope === 'role' ? `<@&${row.value}>` : `\`${row.value}\``}`),
            ...commandChannels.map(row => `**/${row.commandName}** → <#${row.channelId}>`)
        ];
        return interaction.editReply({ embeds: [ok('Server configuration', lines.length ? lines.slice(0, 80) : ['No server-specific settings saved yet.'])] });
    }

    if (sub === 'command-channel') {
        if (!interaction.guildId) return interaction.editReply({ embeds: [ok('Command channel', ['❌ This only works inside a server.'])] });
        const commandName = String(interaction.options.getString('details', true)).trim().toLowerCase().replace(/^\//, '');
        const channel = interaction.options.getChannel('channel', true);
        if (!/^[a-z0-9-]{1,32}$/.test(commandName)) {
            return interaction.editReply({ embeds: [ok('Command channel', ['❌ Enter a valid slash-command name.'])] });
        }
        serverConfig.setCommandChannel(interaction.guildId, commandName, channel.id);
        return interaction.editReply({ embeds: [ok('Command channel saved', [`**/${commandName}** is now limited to <#${channel.id}> in this server.`])] });
    }

    if (sub === 'command-channels') {
        if (!interaction.guildId) return interaction.editReply({ embeds: [ok('Command channels', ['❌ This only works inside a server.'])] });
        const rows = serverConfig.listCommandChannels(interaction.guildId);
        return interaction.editReply({ embeds: [ok('Configured command channels', rows.length
            ? rows.map(row => `**/${row.commandName}** → <#${row.channelId}>`)
            : ['No per-command channel overrides set.'])] });
    }

    if (sub === 'admin-roles') {
        const action = interaction.options.getString('action', true);
        const scope = interaction.options.getString('scope') ?? 'admin';
        const role = interaction.options.getRole('role');
        if (!['admin', 'audit'].includes(scope)) {
            return interaction.editReply({ embeds: [ok('Admin configuration', ['❌ Choose admin-command roles or audit-log roles.'])] });
        }
        const getIds = scope === 'audit' ? adminVisibility.getAuditRoleIds : adminVisibility.getAdminRoleIds;
        const setIds = scope === 'audit' ? adminVisibility.setAuditRoleIds : adminVisibility.setAdminRoleIds;
        const scopeLabel = scope === 'audit' ? 'Audit-log roles' : 'Admin-command roles';
        const format = ids => ids.map(id => `<@&${id}> (${id})`).join('\n') || '_none — nobody matches this set_';

        if (action === 'list') {
            return interaction.editReply({
                embeds: [ok('Admin configuration', [
                    '**Admin-command roles** — can run /admin, /reset, /edit, …',
                    format(adminVisibility.getAdminRoleIds()),
                    '',
                    '**Audit-log roles** — whose command usage is audit-logged',
                    format(adminVisibility.getAuditRoleIds()),
                    '',
                    `**Admin audit log:** ${adminVisibility.isAdminLogEnabled() ? '✅ on' : '⛔ off'} — toggle with \`/dragon-admin config admin-log\``,
                    'Stored sets apply until changed here; defaults apply until a set is stored.'
                ])]
            });
        }

        if (!role) {
            return interaction.editReply({ embeds: [ok(scopeLabel, ['❌ Mention a role to add or remove.'])] });
        }

        const ids = getIds();
        if (action === 'add') {
            if (ids.includes(role.id)) {
                return interaction.editReply({ embeds: [ok(scopeLabel, [`❌ <@&${role.id}> is already in this set.`])] });
            }
            setIds([...ids, role.id]);
            return interaction.editReply({ embeds: [ok(scopeLabel, [`✅ Added <@&${role.id}>.`])] });
        }

        if (!ids.includes(role.id)) {
            return interaction.editReply({ embeds: [ok(scopeLabel, [`❌ <@&${role.id}> is not in this set.`])] });
        }
        setIds(ids.filter(id => id !== role.id));
        const remaining = getIds();
        return interaction.editReply({
            embeds: [ok(scopeLabel, [
                `✅ Removed <@&${role.id}>.`,
                remaining.length ? '' : '⚠️ The set is now empty — nobody matches it until a role is added back.'
            ].filter(Boolean))]
        });
    }

    if (sub === 'admin-log') {
        const enabled = interaction.options.getBoolean('enabled', true);
        adminVisibility.setAdminLogEnabled(enabled);
        return interaction.editReply({
            embeds: [ok('Admin audit log', [enabled
                ? '✅ Admin command usage will be written to the audit log again.'
                : '⛔ Admin audit logging is off — no entries will be written until re-enabled.'])]
        });
    }
}
