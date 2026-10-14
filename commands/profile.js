/*
 * /profile — the player card AND the entire Dragon Hatchery surface.
 *
 * One slash command carries the whole pet system so the command list stays
 * short: dragons, incubators, feeding, training, play, quests, badges, titles
 * and dragon racing all live behind buttons on this embed.
 *
 * STATE LIVES IN THE CUSTOM IDS, NOT IN MEMORY. Every button and select menu
 * encodes what it needs (`dragon|<ownerId>|<action>|<args…>`), so a bot
 * restart — which kills every component collector in this codebase — cannot
 * leave a half-dead panel behind. index.js routes the `dragon|` prefix here.
 */
const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const db = require('../database');
const { ensureUser } = require('../systems/utils/ensureUser');
const hatchery = require('../systems/dragons/dragonManager');
const render = require('../systems/dragons/dragonRender');
const quests = require('../systems/economy/questManager');
const titles = require('../systems/economy/titleManager');
const racing = require('../systems/economy/dragonRacing');
const seasonal = require('../systems/economy/seasonalEvents');

const ID_PREFIX = 'dragon|';
const COLOR = 0x00d4ff;

// ==================================================
// SMALL HELPERS
// ==================================================
function part(customId) {
    return String(customId).split('|').slice(1);
}

function id(...pieces) {
    return ID_PREFIX + pieces.join('|');
}

function style(rarity) {
    return hatchery.RARITY_STYLE[rarity] || hatchery.RARITY_STYLE.common;
}

function traitLine(dragon) {
    const first = hatchery.TRAITS[dragon.trait];
    const second = dragon.trait2 ? hatchery.TRAITS[dragon.trait2] : null;
    const names = [first, second].filter(Boolean).map(t => `${t.emoji} ${t.name}`);
    return names.length ? names.join(' · ') : 'none';
}

function bar(pct, size = 10) {
    const filled = Math.max(0, Math.min(size, Math.round((pct / 100) * size)));
    return `\`${'▰'.repeat(filled)}${'▱'.repeat(size - filled)}\``;
}

function progressOf(dragon) {
    return hatchery.xpProgress(dragon);
}

// ==================================================
// VIEW BUILDERS
// ==================================================
function backRow(ownerId, extras = []) {
    return new ActionRowBuilder().addComponents(
        ...extras,
        new ButtonBuilder()
            .setCustomId(id(ownerId, 'main'))
            .setLabel('Back to profile')
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
    );
}

function buildMain(ownerId, displayName) {
    const summary = hatchery.getHatcherySummary(ownerId);
    const stats = hatchery.getStats(ownerId);
    const questStats = quests.getStats(ownerId);
    const equipped = titles.getEquippedTitle(ownerId);
    const season = seasonal.getActiveSeason();
    const standings = hatchery.getSideStandings();
    const bounty = require('../systems/economy/bountyManager').getBountyAmount(ownerId);
    const balances = db.prepare('SELECT wallet, bank, mining_bank FROM users WHERE userId = ?').get(ownerId)
        || { wallet: 0, bank: 0, mining_bank: 0 };

    const active = summary.active;
    const species = active ? hatchery.SPECIES[active.speciesId] : null;
    const dragonBlock = active
        ? [
            `${species?.emoji || '🐉'} **${active.name}** — Lv **${progressOf(active).level}** ${style(active.rarity).emoji} ${style(active.rarity).label}`,
            `> ${traitLine(active)}`,
            `> ❤️ Hunger ${bar(active.hunger)} ${active.hunger}% · 😊 Mood ${bar(active.happiness)} ${active.happiness}%`,
            `> ⚔️ ${active.power} · 💨 ${active.speed} · 🛡️ ${active.stamina} · 🔗 Bond ${active.bond}`
        ].join('\n')
        : '_No active pet yet — incubate an egg to get started._';

    const bonusLines = hatchery.describeDragonBonus(ownerId).join('\n');

    const embed = new EmbedBuilder()
        .setColor(active?.side === 'evil' ? 0xff2d6f : COLOR)
        .setTitle(`🪪 ${displayName}`)
        .setDescription([
            equipped ? `**${titles.formatTitleTag(ownerId)}**` : '_No title equipped — check the Titles panel._',
            '',
            '**🐉 ACTIVE PET**',
            dragonBlock,
            '',
            '**✨ PASSIVE BONUSES**',
            bonusLines
        ].join('\n'))
        .addFields(
            {
                name: '📦 Hatchery',
                value: [
                    `🥚 Eggs held: **${summary.counts.eggsIdle + summary.counts.incubating}**`,
                    `🌡️ Incubating: **${summary.counts.incubating}**${summary.counts.ready ? ` (✅ **${summary.counts.ready} ready**)` : ''}`,
                    `🐉 Pets: **${stats.dragons}** · best Lv **${stats.bestLevel}**`,
                    `🎓 Hatched lifetime: **${stats.hatched}**`
                ].join('\n'),
                inline: true
            },
            {
                name: '🎯 Progress',
                value: [
                    `📋 Quests claimed: **${questStats.questsClaimed}**`,
                    `🔥 Daily quest streak: **${questStats.dailyStreak}**`,
                    `🏅 Badges: **${questStats.badgesEarned || quests.getBadges(ownerId).length}**`,
                    bounty > 0 ? `🎯 Bounty on you: **🪙${bounty.toLocaleString()}**` : '🎯 No bounty on you'
                ].join('\n'),
                inline: true
            },
            {
                name: '💰 Accounts',
                value: [
                    `💳 Wallet: 🪙${Number(balances.wallet).toLocaleString()}`,
                    `🏦 Bank: 🪙${Number(balances.bank).toLocaleString()}`,
                    `⛏️ Mining bank: 🪙${Number(balances.mining_bank).toLocaleString()}`
                ].join('\n'),
                inline: true
            },
            {
                name: '⚔️ Dragonflight vs Onslaught',
                value: `🌌 **Dragonflight** ${standings.good} · 🩸 **Onslaught** ${standings.evil} — season **${standings.season}**`,
                inline: false
            }
        )
        .setFooter({ text: season ? seasonal.describeSeason().replace(/\*\*/g, '') : 'No seasonal event active' })
        .setTimestamp();

    const file = active
        ? render.renderDragonCard({
            dragon: active,
            species,
            trait: hatchery.TRAITS[active.trait],
            trait2: active.trait2 ? hatchery.TRAITS[active.trait2] : null,
            progress: progressOf(active),
            owner: displayName,
            title: titles.getEquippedTitle(ownerId)?.name || null,
            side: active.side
        })
        : null;

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id(ownerId, 'dragons')).setLabel('Dragons').setEmoji('🐉').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id(ownerId, 'eggs')).setLabel('Eggs').setEmoji('🥚').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id(ownerId, 'quests')).setLabel('Quests').setEmoji('📋').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id(ownerId, 'badges')).setLabel('Badges').setEmoji('🏅').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id(ownerId, 'titles')).setLabel('Titles').setEmoji('🎖️').setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id(ownerId, 'race')).setLabel('Dragon Racing').setEmoji('🏁').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(id(ownerId, 'gift')).setLabel('Seasonal Gift').setEmoji('🎁').setStyle(season?.dailyGift ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id(ownerId, 'rivalry')).setLabel('Rivalry').setEmoji('⚔️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id(ownerId, 'refresh')).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
    );

    return { embed, components: [row1, row2], file };
}

function buildDragons(ownerId, displayName, selectedId = null) {
    const dragons = hatchery.listDragons(ownerId);
    if (!dragons.length) {
        return {
            embed: new EmbedBuilder()
                .setColor(COLOR)
                .setTitle('🐉 YOUR DRAGONS')
                .setDescription('You do not have any pets yet.\n\nEggs drop from **/mine**, **/fish** and successful heists, or buy an **Egg Crate** from **/shop**. Incubate one and hatch it from the **Eggs** panel.'),
            components: [backRow(ownerId)],
            file: null
        };
    }

    let selected = selectedId ? dragons.find(dragon => String(dragon.dragonId) === String(selectedId)) : null;
    if (!selected) selected = dragons.find(dragon => dragon.active) || dragons[0];

    const list = dragons.map((dragon, index) => hatchery.describeDragon(dragon, { index })).join('\n');
    const progress = progressOf(selected);
    const species = hatchery.SPECIES[selected.speciesId] || null;
    const record = racing.getDragonRecord(selected.dragonId) || {};

    const embed = new EmbedBuilder()
        .setColor(selected.side === 'evil' ? 0xff2d6f : COLOR)
        .setTitle('🐉 YOUR DRAGONS')
        .setDescription(list.slice(0, 3500))
        .addFields(
            {
                name: `${species?.emoji || '🐉'} ${selected.name}`,
                value: [
                    `**Side:** ${selected.side === 'evil' ? '🩸 Onslaught beast' : '🌌 Dragonflight dragon'} · **Rarity:** ${style(selected.rarity).emoji} ${style(selected.rarity).label}`,
                    `**Level:** ${progress.level}${progress.maxed ? ' (MAX)' : ` · XP ${progress.xp}/${progress.needed}`}`,
                    `**Traits:** ${traitLine(selected)}`,
                    `**Stats:** ⚔️ ${selected.power} · 💨 ${selected.speed} · 🛡️ ${selected.stamina}`,
                    `**Care:** ❤️ ${selected.hunger}% · 😊 ${selected.happiness}% · 🔗 Bond ${selected.bond}`,
                    `**Racing:** ${record.races || 0} race(s), ${record.wins || 0} win(s)`,
                    selected.lore || species?.lore ? `_${species?.lore || ''}_` : null
                ].filter(Boolean).join('\n'),
                inline: false
            }
        )
        .setFooter({ text: 'Feed, train and play to level your pet — the active pet grants a passive bonus' });

    const file = render.renderDragonCard({
        dragon: selected,
        species,
        trait: hatchery.TRAITS[selected.trait],
        trait2: selected.trait2 ? hatchery.TRAITS[selected.trait2] : null,
        progress,
        owner: displayName,
        side: selected.side
    });

    const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(id(ownerId, 'open'))
            .setPlaceholder('Select a pet to inspect or manage')
            .addOptions(dragons.slice(0, 25).map(dragon => ({
                label: `${dragon.name} — Lv ${dragon.level}`.slice(0, 100),
                description: `${dragon.side === 'evil' ? 'Onslaught' : 'Dragonflight'} · ${traitLine(dragon).replace(/[*_]/g, '')}`.slice(0, 100),
                value: String(dragon.dragonId),
                default: String(dragon.dragonId) === String(selected.dragonId)
            })))
    );

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id(ownerId, 'feed', selected.dragonId)).setLabel('Feed').setEmoji('🍖').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(id(ownerId, 'train', selected.dragonId)).setLabel('Train').setEmoji('🏋️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id(ownerId, 'play', selected.dragonId)).setLabel('Play').setEmoji('🎾').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id(ownerId, 'active', selected.dragonId)).setLabel('Set Active').setEmoji('⭐').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id(ownerId, 'rename', selected.dragonId)).setLabel('Rename').setEmoji('✏️').setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id(ownerId, 'release', selected.dragonId)).setLabel('Release').setEmoji('🕊️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(id(ownerId, 'eggs')).setLabel('Eggs').setEmoji('🥚').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id(ownerId, 'main')).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );

    return { embed, components: [selectRow, row1, row2], file };
}

function buildEggs(ownerId, displayName) {
    const summary = hatchery.getHatcherySummary(ownerId);
    const idle = summary.eggs.filter(egg => egg.status === 'idle');
    const incubating = summary.incubating;

    const lines = [];
    lines.push('**🌡️ INCUBATORS**');
    for (const slot of summary.incubators) {
        if (!slot.unlocked) {
            lines.push(`🔒 Incubator ${slot.slot + 1} — locked${slot.price ? ` · unlock for 🪙${slot.price.toLocaleString()}` : ' · free'}`);
        } else if (slot.egg) {
            lines.push(`Incubator ${slot.slot + 1}: ${hatchery.describeEgg(slot.egg)}`);
        } else {
            lines.push(`⬜ Incubator ${slot.slot + 1} — empty`);
        }
    }
    lines.push('');
    lines.push('**🥚 STORED EGGS**');
    lines.push(idle.length ? idle.map(egg => `• ${hatchery.describeEgg(egg)}`).join('\n') : '_No idle eggs._');

    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('🥚 DRAGON HATCHERY')
        .setDescription(lines.join('\n').slice(0, 3800))
        .setFooter({ text: 'Eggs incubate 24–48h. Accelerators shave hours off instantly.' });

    const focus = incubating.find(egg => new Date(egg.incubateEndsAt || 0).getTime() <= Date.now()) || incubating[0] || idle[0];
    let file = null;
    if (focus) {
        const type = hatchery.EGG_TYPES[focus.eggType];
        const progress = hatchery.incubationProgress(focus);
        file = render.renderEggCard({
            eggType: type,
            rarityColor: style(focus.rarity).color,
            side: focus.side,
            owner: displayName,
            progressPct: progress.pct,
            ready: progress.ready
        });
    }

    const components = [];

    // Ready-to-hatch buttons first — this is the moment players are waiting for.
    const ready = hatchery.readyEggs(ownerId);
    if (ready.length) {
        components.push(new ActionRowBuilder().addComponents(
            ready.slice(0, 5).map(egg => new ButtonBuilder()
                .setCustomId(id(ownerId, 'hatch', egg.eggId))
                .setLabel(`HATCH ${style(egg.rarity).label} EGG`.slice(0, 40))
                .setEmoji('✨')
                .setStyle(ButtonStyle.Success))
        ));
    }

    const emptySlots = summary.incubators.filter(slot => !slot.egg);
    if (idle.length && emptySlots.length) {
        components.push(new ActionRowBuilder().addComponents(
            emptySlots.slice(0, 4).flatMap(slot => idle.slice(0, 3).map(egg => new ButtonBuilder()
                .setCustomId(id(ownerId, 'incubate', egg.eggId, slot.slot))
                .setLabel(`${hatchery.EGG_TYPES[egg.eggType]?.name || 'Egg'} → slot ${slot.slot + 1}`.slice(0, 40))
                .setStyle(slot.unlocked ? ButtonStyle.Primary : ButtonStyle.Secondary)
            )).slice(0, 5)
        ));
    }

    const lockedSlots = summary.incubators.filter(slot => !slot.unlocked);
    if (lockedSlots.length) {
        components.push(new ActionRowBuilder().addComponents(
            lockedSlots.slice(0, 5).map(slot => new ButtonBuilder()
                .setCustomId(id(ownerId, 'unlock', slot.slot))
                .setLabel(`Unlock slot ${slot.slot + 1} (🪙${slot.price.toLocaleString()})`.slice(0, 80))
                .setEmoji('🔓')
                .setStyle(ButtonStyle.Secondary))
        ));
    }

    if (incubating.length) {
        components.push(new ActionRowBuilder().addComponents(
            incubating.slice(0, 5).map(egg => new ButtonBuilder()
                .setCustomId(id(ownerId, 'accel', egg.eggId))
                .setLabel(`Accelerate ${hatchery.EGG_TYPES[egg.eggType]?.name || 'egg'}`.slice(0, 80))
                .setEmoji('⚡')
                .setStyle(ButtonStyle.Primary))
        ));
    }

    components.push(backRow(ownerId));
    return { embed, components: components.slice(0, 5), file };
}

function buildFeed(ownerId, displayName, dragonId, qty = 1) {
    const dragon = hatchery.getDragon(dragonId);
    if (!dragon || dragon.userId !== ownerId) {
        return buildDragons(ownerId, displayName);
    }
    const options = hatchery.listFeedOptions(ownerId);
    const amount = Math.max(1, Math.min(10, Number(qty) || 1));

    const lines = [];
    lines.push(`**${dragon.name}** · ❤️ Hunger ${dragon.hunger}% · 😊 Mood ${dragon.happiness}% · Lv ${dragon.level}`);
    lines.push(`_Feeding costs nothing but the food. Ore and unsold fish only._`);
    lines.push('');
    lines.push(`**🐟 STORED FISH** — ${options.fish.length ? '' : '_none stored_ (catch some with `/fish`)_'}`);
    if (options.fish.length) {
        lines.push(options.fish.slice(0, 12).map(fish =>
            `• ${fish.emoji || '🐟'} **${fish.name}** ×${fish.quantity} — ${fish.rarity}`
        ).join('\n'));
    }
    lines.push('');
    lines.push(`**⛏️ STORED ORE** — ${options.ore.length ? '' : '_none stored_ (mine some with `/mine`)_'}`);
    if (options.ore.length) {
        lines.push(options.ore.slice(0, 12).map(ore =>
            `• **${ore.name}** ×${ore.quantity} — ${ore.rarity}`
        ).join('\n'));
    }

    const embed = new EmbedBuilder()
        .setColor(dragon.side === 'evil' ? 0xff2d6f : COLOR)
        .setTitle(`🍖 FEED ${String(dragon.name).toUpperCase()}`)
        .setDescription(lines.join('\n').slice(0, 3800))
        .setFooter({ text: 'Richer food gives far more XP — keep it well fed for a bigger passive bonus' });

    const components = [];
    const menuOptions = [
        ...options.fish.slice(0, 13).map(fish => ({
            label: `${fish.name} ×${fish.quantity}`.slice(0, 100),
            description: `Fish · ${fish.rarity} · feeds ${amount}`.slice(0, 100),
            value: `fish|${fish.id}`
        })),
        ...options.ore.slice(0, 13).map(ore => ({
            label: `${ore.name} ×${ore.quantity}`.slice(0, 100),
            description: `Ore · ${ore.rarity} · feeds ${amount}`.slice(0, 100),
            value: `ore|${ore.id}`
        }))
    ].slice(0, 25);

    if (menuOptions.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(id(ownerId, 'feeditem', dragon.dragonId, amount))
                .setPlaceholder(`Choose food (feeds ${amount} at a time)`)
                .addOptions(menuOptions)
        ));
    }

    components.push(new ActionRowBuilder().addComponents(
        ...[1, 5, 10].map(value => new ButtonBuilder()
            .setCustomId(id(ownerId, 'feed', dragon.dragonId, value))
            .setLabel(`×${value}`)
            .setStyle(value === amount ? ButtonStyle.Success : ButtonStyle.Secondary)),
        new ButtonBuilder().setCustomId(id(ownerId, 'open', dragon.dragonId)).setLabel('Back to pet').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    ));

    return { embed, components, file: null };
}

function buildQuests(ownerId) {
    const board = quests.getQuestBoard(ownerId);
    const renderSide = (rows, label) => {
        const lines = rows.map(row => {
            const done = row.completed ? '✅' : '⬜';
            const claimed = row.claimed ? ' · **claimed**' : '';
            const claimable = row.completed && !row.claimed;
            return `${done} ${row.quest.emoji} **${row.quest.name}** — ${row.progress}/${row.quest.target}${claimed} · 🪙${Number(row.quest.reward || 0).toLocaleString()}${claimable ? ' 🔔' : ''}`;
        });
        return { label, rows, lines };
    };
    const daily = renderSide(board.daily, '📅 DAILY');
    const weekly = renderSide(board.weekly, '🗓️ WEEKLY');
    const stats = quests.getStats(ownerId);

    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('📋 QUEST BOARD')
        .setDescription([
            `🔥 Daily claim streak: **${stats.dailyStreak}** · 🏆 Quests claimed: **${stats.questsClaimed}**`,
            '',
            `**${daily.label}** _(${board.dailyKey})_`,
            daily.lines.join('\n') || '_none_',
            '',
            `**${weekly.label}** _(${board.weeklyKey})_`,
            weekly.lines.join('\n') || '_none_'
        ].join('\n').slice(0, 3900))
        .setFooter({ text: 'Quests track themselves — play the game and come back to claim' });

    const components = [];
    const claimable = [
        ...daily.rows.filter(row => row.completed && !row.claimed).map(row => ({ row, period: 'daily' })),
        ...weekly.rows.filter(row => row.completed && !row.claimed).map(row => ({ row, period: 'weekly' }))
    ];
    for (let i = 0; i < claimable.length && i < 5; i += 1) {
        const { row, period } = claimable[i];
        if (!components.length || components[components.length - 1].components.length >= 5) {
            components.push(new ActionRowBuilder());
        }
        components[components.length - 1].addComponents(
            new ButtonBuilder()
                .setCustomId(id(ownerId, 'claim', row.quest.id, period))
                .setLabel(`Claim ${row.quest.name}`.slice(0, 80))
                .setEmoji(row.quest.emoji || '🎁')
                .setStyle(ButtonStyle.Success)
        );
    }

    if (!components.length) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(id(ownerId, 'refresh')).setLabel('Refresh board').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
        ));
    }
    components.push(backRow(ownerId));
    return { embed, components: components.slice(0, 5), file: null };
}

function buildBadges(ownerId) {
    const earned = quests.getBadges(ownerId);
    const earnedIds = new Set(earned.map(badge => badge.id));
    const catalog = quests.BADGES || [];
    const lines = catalog.map(badge => {
        const owned = earnedIds.has(badge.id);
        return `${owned ? badge.emoji : '🔒'} **${badge.name}** — ${badge.description || badge.requirementText || ''}${owned ? ' ✅' : ''}`;
    });

    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('🏅 BADGES & ACHIEVEMENTS')
        .setDescription([
            `Earned **${earnedIds.size}/${catalog.length}** — badges appear here for every account, forever.`,
            '',
            lines.join('\n') || '_No badge catalog loaded._'
        ].join('\n').slice(0, 3900));

    return { embed, components: [backRow(ownerId)], file: null };
}

function buildTitles(ownerId) {
    const catalog = titles.listCatalog(ownerId);
    const equipped = catalog.find(title => title.equipped) || null;

    const lines = catalog.map(title => {
        const state = title.equipped ? '⭐ **equipped**' : title.owned ? '✅ owned' : title.locked ? `🔒 locked — ${title.requirementText}` : `🪙${Number(title.price).toLocaleString()}`;
        return `${title.owned ? '🎖️' : title.locked ? '🔒' : '🛒'} **${title.name}** — ${state}`;
    });

    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('🎖️ TITLES')
        .setDescription([
            equipped ? `Currently wearing **${titles.formatTitleTag(ownerId)}**` : '_No title equipped._',
            'Titles show on your `/profile` card and beside your name on the ladder.',
            '',
            lines.join('\n')
        ].join('\n').slice(0, 3900))
        .setFooter({ text: 'Select a title below — owned titles equip instantly, locked ones show their requirement' });

    const components = [];
    if (catalog.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(id(ownerId, 'titlepick'))
                .setPlaceholder('Select a title')
                .addOptions(catalog.slice(0, 25).map(title => ({
                    label: title.name.slice(0, 100),
                    description: (title.equipped ? 'Equipped' : title.owned ? 'Owned — equip it' : title.locked ? `Locked: ${title.requirementText}` : `Buy for ${title.price.toLocaleString()} credits`).slice(0, 100),
                    value: title.id,
                    default: Boolean(title.equipped)
                })))
        ));
    }
    if (equipped) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(id(ownerId, 'unequip')).setLabel('Take off title').setEmoji('🚫').setStyle(ButtonStyle.Secondary)
        ));
    }
    components.push(backRow(ownerId));
    return { embed, components: components.slice(0, 5), file: null };
}

function buildRace(ownerId) {
    const race = racing.getCurrentRace();
    if (!race) {
        return {
            embed: new EmbedBuilder()
                .setColor(COLOR)
                .setTitle('🏁 DRAGON RACING')
                .setDescription('No race is scheduled right now. A new circuit opens every week.'),
            components: [backRow(ownerId)],
            file: null
        };
    }

    const track = racing.getTrack(race.trackId);
    const entrants = racing.getEntrants(race.raceId);
    const dragons = hatchery.listDragons(ownerId);
    const ownedIds = new Set(dragons.map(dragon => dragon.dragonId));
    const mine = entrants.filter(entry => String(entry.userId) === String(ownerId));
    const due = Number(race.endsAt) <= Date.now();

    const entrantLines = entrants.length
        ? entrants.map((entry, index) => {
            const dragon = entry.dragonId ? hatchery.getDragon(entry.dragonId) : null;
            const record = dragon ? (racing.getDragonRecord(dragon.dragonId) || {}) : {};
            return `${index + 1}. ${entry.side === 'evil' ? '🩸' : '🌌'} **${entry.name}** — Lv ${entry.level} · ⚔️ ${entry.power} · 💨 ${entry.speed} · 🏆 ${record.wins || 0} win(s)`;
        }).join('\n')
        : '_No dragons entered yet — be the first._';

    const last = racing.getLastSettledRace();
    const lastLine = last
        ? `Last winner: **${hatchery.getDragon(last.winnerDragonId)?.name || 'unknown'}** on ${racing.getTrack(last.trackId)?.name || 'a closed track'}`
        : 'No race has been run yet.';

    const embed = new EmbedBuilder()
        .setColor(0xa855f7)
        .setTitle(`🏁 ${track?.emoji || '🏁'} ${track?.name || 'DRAGON CIRCUIT'}`)
        .setDescription([
            `**Terrain:** ${track?.terrain || 'unknown'} — matching traits run faster (${Math.round((racing.TERRAIN_MATCH_BONUS || 0) * 100)}% boost)`,
            `**Pot:** 🪙${Number(race.pot).toLocaleString()} · **Closes:** <t:${Math.floor(Number(race.endsAt) / 1000)}:R>${due ? ' · ⚠️ **result pending**' : ''}`,
            `**Distance:** ${track?.length ?? '?'} segments`,
            '',
            '**🐉 ENTRIES**',
            entrantLines,
            '',
            `_${lastLine}_`
        ].join('\n').slice(0, 3800))
        .setFooter({ text: `Bets: 🪙${racing.BET_MIN.toLocaleString()}–🪙${racing.BET_MAX.toLocaleString()} · one bet per race` });

    const components = [];
    const enterable = dragons.filter(dragon => !entrants.some(entry => String(entry.dragonId) === String(dragon.dragonId)));
    if (enterable.length && !due && mine.length < (racing.MAX_ENTRIES_PER_USER || 2)) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(id(ownerId, 'enterpick'))
                .setPlaceholder('Enter one of your dragons')
                .addOptions(enterable.slice(0, 25).map(dragon => ({
                    label: `${dragon.name} — Lv ${dragon.level}`.slice(0, 100),
                    description: `${dragon.side === 'evil' ? 'Onslaught' : 'Dragonflight'} · ${dragon.power} pow / ${dragon.speed} spd`.slice(0, 100),
                    value: String(dragon.dragonId)
                })))
        ));
    }

    const betOptions = entrants
        .filter(entry => ownedIds.size >= 0)
        .flatMap(entry => [50_000, 250_000, 1_000_000].map(amount => ({
            label: `${entry.name} — 🪙${amount.toLocaleString()}`.slice(0, 100),
            description: `Back this dragon to win`.slice(0, 100),
            value: `${entry.dragonId}|${amount}`
        })))
        .slice(0, 25);

    if (betOptions.length && !due) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(id(ownerId, 'betpick'))
                .setPlaceholder('Bet credits on a dragon')
                .addOptions(betOptions)
        ));
    }

    const buttonRow = new ActionRowBuilder().addComponents(
        due
            ? new ButtonBuilder().setCustomId(id(ownerId, 'runrace')).setLabel('Run the race now').setEmoji('🏁').setStyle(ButtonStyle.Success)
            : new ButtonBuilder().setCustomId(id(ownerId, 'refresh')).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id(ownerId, 'main')).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
    );
    components.push(buttonRow);

    return { embed, components: components.slice(0, 5), file: null };
}

/* 🎁 Seasonal calendar — a claim-once-a-day gift while a season is live. */
function buildGift(ownerId, displayName) {
    const season = seasonal.getActiveSeason();
    const backRowOnly = [backRow(ownerId)];
    if (!season) {
        return {
            embed: new EmbedBuilder()
                .setColor(COLOR)
                .setTitle('🎁 SEASONAL EVENTS')
                .setDescription([
                    '**No seasonal event is running right now.**',
                    '',
                    'The grid celebrates on a calendar: Christmas runs Dec 1-25 with a gift every single day, Halloween runs Oct 25-31, summer doubles your yields, and New Year follows Christmas.',
                    '',
                    '_When a season opens, a gift button appears here and a notice is posted in the economy terminal._'
                ].join('\n')),
            components: backRowOnly,
            file: null
        };
    }

    const gift = seasonal.getDailyGift(season.id, season.dayIndex);
    const claimed = db.prepare('SELECT 1 FROM seasonal_claims WHERE userId = ? AND event = ? AND dayKey = ?')
        .get(ownerId, season.id, season.dateKey);
    const highlights = seasonal.getSeasonHighlights();
    const itemLines = (gift.items || []).length
        ? gift.items.map(item => `> 🎁 ${item.quantity}x ${item.itemId.replace(/_/g, ' ')}`).join('\n')
        : null;

    const embed = new EmbedBuilder()
        .setColor(0xff6b35)
        .setTitle(`${season.emoji} ${String(season.name).toUpperCase()} — DAY ${season.dayIndex}`)
        .setDescription([
            season.theme || 'The grid is dressed for the season.',
            '',
            `🎁 **Today's gift:** ${gift.label}`,
            gift.credits ? `> 🪙 ${Number(gift.credits).toLocaleString()} credits` : null,
            itemLines,
            gift.eggChance ? `> 🥚 A dragon egg may be inside (up to ${gift.eggRarity})` : null,
            '',
            claimed ? '✅ **Claimed today** — come back tomorrow for the next one.' : '🔔 **Not claimed yet today.**',
            '',
            `**Days remaining:** ${season.daysRemaining} · **Yield:** x${seasonal.getSeasonalMultiplier('yield')} · **Credits:** x${seasonal.getSeasonalMultiplier('credits').toFixed(2)}`,
            '',
            highlights.length ? highlights.join('\n') : null
        ].filter(Boolean).join('\n'));

    const components = [];
    if (season.dailyGift && !claimed) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(id(ownerId, 'claimgift')).setLabel('Claim today\'s gift').setEmoji('🎁').setStyle(ButtonStyle.Success)
        ));
    }
    components.push(backRow(ownerId));
    return { embed, components, file: null };
}

function buildRivalry(ownerId) {
    const standings = hatchery.getSideStandings();
    const dragons = hatchery.getDragonLeaderboard(10);
    const total = standings.good + standings.evil || 1;
    const goodPct = Math.round((standings.good / total) * 100);

    const embed = new EmbedBuilder()
        .setColor(0xff2d6f)
        .setTitle('⚔️ DRAGONFLIGHT vs ONSLAUGHT')
        .setDescription([
            `Season **${standings.season}**`,
            '',
            `${bar(goodPct, 20)}`,
            `🌌 **Dragonflight** ${standings.good} keepers · 🩸 **Onslaught** ${standings.evil} keepers`,
            `🥚 Eggs found: **${standings.eggs}** · 🐣 Hatched: **${standings.hatched}** · 🏁 Races won: **${standings.races}**`,
            '',
            '**🐉 STRONGEST PETS IN THE GRID**',
            dragons.length
                ? dragons.map((dragon, index) => {
                    const species = dragon.species || hatchery.SPECIES[dragon.speciesId] || {};
                    return `\`#${index + 1}\` ${species.emoji || '🐉'} **${dragon.name}** — Lv ${dragon.level} · ${species.side === 'evil' ? '🩸' : '🌌'} <@${dragon.userId}>`;
                }).join('\n')
                : '_Nobody has hatched anything yet. Be the first._'
        ].join('\n').slice(0, 3800));

    return { embed, components: [backRow(ownerId)], file: null };
}

function buildView(ownerId, displayName, view, args) {
    switch (view) {
        case 'dragons': return buildDragons(ownerId, displayName, args[0]);
        case 'eggs': return buildEggs(ownerId, displayName);
        case 'feed': return buildFeed(ownerId, displayName, args[0], args[1]);
        case 'quests': return buildQuests(ownerId);
        case 'badges': return buildBadges(ownerId);
        case 'titles': return buildTitles(ownerId);
        case 'race': return buildRace(ownerId);
        case 'gift': return buildGift(ownerId, displayName);
        case 'rivalry': return buildRivalry(ownerId);
        case 'main':
        default: return buildMain(ownerId, displayName);
    }
}

function payload(built) {
    return {
        embeds: [built.embed],
        components: built.components,
        files: built.file ? [built.file] : [],
        // Always clear old attachments when re-rendering the panel.
        attachments: []
    };
}

async function respond(interaction, built, { update = true } = {}) {
    const body = payload(built);
    try {
        // A deferred interaction can only be answered with editReply.
        if (!update || interaction.deferred || interaction.replied) return interaction.editReply(body);
        if (typeof interaction.update === 'function') return interaction.update(body);
        return interaction.editReply(body);
    } catch (error) {
        // The source message was deleted — fall back to a fresh reply.
        try {
            return interaction.followUp({ ...body, flags: 64 });
        } catch (fallbackError) {
            return null;
        }
    }
}

// ==================================================
// COMMAND
// ==================================================
module.exports = {
    data: new SlashCommandBuilder()
        .setName('profile')
        .setDescription('Your Dragon Hatchery: pets, eggs, quests, badges, titles and dragon racing')
        .addUserOption(option => option
            .setName('user')
            .setDescription('View another player\'s profile')
            .setRequired(false)),

    async execute(interaction) {
        await interaction.deferReply();
        const target = interaction.options.getUser('user') ?? interaction.user;
        ensureUser(target.id);
        const displayName = (target.displayName || target.username || 'Player').slice(0, 40);

        if (target.id !== interaction.user.id) {
            const built = buildMain(target.id, displayName);
            built.components = [];
            return interaction.editReply(payload(built));
        }

        const built = buildMain(target.id, displayName);
        return interaction.editReply(payload(built));
    },

    // ---------------------------------------------------------------
    // Component router — index.js routes every `dragon|` id here.
    // ---------------------------------------------------------------
    async handleComponent(interaction) {
        const pieces = part(interaction.customId);
        const ownerId = pieces[0];
        const action = pieces[1];
        const args = pieces.slice(2);

        if (!ownerId || !action) return;
        if (interaction.user.id !== ownerId) {
            return interaction.reply({
                content: '❌ This panel belongs to someone else — run `/profile` to open your own.',
                flags: 64
            });
        }
        ensureUser(ownerId);
        const displayName = (interaction.user.displayName || interaction.user.username || 'Player').slice(0, 40);

        // ---- Select menus -------------------------------------------------
        if (interaction.isStringSelectMenu()) {
            const value = interaction.values[0];
            if (action === 'open') {
                return respond(interaction, buildDragons(ownerId, displayName, value));
            }
            if (action === 'feeditem') {
                const [kind, foodId] = String(value).split('|');
                const dragonId = args[0];
                const qty = Math.max(1, Math.min(10, Number(args[1]) || 1));
                const result = hatchery.feedDragon(ownerId, dragonId, { kind, foodId, quantity: qty });
                const built = result.ok
                    ? feedResultView(ownerId, displayName, result, dragonId, qty)
                    : buildFeed(ownerId, displayName, dragonId, qty);
                if (!result.ok) built.embed.setDescription(`❌ ${result.message}\n\n${built.embed.data.description || ''}`);
                return respond(interaction, built);
            }
            if (action === 'titlepick') {
                const catalog = titles.listCatalog(ownerId);
                const title = catalog.find(entry => entry.id === value);
                if (!title) return respond(interaction, buildTitles(ownerId));
                if (title.owned) {
                    const result = titles.equipTitle(ownerId, title.id);
                    const built = buildTitles(ownerId);
                    if (!result.ok) built.embed.setDescription(`❌ ${result.message}\n\n${built.embed.data.description || ''}`);
                    return respond(interaction, built);
                }
                if (title.locked) {
                    const built = buildTitles(ownerId);
                    built.embed.setDescription(`🔒 **${title.name}** is locked — ${title.requirementText}\n\n${built.embed.data.description || ''}`);
                    return respond(interaction, built);
                }
                // Ungated purchase needs a confirmation click.
                const built = buildTitles(ownerId);
                built.embed.setDescription([
                    `🛒 **Buy ${title.name}?**`,
                    `Price: 🪙${Number(title.price).toLocaleString()}`,
                    `_${title.description || ''}_`,
                    '',
                    built.embed.data.description || ''
                ].join('\n'));
                built.components.unshift(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(id(ownerId, 'buy', title.id)).setLabel(`Confirm purchase — 🪙${Number(title.price).toLocaleString()}`.slice(0, 80)).setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(id(ownerId, 'titles')).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
                ));
                return respond(interaction, built);
            }
            if (action === 'enterpick') {
                const race = racing.getCurrentRace();
                if (!race) return respond(interaction, buildRace(ownerId));
                const result = racing.registerDragon(race.raceId, ownerId, Number(value));
                const built = buildRace(ownerId);
                if (!result.ok) built.embed.setDescription(`❌ ${result.message}\n\n${built.embed.data.description || ''}`);
                else built.embed.setDescription(`✅ **${hatchery.getDragon(Number(value))?.name || 'Your dragon'}** is on the grid.\n\n${built.embed.data.description || ''}`);
                return respond(interaction, built);
            }
            if (action === 'betpick') {
                const [dragonId, amount] = String(value).split('|');
                const race = racing.getCurrentRace();
                if (!race) return respond(interaction, buildRace(ownerId));
                const result = racing.placeBet(race.raceId, ownerId, Number(dragonId), Number(amount));
                const built = buildRace(ownerId);
                built.embed.setDescription(`${result.ok ? '✅' : '❌'} ${result.message || `Bet placed on ${hatchery.getDragon(Number(dragonId))?.name}.`}\n\n${built.embed.data.description || ''}`);
                return respond(interaction, built);
            }
            return;
        }

        // ---- Buttons ------------------------------------------------------
        switch (action) {
            case 'refresh':
                return respond(interaction, buildMain(ownerId, displayName));

            case 'dragons':
                return respond(interaction, buildDragons(ownerId, displayName));

            case 'eggs':
                return respond(interaction, buildEggs(ownerId, displayName));

            case 'quests':
                return respond(interaction, buildQuests(ownerId));

            case 'badges':
                return respond(interaction, buildBadges(ownerId));

            case 'titles':
                return respond(interaction, buildTitles(ownerId));

            case 'race':
                return respond(interaction, buildRace(ownerId));

            case 'rivalry':
                return respond(interaction, buildRivalry(ownerId));

            case 'gift':
                return respond(interaction, buildGift(ownerId, displayName));

            case 'claimgift': {
                const result = seasonal.claimDailyGift(ownerId);
                const built = buildGift(ownerId, displayName);
                built.embed.setDescription(`${result.ok ? `🎁 ${result.message}` : `❌ ${result.message}`}\n\n${built.embed.data.description || ''}`);
                if (result.ok) {
                    try {
                        quests.recordQuestEvent(ownerId, 'daily_claim', 1, { seasonal: true });
                    } catch (error) {
                        /* quests never block a gift */
                    }
                }
                return respond(interaction, built);
            }

            case 'main':
                return respond(interaction, buildMain(ownerId, displayName));

            case 'open':
                return respond(interaction, buildDragons(ownerId, displayName, args[0]));

            case 'active': {
                const result = hatchery.setActiveDragon(ownerId, Number(args[0]));
                const built = buildDragons(ownerId, displayName, args[0]);
                built.embed.setDescription(`${result.ok ? '⭐ Now active' : `❌ ${result.message}`}\n\n${built.embed.data.description || ''}`);
                return respond(interaction, built);
            }

            case 'feed':
                return respond(interaction, buildFeed(ownerId, displayName, args[0], args[1]));

            case 'train': {
                const result = hatchery.trainDragon(ownerId, Number(args[0]));
                const built = buildDragons(ownerId, displayName, args[0]);
                const line = result.ok
                    ? `🏋️ **+${result.gain} ${result.stat.toUpperCase()}** for 🪙${result.cost.toLocaleString()}${result.levelsGained.length ? ` — **LEVEL UP → ${result.levelsGained[result.levelsGained.length - 1]}**` : ''}`
                    : `⏳ ${result.message}`;
                built.embed.setDescription(`${line}\n\n${built.embed.data.description || ''}`);
                return respond(interaction, built);
            }

            case 'play': {
                const result = hatchery.playWithDragon(ownerId, Number(args[0]));
                const built = buildDragons(ownerId, displayName, args[0]);
                const line = result.ok
                    ? `🎾 Your dragon ${result.line} **+${result.happiness} mood**${result.levelsGained.length ? ` — **LEVEL UP → ${result.levelsGained[result.levelsGained.length - 1]}**` : ''}`
                    : `⏳ ${result.message}`;
                built.embed.setDescription(`${line}\n\n${built.embed.data.description || ''}`);
                return respond(interaction, built);
            }

            case 'rename': {
                const dragon = hatchery.getDragon(Number(args[0]));
                if (!dragon || dragon.userId !== ownerId) return respond(interaction, buildDragons(ownerId, displayName));
                const modal = new ModalBuilder()
                    .setCustomId(id(ownerId, 'renamego', dragon.dragonId))
                    .setTitle(`Rename ${dragon.name}`.slice(0, 45))
                    .addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('name')
                            .setLabel('New name (2-24 characters)')
                            .setStyle(TextInputStyle.Short)
                            .setMaxLength(24)
                            .setRequired(true)
                    ));
                return interaction.showModal(modal);
            }

            case 'release': {
                const dragon = hatchery.getDragon(Number(args[0]));
                if (!dragon || dragon.userId !== ownerId) return respond(interaction, buildDragons(ownerId, displayName));
                const embed = new EmbedBuilder()
                    .setColor(0xff5577)
                    .setTitle('🕊️ RELEASE THIS PET?')
                    .setDescription([
                        `You are about to release **${dragon.name}** (Lv ${dragon.level}, ${style(dragon.rarity).label}).`,
                        '',
                        'You receive a partial credit refund scaled by level. This cannot be undone.'
                    ].join('\n'));
                return respond(interaction, {
                    embed,
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(id(ownerId, 'releaseyes', dragon.dragonId)).setLabel('Yes, release').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId(id(ownerId, 'open', dragon.dragonId)).setLabel('Keep').setStyle(ButtonStyle.Secondary)
                    )],
                    file: null
                });
            }

            case 'releaseyes': {
                const result = hatchery.releaseDragon(ownerId, Number(args[0]));
                const built = buildDragons(ownerId, displayName);
                built.embed.setDescription(`${result.ok ? `🕊️ **${result.name}** flew off into the grid — 🪙${Number(result.refund).toLocaleString()} returned to your wallet.` : `❌ ${result.message}`}\n\n${built.embed.data.description || ''}`);
                return respond(interaction, built);
            }

            case 'incubate': {
                const eggId = Number(args[0]);
                const slot = Number(args[1]);
                const result = hatchery.startIncubation(ownerId, eggId, slot);
                const built = buildEggs(ownerId, displayName);
                if (!result.ok) built.embed.setDescription(`❌ ${result.message}\n\n${built.embed.data.description || ''}`);
                else {
                    const hours = Math.round((result.incubateMs || 0) / 3_600_000);
                    built.embed.setDescription(`🌡️ Egg is incubating in slot ${slot + 1} — about **${hours}h** to go (<t:${Math.ceil(result.endsAt / 1000)}:R>).\n\n${built.embed.data.description || ''}`);
                }
                return respond(interaction, built);
            }

            case 'unlock': {
                const slot = Number(args[0]);
                const result = hatchery.unlockIncubator(ownerId, slot);
                const built = buildEggs(ownerId, displayName);
                built.embed.setDescription(`${result.ok ? `🔓 Incubator ${slot + 1} unlocked${result.price ? ` for 🪙${result.price.toLocaleString()}` : ''}.` : `❌ ${result.message}`}\n\n${built.embed.data.description || ''}`);
                return respond(interaction, built);
            }

            case 'accel': {
                const eggId = Number(args[0]);
                const itemId = hatchery.ITEMS.INCUBATION_ACCELERATOR;
                const inventory = require('../systems/economy/shopItems');
                const owned = inventory.getItemQuantity(ownerId, itemId);
                const built = buildEggs(ownerId, displayName);
                if (owned <= 0) {
                    built.embed.setDescription(`❌ You have no **Incubation Accelerator** — buy one from \`/shop\` (each shaves 6 hours off an egg).\n\n${built.embed.data.description || ''}`);
                    return respond(interaction, built);
                }
                const result = hatchery.accelerateIncubation(ownerId, eggId, 6);
                if (result.ok) inventory.removeItem(ownerId, itemId, 1);
                built.embed.setDescription(`${result.ok ? `⚡ Acceleration applied — ${result.ready ? '**READY TO HATCH NOW**' : `<t:${Math.ceil(result.endsAt / 1000)}:R> remaining`}.` : `❌ ${result.message}`}\n\n${built.embed.data.description || ''}`);
                return respond(interaction, built);
            }

            case 'hatch':
                return runHatchSequence(interaction, ownerId, displayName, Number(args[0]));

            case 'claim': {
                const result = quests.claimQuest(ownerId, args[0], args[1] || 'daily');
                const built = buildQuests(ownerId);
                const badgeLine = result.ok && result.badges?.length
                    ? `\n🏅 New badges: ${result.badges.map(badge => `${badge.emoji} ${badge.name}`).join(', ')}`
                    : '';
                built.embed.setDescription(`${result.ok ? `✅ ${result.message}` : `❌ ${result.message}`}${badgeLine}\n\n${built.embed.data.description || ''}`);
                return respond(interaction, built);
            }

            case 'buy': {
                const result = titles.purchaseTitle(ownerId, args[0]);
                const built = buildTitles(ownerId);
                built.embed.setDescription(`${result.ok ? `🎖️ ${result.message || `You bought and equipped **${args[0]}**.`}` : `❌ ${result.message}`}\n\n${built.embed.data.description || ''}`);
                return respond(interaction, built);
            }

            case 'unequip': {
                const result = titles.unequipTitle(ownerId);
                const built = buildTitles(ownerId);
                built.embed.setDescription(`${result.ok ? '🚫 Title removed.' : `❌ ${result.message || 'Nothing equipped.'}`}\n\n${built.embed.data.description || ''}`);
                return respond(interaction, built);
            }

            case 'runrace': {
                const race = racing.getCurrentRace();
                if (!race) return respond(interaction, buildRace(ownerId));
                const result = racing.settleIfDue();
                const built = buildRace(ownerId);
                if (!result) {
                    built.embed.setDescription(`⚠️ The race is not due yet.\n\n${built.embed.data.description || ''}`);
                    return respond(interaction, built);
                }
                const standings = result.standings || [];
                built.embed.setDescription([
                    `🏁 **${result.winner?.name || 'A dragon'}** takes the ${racing.getTrack(result.trackId)?.name || 'circuit'}!`,
                    '',
                    ...standings.slice(0, 5).map((entry, index) => `\`#${index + 1}\` ${entry.name} — ${Number(entry.time || 0).toFixed(2)}s`),
                    '',
                    ...(result.log || []).slice(-4)
                ].join('\n').slice(0, 3500));
                return respond(interaction, built);
            }

            default:
                return;
        }
    },

    // ---------------------------------------------------------------
    // Modal router (`dragon|` + 'rename|')
    // ---------------------------------------------------------------
    async handleModal(interaction) {
        const pieces = part(interaction.customId);
        const ownerId = pieces[0];
        const action = pieces[1];
        if (action !== 'renamego') return;
        const dragonId = Number(pieces[2]);
        const name = interaction.fields.getTextInputValue('name');
        const result = hatchery.renameDragon(ownerId, dragonId, name);
        const displayName = (interaction.user.displayName || interaction.user.username || 'Player').slice(0, 40);
        const built = buildDragons(ownerId, displayName, dragonId);
        built.embed.setDescription(`${result.ok ? `✏️ Renamed to **${result.name}**.` : `❌ ${result.message}`}\n\n${built.embed.data.description || ''}`);
        return respond(interaction, built);
    }
};

// ==================================================
// FEED RESULT VIEW
// ==================================================
function feedResultView(ownerId, displayName, result, dragonId, qty) {
    const dragon = result.dragon;
    const species = hatchery.SPECIES[dragon.speciesId] || null;
    const progress = result.progress || progressOf(dragon);
    const levelLine = result.levelsGained?.length
        ? `\n\n🎉 **LEVEL UP!** ${dragon.name} is now **level ${result.levelsGained[result.levelsGained.length - 1]}**.`
        : '';

    const embed = new EmbedBuilder()
        .setColor(dragon.side === 'evil' ? 0xff2d6f : 0x00e5a8)
        .setTitle(`🍖 ${String(result.foodName).toUpperCase()} EATEN`)
        .setDescription([
            `**${dragon.name}** ate **${result.consumed}× ${result.foodName}** (${result.rarity}).`,
            '',
            `✨ XP gained: **+${result.xp.toLocaleString()}**`,
            `❤️ Hunger: **${dragon.hunger}%** · 😊 Mood: **${dragon.happiness}%**`,
            `📈 Level **${progress.level}** — ${progress.maxed ? 'MAX LEVEL' : `${progress.xp}/${progress.needed} XP`}`,
            levelLine
        ].join('\n'))
        .setFooter({ text: 'Keep feeding — a happy pet gives a much bigger passive bonus' });

    const file = render.renderDragonCard({
        dragon,
        species,
        trait: hatchery.TRAITS[dragon.trait],
        trait2: dragon.trait2 ? hatchery.TRAITS[dragon.trait2] : null,
        progress,
        owner: displayName,
        side: dragon.side
    });

    return {
        embed,
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(id(ownerId, 'feed', dragonId, qty)).setLabel('Feed again').setEmoji('🍖').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(id(ownerId, 'play', dragonId)).setLabel('Play').setEmoji('🎾').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(id(ownerId, 'open', dragonId)).setLabel('View pet').setEmoji('🐉').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(id(ownerId, 'main')).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
        )],
        file
    };
}

// ==================================================
// THE HATCH SEQUENCE
// ==================================================
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runHatchSequence(interaction, ownerId, displayName, eggId) {
    const egg = hatchery.getEgg(eggId);
    if (!egg || egg.userId !== ownerId) {
        return respond(interaction, buildEggs(ownerId, displayName));
    }

    const ready = hatchery.readyEggs(ownerId).some(candidate => Number(candidate.eggId) === eggId);
    if (!ready) {
        const built = buildEggs(ownerId, displayName);
        const progress = hatchery.incubationProgress(egg);
        built.embed.setDescription(`⏳ That egg is still incubating — ready <t:${Math.ceil(progress.end / 1000)}:R>.\n\n${built.embed.data.description || ''}`);
        return respond(interaction, built);
    }

    const type = hatchery.EGG_TYPES[egg.eggType];
    const rarityStyle = style(egg.rarity);

    // Acknowledge first: the animation runs for several seconds.
    try {
        await interaction.deferUpdate();
    } catch (error) {
        return null;
    }

    const frames = render.HATCH_FRAMES || [];
    for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index];
        const attachment = render.renderEggFrame({
            eggType: type,
            rarityColor: rarityStyle.color,
            side: egg.side,
            frameIndex: index,
            owner: `@${displayName}`,
            progressPct: frame.crack
        });
        const embed = new EmbedBuilder()
            .setColor(rarityStyle.color)
            .setTitle(`🥚 HATCHING — ${String(type?.name || 'EGG').toUpperCase()}`)
            .setDescription([
                `> ${String(frame.caption || '').replace(/_/g, '*')}`,
                '',
                `\`${'▰'.repeat(Math.round(frame.crack * 14))}${'▱'.repeat(14 - Math.round(frame.crack * 14))}\` ${Math.round(frame.crack * 100)}%`,
                `_${type?.blurb || ''}_`
            ].join('\n'))
            .setFooter({ text: `Frame ${index + 1}/${frames.length} · hold on` });

        await interaction.editReply({
            embeds: [embed],
            components: [],
            files: attachment ? [attachment] : [],
            attachments: []
        }).catch(() => {});
        await delay(index >= frames.length - 2 ? 420 : 560);
    }

    // Now actually hatch it.
    const result = hatchery.hatchEgg(ownerId, eggId);
    if (!result.ok) {
        const built = buildEggs(ownerId, displayName);
        built.embed.setDescription(`❌ ${result.message}\n\n${built.embed.data.description || ''}`);
        return respond(interaction, built, { update: false });
    }

    const dragon = result.dragon;
    const species = result.species;
    const progress = progressOf(dragon);
    const first = hatchery.TRAITS[dragon.trait];
    const second = dragon.trait2 ? hatchery.TRAITS[dragon.trait2] : null;
    const questEvent = quests.recordQuestEvent(ownerId, 'dragon_hatch', 1, { speciesId: species.id, side: species.side });

    const card = render.renderDragonCard({
        dragon,
        species,
        trait: first,
        trait2: second,
        progress,
        owner: `@${displayName}`,
        side: dragon.side
    });

    const apexLine = species.id === 'knightfury'
        ? '\n\n🌌 **KNIGHTFURY.** The apex of the Dragonflight answers to you now. The whole grid felt that.'
        : species.id === 'bloodmaw'
            ? '\n\n🩸 **BLOODMAW.** The apex beast of the Onslaught has chosen you. God help the grid.'
            : species.rarity === 'legendary'
                ? '\n\n✨ A **legendary** bloodline just hatched. That is genuinely rare.'
                : '';

    const badgeLine = questEvent?.badges?.length
        ? `\n🏅 New badges: ${questEvent.badges.map(badge => `${badge.emoji} ${badge.name}`).join(', ')}`
        : '';

    const embed = new EmbedBuilder()
        .setColor(species.side === 'evil' ? 0xff2d6f : rarityStyle.color)
        .setTitle(`✨ ${String(species.name).toUpperCase()} HAS HATCHED`)
        .setDescription([
            `**${dragon.name}** broke out of the ${type?.name || 'egg'}.`,
            '',
            `**Side:** ${species.side === 'evil' ? '🩸 Onslaught beast' : '🌌 Dragonflight dragon'}`,
            `**Rarity:** ${rarityStyle.emoji} ${rarityStyle.label}`,
            `**Traits:** ${[first, second].filter(Boolean).map(trait => `${trait.emoji} ${trait.name}`).join(' · ') || 'none'}`,
            `**Stats:** ⚔️ ${dragon.power} · 💨 ${dragon.speed} · 🛡️ ${dragon.stamina}`,
            `**Passive:** ${[first, second].filter(Boolean).map(trait => {
                const entries = Object.entries(trait.bonus).map(([key, value]) => `${key.replace(/_/g, ' ')} +${Math.round(value * 100)}%`);
                return entries.join(', ');
            }).join(' · ') || 'none'}`,
            '',
            `_${species.lore || ''}_${apexLine}${badgeLine}`
        ].join('\n'))
        .setFooter({ text: dragon.active ? '⭐ This pet is now active — its bonus applies immediately' : 'Set it active to start earning its passive bonus' });

    return interaction.editReply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(id(ownerId, 'open', dragon.dragonId)).setLabel('View card').setEmoji('🐉').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(id(ownerId, 'feed', dragon.dragonId, 1)).setLabel('Feed it').setEmoji('🍖').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(id(ownerId, 'eggs')).setLabel('More eggs').setEmoji('🥚').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(id(ownerId, 'main')).setLabel('Profile').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)
        )],
        files: card ? [card] : [],
        attachments: []
    }).catch(() => null);
}
