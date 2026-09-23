// Zero-sum matrix game solver.
// The row player maximises, the column player minimises the row payoff.
// Returns { x: row mixed strategy, y: column mixed strategy, v: game value }.

const EPS = 1e-12;

export function solve2x2(a, b, c, d) {
  // [[a, b], [c, d]]
  // Pure saddle point check.
  const r0 = Math.min(a, b), r1 = Math.min(c, d);
  const c0 = Math.max(a, c), c1 = Math.max(b, d);
  const maximin = Math.max(r0, r1);
  const minimax = Math.min(c0, c1);
  if (maximin >= minimax - EPS) {
    const i = r0 >= r1 ? 0 : 1;
    const j = c0 <= c1 ? 0 : 1;
    return { x: i === 0 ? [1, 0] : [0, 1], y: j === 0 ? [1, 0] : [0, 1], v: maximin };
  }
  const den = a - b - c + d;
  const p = (d - c) / den; // prob of row 0
  const q = (d - b) / den; // prob of column 0
  return { x: [p, 1 - p], y: [q, 1 - q], v: (a * d - b * c) / den };
}

// A: array of rows (m x n).
export function solveMatrixGame(A) {
  const m = A.length, n = A[0].length;
  if (m === 1 || n === 1) return solveDegenerate(A);
  if (m === 2 && n === 2) return solve2x2(A[0][0], A[0][1], A[1][0], A[1][1]);

  // Pure saddle point shortcut (very common in practice).
  let maximin = -Infinity, bi = 0;
  for (let i = 0; i < m; i++) {
    let mn = Infinity;
    for (let j = 0; j < n; j++) if (A[i][j] < mn) mn = A[i][j];
    if (mn > maximin) { maximin = mn; bi = i; }
  }
  let minimax = Infinity, bj = 0;
  for (let j = 0; j < n; j++) {
    let mx = -Infinity;
    for (let i = 0; i < m; i++) if (A[i][j] > mx) mx = A[i][j];
    if (mx < minimax) { minimax = mx; bj = j; }
  }
  if (maximin >= minimax - EPS) {
    const x = new Array(m).fill(0); x[bi] = 1;
    const y = new Array(n).fill(0); y[bj] = 1;
    return { x, y, v: maximin };
  }
  return simplex(A, m, n);
}

function solveDegenerate(A) {
  const m = A.length, n = A[0].length;
  if (m === 1) {
    let j0 = 0;
    for (let j = 1; j < n; j++) if (A[0][j] < A[0][j0]) j0 = j;
    const y = new Array(n).fill(0); y[j0] = 1;
    return { x: [1], y, v: A[0][j0] };
  }
  let i0 = 0;
  for (let i = 1; i < m; i++) if (A[i][0] > A[i0][0]) i0 = i;
  const x = new Array(m).fill(0); x[i0] = 1;
  return { x, y: [1], v: A[i0][0] };
}

// Column player's LP on a strictly positive shifted matrix:
//   maximise sum(y) s.t. A' y <= 1, y >= 0.  value = 1 / sum(y).
// Row strategy is read from the dual (objective-row coefficients of slacks).
function simplex(A, m, n) {
  let min = Infinity;
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) if (A[i][j] < min) min = A[i][j];
  const shift = 1 - min;
  const W = n + m + 1; // columns: y (n), slacks (m), rhs
  const T = new Float64Array((m + 1) * W);
  for (let i = 0; i < m; i++) {
    const r = i * W;
    for (let j = 0; j < n; j++) T[r + j] = A[i][j] + shift;
    T[r + n + i] = 1;
    T[r + W - 1] = 1;
  }
  const obj = m * W;
  for (let j = 0; j < n; j++) T[obj + j] = -1;
  const basis = new Int32Array(m);
  for (let i = 0; i < m; i++) basis[i] = n + i;

  for (let iter = 0; iter < 10000; iter++) {
    // Bland's rule: first improving column.
    let pc = -1;
    for (let j = 0; j < n + m; j++) if (T[obj + j] < -1e-12) { pc = j; break; }
    if (pc < 0) break;
    let pr = -1, best = Infinity;
    for (let i = 0; i < m; i++) {
      const a = T[i * W + pc];
      if (a > 1e-12) {
        const ratio = T[i * W + W - 1] / a;
        if (ratio < best - 1e-12 || (Math.abs(ratio - best) <= 1e-12 && basis[i] < basis[pr])) {
          best = ratio; pr = i;
        }
      }
    }
    if (pr < 0) break; // unbounded: cannot happen with positive matrix
    const pv = T[pr * W + pc];
    for (let k = 0; k < W; k++) T[pr * W + k] /= pv;
    for (let i = 0; i <= m; i++) {
      if (i === pr) continue;
      const f = T[i * W + pc];
      if (f !== 0) for (let k = 0; k < W; k++) T[i * W + k] -= f * T[pr * W + k];
    }
    basis[pr] = pc;
  }
  const sumY = T[obj + W - 1];
  const vShift = 1 / sumY;
  const y = new Array(n).fill(0);
  for (let i = 0; i < m; i++) if (basis[i] < n) y[basis[i]] = T[i * W + W - 1] * vShift;
  const x = new Array(m);
  for (let i = 0; i < m; i++) x[i] = Math.max(0, T[obj + n + i]) * vShift;
  return { x: normalise(x), y: normalise(y), v: vShift - shift };
}

function normalise(p) {
  let s = 0;
  for (const v of p) s += v;
  return s > 0 ? p.map((v) => v / s) : p;
}
