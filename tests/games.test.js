const test = require('node:test');
const assert = require('node:assert/strict');

test('lightsout solver produces optimal solutions', () => {
    const { createSolvableGrid, solveLightsOut, getOptimalMoves, toggleLight, isSolved } = require('../commands/lightsout');

    for (const size of [3, 4, 5]) {
        const grid = createSolvableGrid(size, 12345);
        const solution = solveLightsOut(grid, size);
        assert.ok(solution, `solver should solve a ${size}x${size} board`);

        // Applying the solution must turn every light off.
        const board = [...grid];
        for (const index of solution) toggleLight(board, index, size);
        assert.ok(isSolved(board), `solution clears the ${size}x${size} board`);
        assert.equal(getOptimalMoves(grid, size), solution.length);
    }
});

test('lightsout daily seed is deterministic per day', () => {
    const { getDailySeed, createSolvableGrid } = require('../commands/lightsout');
    const morning = new Date('2026-09-17T08:00:00Z');
    const evening = new Date('2026-09-17T20:00:00Z');
    assert.equal(getDailySeed(morning), getDailySeed(evening));
    assert.equal(getDailySeed(morning), getDailySeed(new Date('2026-09-17T23:59:59Z')));
    const gridA = createSolvableGrid(4, getDailySeed(morning));
    const gridB = createSolvableGrid(4, getDailySeed(evening));
    assert.deepEqual(gridA, gridB);
});

test('lightsout reward respects efficiency and difficulty caps', () => {
    const { calculateReward, calculateEfficiency } = require('../commands/lightsout');
    assert.equal(calculateEfficiency(10, 5), 50);
    assert.equal(calculateEfficiency(5, 5), 100);

    const easyPerfect = calculateReward({ difficulty: 'easy', attempts: 4, optimalMoves: 4, hintsUsed: 0, mode: 'classic' });
    // 200 base + 150 efficiency + 100 no-hint, capped at 500.
    assert.equal(easyPerfect, 450);
    const easyCapped = calculateReward({ difficulty: 'easy', attempts: 4, optimalMoves: 4, hintsUsed: 1, mode: 'classic' });
    assert.equal(easyCapped, 350);
    // Challenge boosts by 1.25x but the cap still applies.
    const challenge = calculateReward({ difficulty: 'hard', attempts: 5, optimalMoves: 5, hintsUsed: 0, mode: 'challenge' });
    assert.equal(challenge, 1800);
});

test('mastermind evaluateGuess handles duplicates like the classic rules', () => {
    const { evaluateGuess, createSecret } = require('../commands/mastermind');
    const secret = ['🔴', '🟢', '🟢', '🔵'];

    assert.deepEqual(evaluateGuess(secret, ['🔴', '🟢', '🟢', '🔵']), { correctPosition: 4, correctColor: 0 });
    assert.deepEqual(evaluateGuess(secret, ['🔵', '🟢', '🔴', '🟢']), { correctPosition: 1, correctColor: 3 });
    assert.deepEqual(evaluateGuess(secret, ['⚪', '⚪', '⚪', '⚪']), { correctPosition: 0, correctColor: 0 });
    assert.deepEqual(evaluateGuess(secret, ['🔴', '🔴', '🔴', '🔴']), { correctPosition: 1, correctColor: 0 });

    // Seeded daily codes are reproducible; unseeded codes use the right difficulty.
    assert.deepEqual(createSecret('normal', true, '2026-09-17'), createSecret('normal', true, '2026-09-17'));
    assert.equal(createSecret('easy', false).length, 3);
    assert.equal(createSecret('expert', true).length, 6);
    const unique = createSecret('hard', false);
    assert.equal(new Set(unique).size, unique.length, 'no-duplicate secrets never repeat a color');
});

test('highlow multipliers match published probabilities and presets', () => {
    const { rollMultiplier, rollMysteryMultiplier, getSameMultiplier, determineWin, generateNumber } = require('../commands/highlow');

    assert.equal(getSameMultiplier('safe'), 3);
    assert.equal(getSameMultiplier('classic'), 5);
    assert.equal(getSameMultiplier('aggressive'), 7);

    // Statistical sanity: over many rolls, specials stay rare and within bands.
    let specials = 0;
    const trials = 20000;
    for (let i = 0; i < trials; i++) {
        const { type } = rollMultiplier();
        if (type !== 'normal') specials++;
    }
    const rate = specials / trials;
    assert.ok(rate > 0.20 && rate < 0.30, `special rate ${rate} should be ~25%`);

    const mysteryValues = new Set(Array.from({ length: 500 }, () => rollMysteryMultiplier()));
    for (const value of mysteryValues) assert.ok([2, 2.5, 3, 5].includes(value));

    assert.equal(determineWin('higher', 10, 11), true);
    assert.equal(determineWin('higher', 10, 10), false);
    assert.equal(determineWin('lower', 10, 9), true);
    assert.equal(determineWin('same', 10, 10), true);
    const n = generateNumber();
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 100);
});

test('five dice renderer produces the neon dice panel attachment', async () => {
    const { renderDiceRow, UNICODE_FACES } = require('../commands/../systems/games/diceRenderer');

    const rendered = await renderDiceRow([5, 3, 3, 1, 6], [false, true, true, false, false]);
    if (rendered.attachment) {
        assert.equal(rendered.attachment.name, 'five-dice.png');
        assert.ok(rendered.attachment.attachment.length > 5000, 'rendered PNG has real content');
    } else {
        // Canvas unavailable in this environment: unicode fallback must still work.
        assert.equal(rendered.fallback, '⚄ ⚂ ⚂ ⚀ ⚅');
    }
    assert.equal(UNICODE_FACES.length, 6);
});

test('highscore registry stores, ranks, and syncs leaderboard state', () => {
    const db = require('../database');
    const hs = require('../systems/highscores/highscoreManager');

    // Isolate from any previous run.
    db.prepare('DELETE FROM netquel_highscores').run();
    db.prepare("DELETE FROM bot_meta WHERE key = 'hs:leaderboardMessageId'").run();

    hs.setHighscore('hs-a', 4200, 'admin', 'first');
    assert.equal(hs.getHighscore('hs-a').note, 'first');
    hs.setHighscore('hs-b', 9000, 'admin');
    hs.setHighscore('hs-a', 5500, 'admin'); // full overwrite replaces note too

    assert.equal(hs.getHighscore('hs-a').score, 5500);
    assert.equal(hs.getHighscore('hs-c'), null);
    assert.equal(hs.getHighscoreRank('hs-b'), 1);
    assert.equal(hs.getHighscoreRank('hs-a'), 2);
    assert.equal(hs.getHighscoreRank('hs-c'), null);
    assert.deepEqual(
        hs.getTopHighscores(2).map(entry => entry.userId),
        ['hs-b', 'hs-a']
    );

    hs.setLeaderboardMessageId('msg-42');
    assert.equal(hs.getLeaderboardMessageId(), 'msg-42');

    // The leaderboard embed builds with entries present and after cleanup.
    const embed = require('../commands/hs').buildLeaderboardEmbed();
    assert.match(embed.data.title, /HIGHSCORES/);

    db.prepare('DELETE FROM netquel_highscores').run();
    const emptyEmbed = require('../commands/hs').buildLeaderboardEmbed();
    assert.match(emptyEmbed.data.title, /HIGHSCORES/);
});

test('hangman helpers compute display, rewards, and hints', () => {
    const { getDisplayWord, isWordGuessed, getRemainingLetters, getFinalReward, getRandomWord } = require('../commands/hangman');

    const guessed = new Set(['A', 'P']);
    assert.equal(getDisplayWord('APPLE', guessed), 'A P P ＿ ＿');
    assert.equal(isWordGuessed('APPLE', guessed), false);
    assert.deepEqual(getRemainingLetters('APPLE', guessed), ['L', 'E']);
    assert.equal(getRemainingLetters('APPLE', new Set('APPLE'.split(''))).length, 0);

    assert.equal(getFinalReward({ reward: 300, hintsUsed: 1, hintPenalty: 50 }), 250);
    // Rewards never drop below the 25-credit floor.
    assert.equal(getFinalReward({ reward: 200, hintsUsed: 5, hintPenalty: 100 }), 25);

    const word = getRandomWord('animals');
    assert.ok(word.length > 0);
    // Unknown categories fall back to general.
    assert.ok(getRandomWord('does-not-exist').length > 0);
});
