import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODULES_BY_SIZE, WIN_DIFFERENTIAL, vpDiffToBp, thresholds, layoutForRound } from '../src/rules.js';

// Source: Warhammer 40,000 Teams Event Companion v1.0, sections 2 and 14.

test('modules per team size', () => {
  assert.deepEqual(MODULES_BY_SIZE[6], ['S', 'M', 'C']);
  assert.deepEqual(MODULES_BY_SIZE[8], ['S', 'S', 'M', 'C']);
  assert.deepEqual(MODULES_BY_SIZE[3], ['M']);
  // Each module consumes: S = 2, M = 3, C = 1 player per team.
  const used = { S: 2, M: 3, C: 1 };
  for (const [n, mods] of Object.entries(MODULES_BY_SIZE)) {
    assert.equal(mods.reduce((s, m) => s + used[m], 0), Number(n), `size ${n}`);
  }
});

test('BP table: companion example 86-54 gives 16 / 4', () => {
  assert.equal(vpDiffToBp(32), 16);
  assert.equal(vpDiffToBp(-32), 4);
});

test('BP table boundaries', () => {
  assert.equal(vpDiffToBp(0), 10);
  assert.equal(vpDiffToBp(5), 10);
  assert.equal(vpDiffToBp(-5), 10);
  assert.equal(vpDiffToBp(6), 11);
  assert.equal(vpDiffToBp(50), 19);
  assert.equal(vpDiffToBp(51), 20);
  assert.equal(vpDiffToBp(-51), 0);
  for (let d = -80; d <= 80; d++) assert.equal(vpDiffToBp(d) + vpDiffToBp(-d), 20);
});

test('team win thresholds', () => {
  assert.equal(WIN_DIFFERENTIAL[6], 8);
  assert.equal(WIN_DIFFERENTIAL[8], 12);
  assert.deepEqual(thresholds(6), { win: 64, loss: 56, total: 120, differential: 8 });
  assert.deepEqual(thresholds(8), { win: 86, loss: 74, total: 160, differential: 12 });
  // Companion example (5 players): 54 vs 46 is a win (difference 8 >= 6).
  const t5 = thresholds(5);
  assert.ok(54 >= t5.win);
  assert.ok(53 >= t5.win);
  assert.ok(!(52 >= t5.win));
});

test('fixed layout by round: A, B, C, A...', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(layoutForRound), [0, 1, 2, 0, 1]);
});
