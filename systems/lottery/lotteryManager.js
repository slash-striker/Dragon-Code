const fs = require("fs");
const path = require("path");

const LOTTERY_FILE = path.join(__dirname, "../../lottery.json");

function nextSundayNoonEST() {
    const now = new Date();

    // Convert roughly to Eastern Time.
    // (We'll improve this later using cron in Phase 4.)
    const est = new Date(
        now.toLocaleString("en-US", {
            timeZone: "America/New_York"
        })
    );

    const target = new Date(est);

    target.setHours(12, 0, 0, 0);

    const daysUntilSunday = (7 - target.getDay()) % 7;

    target.setDate(target.getDate() + daysUntilSunday);

    if (target <= est)
        target.setDate(target.getDate() + 7);

    return target.getTime();
}

function defaultLottery() {
    return {
        drawAt: nextSundayNoonEST(),
        entries: [],
        pool: 0,
        lastWinner: null
    };
}

function save(data) {
    fs.writeFileSync(
        LOTTERY_FILE,
        JSON.stringify(data, null, 4)
    );
}

function load() {
    if (!fs.existsSync(LOTTERY_FILE)) {
        const data = defaultLottery();
        save(data);
        return data;
    }

    try {
        const raw = fs.readFileSync(LOTTERY_FILE, "utf8");
        const parsed = JSON.parse(raw);

        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Lottery state is not an object.');
        }

        return {
            drawAt: parsed.drawAt ?? defaultLottery().drawAt,
            entries: Array.isArray(parsed.entries) ? parsed.entries : [],
            pool: Number(parsed.pool) || 0,
            lastWinner: parsed.lastWinner ?? null
        };
    } catch (error) {
        console.warn('Lottery state was invalid or unreadable; resetting to defaults.', error.message);
        const data = defaultLottery();
        save(data);
        return data;
    }
}

function addEntry(userId, amount) {

    const lottery = load();

    const existing = lottery.entries.find(
        e => e.userId === userId
    );

    if (existing) {

        existing.amount += amount;

    } else {

        lottery.entries.push({
            userId,
            amount
        });

    }

    lottery.pool += amount;

    save(lottery);

    return lottery;
}

function getPool() {

    return load().pool;

}

function getPrize() {

    return getPool() * 2;

}

function getEntries() {

    return load().entries;

}

function pickWinner() {

    const lottery = load();

    if (!lottery.entries.length)
        return null;

    const totalWeight = lottery.entries.reduce(
        (sum, e) => sum + e.amount,
        0
    );

    let random = Math.random() * totalWeight;

    for (const entry of lottery.entries) {

        random -= entry.amount;

        if (random <= 0) {

            lottery.lastWinner = entry.userId;

            save(lottery);

            return entry;

        }

    }

    return lottery.entries[0];

}

function resetLottery() {

    const lottery = defaultLottery();

    save(lottery);

}

module.exports = {

    load,

    save,

    addEntry,

    getPool,

    getPrize,

    getEntries,

    pickWinner,

    resetLottery

};