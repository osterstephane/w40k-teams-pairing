import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveMatrixGame, solve2x2 } from '../src/matrixgame.js';

function checkEquilibrium(A, { x, y, v }, tol = 1e-7) {
  const m = A.length, n = A[0].length;
  assert.ok(Math.abs(x.reduce((a, b) => a + b, 0) - 1) < tol);
  assert.ok(Math.abs(y.reduce((a, b) => a + b, 0) - 1) < tol);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < m; i++) s += x[i] * A[i][j];
    assert.ok(s >= v - tol, `row strategy guarantees v against column ${j}`);
  }
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += y[j] * A[i][j];
    assert.ok(s <= v + tol, `column strategy holds row ${i} to v`);
  }
}

test('matching pennies', () => {
  const r = solve2x2(1, -1, -1, 1);
  assert.ok(Math.abs(r.v) < 1e-12);
  assert.ok(Math.abs(r.x[0] - 0.5) < 1e-12 && Math.abs(r.y[0] - 0.5) < 1e-12);
});

test('2x2 saddle point', () => {
  const r = solve2x2(3, 5, 1, 4);
  assert.equal(r.v, 3);
  assert.deepEqual(r.x, [1, 0]);
  assert.deepEqual(r.y, [1, 0]);
});

test('rock paper scissors', () => {
  const A = [[0, -1, 1], [1, 0, -1], [-1, 1, 0]];
  const r = solveMatrixGame(A);
  assert.ok(Math.abs(r.v) < 1e-9);
  for (const p of r.x) assert.ok(Math.abs(p - 1 / 3) < 1e-9);
  checkEquilibrium(A, r);
});

test('random games satisfy equilibrium conditions', () => {
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 300; t++) {
    const m = 1 + Math.floor(rnd() * 7), n = 1 + Math.floor(rnd() * 7);
    const A = Array.from({ length: m }, () => Array.from({ length: n }, () => Math.round(rnd() * 20) / 20));
    checkEquilibrium(A, solveMatrixGame(A));
  }
});
