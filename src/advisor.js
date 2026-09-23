// Turns engine results into decision support for the current pairing step.

import { solveMatrixGame } from './matrixgame.js';
import { accumulated, setLayouts } from './pairing.js';

function metricsOf(v) {
  const [obj, win, draw, loss, bp] = v;
  return { obj, win, draw, loss, bp, tp: 3 * win + 2 * draw + loss };
}

function weighted(list) {
  const out = [0, 0, 0, 0, 0];
  for (const [w, v] of list) for (let t = 0; t < 5; t++) out[t] += w * v[t];
  return out;
}

// Generic analysis of a simultaneous step given its objective matrix A and a
// function returning full metrics for a cell.
function analyse(A, rowLabels, colLabels, cellMetrics) {
  const eq = solveMatrixGame(A);
  const m = A.length, nc = A[0].length;
  const cache = new Map();
  const cell = (i, j) => {
    const k = i * nc + j;
    if (!cache.has(k)) cache.set(k, cellMetrics(i, j));
    return cache.get(k);
  };
  const rows = [];
  for (let i = 0; i < m; i++) {
    let vsEq = 0, worst = Infinity, best = -Infinity, worstCol = 0;
    for (let j = 0; j < nc; j++) {
      vsEq += eq.y[j] * A[i][j];
      if (A[i][j] < worst) { worst = A[i][j]; worstCol = j; }
      if (A[i][j] > best) best = A[i][j];
    }
    const met = weighted(eq.y.map((y, j) => [y, y > 1e-9 ? cell(i, j) : [0, 0, 0, 0, 0]]));
    met[0] = vsEq;
    rows.push({ index: i, label: rowLabels[i], prob: eq.x[i], vsEq, worst, best, worstCol, metrics: metricsOf(met) });
  }
  const cols = [];
  for (let j = 0; j < nc; j++) {
    let vsEq = 0, best = -Infinity, bestRow = 0;
    for (let i = 0; i < m; i++) {
      vsEq += eq.x[i] * A[i][j];
      if (A[i][j] > best) { best = A[i][j]; bestRow = i; }
    }
    cols.push({ index: j, label: colLabels[j], prob: eq.y[j], vsEq, bestResponse: bestRow, bestResponseValue: best });
  }
  const projection = weighted(rows.map((r) => [r.prob, [r.metrics.obj, r.metrics.win, r.metrics.draw, r.metrics.loss, r.metrics.bp]]));
  projection[0] = eq.v;
  return { A, eq, value: eq.v, rows, cols, projection: metricsOf(projection) };
}

export function advise(engine, state, mu, sd, onProgress) {
  const acc = accumulated(state, mu, sd);
  if (state.step === 'done') {
    return { step: 'done', projection: metricsOf(engine.terminal(acc.M, acc.V)), accumulated: acc };
  }
  const { M, V } = engine.snap(acc.M, acc.V);
  const { remA, remB, mod } = state;

  if (state.step === 'defenders') {
    const rows = listBits(remA), cols = listBits(remB);
    const total = rows.length * cols.length;
    let done = 0;
    const A = rows.map((dA) => cols.map((dB) => {
      const v = engine.objAttackerStage(remA, remB, mod, M, V, dA, dB).eq.v;
      done++;
      if (onProgress) onProgress(done / total);
      return v;
    }));
    const res = analyse(A, rows, cols, (i, j) => engine.metAttacker(remA, remB, mod, M, V, rows[i], cols[j]));
    return { step: 'defenders', accumulated: acc, ...res };
  }

  const { dA, dB } = state;
  if (state.step === 'attackers') {
    const st = engine.objAttackerStage(remA, remB, mod, M, V, dA, dB);
    const res = analyse(st.A, st.rows, st.cols, (i, j) => engine.metChoose(remA, remB, mod, M, V, dA, dB, st.rows[i], st.cols[j]));
    return { step: 'attackers', accumulated: acc, ...res };
  }

  const { pa, pb } = state;
  if (state.step === 'choices') {
    const st = engine.objChooseStage(remA, remB, mod, M, V, dA, dB, pa, pb);
    // rows: k (their attacker our defender plays), cols: l (our attacker their defender plays)
    const res = analyse(st.A, [pb[0], pb[1]], [pa[0], pa[1]], (k, l) => engine.metOutcome(remA, remB, mod, M, V, dA, dB, pa, pb, k, l));
    return { step: 'choices', accumulated: acc, ...res };
  }

  if (state.step === 'layouts') {
    const { k, l } = state;
    const ourGame = { a: dA, b: pb[k] }, theirGame = { a: pa[l], b: dB };
    const theirAssumed = engine.theirDefLayout(theirGame.a, theirGame.b);
    const options = [0, 1, 2].map((layout) => {
      const next = setLayouts(state, layout, theirAssumed);
      const nAcc = accumulated(next, mu, sd);
      const met = next.step === 'done'
        ? engine.terminal(nAcc.M, nAcc.V)
        : engine.metModule(next.remA, next.remB, next.mod, nAcc.M, nAcc.V);
      return { layout, gameMean: mu[layout][ourGame.a][ourGame.b], gameSd: sd[layout][ourGame.a][ourGame.b], metrics: metricsOf(met) };
    });
    let best = 0;
    for (let i = 1; i < 3; i++) if (options[i].metrics.obj > options[best].metrics.obj + 1e-12) best = i;
    return {
      step: 'layouts', accumulated: acc, ourGame, theirGame, theirAssumed, options, best,
      theirOptions: [0, 1, 2].map((layout) => ({ layout, gameMean: mu[layout][theirGame.a][theirGame.b] })),
      projection: options[best].metrics,
    };
  }
  throw new Error(`Unknown step ${state.step}`);
}

function listBits(mask) {
  const out = [];
  for (let i = 0; mask; i++, mask >>= 1) if (mask & 1) out.push(i);
  return out;
}
