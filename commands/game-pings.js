const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
    getRemainingCooldownMs,
    setPingCooldown,
    formatRemaining
} = require('../systems/util/pingCooldowns');

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

const colors = ['#00fff7', '#b300ff', '#00ff66', '#ff0055'];

const aiLines = [
  "LINKING GAME-NIGHT NODE CLUSTER...",
  "SYNCING EVENT SCHEDULES...",
  "QUANTUM ROUTING ACTIVE...",
  "ENCRYPTION LAYER SYNCHRONIZED...",
  "SIGNAL STABILIZING ACROSS GRID..."
];

// Only members with this role may run /game-pings.
const GAME_PING_ROLE_ID = '1523528812720033822';

// Channels where the ping is allowed to fire (protects the rest of the
// server from pings). Add or remove channel IDs here as needed.
const ALLOWED_CHANNELS = [
  '1504562791967756448' // main economy channel
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('game-pings')
    .setDescription('Ping the Game Ping role for game night')
    .addStringOption(option =>
      option
        .setName('reason')
        .setDescription('What game / when (shown in the broadcast)')
        .setRequired(true)
    ),

  async execute(interaction) {
    // ─────────────────────────────
    // ROLE GATE — holders of the game-ping role only
    // ─────────────────────────────
    const hasGameRole = interaction.member?.roles?.cache?.has(GAME_PING_ROLE_ID);

    if (!hasGameRole) {
      return interaction.reply({
        content: '❌ You need the Game Ping role to use this command.' });
    }

    // ─────────────────────────────
    // CHANNEL GATE — keeps pings out of the rest of the server
    // ─────────────────────────────
    if (!ALLOWED_CHANNELS.includes(interaction.channelId)) {
      return interaction.reply({
        content: `❌ Game pings can only be sent from <#${ALLOWED_CHANNELS[0]}>.` });
    }

    // ─────────────────────────────
    // COOLDOWN — one ping per user per 30 minutes (checked before the
    // animation; only armed after a successful broadcast below)
    // ─────────────────────────────
    const remainingMs = getRemainingCooldownMs('game-pings', interaction.user.id);
    if (remainingMs > 0) {
      return interaction.reply({
        content: `⏳ You already pinged recently. Try again in **${formatRemaining(remainingMs)}**.` });
    }

    const reason = interaction.options.getString('reason').trim().slice(0, 500);
    const pingLine = `<@&${GAME_PING_ROLE_ID}>`;
    const userTag = interaction.user.tag;
    const userId = interaction.user.id;

    // ─────────────────────────────
    // BOOT SCREEN
    // ─────────────────────────────
    const bootEmbed = new EmbedBuilder()
      .setColor('#00fff7')
      .setTitle('⧉ GAME-NIGHT SIGNAL INITIALIZING')
      .setDescription(
        "```ansi\n" +
        "\u001b[36mBOOTING GAME BROADCAST PROTOCOL...\u001b[0m\n" +
        "\u001b[35mESTABLISHING SECURE CHANNEL...\u001b[0m\n" +
        "```"
      );

    await interaction.reply({ embeds: [bootEmbed] });

    await sleep(1200);

    // ─────────────────────────────
    // LOADER SEQUENCE
    // ─────────────────────────────
    for (let i = 1; i <= 4; i++) {
      const progress = i * 25;
      const bar = '█'.repeat(i) + '▒'.repeat(4 - i);

      const embed = new EmbedBuilder()
        .setColor(colors[i % colors.length])
        .setTitle('⧉ GAME BROADCAST LINK')
        .setDescription(
          "```ansi\n" +
          `\u001b[32mINITIALIZING GAME MATRIX [${bar}] ${progress}%\u001b[0m\n` +
          `\u001b[36m${aiLines[i % aiLines.length]}\u001b[0m\n` +
          "```"
        );

      await interaction.editReply({ embeds: [embed] });
      await sleep(900);
    }

    // ─────────────────────────────
    // FINAL BROADCAST
    // ─────────────────────────────
    const color = colors[Math.floor(Math.random() * colors.length)];

    const finalEmbed = new EmbedBuilder()
      .setColor(color)
      .setTitle('🎮 GAME-NIGHT SIGNAL ACTIVE 🎮')
      .setDescription(
        "```diff\n" +
        "- SYSTEM NOTICE: GAME-NIGHT SIGNAL DETECTED\n" +
        "+ ROUTING GAME INVITE TO SUBSCRIBERS...\n" +
        "! PRIORITY: HIGH\n" +
        "```\n\n" +

        "```fix\n" +
        `GAME: ${reason}\n` +
        "```\n\n" +

        `${pingLine}\n\n` +

        "```yaml\n" +
        `TRIGGERED_BY: ${userTag} (${userId})\n` +
        `SERVER: ${interaction.guild?.name || "DM"}\n` +
        "MODULE: GAME BROADCAST SYSTEM\n" +
        "STATUS: ACTIVE\n" +
        "```"
      )
      .setFooter({ text: 'NEON//GAME-MATRIX v1.0 • SIGNAL LIVE' })
      .setTimestamp();

    await interaction.editReply({ embeds: [finalEmbed] });

    // Arm the cooldown only after the ping actually went out.
    setPingCooldown('game-pings', interaction.user.id);
  }
};
