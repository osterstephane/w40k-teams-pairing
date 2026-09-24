import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCell, parseMatrix, toBp, buildModel, parseDelimited, cleanName, isMissingCode, swingMoments } from '../src/matrix.js';

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

// Layout of the team's Google Sheet "Matrice globale": title rows, a header
// row with a "Layout" column, then three rows (Layout A/B/C) per player.
// Google Sheets quotes cells containing line breaks when copying as TSV.
function globalSheet(n, cell) {
  const q = (s) => `"${s}"`;
  const lines = [
    'Matrice globale — 8 joueurs × 8 adversaires × layouts A/B/C',
    'Projet\tPairing scrim\tProgression\t0 / 192 estimés',
    ['Joueur', 'Layout', ...Array.from({ length: n }, (_, j) => q(`Adversaire ${j + 1}\n${j === 0 ? 'Orks' : 'À renseigner'}`))].join('\t'),
  ];
  for (let i = 0; i < n; i++) {
    for (const l of ['A', 'B', 'C']) {
      lines.push([q(`Joueur ${i + 1}\n${i === 1 ? 'Aeldari' : 'À renseigner'}`), `Layout ${l}`, ...Array.from({ length: n }, (_, j) => cell(i, j, l))].join('\t'));
    }
  }
  return lines.join('\n');
}

test('reference codes resolve to BP with sd, case and accent insensitive', () => {
  assert.deepEqual(parseCell('WIN'), { value: 14, sd: 3, code: 'WIN', bp: true });
  assert.equal(parseCell('p_lose').value, 8);
  assert.equal(parseCell('GAMBLE').sd, 5);
  assert.equal(parseCell('SAIS-PÔ'), null);
  assert.ok(isMissingCode('SAIS-PÔ'));
  assert.ok(isMissingCode('sais-po'));
  assert.equal(parseCell('INCONNU'), null);
});

test('quoted multi-line TSV cells', () => {
  const rows = parseDelimited('"a\nb"\tc\n"x ""y"""\tz', '\t');
  assert.deepEqual(rows, [['a\nb', 'c'], ['x "y"', 'z']]);
});

test('names: placeholder line is dropped, filled second line is used', () => {
  assert.equal(cleanName('Joueur 1\nÀ renseigner', 'x'), 'Joueur 1');
  assert.equal(cleanName('Adversaire 1\nOrks', 'x'), 'Orks');
  assert.equal(cleanName('', 'x'), 'x');
});

test('Matrice globale (one row per layout) is parsed into three layouts', () => {
  const codes = ['FACILE', 'WIN', 'p_WIN', 'DRAW', 'p_LOSE', 'LOSE', 'ALED', 'GAMBLE'];
  const text = globalSheet(8, (i, j, l) => (i === 7 && j === 7 ? 'SAIS-PÔ' : codes[(i + j + 'ABC'.indexOf(l)) % 8]));
  const p = parseMatrix(text);
  assert.equal(p.layouts.length, 3);
  assert.equal(p.rowNames.length, 8);
  assert.equal(p.colNames.length, 8);
  assert.equal(p.rowNames[0], 'Joueur 1');
  assert.equal(p.rowNames[1], 'Aeldari');
  assert.equal(p.colNames[0], 'Orks');
  assert.equal(p.colNames[1], 'Adversaire 2');
  assert.equal(p.layouts[0].raw[0][0], 'FACILE');
  assert.equal(p.layouts[1].raw[0][0], 'WIN');
  assert.equal(p.layouts[2].raw[2][1], 'LOSE');
  assert.equal(p.layouts[0].cells[7][7], null);
  const m = buildModel(p.layouts, 8, { type: 'bp' }, 4);
  assert.equal(m.mu[0][0][0], 17);
  assert.equal(m.mu[1][0][0], 14);
  assert.equal(m.sd[0][0][7], 5); // GAMBLE
  assert.equal(m.missing.length, 3); // (7,7) on each layout
});

test('code cells bypass the linear scale, numbers do not', () => {
  const p = parseMatrix('WIN\t1\n0\tDRAW');
  const m = buildModel([p, null, null], 2, { type: 'linear', inMin: -2, inMax: 2, outMin: 4, outMax: 16 }, 4);
  assert.equal(m.mu[0][0][0], 14);
  assert.equal(m.mu[0][0][1], 13);
  assert.equal(m.mu[0][1][0], 10);
});

test('swingMoments: mean and sd of a two-outcome game', () => {
  const m = swingMoments(12, 2, 0.25, 19, 1.5);
  assert.ok(Math.abs(m.mean - 13.75) < 1e-12);
  assert.ok(Math.abs(m.sd - Math.sqrt(12.75)) < 1e-12);
  assert.deepEqual(swingMoments(12, 3, 0, 18, 2), { mean: 12, sd: 3 });
  const all = swingMoments(12, 3, 1, 18, 2);
  assert.ok(Math.abs(all.mean - 18) < 1e-12 && Math.abs(all.sd - 2) < 1e-12);
});

test('"!" = stable result with a chance to punish (default 25 %, 18 BP)', () => {
  const c = parseCell('p_WIN!');
  const ref = swingMoments(12, 3, 0.25, 18, 2);
  assert.equal(c.code, 'p_WIN');
  assert.ok(Math.abs(c.value - ref.mean) < 1e-12); // 13.5
  assert.ok(Math.abs(c.sd - ref.sd) < 1e-12);
  assert.ok(c.sd > 3); // wider than a plain p_WIN
  assert.deepEqual(c.swing, { kind: 'punish', chance: 25, base: 12, target: 18 });
});

test('"?" = risk of being punished (default 3 BP)', () => {
  const c = parseCell('WIN?');
  assert.ok(Math.abs(c.value - swingMoments(14, 3, 0.25, 3, 2).mean) < 1e-12); // 11.25
  assert.equal(c.swing.kind, 'punished');
});

test('swing chance, target and base sd can be set', () => {
  assert.equal(parseCell('p_WIN!40').swing.chance, 40);
  assert.equal(parseCell('p_WIN! 40%').swing.chance, 40);
  assert.equal(parseCell('p_WIN!0').value, 12);
  const custom = parseCell('DRAW!', undefined, { swing: { chance: 50, high: 20, highSd: 0 } });
  assert.equal(custom.value, 15);
  const withSd = parseCell('p_WIN±2 ');
  assert.equal(withSd.sd, 2);
  const both = parseCell('p_WIN!±1');
  assert.ok(Math.abs(both.sd - swingMoments(12, 1, 0.25, 18, 2).sd) < 1e-12);
});

test('invalid swings and removed +/- nuances are rejected', () => {
  assert.equal(parseCell('p_WIN!!'), null);
  assert.equal(parseCell('p_WIN!150'), null);
  assert.equal(parseCell('INCONNU!'), null);
  assert.equal(parseCell('!'), null);
  assert.equal(parseCell('?'), null);
  assert.equal(parseCell('p_WIN+'), null);
  assert.equal(parseCell('WIN--'), null);
  assert.equal(parseCell('SAIS-PÔ'), null);
});
