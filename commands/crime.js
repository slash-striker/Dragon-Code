const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const {
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');

const crimecore = require('../systems/economy/crime/crimeCore');
const heistManager = require('../systems/economy/crime/heistManager');
const heistTiers = require('../systems/economy/crime/heistTiers');
const dragonManager = require('../systems/dragons/dragonManager');
const questManager = require('../systems/economy/questManager');
const { logTransaction } = require('../systems/economy/transactionLogger');
const db = require('../database');
const {
    getColor,
    formatTitle,
    formatFieldName,
    formatButtonLabel,
    isHighTech
} = require('../systems/economy/uiStyleHelper');

const ALLOWED_CHANNEL = '1504562791967756448';

/* Composition summary for the lobby: who has which role vs. what the tier needs. */
function compositionLines(heist) {
    if (!heist?.heistId) return { lines: [], check: null };
    const tier = heistTiers.getTier(heist.tier || 'standard');
    const players = heistManager.getParticipantsDetailed(heist.heistId);
    const check = heistTiers.checkComposition(tier.id, players);
    const lines = [
        `${tier.emoji || '🏦'} **${tier.name}** — needs **${tier.requiredPlayers}** crew`,
        `👥 Crew: ${players.length}/${tier.requiredPlayers}`
    ];
    const roleCounts = check.roleCounts || {};
    for (const [roleId, role] of Object.entries(heistTiers.ROLES)) {
        const need = (tier.rolePlan || {})[roleId] || 0;
        if (need <= 0) continue;
        const have = roleCounts[roleId] || 0;
        lines.push(`${role.emoji} ${role.name}: **${have}/${need}**${have >= need ? ' ✅' : ' ❌'}`);
    }
    if (players.length) {
        lines.push('', players.map(player => {
            const role = player.role ? heistTiers.ROLES[player.role] : null;
            return `• <@${player.userId}> — ${role ? `${role.emoji} ${role.name}` : '🚫 no role picked'}`;
        }).join('\n'));
    }
    return { lines, check };
}

function hud(heist, userId) {
    const players = heist?.heistId
        ? heistManager.getParticipants(heist.heistId)
        : [];
    const composition = compositionLines(heist);
    const useHighTech = isHighTech(userId);

    return new EmbedBuilder()
        .setColor(getColor(userId))
        .setTitle(formatTitle(userId, "🧠 NEURAL CRIME TERMINAL v3.0", "Crime Interface"))
        .setDescription(useHighTech
            ? [
                "```diff",
                "+ DARKNET LINK ACTIVE",
                "- TRACE PROTOCOLS ENABLED",
                "```",
                "",
                `📡 STATUS: ${heist ? "ACTIVE LOBBY" : "IDLE"}`,
                `👥 PLAYERS: ${players.length}/${heist?.maxPlayers || 0}`,
                `🆔 LOBBY: ${heist?.heistId || "NONE"}`,
                "",
                ...(composition.lines.length ? composition.lines : []),
                "",
                "⚠️ HIGH RISK OPERATION SYSTEM ONLINE"
            ].join("\n")
            : [
                `**Status:** ${heist ? "Active Lobby" : "Idle"}`,
                `**Players:** ${players.length}/${heist?.maxPlayers || 0}`,
                `**Lobby ID:** ${heist?.heistId || "None"}`,
                "",
                ...(composition.lines.length ? composition.lines : []),
                "",
                "⚠️ High risk operation"
            ].join("\n")
        );
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('crime')
        .setDescription('Neural crime interface'),

    async execute(interaction) {

        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({ content: "❌ Wrong channel" });
        }

        let heist = heistManager.findOpenHeist?.();

        const useHighTech = isHighTech(interaction.user.id);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("solo").setLabel(formatButtonLabel(interaction.user.id, "SOLO RUN", "Solo Run")).setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("create").setLabel(formatButtonLabel(interaction.user.id, "CREATE HEIST", "Create Heist")).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("join").setLabel(formatButtonLabel(interaction.user.id, "JOIN HEIST", "Join Heist")).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("start").setLabel(formatButtonLabel(interaction.user.id, "START HEIST", "Start Heist")).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("cancel").setLabel(formatButtonLabel(interaction.user.id, "CANCEL", "Cancel")).setStyle(ButtonStyle.Secondary)
        );

        /* Escalation tiers + crew roles. The tier picker switches the whole
           lobby (payout, head-count, required roles); the role picker is how a
           member claims hacker / driver / muscle. */
        let selectedTier = heist?.tier || 'standard';

        const tierRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('heist-tier')
                .setPlaceholder('Escalation tier (leader only)')
                .addOptions(Object.values(heistTiers.TIERS).map(tier => new StringSelectMenuOptionBuilder()
                    .setLabel(`${tier.name} — ${tier.requiredPlayers} players`.slice(0, 100))
                    .setValue(tier.id)
                    .setDescription(`Payout ${Math.round(tier.basePayout).toLocaleString()} · ${tier.risk || 'risk'} risk`.slice(0, 100))
                    .setDefault(tier.id === selectedTier)))
        );
        const roleRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('heist-role')
                .setPlaceholder('Claim your crew role')
                .addOptions(Object.values(heistTiers.ROLES).map(role => new StringSelectMenuOptionBuilder()
                    .setLabel(`${role.name}`.slice(0, 100))
                    .setValue(role.id)
                    .setDescription(String(role.description || '').slice(0, 100))))
        );

        const msg = await interaction.reply({
            embeds: [hud(heist, interaction.user.id)],
            components: [row, tierRow, roleRow],
            fetchReply: true
        });

        const filter = i => ['solo', 'create', 'join', 'start', 'cancel'].includes(i.customId)
            || ['heist-tier', 'heist-role'].includes(i.customId);
        const collector = msg.createMessageComponentCollector({ filter, time: 120000 });

        collector.on('collect', async (btn) => {

            /* ============ TIER PICKER (leader only) ============ */
            if (btn.customId === 'heist-tier') {
                if (!heist) return btn.reply({ content: 'Create a heist lobby first, then pick its tier.', flags: 64 });
                if (heist.leaderId !== btn.user.id) return btn.reply({ content: 'Only the heist leader can change the tier.', flags: 64 });
                const tier = heistTiers.getTier(btn.values[0]);
                selectedTier = tier.id;
                heistManager.setHeistTier(heist.heistId, tier.id, tier.rolePlan, tier.requiredPlayers, tier.target || 'vault');
                heist = heistManager.getHeist(heist.heistId);
                try { db.prepare('DELETE FROM heist_participants WHERE heistId = ? AND userId NOT IN (SELECT userId FROM heist_participants WHERE heistId = ? LIMIT ?)').run(heist.heistId, heist.heistId, tier.requiredPlayers); } catch (error) { /* over-cap crew is trimmed best-effort */ }
                return btn.update({ embeds: [hud(heist, btn.user.id)], components: [row, tierRow, roleRow] });
            }

            /* ============ CREW ROLE PICKER (any member) ============ */
            if (btn.customId === 'heist-role') {
                if (!heist) return btn.reply({ content: 'No open lobby — join a heist first.', flags: 64 });
                const participants = heistManager.getParticipants(heist.heistId);
                if (!participants.some(player => player.userId === btn.user.id)) {
                    heistManager.addParticipant(heist.heistId, btn.user.id);
                }
                heistManager.setParticipantRole(heist.heistId, btn.user.id, btn.values[0]);
                heist = heistManager.getHeist(heist.heistId);
                return btn.update({ embeds: [hud(heist, btn.user.id)], components: [row, tierRow, roleRow] });
            }

            /* ================= SOLO ================= */
            if (btn.customId === "solo") {

                const useHighTech = isHighTech(btn.user.id);
                const steps = useHighTech
                    ? [
                        "🧠 INITIALIZING NEURAL LINK...",
                        "📡 SCANNING DARKNET NODES...",
                        "🔐 BYPASSING FIREWALL LAYER 1...",
                        "🧬 INJECTING PAYLOAD...",
                        "⚠️ DETECTING COUNTER-TRACE SIGNAL..."
                    ]
                    : [
                        "Initializing...",
                        "Scanning...",
                        "Bypassing security...",
                        "Injecting payload...",
                        "Detecting counter-measures..."
                    ];

                let msg = await btn.update({
                    content: steps[0],
                    embeds: [],
                    components: []
                });

                for (let i = 1; i < steps.length; i++) {
                    await new Promise(r => setTimeout(r, 900));
                    await interaction.editReply({ content: steps[i] });
                }

                await new Promise(r => setTimeout(r, 900));

                // suspense layer
                await interaction.editReply({
                    content: useHighTech
                        ? "🎰 FINALIZING BREACH...\n" +
                          "📦 DECODING OUTCOME...\n" +
                          "⚡ REVEALING RESULT NODE..."
                        : "Finalizing breach...\n" +
                          "Decoding outcome...\n" +
                          "Revealing result..."
                });

                await new Promise(r => setTimeout(r, 1200));

                const result = await crimecore.runSolo(btn.user.id);

                if (result.type === "cooldown") {
                    const cooldownEmbed = new EmbedBuilder()
                        .setColor(getColor(btn.user.id, result.color))
                        .setTitle(formatTitle(btn.user.id, "⏳ CRIME COOLDOWN ACTIVE", "Crime Cooldown"))
                        .setDescription(useHighTech
                            ? `**SYSTEM HOLD**\n\n${result.message}\n\n⏱️ **Next available:** ${result.cooldownDisplay}`
                            : `**${result.message}**\n\nNext available: ${result.cooldownDisplay}`)
                        .addFields({
                            name: formatFieldName(btn.user.id, "📊 System Log", "System Log"),
                            value: useHighTech ? "`COOLDOWN SIGNAL DETECTED`" : "Please try again after the cooldown expires.",
                            inline: false
                        })
                        .setFooter({ text: useHighTech ? "NEURAL CRIME TERMINAL • COOLDOWN LOCK" : "Crime System" });

                    return interaction.editReply({
                        content: null,
                        embeds: [cooldownEmbed],
                        components: []
                    });
                }

                const isWin = result.reward > 0;

                // 📋 Quest board hook — a profitable solo run counts as a crime win.
                if (isWin) {
                    try {
                        questManager.recordQuestEvent(btn.user.id, 'crime_win', 1, { payment: result.reward });
                    } catch (error) {
                        console.error('Crime quest hook failed:', error.message);
                    }
                }

                const embed = new EmbedBuilder()
                    .setColor(getColor(btn.user.id, isWin ? 0x00ff88 : 0xff3355))
                    .setTitle(formatTitle(btn.user.id, isWin ? "💰 BREACH SUCCESSFUL" : "💀 OPERATION FAILED", isWin ? "Breach Successful" : "Operation Failed"))
                    .setDescription(useHighTech
                        ? [
                            "```diff",
                            `${isWin ? "+" : "-"} OUTCOME: ${result.message}`,
                            `${isWin ? "+" : "-"} CASH FLOW: ${result.reward}`,
                            `${isWin ? "+" : "-"} RISK CLASS: ${result.type}`,
                            "```"
                        ].join("\n")
                        : `**Outcome:** ${result.message}\n**Cash Flow:** ${result.reward}\n**Risk Class:** ${result.type}`
                    )
                    .addFields(
                        {
                            name: formatFieldName(btn.user.id, "📊 System Log", "System Log"),
                            value: isWin
                                ? "`NODE COMPROMISED — EXTRACTION COMPLETE`"
                                : "`TRACE DETECTED — CONNECTION TERMINATED`",
                            inline: false
                        },
                        {
                            name: formatFieldName(btn.user.id, "🧠 Neural Status", "Status"),
                            value: isWin
                                ? "`STABLE BREACH CHANNEL OPEN`"
                                : "`SECURITY ALERT FLAGGED`",
                            inline: false
                        }
                    )
                    .setFooter({ text: useHighTech ? "NEURAL SCRATCH ENGINE v2.4" : "Crime System" });

                return interaction.editReply({
                    content: null,
                    embeds: [embed],
                    components: []
                });
            }

            /* ================= JOIN HEIST ================= */
            if (btn.customId === "join") {

                if (!heist) {
                    return btn.reply({ content: "No open heist lobby exists yet. Ask someone to create one." });
                }
                if (heist.status !== 'lobby') {
                    return btn.reply({ content: "That heist has already started. Wait for the next lobby." });
                }

                const currentParticipants = heistManager.getParticipants(heist.heistId);
                if (currentParticipants.some(player => player.userId === btn.user.id)) {
                    return btn.reply({ content: "You are already in this heist." });
                }
                if (currentParticipants.length >= heist.maxPlayers) {
                    return btn.reply({ content: "This heist is full. Start it or wait for a new lobby." });
                }
                heistManager.addParticipant(heist.heistId, btn.user.id);
                // Joiners default to muscle so a lobby is never blocked on role choice.
                heistManager.setParticipantRole(heist.heistId, btn.user.id, 'muscle');

                heist = heistManager.getHeist(heist.heistId);

                return btn.update({
                    embeds: [hud(heist, btn.user.id)],
                    components: [row, tierRow, roleRow]
                });
            }

            /* ================= CREATE HEIST ================= */
            if (btn.customId === "create") {
                if (heist) {
                    return btn.reply({ content: `An open lobby already exists (${heist.heistId}). Join it instead.` });
                }
                const tier = heistTiers.getTier(selectedTier);
                heist = heistManager.createHeist({
                    heistId: `HX-${Date.now()}`,
                    leaderId: btn.user.id,
                    maxPlayers: tier.requiredPlayers,
                    difficulty: tier.id,
                    tier: tier.id,
                    target: tier.target || 'vault',
                    rolePlan: tier.rolePlan
                });
                heistManager.addParticipant(heist.heistId, btn.user.id);
                heistManager.setParticipantRole(heist.heistId, btn.user.id, 'hacker');
                heist = heistManager.getHeist(heist.heistId);
                return btn.update({
                    embeds: [hud(heist, btn.user.id)],
                    components: [row, tierRow, roleRow]
                });
            }

            /* ================= START HEIST ================= */
            if (btn.customId === "start") {

                if (!heist) return btn.reply({ content: "No active heist lobby. Use Join Heist to create one." });

                if (heist.leaderId !== btn.user.id)
                    return btn.reply({ content: "Only the heist leader can start this operation." });

                const tier = heistTiers.getTier(heist.tier || selectedTier);
                const crew = heistManager.getParticipantsDetailed(heist.heistId);

                if (crew.length < 2)
                    return btn.reply({ content: "At least 2 players are required. Invite someone to join, then start the heist.", flags: 64 });

                /* Under-staffed runs are ALLOWED to launch — they just fail
                   hilariously, which is the whole point of the escalation. */
                heistManager.setHeistStatus(heist.heistId, "running");

                await btn.update({
                    content: `🚨 **${tier.name}** LAUNCHING...`,
                    embeds: [],
                    components: []
                });

                const result = heistTiers.resolveHeist({ tierId: tier.id, participants: crew });

                if (!result.success) {
                    // Regroup: the lobby closes and the crew walks away with nothing but a story.
                    heistManager.recordResolution(heist.heistId, 'failed', 0, result.log || []);
                    heistManager.cancelHeist(heist.heistId);
                    const failEmbed = new EmbedBuilder()
                        .setColor(0xff3355)
                        .setTitle('💀 HEIST FAILED — CREW INCOMPLETE')
                        .setDescription([
                            result.funny || 'The plan fell apart before it started.',
                            '',
                            ...(result.log || []).map(line => `> ${line}`),
                            '',
                            `**Needed:** ${tier.requiredPlayers} crew for **${tier.name}** — you had ${result.have ?? crew.length}.`,
                            (result.missing || []).length
                                ? `**Missing roles:** ${result.missing.map(entry => `${heistTiers.ROLES[entry.role]?.emoji || '❔'} ${entry.role} ×${entry.need - entry.have}`).join(', ')}`
                                : null,
                            '',
                            '_Nobody was charged — the entry fee is zero. Regroup and try again._'
                        ].filter(Boolean).join('\n'))
                        .setFooter({ text: 'NEURAL CRIME TERMINAL • failed operation logged' });
                    return interaction.followUp({ embeds: [failEmbed] }).catch(() => {});
                }

                /* ---------- SUCCESS: pay the crew ---------- */
                const paid = [];
                let totalPaid = 0;
                for (const member of crew) {
                    const petBonus = dragonManager.getDragonBonus(member.userId, 'heist_payout');
                    const share = Math.max(0, Math.floor((result.perPlayer || 0) * (1 + petBonus)));
                    if (share <= 0) continue;
                    try {
                        db.transaction(() => {
                            db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(member.userId);
                            db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(share, member.userId);
                            db.prepare('UPDATE heist_participants SET contribution = contribution + ? WHERE heistId = ? AND userId = ?')
                                .run(share, heist.heistId, member.userId);
                        })();
                        logTransaction(member.userId, 'heist_payout', share, `${tier.name} heist payout${petBonus > 0 ? ` (+${(petBonus * 100).toFixed(1)}% pet bonus)` : ''}`);
                        paid.push({ userId: member.userId, share, petBonus });
                        totalPaid += share;

                        questManager.recordQuestEvent(member.userId, 'heist_win', 1, { tier: tier.id });
                        questManager.awardBadge(member.userId, 'heist_legend');

                        /* 🥚 A clean score is the best egg source in the game. */
                        const tierScore = Math.max(0, heistTiers.TIERS.findIndex(entry => entry.id === tier.id));
                        const egg = dragonManager.rollEggDrop(member.userId, { source: 'heist', tierScore });
                        if (egg) {
                            const eggType = dragonManager.EGG_TYPES[egg.eggType];
                            paid[paid.length - 1].egg = eggType?.name || egg.eggType;
                        }
                    } catch (error) {
                        console.error('Heist payout failed for', member.userId, error.message);
                    }
                }

                heistManager.recordResolution(heist.heistId, 'completed', totalPaid, result.log || []);
                heistManager.cancelHeist(heist.heistId);

                const winEmbed = new EmbedBuilder()
                    .setColor(0x00e5a8)
                    .setTitle(`🏦 ${String(tier.name).toUpperCase()} — CLEAN GETAWAY`)
                    .setDescription([
                        ...(result.log || []).map(line => `> ${line}`),
                        '',
                        `**Total lifted:** 🪙${totalPaid.toLocaleString()} across ${paid.length} crew.`,
                        ...paid.map(entry => `<@${entry.userId}> — 🪙${entry.share.toLocaleString()}${entry.petBonus > 0 ? ` (🐉 +${(entry.petBonus * 100).toFixed(1)}%)` : ''}${entry.egg ? ` · 🥚 **${entry.egg}**` : ''}`)
                    ].join('\n'))
                    .setFooter({ text: 'NEURAL CRIME TERMINAL • operation complete' });

                return interaction.followUp({ embeds: [winEmbed] }).catch(() => {});
            }

            /* ================= CANCEL ================= */
            if (btn.customId === "cancel") {

                if (!heist) return btn.reply({ content: "No active heist lobby to cancel." });

                if (heist.leaderId !== btn.user.id)
                    return btn.reply({ content: "Only the heist leader can cancel this lobby." });

                heistManager.cancelHeist(heist.heistId);

                return btn.update({
                    content: "🛑 HEIST TERMINATED",
                    embeds: [],
                    components: []
                });
            }
        });
    }
};