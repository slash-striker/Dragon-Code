const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} = require('discord.js');

const { getUser, updateUser } = require('../systems/economy/userManager');
const { getItemQuantity, removeItem } = require('../systems/economy/shopItems');
const { logTransaction } = require('../systems/economy/transactionLogger');
const { setCooldown, getRemainingTime, formatRemainingTime } = require('../systems/economy/cooldownManager');
const { getColor, formatTitle, formatFieldName, isHighTech } = require('../systems/economy/uiStyleHelper');
const { NEON, panel, kv, ANSI } = require('../systems/games/neonUI');
const db = require('../database');

const ALLOWED_CHANNEL = '1504562791967756448';
const SCRATCHCARD_COST = 500;

function safe(n) {
    return typeof n === 'number' && !isNaN(n) ? n : 0;
}

// ------------------------------
// 🎯 WIN CONTROL (25% TOTAL WIN RATE)
// ------------------------------
function rollReward(hasLuckyDice) {
    // Lucky dice increases win rate from 25% to 40%
    const winChance = hasLuckyDice ? 0.40 : 0.25;

    const isWin = Math.random() < winChance;

    if (!isWin) {
        return { type: "nothing", amount: 0, label: "Empty Card" };
    }

    // 🎰 weighted win pool (rare → common)
    // The 💰 square pays big: even the minor burst beats the card's cost.
    const winPool = [
        { type: "wallet", amount: 750, label: "Minor Credit Burst", weight: 50 },
        { type: "wallet", amount: 1500, label: "Quantum Surge", weight: 30 },
        { type: "wallet", amount: 3000, label: "System Overflow Cache", weight: 15 },
        { type: "wallet", amount: 6000, label: "Neural Jackpot Core", weight: 4 },
        { type: "bank", amount: 2500, label: "Vault Injection Node", weight: 1 }
    ];

    const total = winPool.reduce((a, b) => a + b.weight, 0);
    let r = Math.random() * total;

    for (const item of winPool) {
        if (r < item.weight) return item;
        r -= item.weight;
    }

    return winPool[0];
}

// ------------------------------
// 🎫 CARD CREATION
// ------------------------------
function createCard(hasLuckyDice) {
    const reward = rollReward(hasLuckyDice);
    return {
        reward,
        winningIndex: reward.amount > 0 ? Math.floor(Math.random() * 9) : -1,
        scratched: Array(9).fill(false),
        scratches: 0,
        glitchUsed: false,
        completed: false
    };
}

// ------------------------------
// 🎨 VISUAL RENDER
// ------------------------------
function renderCard(card) {
    const rows = [];

    for (let i = 0; i < 9; i += 3) {
        const row = new ActionRowBuilder();

        for (let j = 0; j < 3; j++) {
            const index = i + j;

            let label = "█";

            if (card.scratched[index]) {
                label = index === card.winningIndex ? "💰" : "×";
            }

            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`scratch_${index}`)
                    .setLabel(label)
                    .setStyle(
                        card.scratched[index]
                            ? index === card.winningIndex ? ButtonStyle.Success : ButtonStyle.Danger
                            : ButtonStyle.Secondary
                    )
                    .setDisabled(card.scratched[index])
            );
        }

        rows.push(row);
    }

    return rows;
}

// ------------------------------
// 📊 PROGRESS BAR
// ------------------------------
function progress(card) {
    const pct = Math.floor((card.scratches / 9) * 100);
    const bar = "█".repeat(card.scratches) + "░".repeat(9 - card.scratches);
    return `\`${bar}\` ${pct}%`;
}

// ------------------------------
// MAIN COMMAND
// ------------------------------
module.exports = {
    data: new SlashCommandBuilder()
        .setName('scratchcard')
        .setDescription('Buy and scratch a hidden reward card'),

    async execute(interaction) {
        // Acknowledge FIRST — purchase writes, item checks and the boot
        // sequence can push the first reply past Discord's 3-second window,
        // and an expired interaction must not eat the cooldown either.
        await interaction.deferReply();

        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.editReply({
                content: `❌ Locked terminal: <#${ALLOWED_CHANNEL}>` });
        }

        const user = await getUser(interaction.user.id);

        user.wallet = safe(user.wallet);
        user.bank = safe(user.bank);

        if (user.wallet < SCRATCHCARD_COST) {
            return interaction.editReply({
                content: `❌ You need 🪙 ${SCRATCHCARD_COST.toLocaleString()} holdings to buy a scratchcard.` });
        }

        // Check cooldown
        const remainingTime = getRemainingTime(interaction.user.id, 'scratchcard');
        if (remainingTime > 0) {
            return interaction.editReply({
                content: `❌ You are on cooldown for scratchcard. Please wait ${formatRemainingTime(remainingTime)}.` });
        }

        // Check for Lucky Dice
        const hasLuckyDice = getItemQuantity(interaction.user.id, 'lucky_dice', db) > 0;
        let luckyDiceUsed = false;

        if (hasLuckyDice) {
            luckyDiceUsed = true;
            removeItem(interaction.user.id, 'lucky_dice', 1);
        }

        db.transaction(() => {
            const debit = db.prepare('UPDATE users SET wallet = wallet - ?, scratchcardCount = COALESCE(scratchcardCount, 0) + 1 WHERE userId = ? AND wallet >= ?')
                .run(SCRATCHCARD_COST, interaction.user.id, SCRATCHCARD_COST);
            if (debit.changes !== 1) throw new Error('Insufficient wallet funds.');
            const slashDragonId = '1505829367631183963';
            db.prepare('INSERT OR IGNORE INTO users (userId) VALUES (?)').run(slashDragonId);
            db.prepare('UPDATE users SET wallet = wallet + ? WHERE userId = ?').run(SCRATCHCARD_COST, slashDragonId);
        })();
        user.wallet -= SCRATCHCARD_COST;
        logTransaction(interaction.user.id, 'scratchcard_purchase', -SCRATCHCARD_COST, 'Scratchcard purchase');
        logTransaction('1505829367631183963', 'scratchcard_revenue', SCRATCHCARD_COST, `Scratchcard purchased by ${interaction.user.id}`);

        // ------------------------------
        // 🖨️ BOOT SEQUENCE
        // ------------------------------
        const useHighTech = isHighTech(interaction.user.id);

        if (useHighTech) {
            await interaction.editReply({
                content:
                    "🖨️ Printing scratchcard...\n" +
                    "📦 Applying holographic coating...\n" +
                    `🔐 Locking reward layer...\n💳 Purchase authorized: -${SCRATCHCARD_COST} credits` +
                    (luckyDiceUsed ? "\n🎲 Lucky Dice activated for better odds!" : "")
            });

            await new Promise(r => setTimeout(r, 1200));

            await interaction.editReply(
                "🎫 Card ready.\n👉 Scratch the surface to reveal hidden data."
            );
        }

        const card = createCard(luckyDiceUsed);

        const baseEmbed = new EmbedBuilder()
            .setColor(getColor(interaction.user.id, NEON.magenta))
            .setTitle(formatTitle(interaction.user.id, "◢ ═══ 🎫 SCRATCHCARD // SEAL LAYER ═══ ◣", "Scratchcard"))
            .setDescription(useHighTech
                ? panel(
                    `${ANSI.MAGENTA}◈ ENCRYPTED CARD LOADED${ANSI.RESET}`,
                    kv('Cost', `🪙${SCRATCHCARD_COST.toLocaleString()}`),
                    kv('Lucky chip', luckyDiceUsed ? `${ANSI.GREEN}ENGAGED${ANSI.RESET}` : `${ANSI.DIM}not detected${ANSI.RESET}`),
                    '',
                    `${ANSI.DIM}scratch the coating to reveal the payload${ANSI.RESET}`
                )
                : "Scratch the card to reveal your reward.")
            .addFields({
                name: formatFieldName(interaction.user.id, "◈ Decrypt Progress", "Progress"),
                value: progress(card),
                inline: true
            });

        let message;
        if (useHighTech) {
            message = await interaction.editReply({
                embeds: [baseEmbed],
                components: renderCard(card)
            });
        } else {
            message = await interaction.editReply({
                embeds: [baseEmbed],
                components: renderCard(card)
            });
        }

        // ------------------------------
        // 🎮 COLLECTOR
        // ------------------------------
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 30000
        });

        collector.on("collect", async (i) => {

            if (i.user.id !== interaction.user.id) {
                return i.reply({ content: "Not your card." });
            }

            const index = parseInt(i.customId.split("_")[1]);

            if (card.scratched[index]) return i.deferUpdate();

            card.scratched[index] = true;
            card.scratches++;
            if (index === card.winningIndex || card.scratches >= 9) {
                card.completed = true;
            }

            // ------------------------------
            // ⚡ GLITCH EFFECT (rare)
            // ------------------------------
            let embed = EmbedBuilder.from(baseEmbed)
                .setFields({
                    name: formatFieldName(interaction.user.id, "Progress", "Progress"),
                    value: progress(card)
                });

            if (!card.glitchUsed && Math.random() < 0.2) {
                card.glitchUsed = true;

                embed.setColor(getColor(interaction.user.id, 0xff00ff))
                    .setDescription(useHighTech ? "⚠️ COATING INSTABILITY DETECTED...\nRecalibrating scratch layer..." : "Coating instability detected...");

                await i.update({
                    embeds: [embed],
                    components: renderCard(card)
                });

                setTimeout(async () => {
                    await message.edit({
                        embeds: [baseEmbed],
                        components: renderCard(card)
                    });
                }, 900);

                return;
            }

            await i.update({
                embeds: [embed],
                components: renderCard(card)
            });

            if (card.completed) {
                collector.stop("done");
            }
        });

        // ------------------------------
        // 🎯 END RESULT
        // ------------------------------
        collector.on("end", async () => {

            const reward = card.completed ? card.reward : { type: "nothing", amount: 0, label: "Unfinished Card" };

            if (reward.type === "wallet") user.wallet += reward.amount;
            if (reward.type === "bank") user.bank += reward.amount;

            await updateUser({
                ...user,
                wallet: user.wallet,
                bank: user.bank,
                userId: user.userId
            });

            // Log transaction
            if (reward.amount > 0) {
                logTransaction(interaction.user.id, 'scratchcard', reward.amount, luckyDiceUsed ? 'Lucky Dice used' : '');
            }

            // Set cooldown after every purchased card, including abandoned cards.
            setCooldown(interaction.user.id, 'scratchcard');

            const win = reward.amount > 0;            const finalEmbed = new EmbedBuilder()
                .setColor(getColor(interaction.user.id, win ? NEON.green : NEON.red))
                .setTitle(formatTitle(interaction.user.id,
                    win ? "◢ ═══ 🎉 PAYLOAD DECRYPTED ═══ ◣" : "◢ ═══ ❌ NO SIGNAL FOUND ═══ ◣",
                    win ? "Reward Decrypted" : "Empty Card"))
                .setDescription(useHighTech
                    ? panel(
                        `${ANSI.MAGENTA}◈ FINAL READOUT${ANSI.RESET}`,
                        win
                            ? kv('Payload', `**${reward.label}**`)
                            : reward.label === "Unfinished Card"
                                ? `${ANSI.RED}link timed out before full decryption${ANSI.RESET}`
                                : `${ANSI.RED}no reward signatures detected${ANSI.RESET}`,
                        '',
                        win
                            ? `${ANSI.GREEN}${ANSI.BOLD}≫ +🪙${reward.amount.toLocaleString()} CREDITED <<${ANSI.RESET}`
                            : `${ANSI.DIM}better luck next cycle${ANSI.RESET}`
                    )
                    : win
                        ? `You uncovered: **${reward.label}**`
                        : "No reward found.")
                .addFields(
                    {
                        name: formatFieldName(interaction.user.id, "◈ Wallet", "Wallet"),
                        value: `🪙 ${user.wallet.toLocaleString()}`,
                        inline: true
                    },
                    {
                        name: formatFieldName(interaction.user.id, "◈ Bank", "Bank"),
                        value: `🏦 ${user.bank.toLocaleString()}`,
                        inline: true
                    }
                )
                .setFooter({ text: useHighTech ? "SCRATCHCARD OS v5.1 • HOLOGRAPHIC RELEASE" : "Scratchcard System" });

            await message.edit({
                embeds: [finalEmbed],
                components: []
            });
        });
    }
};
