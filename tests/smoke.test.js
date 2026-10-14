const test = require('node:test');
const assert = require('node:assert/strict');

test('database initializes expected tables', () => {
  const db = require('../database');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const names = tables.map(({ name }) => name);

  assert.ok(names.includes('users'));
  assert.ok(names.includes('heists'));
  assert.ok(names.includes('inventory'));
  assert.ok(names.includes('casino_settings'));
});

test('leveling module loads without crashing', async () => {
  const leveling = require('../systems/leveling/levelingSystem');

  assert.equal(typeof leveling.getLevelFromXP, 'function');
  assert.equal(leveling.getLevelFromXP(0), 0);
  assert.equal(leveling.getLevelFromXP(150), 1);
  assert.equal(leveling.getLevelFromXP(750), 2);

  const avatarPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAFr7MZAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJ0UkGAAAAAAgIY0l5AAAAC0lEQVR4n2NgYAAAAAIAAeIhvAAAAABJRU5ErkJggg==',
    'base64'
  );

  const card = await leveling.createLevelCard(
    { user: { displayAvatarURL: () => avatarPng } },
    1,
    150,
    0
  );

  assert.ok(card === null || Buffer.isBuffer(card));
  leveling.stopCleanupTimers();
});

test('casino table renderer loads and returns an attachment', () => {
  const { casinoTable } = require('../systems/casino/tableRenderer');
  const attachment = casinoTable({
    title: 'Smoke Test',
    playerCards: [{ suit: '♥', value: 'A' }],
    dealerCards: [{ suit: '♣', value: 'K' }],
    status: 'ok',
    filename: 'table.png'
  });

  assert.ok(attachment);
  assert.equal(attachment.name, 'table.png');
});

test('inventory helpers can add and remove items', () => {
  const db = require('../database');
  const { addItem, removeItem, hasItem } = require('../systems/economy/inventoryh');
  const userId = 'inventory-smoke-user';

  db.prepare('DELETE FROM inventory WHERE userId = ?').run(userId);
  addItem(userId, 'coffee', 2);
  assert.equal(hasItem(userId, 'coffee'), true);
  removeItem(userId, 'coffee', 1);
  assert.equal(db.prepare('SELECT quantity FROM inventory WHERE userId = ? AND itemId = ?').get(userId, 'coffee').quantity, 1);
});

test('user manager preserves core stats and defaults', () => {
  const db = require('../database');
  const { getUser, updateUser } = require('../systems/economy/userManager');
  const userId = 'user-manager-smoke-user';

  db.prepare('DELETE FROM users WHERE userId = ?').run(userId);

  const user = getUser(userId);
  assert.equal(user.wallet, 0);
  assert.equal(user.xp, 0);
  assert.equal(user.level, 0);

  updateUser({ ...user, userId, wallet: 250, xp: 50, level: 1, uiStyle: 'normal' });
  const updated = getUser(userId);
  assert.equal(updated.wallet, 250);
  assert.equal(updated.xp, 50);
  assert.equal(updated.level, 1);
  assert.equal(updated.uiStyle, 'normal');
});

test('lottery state recovers from malformed data', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const lotteryPath = path.join(__dirname, '..', 'lottery.json');
  const original = fs.existsSync(lotteryPath) ? fs.readFileSync(lotteryPath, 'utf8') : null;

  fs.writeFileSync(lotteryPath, '{broken json');
  const lottery = require('../systems/lottery/lotteryManager');
  const state = lottery.load();

  assert.ok(state && Array.isArray(state.entries));
  assert.equal(state.pool, 0);

  if (original === null) {
    fs.unlinkSync(lotteryPath);
  } else {
    fs.writeFileSync(lotteryPath, original);
  }
});

test('welcome card helper can render an image buffer', async () => {
  const { createWelcomeCard } = require('../events/guildMemberAdd');
  const avatarPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAFr7MZAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJ0UkGAAAAAAgIY0l5AAAAC0lEQVR4n2NgYAAAAAIAAeIhvAAAAABJRU5ErkJggg==',
    'base64'
  );

  const buffer = await createWelcomeCard({
    user: { username: 'TestUser', displayAvatarURL: () => avatarPng },
    guild: { name: 'Test Guild', memberCount: 42 }
  });

  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 1000);
});
