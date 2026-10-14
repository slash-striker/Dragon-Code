const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { getUser, updateUser } = require('../systems/economy/userManager');
const { getItemQuantity, removeItem } = require('../systems/economy/shopItems');
const { logTransaction } = require('../systems/economy/transactionLogger');
const dragonManager = require('../systems/dragons/dragonManager');
const questManager = require('../systems/economy/questManager');
const bountyManager = require('../systems/economy/bountyManager');
const { setCooldown, getRemainingTime, formatRemainingTime } = require('../systems/economy/cooldownManager');
const { getColor, formatTitle, formatFieldName, formatButtonLabel, isHighTech } = require('../systems/economy/uiStyleHelper');
const db = require('../database');

/*
 * /rob — unified crime command (formerly /rob-player + /rob-bank).
 *
 *   /rob type:player target:<user>   → solo wallet robbery (old /rob-player)
 *   /rob type:bank   target:<user>   → team bank heist with buttons (old /rob-bank)
 *
 * Uses a required choice option instead of subcommands so Discord shows a
 * single "/rob" entry with a bank/player selector. Cooldown keys are
 * unchanged (rob_player / rob_bank), so existing cooldowns and the 10062
 * rollback mapping keep working.
 */

const ALLOWED_CHANNEL = '1504562791967756448';
const ROB_COST = 3000;
const MIN_TARGET_BALANCE = 300;
const COST_PER_PLAYER = 5000;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const HEIST_DURATION = 5 * 60 * 1000; // 5 minutes
const SLASHDRAGON_ID = '1505829367631183963';

// Store active heists
const activeHeists = new Map();

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/* =========================
   /rob PLAYER — solo wallet robbery (was /rob-player)
========================= */

async function runRobPlayer(interaction) {
    if (interaction.channelId !== ALLOWED_CHANNEL) {
        return interaction.editReply({
            content: `❌ You can only use this in <#${ALLOWED_CHANNEL}>.` });
    }

    const target = interaction.options.getUser('target');
    const robber = interaction.user;

    if (!target) {
        return interaction.editReply({
            content: '❌ You need to pick a **target** player to rob.' });
    }

    if (target.id === robber.id) {
        return interaction.editReply({
            content: '❌ You cannot rob yourself.' });
    }

    if (target.bot && target.id !== SLASHDRAGON_ID) {
        return interaction.editReply({
            content: '❌ You cannot rob bots.' });
    }

    const robberUser = await getUser(robber.id);
    const targetUser = await getUser(target.id);

    // Check cooldown
    const remainingTime = getRemainingTime(robber.id, 'rob_player');
    if (remainingTime > 0) {
        return interaction.editReply({
            content: `❌ You are on cooldown for rob player. Please wait ${formatRemainingTime(remainingTime)}.` });
    }

    // Check if robber has enough to pay the cost
    if (robberUser.wallet < ROB_COST) {
        return interaction.editReply({
            content: `❌ You need at least 🪙 ${ROB_COST.toLocaleString()} in your wallet to attempt a robbery.` });
    }

    // Check if target has enough to be robbed
    const targetBalance = targetUser.wallet || 0;
    if (targetBalance < MIN_TARGET_BALANCE) {
        return interaction.editReply({
            content: `❌ This target doesn't have enough coins to rob (minimum: 🪙 ${MIN_TARGET_BALANCE.toLocaleString()}).` });
    }

    // Check for SMI (Secret Money Intelligence) on target
    const targetHasSMI = getItemQuantity(target.id, 'smi', db) > 0;

    if (targetHasSMI) {
        const smiRoll = Math.random();
        if (smiRoll < 0.5) {
            // SMI engages - target gets what would have been stolen
            const stealPercentage = 0.3 + (Math.random() * 0.1);
            const wouldSteal = Math.floor(targetBalance * stealPercentage);

            if (robberUser.wallet >= wouldSteal) {
                robberUser.wallet -= wouldSteal;
                targetUser.wallet += wouldSteal;
                removeItem(target.id, 'smi', 1);
                updateUser(robberUser);
                updateUser(targetUser);

                const embed = new EmbedBuilder()
                    .setColor(0xff0000)
                    .setTitle('💥 ROBBERY BLOCKED BY SMI')
                    .setDescription(`You tried to rob <@${target.id}> but their SMI intercepted you!`)
                    .addFields(
                        { name: 'Lost', value: `🪙 ${wouldSteal.toLocaleString()}`, inline: true },
                        { name: 'SMI Status', value: 'Engaged', inline: true }
                    )
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });
            } else {
                // Robber doesn't have enough to pay, nobody gains/loses
                removeItem(target.id, 'smi', 1);

                const embed = new EmbedBuilder()
                    .setColor(0xff9900)
                    .setTitle('⚠️ ROBBERY BLOCKED BY SMI')
                    .setDescription(`<@${target.id}>'s SMI engaged but you don't have enough to pay.`)
                    .addFields(
                        { name: 'Result', value: 'No transaction', inline: true },
                        { name: 'SMI Status', value: 'Engaged (insufficient funds)', inline: true }
                    )
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });
            }
        } else {
            // SMI did not engage - send private message to target
            try {
                const targetMember = await interaction.guild.members.fetch(target.id);
                await targetMember.send({
                    content: `🕵️ **SMI ALERT**: Someone attempted to rob you but your SMI did not engage this time.`
                });
            } catch (e) {
                // Can't DM user
            }
        }
    }

    // Deduct cost from robber
    robberUser.wallet -= ROB_COST;
    updateUser(robberUser);

    // Check for Watchdog on target
    const targetHasWatchdog = getItemQuantity(target.id, 'watchdog', db) > 0;
    let watchdogCaught = false;

    if (targetHasWatchdog) {
        const watchdogRoll = Math.random();
        if (watchdogRoll < 0.4) {
            watchdogCaught = true;
            removeItem(target.id, 'watchdog', 1);
        }
    }

    // Calculate success chance (40% base, reduced by watchdog)
    let successChance = 0.4;
    if (watchdogCaught) {
        successChance = 0.15; // Reduced to 15% if watchdog catches
    }

    /* 🐉 Hatchery: the robber's active pet can help, the victim's can defend.
       Clamped so a pet can never turn a robbery into a certainty or a lock. */
    const robberPetBonus = dragonManager.getDragonBonus(robber.id, 'rob_success');
    const targetPetDefense = dragonManager.getDragonBonus(target.id, 'rob_defense');
    successChance = successChance * (1 + robberPetBonus) * (1 - targetPetDefense);
    successChance = Math.max(0.05, Math.min(0.9, successChance));

    const success = Math.random() < successChance;

    const useHighTech = isHighTech(robber.id);

    if (success) {
        // Calculate stolen amount (30-40% of target's wallet)
        const stealPercentage = 0.3 + (Math.random() * 0.1); // 30-40%
        const stolenAmount = Math.floor(targetBalance * stealPercentage);

        // Deduct from target and add to robber
        targetUser.wallet -= stolenAmount;
        robberUser.wallet += stolenAmount;

        // Check for rob insurance on target
        const targetHasInsurance = getItemQuantity(target.id, 'rob_insurance', db) > 0;
        let insuranceReimbursement = 0;

        if (targetHasInsurance) {
            insuranceReimbursement = Math.floor(stolenAmount * 0.67);
            targetUser.wallet += insuranceReimbursement;
            removeItem(target.id, 'rob_insurance', 1);
        }

        updateUser(targetUser);
        updateUser(robberUser);

        // Log transactions
        logTransaction(robber.id, 'rob_player', stolenAmount, `Robbed ${target.tag}`);
        logTransaction(target.id, 'rob_player', -stolenAmount, `Robbed by ${robber.tag}`);
        if (insuranceReimbursement > 0) {
            logTransaction(target.id, 'rob_player', insuranceReimbursement, 'Insurance reimbursement');
        }

        // Set cooldown
        setCooldown(robber.id, 'rob_player');

        const embed = new EmbedBuilder()
            .setColor(getColor(robber.id, 0x00ff00))
            .setTitle(formatTitle(robber.id, '💰 ROBBERY SUCCESSFUL', 'Robbery Successful'))
            .setDescription(useHighTech ? `You successfully robbed <@${target.id}>!` : `You successfully robbed <@${target.id}>`)
            .addFields(
                { name: formatFieldName(robber.id, 'Stolen Amount', 'Stolen Amount'), value: `🪙 ${stolenAmount.toLocaleString()}`, inline: true },
                { name: formatFieldName(robber.id, 'Percentage', 'Percentage'), value: `${(stealPercentage * 100).toFixed(1)}%`, inline: true },
                { name: formatFieldName(robber.id, 'Cost', 'Cost'), value: `🪙 ${ROB_COST.toLocaleString()}`, inline: true }
            );

        if (insuranceReimbursement > 0) {
            embed.addFields({ name: formatFieldName(robber.id, 'Insurance Reimbursed', 'Insurance'), value: `🪙 ${insuranceReimbursement.toLocaleString()}`, inline: true });
        }

        /* 🎯 BOUNTY CLAIM — whoever robs the marked player collects the whole
           pooled reward. Zero staff work, maximum drama. */
        let bountyClaim = null;
        try {
            bountyClaim = bountyManager.claimBounty(target.id, robber.id);
            if (bountyClaim?.ok) {
                embed.addFields({
                    name: '🎯 BOUNTY COLLECTED',
                    value: `Someone had a price on <@${target.id}>\n**+🪙${Number(bountyClaim.amount).toLocaleString()}** added to your wallet.`,
                    inline: false
                });
                try {
                    await interaction.channel?.send({
                        content: `🎯 <@${robber.id}> just collected the **🪙${Number(bountyClaim.amount).toLocaleString()}** bounty on <@${target.id}>.
_The board is clear — for now._`
                    });
                } catch (error) {
                    /* announcement is best effort */
                }
            }
        } catch (error) {
            console.error('Bounty claim failed:', error.message);
        }

        if (robberPetBonus > 0) {
            embed.addFields({ name: '🐉 Pet bonus', value: `+${(robberPetBonus * 100).toFixed(1)}% robbery odds from your active pet`, inline: false });
        }
        if (targetPetDefense > 0) {
            embed.addFields({ name: '🛡️ Their pet', value: `**${target.username || 'They'}** had a pet cutting your odds by ${(targetPetDefense * 100).toFixed(1)}%`, inline: false });
        }

        // 📋 Quests / achievements.
        try {
            questManager.recordQuestEvent(robber.id, 'rob_win', 1, { targetId: target.id });
            questManager.awardBadge(robber.id, 'bounty_hunter');
        } catch (error) {
            console.error('Rob quest hook failed:', error.message);
        }

        embed.setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    } else {
        // Robbery failed - only lost the cost
        setCooldown(robber.id, 'rob_player');

        const embed = new EmbedBuilder()
            .setColor(getColor(robber.id, 0xff0000))
            .setTitle(formatTitle(robber.id, '💥 ROBBERY FAILED', 'Robbery Failed'))
            .setDescription(useHighTech ? `You failed to rob <@${target.id}>!` : `You failed to rob <@${target.id}>`)
            .addFields(
                { name: formatFieldName(robber.id, 'Lost', 'Lost'), value: `🪙 ${ROB_COST.toLocaleString()}`, inline: true },
                { name: formatFieldName(robber.id, 'Success Rate', 'Success Rate'), value: `${(successChance * 100).toFixed(0)}%`, inline: true }
            );

        if (watchdogCaught) {
            embed.addFields({ name: 'Watchdog', value: '🐕 Caught you!', inline: true });
        }

        embed.setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }
}

/* =========================
   /rob BANK — team bank heist (was /rob-bank)
========================= */

function calculateSuccessRate(playerCount) {
    // 3 players = 50%, 4 = 60%, 5 = 70%, 6 = 80%
    return 20 + (playerCount * 10);
}

async function completeHeist(heist, message, panicPressed) {
    activeHeists.delete(heist.id);

    const targetUser = await getUser(heist.target);

    // Check for SMI on target
    const targetHasSMI = getItemQuantity(heist.target, 'smi', db) > 0;

    if (targetHasSMI && !panicPressed) {
        const smiRoll = Math.random();
        if (smiRoll < 0.5) {
            // SMI engages - block the heist
            removeItem(heist.target, 'smi', 1);

            // Try to get the would-be stolen amount from participants
            const stealPercentage = 0.3 + (Math.random() * 0.1);
            const totalFunds = (targetUser.bank || 0) + (targetUser.wallet || 0);
            const wouldSteal = Math.floor(totalFunds * stealPercentage);

            // Try to get money from participants to give to target
            let totalRecovered = 0;
            for (const participantId of heist.participants) {
                const participant = await getUser(participantId);
                const canPay = Math.min(participant.wallet, Math.floor(wouldSteal / heist.participants.length));
                if (canPay > 0) {
                    participant.wallet -= canPay;
                    targetUser.bank += canPay;
                    totalRecovered += canPay;
                    updateUser(participant);
                }
            }

            updateUser(targetUser);

            const embed = new EmbedBuilder()
                .setColor(0xff0000)
                .setTitle('🕵️ SMI BLOCKED HEIST')
                .setDescription(`<@${heist.target}>'s Secret Money Intelligence intercepted the bank heist!`)
                .addFields(
                    { name: 'Recovered', value: `🪙 ${totalRecovered.toLocaleString()}`, inline: true },
                    { name: 'SMI Status', value: 'Engaged', inline: true }
                );

            await message.edit({
                embeds: [embed],
                components: []
            });
            return;
        } else {
            // SMI did not engage - send private message to target
            try {
                const targetMember = await message.guild.members.fetch(heist.target);
                await targetMember.send({
                    content: `🕵️ **SMI ALERT**: Someone attempted to rob your bank but your SMI did not engage this time.`
                });
            } catch (e) {
                // Can't DM user
            }
        }
    }

    if (panicPressed) {
        // Target gets 5k * player count
        const reward = COST_PER_PLAYER * heist.participants.length;
        targetUser.bank += reward;
        updateUser(targetUser);

        const embed = new EmbedBuilder()
            .setColor(0x00ff00)
            .setTitle('🚨 PANIC BUTTON PRESSED!')
            .setDescription(`<@${heist.target}> pressed the panic button!`)
            .addFields(
                { name: 'Reward', value: `🪙 ${reward.toLocaleString()}`, inline: true },
                { name: 'Source', value: 'Heist participants', inline: true }
            )
            .setFooter({ text: 'Heist failed - target was alerted' });

        await message.edit({
            embeds: [embed],
            components: []
        });
    } else {
        // Heist successful - steal from the target's holdings and bank.
        const successRate = calculateSuccessRate(heist.participants.length);
        const success = Math.random() * 100 < successRate;

        if (success) {
            const stealPercentage = 0.3 + (Math.random() * 0.1); // 30-40%
            const totalFunds = (targetUser.bank || 0) + (targetUser.wallet || 0);
            const stolenAmount = Math.floor(totalFunds * stealPercentage);

            if (stolenAmount > 0) {
                const stolenFromBank = Math.min(targetUser.bank, stolenAmount);
                const stolenFromWallet = stolenAmount - stolenFromBank;
                targetUser.bank -= stolenFromBank;
                targetUser.wallet -= stolenFromWallet;
                updateUser(targetUser);

                const sharePerPlayer = Math.floor(stolenAmount / heist.participants.length);
                const remainder = stolenAmount - (sharePerPlayer * heist.participants.length);

                // Distribute shares
                for (const participantId of heist.participants) {
                    const user = await getUser(participantId);
                    user.wallet += sharePerPlayer;
                    updateUser(user);

                    // Log transaction for participant
                    logTransaction(participantId, 'rob_bank', sharePerPlayer, `Heist share from ${heist.target}`);
                }

                // Give remainder to starter
                if (remainder > 0) {
                    const starter = await getUser(heist.starter);
                    starter.wallet += remainder;
                    updateUser(starter);

                    // Log transaction for remainder
                    logTransaction(heist.starter, 'rob_bank', remainder, `Heist remainder from ${heist.target}`);
                }

                // Log transaction for target
                logTransaction(heist.target, 'rob_bank', -stolenAmount, `Bank heist by ${heist.participants.length} participants`);

                // Check for rob insurance on target
                const targetHasInsurance = getItemQuantity(heist.target, 'rob_insurance', db) > 0;
                let insuranceReimbursement = 0;

                if (targetHasInsurance) {
                    insuranceReimbursement = Math.floor(stolenAmount * 0.67);
                    targetUser.bank += insuranceReimbursement;
                    removeItem(heist.target, 'rob_insurance', 1);
                    updateUser(targetUser);

                    // Log insurance reimbursement
                    logTransaction(heist.target, 'rob_bank', insuranceReimbursement, 'Insurance reimbursement');
                }

                const participantList = heist.participants.map(id => `<@${id}>`).join('\n');
                const useHighTech = isHighTech(heist.starter);

                const embed = new EmbedBuilder()
                    .setColor(getColor(heist.starter, 0x00ff00))
                    .setTitle(formatTitle(heist.starter, '💰 BANK HEIST SUCCESSFUL!', 'Bank Heist Successful'))
                    .setDescription(useHighTech ? `Successfully robbed <@${heist.target}>'s bank!` : `Successfully robbed <@${heist.target}>'s bank!`)
                    .addFields(
                        { name: formatFieldName(heist.starter, 'Total Stolen', 'Total Stolen'), value: `🪙 ${stolenAmount.toLocaleString()}`, inline: true },
                        { name: formatFieldName(heist.starter, 'Percentage', 'Percentage'), value: `${(stealPercentage * 100).toFixed(1)}%`, inline: true },
                        { name: formatFieldName(heist.starter, 'Accounts Hit', 'Accounts Hit'), value: `Holdings: 🪙 ${stolenFromWallet.toLocaleString()}\nBank: 🪙 ${stolenFromBank.toLocaleString()}`, inline: true },
                        { name: formatFieldName(heist.starter, 'Share Per Player', 'Share Per Player'), value: `🪙 ${sharePerPlayer.toLocaleString()}`, inline: true },
                        { name: formatFieldName(heist.starter, 'Participants', 'Participants'), value: participantList, inline: false }
                    );

                if (insuranceReimbursement > 0) {
                    embed.addFields({ name: formatFieldName(heist.starter, 'Insurance Reimbursed', 'Insurance'), value: `🪙 ${insuranceReimbursement.toLocaleString()}`, inline: true });
                }

                embed.setFooter({ text: useHighTech ? (remainder > 0 ? `🪙 ${remainder.toLocaleString()} remainder given to starter` : 'Evenly distributed') : (remainder > 0 ? `${remainder.toLocaleString()} remainder given to starter` : 'Evenly distributed') });

                await message.edit({
                    embeds: [embed],
                    components: []
                });

                // Set cooldown for all participants
                for (const participantId of heist.participants) {
                    setCooldown(participantId, 'rob_bank');
                }
            } else {
                // Bank was empty
                const useHighTech = isHighTech(heist.starter);
                const embed = new EmbedBuilder()
                    .setColor(getColor(heist.starter, 0xff9900))
                    .setTitle(formatTitle(heist.starter, '💸 BANK HEIST FAILED', 'Bank Heist Failed'))
                    .setDescription(useHighTech ? `<@${heist.target}>'s bank was empty!` : `<@${heist.target}>'s bank was empty!`)
                    .addFields(
                        { name: formatFieldName(heist.starter, 'Lost', 'Lost'), value: `🪙 ${COST_PER_PLAYER.toLocaleString()} per player`, inline: true }
                    );

                await message.edit({
                    embeds: [embed],
                    components: []
                });

                // Set cooldown for all participants
                for (const participantId of heist.participants) {
                    setCooldown(participantId, 'rob_bank');
                }
            }
        } else {
            // Heist failed despite no panic
            const embed = new EmbedBuilder()
                .setColor(0xff0000)
                .setTitle('💥 BANK HEIST FAILED')
                .setDescription('The heist was unsuccessful!')
                .addFields(
                    { name: 'Lost', value: `🪙 ${COST_PER_PLAYER.toLocaleString()} per player`, inline: true },
                    { name: 'Success Rate', value: `${calculateSuccessRate(heist.participants.length)}%`, inline: true }
                );

            await message.edit({
                embeds: [embed],
                components: []
            });

            // Set cooldown for all participants
            for (const participantId of heist.participants) {
                setCooldown(participantId, 'rob_bank');
            }
        }
    }
}

async function runRobBank(interaction) {
    if (interaction.channelId !== ALLOWED_CHANNEL) {
        return interaction.editReply({
            content: `❌ You can only use this in <#${ALLOWED_CHANNEL}>.` });
    }

    const slashDragonTarget = interaction.options.getBoolean('slashdragon');
    const target = slashDragonTarget
        ? await interaction.client.users.fetch(SLASHDRAGON_ID).catch(() => null)
        : interaction.options.getUser('target');
    const starter = interaction.user;

    if (!target) {
        return interaction.editReply({
            content: '❌ Choose a target user or set **slashdragon** to true.' });
    }

    if (target.id === starter.id) {
        return interaction.editReply({
            content: '❌ You cannot rob your own bank.' });
    }

    if (target.bot && target.id !== SLASHDRAGON_ID) {
        return interaction.editReply({
            content: '❌ You cannot rob bots.' });
    }

    const starterUser = await getUser(starter.id);

    // Check cooldown
    const remainingTime = getRemainingTime(starter.id, 'rob_bank');
    if (remainingTime > 0) {
        return interaction.editReply({
            content: `❌ You are on cooldown for rob bank. Please wait ${formatRemainingTime(remainingTime)}.` });
    }

    if (starterUser.wallet < COST_PER_PLAYER) {
        return interaction.editReply({
            content: `❌ You need at least 🪙 ${COST_PER_PLAYER.toLocaleString()} to start a heist.` });
    }

    // Deduct cost from starter
    starterUser.wallet -= COST_PER_PLAYER;
    updateUser(starterUser);

    // Create heist
    const heistId = Date.now().toString();
    const heist = {
        id: heistId,
        starter: starter.id,
        target: target.id,
        participants: [starter.id],
        startTime: null,
        panicPressed: false,
        status: 'recruiting'
    };

    activeHeists.set(heistId, heist);

    const embed = new EmbedBuilder()
        .setColor(0xff9900)
        .setTitle('🏦 BANK HEIST RECRUITMENT')
        .setDescription(`**Starter:** <@${starter.id}>\n**Target:** <@${target.id}>\n**Target accounts:** Holdings + Bank\n**Participants:** 1/${MAX_PLAYERS}\n**Cost per player:** 🪙 ${COST_PER_PLAYER.toLocaleString()}`)
        .addFields(
            { name: 'Success Rate', value: `${calculateSuccessRate(1)}%`, inline: true },
            { name: 'Time Limit', value: '5 minutes', inline: true }
        )
        .setFooter({ text: 'Click to join the heist or start when ready' });

    const joinButton = new ButtonBuilder()
        .setCustomId(`heist:join:${heistId}`)
        .setLabel('Join Heist')
        .setStyle(ButtonStyle.Primary);

    const startButton = new ButtonBuilder()
        .setCustomId(`heist:start:${heistId}`)
        .setLabel('Start Heist')
        .setStyle(ButtonStyle.Success)
        .setDisabled(true);

    const cancelButton = new ButtonBuilder()
        .setCustomId(`heist:cancel:${heistId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(joinButton, startButton, cancelButton);

    const message = await interaction.editReply({
        embeds: [embed],
        components: [row],
        fetchReply: true
    });

    // Button collector
    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 300000 // 5 minutes to recruit
    });

    collector.on('collect', async (btn) => {
        const [action, id] = btn.customId.split(':').slice(1);

        if (action === 'join') {
            if (btn.user.id === starter.id) {
                return btn.reply({ content: 'You already started this heist.' });
            }

            if (heist.participants.includes(btn.user.id)) {
                return btn.reply({ content: 'You already joined this heist.' });
            }

            if (heist.participants.length >= MAX_PLAYERS) {
                return btn.reply({ content: 'This heist is full.' });
            }

            const user = await getUser(btn.user.id);
            if (user.wallet < COST_PER_PLAYER) {
                return btn.reply({
                    content: `You need at least 🪙 ${COST_PER_PLAYER.toLocaleString()} to join.` });
            }

            user.wallet -= COST_PER_PLAYER;
            updateUser(user);

            heist.participants.push(btn.user.id);

            const successRate = calculateSuccessRate(heist.participants.length);
            const updatedEmbed = EmbedBuilder.from(embed)
                .setDescription(`**Starter:** <@${starter.id}>\n**Target:** <@${target.id}>\n**Target accounts:** Holdings + Bank\n**Participants:** ${heist.participants.length}/${MAX_PLAYERS}\n**Cost per player:** 🪙 ${COST_PER_PLAYER.toLocaleString()}`)
                .spliceFields(0, 1, { name: 'Success Rate', value: `${successRate}%`, inline: true });

            startButton.setDisabled(heist.participants.length < MIN_PLAYERS);

            await btn.update({
                embeds: [updatedEmbed],
                components: [row]
            });
        }

        if (action === 'start') {
            if (btn.user.id !== starter.id) {
                return btn.reply({ content: 'Only the starter can start the heist.' });
            }

            if (heist.participants.length < MIN_PLAYERS) {
                return btn.reply({ content: `Need at least ${MIN_PLAYERS} players to start.` });
            }

            heist.status = 'active';
            heist.startTime = Date.now();

            const successRate = calculateSuccessRate(heist.participants.length);

            // Check for Mobile Phone on target - ping them
            const targetHasMobilePhone = getItemQuantity(target.id, 'mobile_phone', db) > 0;
            if (targetHasMobilePhone) {
                try {
                    const targetMember = await interaction.guild.members.fetch(target.id);
                    await targetMember.send({
                        content: `📱 **BANK HEIST ALERT**: Someone has started a bank heist targeting your bank! Press the panic button if you can!`
                    });
                } catch (e) {
                    // Can't DM user
                }
            }

            const activeEmbed = new EmbedBuilder()
                .setColor(0xff0000)
                .setTitle('🚨 BANK HEIST IN PROGRESS')
                .setDescription(`**Target:** <@${target.id}>\n**Participants:** ${heist.participants.length}\n**Success Rate:** ${successRate}%`)
                .addFields(
                    { name: 'Time Remaining', value: '5:00', inline: true },
                    { name: 'Status', value: '⏳ In Progress', inline: true }
                )
                .setFooter({ text: 'Target: Press the panic button to alert authorities!' });

            const panicButton = new ButtonBuilder()
                .setCustomId(`heist:panic:${heistId}`)
                .setLabel('🚨 PANIC BUTTON')
                .setStyle(ButtonStyle.Danger);

            const panicRow = new ActionRowBuilder().addComponents(panicButton);

            await btn.update({
                embeds: [activeEmbed],
                components: [panicRow]
            });

            // Start countdown
            const countdownInterval = setInterval(async () => {
                if (heist.panicPressed) {
                    clearInterval(countdownInterval);
                    return;
                }

                const elapsed = Date.now() - heist.startTime;
                const remaining = HEIST_DURATION - elapsed;

                if (remaining <= 0) {
                    clearInterval(countdownInterval);
                    await completeHeist(heist, message, false);
                    return;
                }

                const minutes = Math.floor(remaining / 60000);
                const seconds = Math.floor((remaining % 60000) / 1000);
                const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

                try {
                    const updatedEmbed = EmbedBuilder.from(activeEmbed)
                        .spliceFields(0, 1, { name: 'Time Remaining', value: timeStr, inline: true });
                    await message.edit({ embeds: [updatedEmbed] });
                } catch (e) {
                    clearInterval(countdownInterval);
                }
            }, 1000);
        }

        if (action === 'cancel') {
            if (btn.user.id !== starter.id) {
                return btn.reply({ content: 'Only the starter can cancel the heist.' });
            }

            // Refund all participants
            for (const participantId of heist.participants) {
                const user = await getUser(participantId);
                user.wallet += COST_PER_PLAYER;
                updateUser(user);
            }

            activeHeists.delete(heistId);

            const cancelEmbed = new EmbedBuilder()
                .setColor(0x808080)
                .setTitle('❌ HEIST CANCELED')
                .setDescription('All participants have been refunded.');

            await btn.update({
                embeds: [cancelEmbed],
                components: []
            });

            collector.stop();
        }

        if (action === 'panic') {
            if (btn.user.id !== target.id) {
                return btn.reply({ content: 'Only the target can press the panic button.' });
            }

            if (heist.panicPressed) {
                return btn.reply({ content: 'Panic button already pressed!' });
            }

            heist.panicPressed = true;
            await completeHeist(heist, message, true);
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time' && heist.status === 'recruiting') {
            // Refund all participants
            for (const participantId of heist.participants) {
                const user = await getUser(participantId);
                user.wallet += COST_PER_PLAYER;
                updateUser(user);
            }

            activeHeists.delete(heistId);

            try {
                await message.edit({
                    content: '⏰ Recruitment timed out. All participants refunded.',
                    embeds: [],
                    components: []
                });
            } catch {}
        }
    });
}

/* =========================
   MAIN — one command, target type chosen via selector
========================= */

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rob')
        .setDescription('Crime system: rob players or organize bank heists')
        .addStringOption(opt =>
            opt.setName('type')
                .setDescription('What are you robbing?')
                .setRequired(true)
                .addChoices(
                    { name: 'Player — rob someone\'s wallet', value: 'player' },
                    { name: 'Bank — team heist (3-6 players)', value: 'bank' }
                ))
        .addUserOption(opt =>
            opt.setName('target')
                .setDescription('Player to rob / user whose bank to rob')
                .setRequired(false))
        .addBooleanOption(opt =>
            opt.setName('slashdragon')
                .setDescription('(Bank only) Target SlashDragon\'s bank instead')
                .setRequired(false)),

    async execute(interaction) {
        /* 10062 fix — /rob is the heaviest economy command (getUser fetches,
           DM attempts, embed chains). Acknowledge FIRST, before the type
           branch; every gate and result below answers via editReply. */
        await interaction.deferReply();
        const type = interaction.options.getString('type', true);
        if (type === 'player') return runRobPlayer(interaction);
        return runRobBank(interaction);
    }
};
