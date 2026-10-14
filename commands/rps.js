const { SlashCommandBuilder, ButtonStyle } = require('discord.js');
const { startGame, payout, showStats } = require('../systems/games/gameHelper');
const choices = ['rock', 'paper', 'scissors'];
module.exports = {
    data: new SlashCommandBuilder().setName('rps').setDescription('Play rock paper scissors').addStringOption(option => option.setName('mode').setDescription('Play or view stats').addChoices({ name: 'Play', value: 'play' }, { name: 'Stats', value: 'stats' })),
    async execute(interaction) {
        if (interaction.options.getString('mode') === 'stats') return showStats(interaction, 'rps', '✊ RPS Statistics');
        const state = { choice: null, ended: false };
        return startGame(interaction, { initialState: state, key: 'rps', title: '✊ Rock Paper Scissors', description: () => 'Choose your move. Win **🪙300**.', buttons: () => choices.map(c => ({ id: `rps:${c}`, label: c[0].toUpperCase() + c.slice(1), style: ButtonStyle.Primary })), onClick: async ({ button, state: game, message, end }) => {
            const player = button.customId.split(':')[1]; const bot = choices[Math.floor(Math.random() * 3)];
            const win = (player === 'rock' && bot === 'scissors') || (player === 'paper' && bot === 'rock') || (player === 'scissors' && bot === 'paper');
            game.ended = true; end(); await payout(interaction.user.id, 'rps', player === bot ? 100 : win ? 300 : 0, message, `RPS: ${player} vs ${bot}`);
        }});
    }
};
