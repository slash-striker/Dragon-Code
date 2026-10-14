const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ANSI = {
    blue: '\x1b[34m',
    lightBlue: '\x1b[94m',
    red: '\x1b[31m',
    reset: '\x1b[0m'
};

function progressBar(percent, width = 16) {
    const filled = Math.round((percent / 100) * width);
    return `${ANSI.blue}[${ANSI.lightBlue}${'█'.repeat(filled)}${ANSI.red}${'░'.repeat(width - filled)}${ANSI.blue}]${ANSI.reset} ${ANSI.lightBlue}${percent}%${ANSI.reset}`;
}

function glitchFrame(percent) {
    const corrupted = percent < 50 ? '0xD3P_// SYNC LOST' : '0xV4U1T_// PACKET CORRUPT';
    return [
        `${ANSI.red}[${'▓'.repeat(5)}${'░'.repeat(11)}] ??%${ANSI.reset}`,
        `${ANSI.red}${corrupted}${ANSI.reset}`,
        `${ANSI.red}// BUFFER DESYNC // RETRYING //${ANSI.reset}`
    ].join('\n');
}

async function runCyberProgress(interaction, {
    title,
    stages,
    fallback = 'Processing transaction...'
}) {
    const sequence = stages.length ? stages : [{ percent: 100, message: fallback }];
    const first = sequence[0];
    await interaction.reply({
        content: `\`\`\`ansi\n\u001b[1;36m${title}\u001b[0m\n${progressBar(first.percent)}\n\u001b[2;37m${first.message}\u001b[0m\n\`\`\``
    });

    for (let index = 1; index < sequence.length; index += 1) {
        const stage = sequence[index];
        await delay(stage.delay ?? 420);
        if (index % 2 === 0) {
            await interaction.editReply({
                content: `\`\`\`ansi\n${ANSI.lightBlue}${title}${ANSI.reset}\n${glitchFrame(stage.percent)}\n\`\`\``
            });
            await delay(150);
        }
        await interaction.editReply({
            content: `\`\`\`ansi\n${ANSI.lightBlue}${title}${ANSI.reset}\n${progressBar(stage.percent)}\n${ANSI.lightBlue}${stage.message}${ANSI.reset}\n\`\`\``
        });
    }
}

module.exports = { runCyberProgress };
