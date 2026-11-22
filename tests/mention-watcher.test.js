const test = require('node:test');
const assert = require('node:assert');

const watcher = require('../events/mentionWatcher');

test('mention watcher: "play" is no longer a typo of "slay"', () => {
    // The reported false positive: the word "play" used to sit one edit from
    // the four-letter keyword "slay" and summoned the owner.
    assert.strictEqual(watcher.findKeyword('do u play still softbear games no'), null);
    assert.strictEqual(watcher.findKeyword('play'), null);
});

test('mention watcher: real keywords and longer typos still summon', () => {
    assert.strictEqual(watcher.findKeyword('slay'), 'slay');
    assert.strictEqual(watcher.findKeyword('slash'), 'slash');
    assert.strictEqual(watcher.findKeyword('striker'), 'striker');
    // A one-edit typo of a longer keyword still matches.
    assert.ok(watcher.findKeyword('strikerq'));
});
