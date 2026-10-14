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

module.exports = {
    data: hideFromMembers(new SlashCommandBuilder())
        .setName('dragon-admin')
        .setDescription('[ADMIN] Manage dragons, tournaments, market rounds, events and the economy extras')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

        // ---------------- HATCHERY ----------------
        .addSubcommandGroup(group => group
            .setName('hatchery')
            .setDescription('Eggs, dragons and incubators')
            .addSubcommand(sub => sub
                .setName('grant-egg')
                .setDescription('Give a player an egg (optionally of a specific type)')
                .addUserOption(o => o.setName('user').setDescription('Recipient').setRequired(true))
                .addStringOption(o => o.setName('type').setDescription('Egg id (autocomplete)').setAutocomplete(true))
                .addStringOption(o => o.setName('source').setDescription('Where it came from (flavour)').setRequired(false)))
            .addSubcommand(sub => sub
                .setName('give-dragon')
                .setDescription('Skip the egg entirely and hand over a hatched pet')
                .addUserOption(o => o.setName('user').setDescription('Recipient').setRequired(true))
                .addStringOption(o => o.setName('species').setDescription('Species id (autocomplete)').setAutocomplete(true).setRequired(true))
                .addStringOption(o => o.setName('trait').setDescription('Primary trait id').setRequired(false)))
            .addSubcommand(sub => sub
                .setName('hatch')
                .setDescription('Force an incubating egg to hatch now')
                .addIntegerOption(o => o.setName('egg').setDescription('Egg id').setRequired(true)))
            .addSubcommand(sub => sub
                .setName('set-level')
                .setDescription('Set a dragon level and stats')
                .addIntegerOption(o => o.setName('dragon').setDescription('Dragon id').setRequired(true))
                .addIntegerOption(o => o.setName('level').setDescription('Level (1-30)').setRequired(true).setMinValue(1).setMaxValue(30)))
            .addSubcommand(sub => sub
                .setName('delete')
                .setDescription('Delete a dragon permanently')
                .addIntegerOption(o => o.setName('dragon').setDescription('Dragon id').setRequired(true)))
            .addSubcommand(sub => sub
                .setName('list')
                .setDescription('List a player\'s eggs and dragons')
                .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true)))
        )

        // ---------------- RUN A SYSTEM RIGHT NOW ----------------
        .addSubcommandGroup(group => group
            .setName('run')
            .setDescription('Trigger a scheduled system immediately')
            .addSubcommand(sub => sub
                .setName('tournament')
                .setDescription('Open a fishing tournament in this channel')
                .addIntegerOption(o => o.setName('minutes').setDescription('Window length in minutes').setRequired(false).setMinValue(5).setMaxValue(180))
                .addIntegerOption(o => o.setName('pot').setDescription('Starting pot in credits').setRequired(false).setMinValue(0)))
            .addSubcommand(sub => sub
                .setName('settle-tournament')
                .setDescription('Force-settle the live tournament and pay the podium'))
            .addSubcommand(sub => sub
                .setName('market-round')
                .setDescription('Open a new contrarian market round')
                .addStringOption(o => o.setName('ore').setDescription('Ore id (autocomplete)').setAutocomplete(true)))
            .addSubcommand(sub => sub
                .setName('settle-market')
                .setDescription('Force-settle the open market round'))
            .addSubcommand(sub => sub
                .setName('flash-deals')
                .setDescription('Re-roll today\'s flash deals')
                .addBooleanOption(o => o.setName('force').setDescription('Replace existing deals for today').setRequired(false)))
            .addSubcommand(sub => sub
                .setName('capsule')
                .setDescription('Drop a credit capsule right now in this channel'))
            .addSubcommand(sub => sub
                .setName('snapshot')
                .setDescription('Post the weekly economy snapshot now'))
            .addSubcommand(sub => sub
                .setName('race-open')
                .setDescription('Open this week\'s dragon race'))
            .addSubcommand(sub => sub
                .setName('race-settle')
                .setDescription('Run and settle the open dragon race now'))
            .addSubcommand(sub => sub
                .setName('elo-promotion')
                .setDescription('Run the weekly Tic-Tac-Toe Elo promotion'))
        )

        // ---------------- REWARDS ----------------
        .addSubcommandGroup(group => group
            .setName('reward')
            .setDescription('Hand out badges, titles and protection')
            .addSubcommand(sub => sub
                .setName('badge')
                .setDescription('Award a badge to a player')
                .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
                .addStringOption(o => o.setName('badge').setDescription('Badge id (autocomplete)').setAutocomplete(true).setRequired(true))
                .addBooleanOption(o => o.setName('remove').setDescription('Remove it instead of granting')))
            .addSubcommand(sub => sub
                .setName('title')
                .setDescription('Grant or revoke a cosmetic title')
                .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
                .addStringOption(o => o.setName('title').setDescription('Title id (autocomplete)').setAutocomplete(true).setRequired(true))
                .addBooleanOption(o => o.setName('remove').setDescription('Revoke it instead of granting')))
            .addSubcommand(sub => sub
                .setName('streak-shield')
                .setDescription('Inject streak-protection days')
                .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
                .addIntegerOption(o => o.setName('days').setDescription('Days to add (negative to remove)').setRequired(true)))
            .addSubcommand(sub => sub
                .setName('seasonal-gift')
                .setDescription('Give a player today\'s seasonal gift (bypasses the once-a-day lock)')
                .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true))
                .addBooleanOption(o => o.setName('clear-lock').setDescription('Clear today\'s claim row first').setRequired(false)))
        )

        // ---------------- INSPECT ----------------
        .addSubcommandGroup(group => group
            .setName('view')
            .setDescription('Inspect live system state')
            .addSubcommand(sub => sub.setName('status').setDescription('Show the status of every new subsystem'))
            .addSubcommand(sub => sub
                .setName('bounties')
                .setDescription('Top open bounties'))
            .addSubcommand(sub => sub
                .setName('clear-bounty')
                .setDescription('Wipe the bounty on a target')
                .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)))
            .addSubcommand(sub => sub
                .setName('reminders')
                .setDescription('Pending reminders for a player')
                .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true)))
            .addSubcommand(sub => sub
                .setName('capsules')
                .setDescription('Live capsules (and their channels)'))
            .addSubcommand(sub => sub
                .setName('trades')
                .setDescription('Open trades for a player')
                .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true)))
            .addSubcommand(sub => sub
                .setName('ladder')
                .setDescription('Current Tic-Tac-Toe Elo ladder'))
            .addSubcommand(sub => sub
                .setName('races')
                .setDescription('Recent dragon race history'))
        )

        // ---------------- CONFIG ----------------
        .addSubcommandGroup(group => group
            .setName('config')
            .setDescription('Tune the new systems')
            .addSubcommand(sub => sub
                .setName('capsule-channels')
                .setDescription('Set the channels capsules can spawn in')
                .addChannelOption(o => o.setName('channel1').setDescription('First channel').setRequired(true))
                .addChannelOption(o => o.setName('channel2').setDescription('Second channel'))
                .addChannelOption(o => o.setName('channel3').setDescription('Third channel')))
            .addSubcommand(sub => sub
                .setName('capsule-range')
                .setDescription('Set the capsule credit range')
                .addIntegerOption(o => o.setName('min').setDescription('Minimum credits').setRequired(true).setMinValue(500))
                .addIntegerOption(o => o.setName('max').setDescription('Maximum credits').setRequired(true).setMinValue(500)))
            .addSubcommand(sub => sub
                .setName('snapshot-channel')
                .setDescription('Set where the weekly snapshot is posted')
                .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
            .addSubcommand(sub => sub
                .setName('reset-elo')
                .setDescription('Reset a player\'s Tic-Tac-Toe Elo')
                .addUserOption(o => o.setName('user').setDescription('Player').setRequired(true)))
            .addSubcommand(sub => sub
                .setName('cancel-trade')
                .setDescription('Force-cancel an open trade')
                .addStringOption(o => o.setName('trade-id').setDescription('Trade id (see /dragon-admin view trades)').setRequired(true)))
            .addSubcommand(sub => sub
                .setName('admin-roles')
                .setDescription('Configure which roles run admin commands and who gets audit-logged')
                .addStringOption(o => o.setName('action')
                    .setDescription('List, add, or remove')
                    .setRequired(true)
                    .addChoices(
                        { name: 'List both role sets', value: 'list' },
                        { name: 'Add a role', value: 'add' },
                        { name: 'Remove a role', value: 'remove' }
                    ))
                .addStringOption(o => o.setName('scope')
                    .setDescription('Which set to change (default: admin commands)')
                    .addChoices(
                        { name: 'Admin commands (run /admin, /reset, …)', value: 'admin' },
                        { name: 'Audit log (logged as admin activity)', value: 'audit' }
                    ))
                .addRoleOption(o => o.setName('role').setDescription('Role to add or remove')))
            .addSubcommand(sub => sub
                .setName('admin-log')
                .setDescription('Turn the admin-activity audit log on or off')
                .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true)))
        ),

    async autocomplete(interaction) {
        if (!isAdminUser(interaction)) return interaction.respond([]);
        const focused = interaction.options.getFocused().toLowerCase();
        const which = interaction.options.getSubcommand();
        let choices = [];

        if (which === 'grant-egg') {
            choices = Object.values(hatchery.EGG_TYPES).map(egg => ({
                name: `${egg.name} (${egg.rarity}, ${egg.side})`.slice(0, 100),
                value: egg.id
            }));
        } else if (which === 'give-dragon') {
            choices = Object.values(hatchery.SPECIES).map(species => ({
                name: `${species.name} (${species.rarity}, ${species.side})`.slice(0, 100),
                value: species.id
            }));
        } else if (which === 'badge') {
            choices = (quests.BADGES || []).map(badge => ({
                name: `${badge.name} — ${badge.id}`.slice(0, 100),
                value: badge.id
            }));
        } else if (which === 'title') {
            choices = titles.TITLES.map(title => ({
                name: `${title.name} — ${title.id}`.slice(0, 100),
                value: title.id
            }));
        } else if (which === 'market-round') {
            choices = Object.keys(require('../systems/mining/oreTables').BASE_ORE_VALUES || {}).map(ore => ({
                name: ore.replace(/_/g, ' '),
                value: ore
            }));
        }

        const filtered = choices.filter(choice =>
            choice.name.toLowerCase().includes(focused) || choice.value.includes(focused)
        ).slice(0, 25);
        return interaction.respond(filtered);
    },

    async execute(interaction) {
        if (!isAdminUser(interaction)) {
            return interaction.reply({ content: '❌ This command is restricted to administrators.', flags: 64 });
        }
        await interaction.deferReply({ flags: 64 });

        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();

        try {
            if (group === 'hatchery') return await runHatchery(interaction, sub);
            if (group === 'run') return await runSystems(interaction, sub);
            if (group === 'reward') return await runReward(interaction, sub);
            if (group === 'view') return await runView(interaction, sub);
            if (group === 'config') return await runConfig(interaction, sub);
            return interaction.editReply({ embeds: [ok('Dragon Admin', ['Unknown subcommand.'])], flags: 64 });
        } catch (error) {
            console.error('dragon-admin failed:', error);
            return interaction.editReply({
                embeds: [ok('Dragon Admin — ERROR', [`'${error.message || error}'`])],
                flags: 64
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
        return interaction.editReply({
            embeds: [ok('Snapshot', [`⚠️ ${result.message}`, '', 'Preview:', snapshot.buildSnapshotEmbed(built).title])]
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

    if (sub === 'admin-roles') {
        const action = interaction.options.getString('action', true);
        const scope = interaction.options.getString('scope') ?? 'admin';
        const role = interaction.options.getRole('role');
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
