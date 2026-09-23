import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCell, parseMatrix, toBp, buildModel } from '../src/matrix.js';

test('cell formats', () => {
  assert.deepEqual(parseCell('12'), { value: 12, sd: null });
  assert.deepEqual(parseCell('12,5'), { value: 12.5, sd: null });
  assert.deepEqual(parseCell('12±3'), { value: 12, sd: 3 });
  assert.deepEqual(parseCell('12 +- 2,5'), { value: 12, sd: 2.5 });
  assert.deepEqual(parseCell('-2 (1)'), { value: -2, sd: 1 });
  assert.equal(parseCell('abc'), null);
  assert.equal(parseCell(''), null);
});

test('pasted TSV with headers', () => {
  const p = parseMatrix('\tOrks\tEldar\nAlice\t12\t8±5\nBob\t10\t15\n');
  assert.deepEqual(p.rowNames, ['Alice', 'Bob']);
  assert.deepEqual(p.colNames, ['Orks', 'Eldar']);
  assert.deepEqual(p.cells[0][1], { value: 8, sd: 5 });
});

test('pasted matrix without headers, semicolon, comma decimals', () => {
  const p = parseMatrix('12,5;8\n10;15');
  assert.deepEqual(p.rowNames, ['Nous 1', 'Nous 2']);
  assert.equal(p.cells[0][0].value, 12.5);
});

test('linear scale conversion is clamped', () => {
  const s = { type: 'linear', inMin: -2, inMax: 2, outMin: 4, outMax: 16 };
  assert.equal(toBp(0, s), 10);
  assert.equal(toBp(2, s), 16);
  assert.equal(toBp(-2, s), 4);
  assert.equal(toBp(25, { type: 'bp' }), 20);
});

test('buildModel falls back to first layout and default sd', () => {
  const p = parseMatrix('12\t8\n10\t15±2');
  const m = buildModel([p, null, null], 2, { type: 'bp' }, 4);
  assert.equal(m.mu[2][0][0], 12);
  assert.equal(m.sd[1][0][0], 4);
  assert.equal(m.sd[0][1][1], 2);
  assert.equal(m.missing.length, 0);
});
