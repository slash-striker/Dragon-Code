const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    MessageFlags
} = require('discord.js');
const { getUser, updateUser } = require('../systems/economy/userManager');
const ALLOWED_CHANNEL = '1504562791967756448';
const JOBS_PER_PAGE = 5;

/*
 * /job — unified career command (formerly /job-list + /job-apply).
 *
 *   /job action:list   → browse the Netquel career clearance archive (paginated)
 *   /job action:apply  → request your next clearance via select menu
 *
 * A choice option instead of subcommands keeps "/job" as a single slash
 * entry. The pagination buttons keep their `job-list:` customIds (handled by
 * handleComponent below, which index.js wires for button interactions),
 * so old panels keep working after a reload.
 */

// Add or rebalance careers here; the rest of the career system reads this list.
const jobs = [
    { name: 'Dock Worker', description: 'Move cargo through the neon freight arteries.', salary: 90, workRequired: 8, icon: '⚓' },
    { name: 'Orbital Salvager', description: 'Recover valuable tech from abandoned debris fields.', salary: 140, workRequired: 12, icon: '🧲' },
    { name: 'Drone Operator', description: 'Command remote industrial swarms beyond the station hull.', salary: 210, workRequired: 16, icon: '🤖' },
    { name: 'Starship Mechanic', description: 'Keep engines breathing when the void turns hostile.', salary: 300, workRequired: 20, icon: '🔧' },
    { name: 'Shuttle Pilot', description: 'Thread civilian craft through contested jump lanes.', salary: 430, workRequired: 25, icon: '🚀' },
    { name: 'Exploration Officer', description: 'Chart unclaimed systems and classify alien signals.', salary: 600, workRequired: 30, icon: '🔭' },
    { name: 'Recon Specialist', description: 'Extract intelligence from black-zone frontier networks.', salary: 820, workRequired: 36, icon: '📡' },
    { name: 'Fleet Engineer', description: 'Synchronize capital-ship systems across the battle line.', salary: 1_100, workRequired: 42, icon: '⚙️' },
    { name: 'AI Systems Architect', description: 'Build strategic minds trusted with whole sectors.', salary: 1_500, workRequired: 50, icon: '🧠' },
    { name: 'Frigate Commander', description: 'Lead a fast-response strike vessel through deep space.', salary: 2_000, workRequired: 60, icon: '🛡️' },
    { name: 'Battlecruiser Captain', description: 'Command a warship built to hold the line.', salary: 2_700, workRequired: 72, icon: '⚔️' },
    { name: 'Void Operations Director', description: 'Coordinate covert operations across the empire.', salary: 3_600, workRequired: 86, icon: '🌌' },
    { name: 'Admiral', description: 'Direct fleet doctrine for an entire stellar theater.', salary: 4_800, workRequired: 102, icon: '⭐' },
    { name: 'Galactic Strategist', description: 'Turn interstellar chaos into decisive advantage.', salary: 6_400, workRequired: 120, icon: '♟️' },
    { name: 'Sector Governor', description: 'Govern prosperous worlds at the edge of civilization.', salary: 8_500, workRequired: 145, icon: '🏛️' },
    { name: 'Fleet Overseer', description: 'Maintain supremacy across the imperial armada.', salary: 11_200, workRequired: 175, icon: '🛰️' },
    { name: 'High Council Commander', description: 'Answer only to the council and the stars.', salary: 14_800, workRequired: 210, icon: '👁️' },
    { name: 'Supreme Fleet Marshal', description: 'Hold final command of the Netquel war machine.', salary: 20_000, workRequired: null, icon: '👑' }
];

function getCareerLevel(user) {
    const matchingLevel = jobs.findIndex(job => job.name.toLowerCase() === String(user.job).toLowerCase());
    return matchingLevel >= 0 ? matchingLevel : 0;
}

function getJob(level) {
    return jobs[Math.max(0, Math.min(level, jobs.length - 1))];
}

function createProgressBar(value, max, size = 12) {
    if (!max) return '▓'.repeat(size);
    const filled = Math.max(0, Math.min(size, Math.floor((value / max) * size)));
    return `${'▓'.repeat(filled)}${'░'.repeat(size - filled)}`;
}

/* =========================
   /job action:list — career archive
========================= */

function buildPage(user, requestedPage = 0) {
    const careerLevel = getCareerLevel(user);
    const pageCount = Math.ceil(jobs.length / JOBS_PER_PAGE);
    const page = Math.max(0, Math.min(Number(requestedPage) || 0, pageCount - 1));
    const pageJobs = jobs.slice(page * JOBS_PER_PAGE, (page + 1) * JOBS_PER_PAGE);

    const embed = new EmbedBuilder()
        .setColor(0x9b5cff)
        .setTitle('◢ CAREER ARCHIVE // NETQUEL COMMAND ◣')
        .setDescription('```ansi\n\u001b[1;35mCLEARANCE PATHWAYS LOADED · SELECT A LOCKED-IN FUTURE\u001b[0m\n```')
        .setFooter({ text: `Career pathways ${page + 1}/${pageCount} • Use /job action:apply to request clearance` })
        .setTimestamp();

    for (const [offset, job] of pageJobs.entries()) {
        const level = page * JOBS_PER_PAGE + offset;
        const locked = level > careerLevel;
        const active = level === careerLevel;
        const status = active ? '◆ ACTIVE CLEARANCE' : locked ? '🔒 LOCKED' : '✓ COMPLETED';
        const requirement = job.workRequired
            ? `${job.workRequired.toLocaleString()} assignments to unlock next clearance`
            : 'Maximum career clearance achieved';

        embed.addFields({
            name: `${job.icon} ${String(level + 1).padStart(2, '0')} · ${job.name} ${active ? '◆' : ''}`,
            value: `${job.description}\n\n**${status}** · 🪙 ${job.salary.toLocaleString()} / assignment\n\n${requirement}`,
            inline: false
        });
    }

    const navigation = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`job-list:${page - 1}`)
            .setLabel('Previous')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId(`job-list:${page + 1}`)
            .setLabel('Next')
            .setEmoji('▶️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page === pageCount - 1)
    );

    return { embeds: [embed], components: [navigation] };
}

/* =========================
   /job action:apply — clearance request
========================= */

function errorEmbed(title, description) {
    return new EmbedBuilder()
        .setColor(0xff4d9d)
        .setTitle(`◢ ${title} ◣`)
        .setDescription(description)
        .setFooter({ text: 'Netquel Career Grid • Application terminated' });
}

async function runJobApply(interaction) {
    const user = getUser(interaction.user.id);
    const currentLevel = getCareerLevel(user);
    const currentJob = getJob(currentLevel);
    const nextJob = jobs[currentLevel + 1];

    if (!nextJob) {
        return interaction.reply({
            embeds: [errorEmbed('MAXIMUM CLEARANCE', `You already hold ${currentJob.icon} **${currentJob.name}** — the highest clearance in the archive.`)],
            flags: MessageFlags.Ephemeral
        });
    }

    if ((Number(user.jobWorkProgress) || 0) < currentJob.workRequired) {
        const remaining = currentJob.workRequired - (Number(user.jobWorkProgress) || 0);
        return interaction.reply({
            embeds: [errorEmbed('CLEARANCE LOCKED', `Complete **${remaining}** more ${currentJob.icon} **${currentJob.name}** assignment${remaining === 1 ? '' : 's'} before requesting ${nextJob.icon} **${nextJob.name}**.`)],
            flags: MessageFlags.Ephemeral
        });
    }

    // Present the authorized next clearance as a select menu. The progression
    // gate above remains the source of truth, so the UI cannot bypass work
    // requirements.
    const selectableJobs = jobs
        .slice(currentLevel + 1, currentLevel + 26)
        .map((job, index) => {
            const level = currentLevel + index + 1;
            const isNext = level === currentLevel + 1;
            return {
                label: `${job.icon} ${job.name}`.slice(0, 100),
                description: `${isNext ? 'NEXT CLEARANCE' : `LOCKED • LEVEL ${level + 1}`} • ${job.salary.toLocaleString()} credits / assignment`.slice(0, 100),
                value: String(level)
            };
        });
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`job-apply:${interaction.user.id}`)
        .setPlaceholder('Select a career clearance')
        .addOptions(selectableJobs);
    const message = await interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(0x9b5cff)
            .setTitle('◢ CAREER APPLICATION TERMINAL ◣')
            .setDescription(`Select a career from the menu. Only your next unlocked clearance can be accepted.\n\n${selectableJobs.map(option => `${option.label} — ${option.description}`).join('\n')}`)],
        components: [new ActionRowBuilder().addComponents(menu)],
        // PUBLIC — everyone can see you applied (kept non-ephemeral on purpose).
        fetchReply: true
    });
    const collector = message.createMessageComponentCollector({ time: 60_000 });
    collector.on('collect', async component => {
        if (component.user.id !== interaction.user.id) {
            return component.reply({ content: 'This is not your career application.' });
        }
        const selectedLevel = Number(component.values[0]);
        if (selectedLevel !== currentLevel + 1) {
            return component.update({ content: '❌ That clearance is no longer available.', embeds: [], components: [] });
        }
        const selectedJob = jobs[selectedLevel];
        user.job = selectedJob.name;
        user.careerLevel = selectedLevel;
        user.currentJobSalary = selectedJob.salary;
        user.jobWorkProgress = 0;
        user.promotionStatus = 'IN PROGRESS';
        updateUser(user);
        collector.stop();
        return component.update({
            embeds: [new EmbedBuilder()
                .setColor(0x57f287)
                .setTitle('◢ CAREER CLEARANCE GRANTED ◣')
                .setDescription(`Welcome to the next tier, ${interaction.user}.\n\n**NEW POSTING** ${selectedJob.icon} **${selectedJob.name}**\n> ${selectedJob.description}\n**COMPENSATION** \`🪙 ${selectedJob.salary.toLocaleString()} credits / assignment\``)
                .setFooter({ text: 'NETQUEL COMMAND • Career authorization sealed' })
                .setTimestamp()],
            components: []
        });
    });
    collector.on('end', () => message.edit({ components: [] }).catch(() => {}));
}

/* =========================
   MAIN
========================= */

module.exports = {
    data: new SlashCommandBuilder()
        .setName('job')
        .setDescription('Career system: browse clearances or apply for promotion')
        .addStringOption(opt => opt
            .setName('action')
            .setDescription('Browse the archive or apply for your next clearance')
            .addChoices(
                { name: 'List — browse career clearances', value: 'list' },
                { name: 'Apply — request your next clearance', value: 'apply' }
            )),

    async execute(interaction) {
        if (interaction.channelId !== ALLOWED_CHANNEL) {
            return interaction.reply({
                content: `❌ Access denied. Terminal locked to <#${ALLOWED_CHANNEL}>.` });
        }
        if (interaction.options.getString('action') === 'apply') return runJobApply(interaction);
        return interaction.reply(buildPage(getUser(interaction.user.id)));
    },

    // Pagination buttons for /job list (customId prefix `job-list:`).
    async handleComponent(interaction) {
        const [, page] = interaction.customId.split(':');
        return interaction.update(buildPage(getUser(interaction.user.id), page));
    },

    jobs,
    getCareerLevel,
    getJob,
    createProgressBar
};
