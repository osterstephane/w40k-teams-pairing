// Parsing of a matchup matrix pasted from a spreadsheet (Google Sheets / Excel).
//
// Accepted layout: our players in rows, their players in columns, optional
// header row / column with names. Separators: tab, ';' or ','.
// Cell formats: "12", "12,5", "12±3", "12+-3", "12 (3)"  -> mean [± sd].

const CELL = /^\s*([+-]?\d+(?:[.,]\d+)?)\s*(?:(?:±|\+-|\+\/-)\s*(\d+(?:[.,]\d+)?)|\(\s*(\d+(?:[.,]\d+)?)\s*\))?\s*$/;

export function parseCell(text) {
  if (text == null) return null;
  const m = CELL.exec(String(text));
  if (!m) return null;
  const num = (s) => (s == null ? null : parseFloat(s.replace(',', '.')));
  return { value: num(m[1]), sd: num(m[2] ?? m[3]) };
}

function splitLine(line, sep) {
  return line.split(sep).map((c) => c.trim());
}

export function parseMatrix(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) throw new Error('Matrice vide');
  const sep = text.includes('\t') ? '\t' : text.includes(';') ? ';' : ',';
  let grid = lines.map((l) => splitLine(l, sep));
  const isNum = (c) => parseCell(c) !== null;

  const headerRow = grid[0].slice(1).some((c) => c !== '' && !isNum(c));
  let colNames = null;
  if (headerRow) { colNames = grid[0]; grid = grid.slice(1); }
  const headerCol = grid.some((r) => r[0] !== '' && !isNum(r[0]));
  let rowNames = null;
  if (headerCol) {
    rowNames = grid.map((r) => r[0]);
    grid = grid.map((r) => r.slice(1));
    if (colNames) colNames = colNames.slice(1);
  }
  const nCols = Math.max(...grid.map((r) => r.length));
  const cells = grid.map((r) => Array.from({ length: nCols }, (_, j) => parseCell(r[j])));
  return {
    rowNames: rowNames ?? cells.map((_, i) => `Nous ${i + 1}`),
    colNames: (colNames ?? Array.from({ length: nCols }, (_, j) => `Eux ${j + 1}`)).slice(0, nCols),
    cells,
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
        const c = p.cells[a]?.[b] ?? base.cells[a]?.[b] ?? null;
        if (!c) missing.push({ layout: l, a, b });
        mu[l][a].push(c ? toBp(c.value, scale) : 10);
        sd[l][a].push(c && c.sd != null ? sdToBp(c.sd, scale) : defaultSd);
      }
    }
  }
  return { mu, sd, missing };
}
