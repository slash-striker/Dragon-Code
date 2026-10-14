const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
    getRemainingCooldownMs,
    setPingCooldown,
    formatRemaining
} = require('../systems/util/pingCooldowns');

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

const colors = ['#00fff7', '#b300ff', '#00ff66', '#ff0055'];

const aiLines = [
  "NEURAL CORE LINK ESTABLISHED...",
  "SCANNING STAFF NODE CLUSTER...",
  "QUANTUM ROUTING ACTIVE...",
  "ENCRYPTION LAYER SYNCHRONIZED...",
  "SIGNAL STABILIZING ACROSS GRID..."
];

const SLASHLING_ROLE = '1504377329521262653';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('staff')
    .setDescription('[STAFF ONLY] Broadcast encrypted staff signal (once per 30 min)')
    .addStringOption(option =>
      option
        .setName('reason')
        .setDescription('Reason for staff ping (optional)')
        .setRequired(false)
    ),

  async execute(interaction) {
    // Slashling-only check
    const hasSlashlingRole = interaction.member.roles.cache.has(SLASHLING_ROLE);

    if (!hasSlashlingRole) {
      return interaction.reply({
        content: '❌ This command is restricted to Slashlings only.' });
    }

    // ─────────────────────────────
    // COOLDOWN — one staff ping per user per 30 minutes (checked before
    // the animation; only armed after a successful broadcast below)
    // ─────────────────────────────
    const remainingMs = getRemainingCooldownMs('staff', interaction.user.id);
    if (remainingMs > 0) {
      return interaction.reply({
        content: `⏳ You already pinged staff recently. Try again in **${formatRemaining(remainingMs)}**.` });
    }

    const staffRoles = [
      '1504365030877954162',
      '1504365030877954160',
      '1504365030877954161'
    ];

    const reasonRaw = interaction.options.getString('reason');
    const reason = reasonRaw && reasonRaw.trim().length > 0
      ? reasonRaw.trim()
      : "No reason provided";

    const pingLine = staffRoles.map(id => `<@&${id}>`).join(' ');
    const userTag = interaction.user.tag;
    const userId = interaction.user.id;

    // ─────────────────────────────
    // BOOT SCREEN
    // ─────────────────────────────
    const bootEmbed = new EmbedBuilder()
      .setColor('#00fff7')
      .setTitle('⧉ NEON STAFF MATRIX INITIALIZING')
      .setDescription(
        "```ansi\n" +
        "\u001b[36mBOOTING ENCRYPTED STAFF PROTOCOL...\u001b[0m\n" +
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
        .setTitle('⧉ NEURAL BROADCAST LINK')
        .setDescription(
          "```ansi\n" +
          `\u001b[32mINITIALIZING STAFF MATRIX [${bar}] ${progress}%\u001b[0m\n` +
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
      .setTitle('⚠ STAFF BROADCAST SIGNAL ACTIVE ⚠')
      .setDescription(
        "```diff\n" +
        "- SYSTEM NOTICE: STAFF OVERRIDE SIGNAL DETECTED\n" +
        "+ ROUTING ENCRYPTED MESSAGE TO STAFF NODES...\n" +
        "! PRIORITY: HIGH\n" +
        "```\n\n" +

        "```fix\n" +
        `REASON: ${reason}\n` +
        "```\n\n" +

        `${pingLine}\n\n` +

        "```yaml\n" +
        `TRIGGERED_BY: ${userTag} (${userId})\n` +
        `SERVER: ${interaction.guild?.name || "DM"}\n` +
        "MODULE: STAFF BROADCAST SYSTEM\n" +
        "STATUS: ACTIVE\n" +
        "```"
      )
      .setFooter({ text: 'NEON//STAFF-MATRIX v4.3 • SIGNAL LIVE' })
      .setTimestamp();

    await interaction.editReply({ embeds: [finalEmbed] });

    // Arm the cooldown only after the ping actually went out.
    setPingCooldown('staff', interaction.user.id);
  }
};