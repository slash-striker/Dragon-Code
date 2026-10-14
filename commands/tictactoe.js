const { SlashCommandBuilder, ButtonStyle } = require('discord.js');
const { startGame, payout, showStats } = require('../systems/games/gameHelper');
module.exports = { data: new SlashCommandBuilder().setName('tictactoe').setDescription('Play Tic-Tac-Toe against the bot').addStringOption(option => option.setName('mode').setDescription('Play or view stats').addChoices({ name: 'Play', value: 'play' }, { name: 'Stats', value: 'stats' })), async execute(interaction) {
    if (interaction.options.getString('mode') === 'stats') return showStats(interaction, 'tictactoe', '❌ Tic-Tac-Toe Statistics');
    const state = { board: Array(9).fill(''), ended: false };
    const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    const winner = b => lines.find(([a,c,d]) => b[a] && b[a] === b[c] && b[a] === b[d]);
    const winningMove = b => {
        for (const index of b.map((v, i) => v ? -1 : i).filter(i => i >= 0)) {
            b[index] = 'O';
            if (winner(b)) { b[index] = ''; return index; }
            b[index] = '';
        }
        return null;
    };
    return startGame(interaction, { initialState: state, key: 'tictactoe', title: '❌ Tic-Tac-Toe', description: s => `\`${s.board.map((v, i) => v || `${i + 1}`).slice(0, 3).join(' | ')}\`\n\`${s.board.slice(3, 6).map((v, i) => v || `${i + 4}`).join(' | ')}\`\n\`${s.board.slice(6).map((v, i) => v || `${i + 7}`).join(' | ')}\``, buttons: () => state.board.map((_, i) => ({ id: `ttt:${i}`, label: state.board[i] || `${i + 1}`, style: ButtonStyle.Secondary, disabled: Boolean(state.board[i]) })), onClick: async ({ button, state: game, message, end }) => {
        const i = Number(button.customId.split(':')[1]); if (game.board[i]) return; game.board[i] = 'X';
        if (!winner(game.board) && game.board.includes('')) {
            const move = winningMove(game.board);
            if (move === null) {
                const open = game.board.map((v, n) => v ? -1 : n).filter(n => n >= 0);
                game.board[open.includes(4) ? 4 : open[Math.floor(Math.random() * open.length)]] = 'O';
            }
        }
        const win = winner(game.board); const done = win || !game.board.includes(''); if (done) { const won = win && game.board[win[0]] === 'X'; game.ended = true; end(); await payout(interaction.user.id, 'tictactoe', won ? 500 : 0, message, won ? 'Tic-Tac-Toe win!' : win ? 'Tic-Tac-Toe lost' : 'Tic-Tac-Toe draw'); }
    }});
}};
