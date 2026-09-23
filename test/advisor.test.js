import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';
import { advise } from '../src/advisor.js';
import { initialState, setDefenders, setAttackers, setChoices, setLayouts } from '../src/pairing.js';
import { randomModel } from './helpers.js';

test('advice follows the whole 6-player pairing', () => {
  const { mu, sd } = randomModel(6, 4);
  const e = createEngine({ n: 6, mu, sd });
  let s = initialState(6);
  let progress = 0;
  let adv = advise(e, s, mu, sd, (p) => { progress = p; });
  assert.equal(progress, 1);
  assert.equal(adv.rows.length, 6);
  const pSum = adv.rows.reduce((a, r) => a + r.prob, 0);
  assert.ok(Math.abs(pSum - 1) < 1e-9);
  for (const r of adv.rows) assert.ok(r.worst <= r.vsEq + 1e-12 && r.vsEq <= r.best + 1e-12);
  // Every option played with positive probability is worth the game value.
  for (const r of adv.rows) if (r.prob > 1e-6) assert.ok(Math.abs(r.vsEq - adv.value) < 1e-6);

  const pick = (a) => a.rows.reduce((b, r) => (r.vsEq > b.vsEq ? r : b)).label;
  const pickCol = (a) => a.cols.reduce((b, c) => (c.vsEq < b.vsEq ? c : b)).label;
  s = setDefenders(s, pick(adv), pickCol(adv));
  adv = advise(e, s, mu, sd);
  assert.equal(adv.step, 'attackers');
  assert.equal(adv.rows.length, 10); // C(5,2)
  s = setAttackers(s, pick(adv), pickCol(adv));
  adv = advise(e, s, mu, sd);
  assert.equal(adv.step, 'choices');
  s = setChoices(s, adv.rows.findIndex((r) => r.label === pick(adv)), adv.cols.findIndex((c) => c.label === pickCol(adv)));
  adv = advise(e, s, mu, sd);
  assert.equal(adv.step, 'layouts');
  assert.equal(adv.options.length, 3);
  const best = adv.options[adv.best].metrics.obj;
  for (const o of adv.options) assert.ok(o.metrics.obj <= best + 1e-12);
  s = setLayouts(s, adv.best, adv.theirAssumed);
  adv = advise(e, s, mu, sd);
  assert.equal(adv.step, 'defenders');
  assert.equal(adv.rows.length, 4);
});

test('done state reports exact final projection', () => {
  const { mu, sd } = randomModel(3, 8);
  const e = createEngine({ n: 3, mu, sd });
  let s = initialState(3);
  s = setLayouts(setChoices(setAttackers(setDefenders(s, 0, 0), [1, 2], [1, 2]), 0, 0), 0, 0);
  const adv = advise(e, s, mu, sd);
  assert.equal(adv.step, 'done');
  const expected = mu[0][0][1] + mu[0][1][0] + mu[0][2][2];
  assert.ok(Math.abs(adv.projection.bp - expected) < 1e-9);
});
