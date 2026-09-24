import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, bits, pairs, phi } from '../src/engine.js';
import { solveMatrixGame } from '../src/matrixgame.js';
import { MODULES_BY_SIZE, thresholds, layoutForRound } from '../src/rules.js';
import { randomModel, constantModel } from './helpers.js';

const full = (n) => (1 << n) - 1;

// Independent brute-force reference: plain recursion over the pairing tree,
// no memo, no snapping, no fast path.
function bruteForce(n, mu, sd, round, obj) {
  const mods = MODULES_BY_SIZE[n];
  const th = thresholds(n);
  const fl = layoutForRound(round);
  const best = (a, b) => [0, 1, 2].reduce((x, l) => (mu[l][a][b] > mu[x][a][b] ? l : x), 0);
  const worst = (a, b) => [0, 1, 2].reduce((x, l) => (mu[l][a][b] < mu[x][a][b] ? l : x), 0);
  const term = (M, V) => {
    const s = Math.sqrt(V);
    const pW = 1 - phi((th.win - 0.5 - M) / s), pL = phi((th.loss + 0.5 - M) / s);
    return obj(pW, 1 - pW - pL, pL, M);
  };
  function rec(remA, remB, mod, M, V) {
    if (mod >= mods.length) return term(M, V);
    if (mods[mod] === 'C') {
      const a = bits(remA)[0], b = bits(remB)[0];
      return rec(0, 0, mod + 1, M + mu[fl][a][b], V + sd[fl][a][b] ** 2);
    }
    const D = bits(remA).map((dA) => bits(remB).map((dB) => {
      const PA = pairs(bits(remA & ~(1 << dA))), PB = pairs(bits(remB & ~(1 << dB)));
      const Att = PA.map((pa) => PB.map((pb) => {
        const C = [0, 1].map((k) => [0, 1].map((l) => {
          const g1 = [dA, pb[k], best(dA, pb[k])], g2 = [pa[l], dB, worst(pa[l], dB)];
          let m = M + mu[g1[2]][g1[0]][g1[1]] + mu[g2[2]][g2[0]][g2[1]];
          let v = V + sd[g1[2]][g1[0]][g1[1]] ** 2 + sd[g2[2]][g2[0]][g2[1]] ** 2;
          let nA, nB;
          if (mods[mod] === 'M') {
            m += mu[fl][pa[1 - l]][pb[1 - k]]; v += sd[fl][pa[1 - l]][pb[1 - k]] ** 2;
            nA = remA & ~(1 << dA) & ~(1 << pa[0]) & ~(1 << pa[1]);
            nB = remB & ~(1 << dB) & ~(1 << pb[0]) & ~(1 << pb[1]);
          } else {
            nA = remA & ~(1 << dA) & ~(1 << pa[l]);
            nB = remB & ~(1 << dB) & ~(1 << pb[k]);
          }
          return rec(nA, nB, mod + 1, m, v);
        }));
        return solveMatrixGame(C).v;
      }));
      return solveMatrixGame(Att).v;
    }));
    return solveMatrixGame(D).v;
  }
  return rec(full(n), full(n), 0, 0, 0);
}

const TP = (pW, pD) => pW + 0.5 * pD;
const tiny = { mean: 1e-6, variance: 1e-6 };

for (const n of [3, 4, 5]) {
  test(`${n} players: engine matches brute force (team points objective)`, () => {
    for (const seed of [1, 2, 3]) {
      const { mu, sd } = randomModel(n, seed);
      const e = createEngine({ n, mu, sd, round: 2, quantum: tiny });
      const ref = bruteForce(n, mu, sd, 2, TP);
      assert.ok(Math.abs(e.objModule(full(n), full(n), 0, 0, 0) - ref) < 1e-6, `seed ${seed}: ${e.objModule(full(n), full(n), 0, 0, 0)} vs ${ref}`);
    }
  });
}

test('4 players: margin objective matches brute force expected BP', () => {
  const { mu, sd } = randomModel(4, 9);
  const e = createEngine({ n: 4, mu, sd, quantum: tiny, objective: { marginWeight: 1 } });
  const ref = bruteForce(4, mu, sd, 1, (pW, pD, pL, M) => M / 80);
  assert.ok(Math.abs(e.objModule(15, 15, 0, 0, 0) - ref) < 1e-9);
});

test('fast final-module path equals generic stage evaluation', () => {
  const { mu, sd } = randomModel(8, 5);
  const e = createEngine({ n: 8, mu, sd });
  // Main Engagement with 4 players left (module index 2 for 8 players).
  const remA = 0b10110100, remB = 0b01011010;
  const fast = e.objModule(remA, remB, 2, 40, 64);
  const generic = e.objDefenderStage(remA, remB, 2, 40, 64).eq.v;
  assert.ok(Math.abs(fast - generic) < 1e-12);
});

test('metrics layer agrees with objective layer', () => {
  const { mu, sd } = randomModel(6, 11);
  const e = createEngine({ n: 6, mu, sd });
  const obj = e.objModule(63, 63, 0, 0, 0);
  const met = e.metModule(63, 63, 0, 0, 0);
  assert.ok(Math.abs(met[0] - obj) < 1e-9);
  assert.ok(Math.abs(met[1] + met[2] + met[3] - 1) < 1e-9);
  // obj = P(win) + 0.5 P(draw) by default
  assert.ok(Math.abs(met[1] + 0.5 * met[2] - obj) < 1e-6);
});

test('perfectly even matrix gives an even match', () => {
  const { mu, sd } = constantModel(6, 10);
  const met = createEngine({ n: 6, mu, sd }).metModule(63, 63, 0, 0, 0);
  assert.ok(Math.abs(met[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(met[1] - met[3]) < 1e-9);
  assert.equal(met[4], 60);
});

test('improving one matchup never lowers our value', () => {
  const { mu, sd } = randomModel(6, 21);
  const before = createEngine({ n: 6, mu, sd }).objModule(63, 63, 0, 0, 0);
  const mu2 = mu.map((L) => L.map((r) => [...r]));
  for (let l = 0; l < 3; l++) mu2[l][2][3] = Math.min(20, mu2[l][2][3] + 5);
  const after = createEngine({ n: 6, mu: mu2, sd }).objModule(63, 63, 0, 0, 0);
  assert.ok(after >= before - 1e-9);
});

test('risk attitude: favourite prefers low variance, underdog prefers high variance', () => {
  // Terminal only: same mean, different variance.
  const e = createEngine({ n: 6, ...constantModel(6, 10) });
  const fav = 66, dog = 54;
  assert.ok(e.terminal(fav, 20)[0] > e.terminal(fav, 200)[0]);
  assert.ok(e.terminal(dog, 20)[0] < e.terminal(dog, 200)[0]);
});

test('boundary: win threshold uses the companion differential', () => {
  const e = createEngine({ n: 6, ...constantModel(6, 10) });
  // Almost no variance: 64 BP is a win (64 - 56 = 8), 63 is a draw, 56 a loss.
  assert.ok(e.terminal(64, 1e-4)[1] > 0.999);
  assert.ok(e.terminal(63, 1e-4)[2] > 0.999);
  assert.ok(e.terminal(57, 1e-4)[2] > 0.999);
  assert.ok(e.terminal(56, 1e-4)[3] > 0.999);
});

test('a punish swing is well approximated by its mean and sd at team level', () => {
  // 8 players (win at >= 86 BP). 7 other games ~ N(m7, 7 * 3^2).
  // Last game: stable 12 +/- 2, 25 % chance to reach 19 +/- 1.5.
  const [p, c, s, h, sh] = [0.25, 12, 2, 19, 1.5];
  const mean = (1 - p) * c + p * h;
  const variance = (1 - p) * (s * s + c * c) + p * (sh * sh + h * h) - mean * mean;
  for (const m7 of [66, 70, 74, 78]) {
    const v7 = 7 * 9;
    const exact = (1 - p) * (1 - phi((85.5 - m7 - c) / Math.sqrt(v7 + s * s)))
      + p * (1 - phi((85.5 - m7 - h) / Math.sqrt(v7 + sh * sh)));
    const approx = 1 - phi((85.5 - m7 - mean) / Math.sqrt(v7 + variance));
    assert.ok(Math.abs(exact - approx) < 0.005, `m7=${m7}: ${exact} vs ${approx}`);
  }
});
