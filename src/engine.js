// Pairing decision engine.
//
// Model
// -----
// mu[l][a][b] : expected Battle Points (0-20) for OUR player a against THEIR
//               player b on layout l (0 = A, 1 = B, 2 = C).
// sd[l][a][b] : standard deviation of that BP result (uncertainty of the estimate
//               plus dice). Games are assumed independent, so the team total is
//               approximated by a normal distribution N(sum mu, sum sd^2).
//
// The pairing is a sequence of simultaneous secret choices (defender, attackers,
// which attacker to accept). Every such step is solved as a zero-sum matrix game,
// with backward induction over the whole pairing tree.
//
// Objective (maximised by us, minimised by the opponent):
//   obj = (1 - marginWeight) * (P(win) + drawValue * P(draw))
//       +      marginWeight  * (E[our BP] / total BP)
// drawValue = 0.5, marginWeight = 0  <=>  maximise expected Team Points.
//
// Two layers:
//  - "obj" layer: objective value only, memoised, used to find the equilibria;
//  - "metrics" layer: follows the equilibria found by the obj layer and returns
//    [obj, P(win), P(draw), P(loss), E[our BP]].
//
// Documented simplifications (see docs/MODEL.md):
//  - in the look-ahead, a defender picks the layout with the best expected BP for
//    its side (the live state always uses the layout actually declared);
//  - the accumulated mean / variance are snapped to a small grid at the start of
//    each non-final module so sub-trees can be shared (default 0.5 BP, 4 BP^2).

import { solve2x2, solveMatrixGame } from './matrixgame.js';
import { MODULES_BY_SIZE, thresholds, layoutForRound } from './rules.js';

export const METRIC = { OBJ: 0, WIN: 1, DRAW: 2, LOSS: 3, BP: 4 };

export function bits(mask) {
  const out = [];
  for (let i = 0; mask; i++, mask >>= 1) if (mask & 1) out.push(i);
  return out;
}

export function pairs(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
  return out;
}

// Standard normal CDF (Abramowitz & Stegun 7.1.26, |err| < 1.5e-7).
export function phi(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

function value2x2(a, b, c, d) {
  const maximin = Math.max(Math.min(a, b), Math.min(c, d));
  const minimax = Math.min(Math.max(a, c), Math.max(b, d));
  if (maximin >= minimax - 1e-12) return maximin;
  return (a * d - b * c) / (a - b - c + d);
}

function lowBit(mask) {
  return 31 - Math.clz32(mask & -mask);
}

export function createEngine(config) {
  const n = config.n;
  const modules = MODULES_BY_SIZE[n];
  if (!modules) throw new Error(`Unsupported team size ${n} (3 to 8)`);
  const th = thresholds(n);
  const round = config.round ?? 1;
  const fixedLayout = layoutForRound(round);
  const drawValue = config.objective?.drawValue ?? 0.5;
  const marginWeight = config.objective?.marginWeight ?? 0;
  const qm = config.quantum?.mean ?? 0.5;
  const qv = config.quantum?.variance ?? 4;
  const mu = config.mu, sd = config.sd;

  // Per role: layout used, mean and variance of the game (look-ahead model).
  const ourDefLayout = new Int8Array(n * n), theirDefLayout = new Int8Array(n * n);
  const OM = new Float64Array(n * n), OV = new Float64Array(n * n); // our defender game
  const TM = new Float64Array(n * n), TV = new Float64Array(n * n); // their defender game
  const FM = new Float64Array(n * n), FV = new Float64Array(n * n); // fixed-layout game
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      const k = a * n + b;
      let best = 0, worst = 0;
      for (let l = 1; l < 3; l++) {
        if (mu[l][a][b] > mu[best][a][b]) best = l;
        if (mu[l][a][b] < mu[worst][a][b]) worst = l;
      }
      ourDefLayout[k] = best; theirDefLayout[k] = worst;
      OM[k] = mu[best][a][b]; OV[k] = sd[best][a][b] ** 2;
      TM[k] = mu[worst][a][b]; TV[k] = sd[worst][a][b] ** 2;
      FM[k] = mu[fixedLayout][a][b]; FV[k] = sd[fixedLayout][a][b] ** 2;
    }
  }

  const winZ = th.win - 0.5, lossZ = th.loss + 0.5;

  function terminal(M, V) {
    const s = Math.sqrt(Math.max(V, 1e-4));
    const pW = 1 - phi((winZ - M) / s);
    const pL = phi((lossZ - M) / s);
    const pD = Math.max(0, 1 - pW - pL);
    const obj = (1 - marginWeight) * (pW + drawValue * pD) + marginWeight * (M / th.total);
    return [obj, pW, pD, pL, M];
  }

  function terminalObj(M, V) {
    const s = Math.sqrt(Math.max(V, 1e-4));
    const pW = 1 - phi((winZ - M) / s);
    const pL = phi((lossZ - M) / s);
    return (1 - marginWeight) * (pW + drawValue * Math.max(0, 1 - pW - pL)) + marginWeight * (M / th.total);
  }

  const snapM = (M) => Math.round(M / qm) * qm;
  const snapV = (V) => Math.round(V / qv) * qv;
  // Numeric memo keys while they stay exact (always true with the default grid);
  // string keys otherwise (e.g. very fine grids used in tests).
  const mRange = Math.ceil(2 * 20 * n / qm) + 2, vRange = Math.ceil(n * 400 / qv) + 2;
  const numericKeys = mRange * vRange * 8 * 65536 < Number.MAX_SAFE_INTEGER;
  const keyOf = numericKeys
    ? (remA, remB, mod, M, V) => (((Math.round(V / qv) * mRange + Math.round(M / qm)) * 8 + mod) * 256 + remB) * 256 + remA
    : (remA, remB, mod, M, V) => `${remA},${remB},${mod},${Math.round(M / qm)},${Math.round(V / qv)}`;

  const objMemo = new Map();
  const metMemo = new Map();

  // Next state after the step-5 choices (k: which of their attackers our defender
  // plays, l: which of our attackers their defender plays).
  function transition(remA, remB, mod, M, V, dA, dB, pa, pb, k, l) {
    const g1 = dA * n + pb[k], g2 = pa[l] * n + dB;
    M += OM[g1] + TM[g2];
    V += OV[g1] + TV[g2];
    let nA, nB;
    if (modules[mod] === 'M') {
      const g3 = pa[1 - l] * n + pb[1 - k];
      M += FM[g3]; V += FV[g3];
      nA = remA & ~(1 << dA) & ~(1 << pa[0]) & ~(1 << pa[1]);
      nB = remB & ~(1 << dB) & ~(1 << pb[0]) & ~(1 << pb[1]);
    } else {
      nA = remA & ~(1 << dA) & ~(1 << pa[l]);
      nB = remB & ~(1 << dB) & ~(1 << pb[k]);
    }
    mod++;
    // Champion System: forced pairing of the last player of each team.
    while (mod < modules.length && modules[mod] === 'C') {
      const c = lowBit(nA) * n + lowBit(nB);
      M += FM[c]; V += FV[c];
      nA = 0; nB = 0; mod++;
    }
    return { remA: nA, remB: nB, mod, M, V, terminal: mod >= modules.length };
  }

  // ---------------------------------------------------------------- obj layer

  function objModule(remA, remB, mod, M, V) {
    while (mod < modules.length && modules[mod] === 'C') {
      const c = lowBit(remA) * n + lowBit(remB);
      M += FM[c]; V += FV[c]; remA = 0; remB = 0; mod++;
    }
    if (mod >= modules.length) return terminalObj(M, V);
    M = snapM(M); V = snapV(V);
    const key = keyOf(remA, remB, mod, M, V);
    let v = objMemo.get(key);
    if (v !== undefined) return v;
    v = modules[mod] === 'M' ? finalModuleObj(remA, remB, M, V) : objDefenderStage(remA, remB, mod, M, V).eq.v;
    objMemo.set(key, v);
    return v;
  }

  function objOutcome(remA, remB, mod, M, V, dA, dB, pa, pb, k, l) {
    const t = transition(remA, remB, mod, M, V, dA, dB, pa, pb, k, l);
    return t.terminal ? terminalObj(t.M, t.V) : objModule(t.remA, t.remB, t.mod, t.M, t.V);
  }

  function objChooseStage(remA, remB, mod, M, V, dA, dB, pa, pb) {
    const A = [
      [objOutcome(remA, remB, mod, M, V, dA, dB, pa, pb, 0, 0), objOutcome(remA, remB, mod, M, V, dA, dB, pa, pb, 0, 1)],
      [objOutcome(remA, remB, mod, M, V, dA, dB, pa, pb, 1, 0), objOutcome(remA, remB, mod, M, V, dA, dB, pa, pb, 1, 1)],
    ];
    return { A, eq: solve2x2(A[0][0], A[0][1], A[1][0], A[1][1]) };
  }

  function objAttackerStage(remA, remB, mod, M, V, dA, dB) {
    const rows = pairs(bits(remA & ~(1 << dA)));
    const cols = pairs(bits(remB & ~(1 << dB)));
    const A = rows.map((pa) => cols.map((pb) => objChooseStage(remA, remB, mod, M, V, dA, dB, pa, pb).eq.v));
    return { rows, cols, A, eq: solveMatrixGame(A) };
  }

  function objDefenderStage(remA, remB, mod, M, V) {
    const rows = bits(remA), cols = bits(remB);
    const A = rows.map((dA) => cols.map((dB) => objAttackerStage(remA, remB, mod, M, V, dA, dB).eq.v));
    return { rows, cols, A, eq: solveMatrixGame(A) };
  }

  // Fast path for the Main Engagement (always the last choice module): no
  // allocation per leaf, no memo for terminal states. Same maths as the
  // generic stages above.
  function finalModuleObj(remA, remB, M, V) {
    const LA = bits(remA), LB = bits(remB), r = LA.length;
    const champ = r === 4;
    const D = [];
    for (let iA = 0; iA < r; iA++) {
      const dA = LA[iA];
      const oA = LA.filter((x) => x !== dA);
      const PA = pairs(oA);
      const row = [];
      for (let iB = 0; iB < r; iB++) {
        const dB = LB[iB];
        const oB = LB.filter((x) => x !== dB);
        const PB = pairs(oB);
        const att = [];
        for (const pa of PA) {
          const cA = champ ? oA.find((x) => x !== pa[0] && x !== pa[1]) : -1;
          const arow = [];
          for (const pb of PB) {
            let m0 = M, v0 = V;
            if (champ) {
              const cB = oB.find((x) => x !== pb[0] && x !== pb[1]);
              m0 += FM[cA * n + cB]; v0 += FV[cA * n + cB];
            }
            const g1a = dA * n + pb[0], g1b = dA * n + pb[1];
            const g2a = pa[0] * n + dB, g2b = pa[1] * n + dB;
            // k = 0/1: our defender plays pb[k]; l = 0/1: their defender plays pa[l].
            const o00 = terminalObj(m0 + OM[g1a] + TM[g2a] + FM[pa[1] * n + pb[1]], v0 + OV[g1a] + TV[g2a] + FV[pa[1] * n + pb[1]]);
            const o01 = terminalObj(m0 + OM[g1a] + TM[g2b] + FM[pa[0] * n + pb[1]], v0 + OV[g1a] + TV[g2b] + FV[pa[0] * n + pb[1]]);
            const o10 = terminalObj(m0 + OM[g1b] + TM[g2a] + FM[pa[1] * n + pb[0]], v0 + OV[g1b] + TV[g2a] + FV[pa[1] * n + pb[0]]);
            const o11 = terminalObj(m0 + OM[g1b] + TM[g2b] + FM[pa[0] * n + pb[0]], v0 + OV[g1b] + TV[g2b] + FV[pa[0] * n + pb[0]]);
            arow.push(value2x2(o00, o01, o10, o11));
          }
          att.push(arow);
        }
        row.push(solveMatrixGame(att).v);
      }
      D.push(row);
    }
    return solveMatrixGame(D).v;
  }

  // ------------------------------------------------------------ metrics layer

  function mix(eq, cellFn) {
    const out = [0, 0, 0, 0, 0];
    for (let i = 0; i < eq.x.length; i++) {
      if (eq.x[i] < 1e-9) continue;
      for (let j = 0; j < eq.y.length; j++) {
        const w = eq.x[i] * eq.y[j];
        if (w < 1e-9) continue;
        const c = cellFn(i, j);
        for (let t = 0; t < 5; t++) out[t] += w * c[t];
      }
    }
    return out;
  }

  function metModule(remA, remB, mod, M, V) {
    while (mod < modules.length && modules[mod] === 'C') {
      const c = lowBit(remA) * n + lowBit(remB);
      M += FM[c]; V += FV[c]; remA = 0; remB = 0; mod++;
    }
    if (mod >= modules.length) return terminal(M, V);
    M = snapM(M); V = snapV(V);
    const key = keyOf(remA, remB, mod, M, V);
    let v = metMemo.get(key);
    if (v) return v;
    const st = objDefenderStage(remA, remB, mod, M, V);
    v = mix(st.eq, (i, j) => metAttacker(remA, remB, mod, M, V, st.rows[i], st.cols[j]));
    v[0] = st.eq.v;
    metMemo.set(key, v);
    return v;
  }

  function metAttacker(remA, remB, mod, M, V, dA, dB) {
    const st = objAttackerStage(remA, remB, mod, M, V, dA, dB);
    const v = mix(st.eq, (i, j) => metChoose(remA, remB, mod, M, V, dA, dB, st.rows[i], st.cols[j]));
    v[0] = st.eq.v;
    return v;
  }

  function metChoose(remA, remB, mod, M, V, dA, dB, pa, pb) {
    const st = objChooseStage(remA, remB, mod, M, V, dA, dB, pa, pb);
    const v = mix(st.eq, (k, l) => metOutcome(remA, remB, mod, M, V, dA, dB, pa, pb, k, l));
    v[0] = st.eq.v;
    return v;
  }

  function metOutcome(remA, remB, mod, M, V, dA, dB, pa, pb, k, l) {
    const t = transition(remA, remB, mod, M, V, dA, dB, pa, pb, k, l);
    return t.terminal ? terminal(t.M, t.V) : metModule(t.remA, t.remB, t.mod, t.M, t.V);
  }

  return {
    n, modules, thresholds: th, fixedLayout, round,
    ourDefLayout: (a, b) => ourDefLayout[a * n + b],
    theirDefLayout: (a, b) => theirDefLayout[a * n + b],
    terminal,
    transition,
    snap: (M, V) => ({ M: snapM(M), V: snapV(V) }),
    // Objective only (fast).
    objModule, objDefenderStage, objAttackerStage, objChooseStage, objOutcome,
    // Full metrics following the equilibrium.
    metModule, metAttacker, metChoose, metOutcome,
    stats: () => ({ objStates: objMemo.size, metStates: metMemo.size }),
  };
}
