// Parsing of a matchup matrix pasted from a spreadsheet (Google Sheets / Excel).
//
// Two layouts are recognised:
//  - square grid: our players in rows, their players in columns, optional
//    header row / column with names;
//  - "one row per layout": a header row with a "Layout" column, then for each
//    of our players three rows "Layout A", "Layout B", "Layout C".
// Separators: tab (Google Sheets copy), ';' or ','. Quoted multi-line cells
// (as produced by Google Sheets for cells with line breaks) are supported.
//
// Cell formats: "12", "12,5", "12±3", "12+-3", "12 (3)" -> BP mean [± sd],
// or a code from the team's reference table (e.g. "WIN", "p_LOSE", "GAMBLE").

const CELL = /^\s*([+-]?\d+(?:[.,]\d+)?)\s*(?:(?:±|\+-|\+\/-)\s*(\d+(?:[.,]\d+)?)|\(\s*(\d+(?:[.,]\d+)?)\s*\))?\s*$/;

// Default reference table ("Référentiel des estimés"). Centres come from the
// team's sheet; standard deviations are our reading of its risk notes
// ("faible risque", "variance faible", "forte variance") and are editable.
export const DEFAULT_CODES = [
  { code: 'FACILE', mean: 17, sd: 3, label: 'Match très favorable (15–20)' },
  { code: 'WIN', mean: 14, sd: 3, label: 'Match positif (13–15)' },
  { code: 'p_WIN', mean: 12, sd: 3, label: 'Léger avantage (11–13)' },
  { code: 'DRAW', mean: 10, sd: 2.5, label: 'Match équilibré (9–11)' },
  { code: 'p_LOSE', mean: 8, sd: 3, label: 'Léger désavantage (7–9)' },
  { code: 'LOSE', mean: 6, sd: 3, label: 'Match négatif (5–7)' },
  { code: 'ALED', mean: 3, sd: 3, label: 'Match très défavorable (0–5)' },
  { code: 'GAMBLE', mean: 10, sd: 5, label: 'Match très volatil (5–15)' },
];

// Codes meaning "no estimate yet".
const MISSING_CODES = new Set(['SAISPO', 'SAIS-PO', '?', '-', '—']);

export function normaliseCode(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase().replace(/\s+/g, '_');
}

export function isMissingCode(text) {
  const c = normaliseCode(text);
  return MISSING_CODES.has(c) || MISSING_CODES.has(c.replace(/-/g, ''));
}

// Code cell with an optional swing scenario and uncertainty:
//   "p_WIN!"      : stable p_WIN, with a chance to punish an opponent's mistake
//                   and reach a big score ("upside")
//   "p_WIN?"      : p_WIN, with a risk of being punished ("downside")
//   "p_WIN!40"    : explicit chance (40 %); "%" is optional
//   "p_WIN!40_20" : explicit chance and score reached (20 BP, i.e. a 20-0)
//   "p_LOSE?50_3" : 50 % risk of ending at 3 BP
//   "WIN±5"       : explicit standard deviation in BP for the base result
const CODE_CELL = /^\s*(.*?)\s*(?:([!?])\s*(\d{1,3}(?:[.,]\d+)?)?\s*%?\s*(?:_\s*(\d{1,2}(?:[.,]\d+)?))?)?\s*(?:(?:±|\+-|\+\/-)\s*(\d+(?:[.,]\d+)?))?\s*$/;

// Defaults for "!" / "?" (editable in the Matrix tab):
//   chance : probability (%) that the swing happens
//   high   : BP reached when we punish
//   low    : BP left when we get punished
//   spread : sd (BP) of the swing result, reduced near 0 and 20 (a 20-0 is exact)
export const DEFAULT_SWING = { chance: 25, high: 18, low: 3, spread: 2 };

export function swingSpread(target, spread = DEFAULT_SWING.spread) {
  return Math.max(0, Math.min(spread, 20 - target, target));
}

// Mean and sd of a two-outcome game: base N(c, s²) with probability 1 - p,
// swing N(h, sh²) with probability p (moment matching, see docs/MODEL.md).
export function swingMoments(c, s, p, h, sh) {
  const mean = (1 - p) * c + p * h;
  const ex2 = (1 - p) * (s * s + c * c) + p * (sh * sh + h * h);
  return { mean, sd: Math.sqrt(Math.max(0, ex2 - mean * mean)) };
}

// Returns { value, sd, code?, swing?, bp? } or null. Code cells are already in BP.
// options.swing: defaults for "!" / "?" (see DEFAULT_SWING).
export function parseCell(text, codes = DEFAULT_CODES, options = {}) {
  if (text == null) return null;
  const num = (s) => (s == null ? null : parseFloat(s.replace(',', '.')));
  const m = CELL.exec(String(text));
  if (m) return { value: num(m[1]), sd: num(m[2] ?? m[3]) };
  const find = (t) => codes.find((c) => normaliseCode(c.code) === normaliseCode(t));
  const exact = normaliseCode(text) ? find(text) : null;
  if (exact) return { value: exact.mean, sd: exact.sd, code: exact.code, bp: true };
  const c = CODE_CELL.exec(String(text));
  if (!c || !c[1]) return null;
  const hit = find(c[1]);
  if (!hit) return null;
  const base = { mean: hit.mean, sd: c[5] != null ? num(c[5]) : hit.sd, customSd: c[5] != null };
  if (!c[2]) return { value: base.mean, sd: base.sd, code: hit.code, bp: true };
  const sw = { ...DEFAULT_SWING, ...options.swing };
  const up = c[2] === '!';
  const chance = c[3] != null ? num(c[3]) : sw.chance;
  const target = c[4] != null ? num(c[4]) : up ? sw.high : sw.low;
  if (!(chance >= 0 && chance <= 100) || !(target >= 0 && target <= 20)) return null;
  const { mean, sd } = swingMoments(base.mean, base.sd, chance / 100, target, swingSpread(target, sw.spread));
  return {
    value: Math.max(0, Math.min(20, mean)), sd,
    code: hit.code, bp: true,
    swing: { kind: up ? 'punish' : 'punished', chance, base: base.mean, target },
  };
}

// Inverse of parseCell for code cells: builds "p_WIN", "p_WIN!", "p_WIN!40_20"...
// Chance and score are written only when they differ from the defaults.
export function formatCodeCell({ code, kind = null, chance, target, sd = null }, defaults = DEFAULT_SWING) {
  const d = { ...DEFAULT_SWING, ...defaults };
  let out = code;
  if (kind) {
    const defTarget = kind === 'punish' ? d.high : d.low;
    const showTarget = target != null && target !== defTarget;
    const showChance = showTarget || (chance != null && chance !== d.chance);
    out += kind === 'punish' ? '!' : '?';
    if (showChance) out += String(chance ?? d.chance);
    if (showTarget) out += `_${target}`;
  }
  if (sd != null) out += `±${sd}`;
  return out;
}

// RFC-4180-ish parser: handles quoted fields containing separators, quotes and
// line breaks.
export function parseDelimited(text, sep) {
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  text = text.replace(/\r\n?/g, '\n');
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === sep) { row.push(field); field = ''; i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

function detectSeparator(text) {
  return text.includes('\t') ? '\t' : text.includes(';') ? ';' : ',';
}

// "Joueur 1\nÀ renseigner" -> "Joueur 1"; "Adversaire 2\nOrks" -> "Orks".
export function cleanName(text, fallback) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const useful = lines.filter((l) => !/^[àa] renseigner$/i.test(l));
  if (!useful.length) return fallback;
  return useful.length > 1 ? useful.slice(1).join(' ') : useful[0];
}

const LAYOUT_ROW = /^layout\s*([abc])$/i;

function parseLayoutRows(grid, codes) {
  const hIdx = grid.findIndex((r) => r.some((c) => /^layout$/i.test(c)));
  const header = hIdx >= 0 ? grid[hIdx] : null;
  let layoutCol = header ? header.findIndex((c) => /^layout$/i.test(c)) : -1;
  if (layoutCol < 0) {
    const first = grid.find((r) => r.some((c) => LAYOUT_ROW.test(c)));
    layoutCol = first.findIndex((c) => LAYOUT_ROW.test(c));
  }
  const nameCol = layoutCol - 1;
  const rows = grid.slice(hIdx + 1).filter((r) => LAYOUT_ROW.test(r[layoutCol] ?? ''));
  const players = [];
  const byPlayer = new Map();
  let lastName = '';
  for (const r of rows) {
    const raw = nameCol >= 0 && r[nameCol] ? r[nameCol] : lastName;
    lastName = raw;
    if (!byPlayer.has(raw)) { byPlayer.set(raw, [null, null, null]); players.push(raw); }
    const l = 'abc'.indexOf(LAYOUT_ROW.exec(r[layoutCol])[1].toLowerCase());
    byPlayer.get(raw)[l] = r.slice(layoutCol + 1);
  }
  const n = players.length;
  const width = Math.max(n, ...rows.map((r) => r.length - layoutCol - 1));
  const nCols = header ? Math.min(width, header.length - layoutCol - 1) : width;
  const colNames = Array.from({ length: nCols }, (_, j) => cleanName(header?.[layoutCol + 1 + j], `Eux ${j + 1}`));
  const rowNames = players.map((p, i) => cleanName(p, `Nous ${i + 1}`));
  const raws = [0, 1, 2].map((l) => players.map((p) => Array.from({ length: nCols }, (_, j) => byPlayer.get(p)[l]?.[j] ?? '')));
  const layouts = raws.map((g) => ({ rowNames, colNames, raw: g, cells: g.map((row) => row.map((c) => parseCell(c, codes))) }));
  return { rowNames, colNames, layouts, raw: raws[0], cells: layouts[0].cells };
}

export function parseMatrix(text, codes = DEFAULT_CODES) {
  if (!text.trim()) throw new Error('Matrice vide');
  let grid = parseDelimited(text, detectSeparator(text));
  if (!grid.length) throw new Error('Matrice vide');
  if (grid.some((r) => r.some((c) => LAYOUT_ROW.test(c)))) return parseLayoutRows(grid, codes);

  const isVal = (c) => parseCell(c, codes) !== null || isMissingCode(c);
  const headerRow = grid[0].slice(1).some((c) => c !== '' && !isVal(c));
  let colNames = null;
  if (headerRow) { colNames = grid[0]; grid = grid.slice(1); }
  const headerCol = grid.some((r) => r[0] !== '' && !isVal(r[0]));
  let rowNames = null;
  if (headerCol) {
    rowNames = grid.map((r) => r[0]);
    grid = grid.map((r) => r.slice(1));
    if (colNames) colNames = colNames.slice(1);
  }
  const nCols = Math.max(...grid.map((r) => r.length));
  const raw = grid.map((r) => Array.from({ length: nCols }, (_, j) => r[j] ?? ''));
  return {
    rowNames: (rowNames ?? raw.map((_, i) => `Nous ${i + 1}`)).map((s, i) => cleanName(s, `Nous ${i + 1}`)),
    colNames: (colNames ?? Array.from({ length: nCols }, (_, j) => `Eux ${j + 1}`)).slice(0, nCols).map((s, j) => cleanName(s, `Eux ${j + 1}`)),
    raw,
    cells: raw.map((r) => r.map((c) => parseCell(c, codes))),
  };
}

// Converts a raw value to expected BP (0-20).
//   scale.type === 'bp'     : value already in BP
//   scale.type === 'linear' : [inMin, inMax] -> [outMin, outMax]
export function toBp(value, scale) {
  if (value == null) return null;
  let v = value;
  if (scale?.type === 'linear') {
    const { inMin, inMax, outMin, outMax } = scale;
    v = outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
  }
  return Math.max(0, Math.min(20, v));
}

// sd given in raw units is scaled with the same factor as the value.
export function sdToBp(sd, scale) {
  if (sd == null) return null;
  if (scale?.type === 'linear') return Math.abs(sd * (scale.outMax - scale.outMin) / (scale.inMax - scale.inMin));
  return sd;
}

// Builds engine inputs mu[l][a][b], sd[l][a][b] from up to three parsed layout
// matrices (missing layouts fall back to the first one) and a default sd.
// Code cells are already in BP and bypass the numeric scale.
export function buildModel(parsedByLayout, n, scale, defaultSd) {
  const base = parsedByLayout.find((p) => p);
  if (!base) throw new Error('Aucune matrice');
  const missing = [];
  const mu = [], sd = [];
  for (let l = 0; l < 3; l++) {
    const p = parsedByLayout[l] ?? base;
    mu.push([]); sd.push([]);
    for (let a = 0; a < n; a++) {
      mu[l].push([]); sd[l].push([]);
      for (let b = 0; b < n; b++) {
        const c = p.cells[a]?.[b] ?? null;
        if (!c) missing.push({ layout: l, a, b });
        mu[l][a].push(c ? (c.bp ? Math.max(0, Math.min(20, c.value)) : toBp(c.value, scale)) : 10);
        sd[l][a].push(c && c.sd != null ? (c.bp ? c.sd : sdToBp(c.sd, scale)) : defaultSd);
      }
    }
  }
  return { mu, sd, missing };
}
