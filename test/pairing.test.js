import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, setDefenders, setAttackers, setChoices, setLayouts, accumulated } from '../src/pairing.js';
import { constantModel } from './helpers.js';

// Plays a full pairing always picking the lowest available indices.
function playThrough(n, round = 1) {
  let s = initialState(n, round);
  while (s.step !== 'done') {
    const a = [], b = [];
    for (let i = 0; i < n; i++) { if ((s.remA >> i) & 1) a.push(i); if ((s.remB >> i) & 1) b.push(i); }
    s = setDefenders(s, a[0], b[0]);
    s = setAttackers(s, [a[1], a[2]], [b[1], b[2]]);
    s = setChoices(s, 1, 0);
    s = setLayouts(s, 2, 1);
  }
  return s;
}

for (const n of [3, 4, 5, 6, 7, 8]) {
  test(`${n} players: every player paired exactly once`, () => {
    const s = playThrough(n);
    assert.equal(s.games.length, n);
    assert.deepEqual(s.games.map((g) => g.a).sort(), [...Array(n).keys()]);
    assert.deepEqual(s.games.map((g) => g.b).sort(), [...Array(n).keys()]);
  });
}

test('6 players: Initial Skirmish, Main Engagement with refused attackers, Champion', () => {
  const s = playThrough(6, 2);
  const roles = s.games.map((g) => `${g.module}:${g.role}`);
  assert.deepEqual(roles, [
    '0:ourDefender', '0:theirDefender',
    '1:ourDefender', '1:theirDefender', '1:refused',
    '2:champion',
  ]);
  // Round 2 -> refused attackers and champions play Layout B.
  assert.equal(s.games[4].layout, 1);
  assert.equal(s.games[5].layout, 1);
  // Defenders keep the layout they declared.
  assert.equal(s.games[0].layout, 2);
  assert.equal(s.games[1].layout, 1);
});

test('Initial Skirmish: refused attackers go back to the pool', () => {
  let s = initialState(6);
  s = setDefenders(s, 0, 0);
  s = setAttackers(s, [1, 2], [3, 4]);
  s = setChoices(s, 1, 0); // our defender plays their 4, their defender plays our 1
  s = setLayouts(s, 0, 0);
  assert.deepEqual(s.games.map((g) => [g.a, g.b]), [[0, 4], [1, 0]]);
  assert.equal(s.remA, 0b111100); // 2..5 remain (2 was refused)
  assert.equal(s.remB, 0b101110); // 1,2,3,5 remain (3 was refused)
});

test('invalid selections are rejected', () => {
  let s = initialState(6);
  assert.throws(() => setAttackers(s, [1, 2], [1, 2]));
  s = setDefenders(s, 0, 0);
  assert.throws(() => setDefenders(s, 1, 1));
  assert.throws(() => setAttackers(s, [0, 1], [1, 2]), /Invalid/); // defender cannot attack
  assert.throws(() => setAttackers(s, [1, 1], [1, 2]), /Invalid/);
  s = setAttackers(s, [1, 2], [1, 2]);
  assert.throws(() => setChoices(s, 2, 0));
});

test('accumulated mean and variance', () => {
  const s = playThrough(6);
  const { mu, sd } = constantModel(6, 12, 3);
  const acc = accumulated(s, mu, sd);
  assert.equal(acc.M, 72);
  assert.equal(acc.V, 54);
});
