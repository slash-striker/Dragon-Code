const { SlashCommandBuilder } = require('discord.js');
const { NEON, panel, gameEmbed } = require('../systems/games/gamenightUI');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('game-night')
        .setDescription('The Game Night hub — every party game on the station'),
    async execute(interaction) {
        const embed = gameEmbed({
            userId: interaction.user.id,
            title: 'GAME NIGHT',
            color: NEON.purple,
            lines: [
                panel(
                    '```\n' +
                    'ARCADE ONLINE — 7 MODULES\n' +
                    '=========================\n' +
                    '🎡 roulette ......... /roulette amount:<#> bet_type:<color/area> number:<0-36> — instant spin\n' +
                    '🔢 guess-number ..... free to play · 🪙500K to the exact hit\n' +
                    '💣 bomb ............. co-op defusal\n' +
                    '⚡ math ............. fastest brain wins\n' +
                    '🕵️ mafia ............ social deduction\n' +
                    '🎭 spy .............. bluff or bust\n' +
                    '💬 activities ...... qotd + party games\n' +
                    '```'
                ),
                '> 🎡 **Roulette** — `/roulette amount:<#> bet_type:red` or `number:17` — one command, one spin, instant result.',
                '> 🔢 **Guess the Number** — type a number 1–1000 in the vault channel. ✅ wins the pot, ❌ burns your fee, 🔁 was taken.',
                '> 💣 **Bomb Defusal** — `/activities action:bomb` · up to 5 engineers, 5 stages, 2 wrong wires and 💥.',
                '> ⚡ **Math Duel** — `/activities action:math` · first correct click takes the pot.',
                '> 🕵️ **Mafia: Neon Protocol** — `/activities action:mafia` · 5–10 players, night kills, day lynch votes, role DMs.',
                '> 🎭 **Spy Hunters** — `/activities action:spy` · one player gets no location; interrogate, then vote.',
                '> 💬 **QOTD** — `/activities action:start` · a logged quote appears; guess who said it.',
                '',
                '> 📼 **Log a quote for QOTD:** react to any message with the watch emoji (949479338275913799), or ping that emoji on the message — the bot stores who said it and what they said.',
                '> 🏆 Payouts go straight to your wallet. Trust no one. Have fun.'
            ],
            footer: 'GAME NIGHT · the arcade never closes'
        });
        await interaction.reply({ embeds: [embed] });
    }
};
