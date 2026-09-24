import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SharedMatrix, toShared, fromShared, diffShared, rowId } from '../src/shared.js';

// In-memory stand-in for the artifact `db` capability: documents by path,
// synchronous snapshot delivery, `update` requires an existing document.
function fakeDb({ readonly = false } = {}) {
  const docs = new Map();
  const docListeners = new Map();
  const colListeners = new Map();
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const snap = (path) => ({ id: path.split('/').pop(), exists: docs.has(path), data: () => (docs.has(path) ? clone(docs.get(path)) : undefined) });
  const colOf = (path) => path.split('/').slice(0, -1).join('/');
  const notify = (path) => {
    for (const cb of docListeners.get(path) ?? []) cb(snap(path));
    const col = colOf(path);
    for (const cb of colListeners.get(col) ?? []) cb(colSnap(col));
  };
  const colSnap = (col) => {
    const list = [...docs.keys()].filter((p) => colOf(p) === col).sort().map(snap);
    return { docs: list, size: list.length, empty: !list.length };
  };
  const reject = () => Promise.reject({ code: 'invalid_argument', message: 'read only' });
  const doc = (path) => ({
    id: path.split('/').pop(),
    path,
    get: async () => snap(path),
    set: async (data) => { if (readonly) return reject(); docs.set(path, clone(data)); notify(path); },
    update: async (data) => {
      if (readonly || !docs.has(path)) return reject();
      docs.set(path, { ...docs.get(path), ...clone(data) }); notify(path);
    },
    delete: async () => { docs.delete(path); notify(path); },
    onSnapshot: (cb) => {
      if (!docListeners.has(path)) docListeners.set(path, []);
      docListeners.get(path).push(cb);
      cb(snap(path));
      return () => {};
    },
  });
  const collection = (col) => ({
    path: col,
    doc: (id) => doc(`${col}/${id}`),
    onSnapshot: (cb) => {
      if (!colListeners.has(col)) colListeners.set(col, []);
      colListeners.get(col).push(cb);
      cb(colSnap(col));
      return () => {};
    },
  });
  return { doc, collection, docs };
}

function cfgOf(n, fill) {
  return {
    n,
    us: Array.from({ length: n }, (_, i) => `Nous ${i + 1}`),
    them: Array.from({ length: n }, (_, j) => `Eux ${j + 1}`),
    grids: [0, 1, 2].map((l) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => fill(l, i, j)))),
    sameLayouts: false,
    codes: [{ code: 'WIN', mean: 14, sd: 3 }],
    swing: { chance: 25, high: 18, low: 3, spread: 2 },
  };
}

// A view = a local configuration plus its SharedMatrix.
function view(db, cfg) {
  const v = { cfg, statuses: [] };
  v.sm = new SharedMatrix(db, {
    getLocal: () => v.cfg,
    applyRemote: (part) => { v.cfg = { ...v.cfg, ...part }; },
    onStatus: (s) => v.statuses.push(s),
    debounceMs: 0,
  });
  v.sm.start();
  return v;
}

test('toShared / fromShared round-trip and cell-level diff', () => {
  const cfg = cfgOf(3, (l, i, j) => `${l}${i}${j}`);
  const s = toShared(cfg);
  assert.equal(Object.keys(s.rows).length, 9);
  assert.deepEqual(s.rows[rowId(2, 1)], { c0: '210', c1: '211', c2: '212' });
  const back = fromShared(s.meta, s.rows);
  assert.deepEqual(back.grids, cfg.grids);
  const edited = cfgOf(3, (l, i, j) => (l === 1 && i === 2 && j === 0 ? 'WIN' : `${l}${i}${j}`));
  assert.deepEqual(diffShared(s, toShared(edited)), { meta: null, rows: [{ id: 'L1-2', fields: { c0: 'WIN' } }] });
});

test('empty store: the first view shares its matrix', async () => {
  const db = fakeDb();
  const a = view(db, cfgOf(3, () => 'DRAW'));
  assert.equal(a.sm.status, 'empty');
  await a.sm.shareMine();
  assert.equal(a.sm.status, 'live');
  assert.equal(db.docs.get('team/meta').n, 3);
  assert.equal([...db.docs.keys()].filter((k) => k.startsWith('rows/')).length, 9);
});

test('a teammate opening the page gets the team matrix, not their local one', async () => {
  const db = fakeDb();
  const a = view(db, cfgOf(3, () => 'WIN'));
  await a.sm.shareMine();
  const b = view(db, cfgOf(4, () => 'LOSE'));
  assert.equal(b.cfg.n, 3);
  assert.equal(b.cfg.grids[0][0][0], 'WIN');
  assert.equal(db.docs.get('team/meta').n, 3); // B did not overwrite anything
});

test('an edit is written and reaches the other view', async () => {
  const db = fakeDb();
  const a = view(db, cfgOf(3, () => 'DRAW'));
  await a.sm.shareMine();
  const b = view(db, cfgOf(3, () => ''));
  a.cfg.grids[1][2][0] = 'p_WIN!40_20';
  await a.sm.flush();
  assert.equal(db.docs.get('rows/L1-2').c0, 'p_WIN!40_20');
  assert.equal(b.cfg.grids[1][2][0], 'p_WIN!40_20');
  assert.ok(db.docs.get('team/meta').updatedAt);
});

test('two teammates editing different cells of the same row keep both edits', async () => {
  const db = fakeDb();
  const a = view(db, cfgOf(3, () => 'DRAW'));
  await a.sm.shareMine();
  const b = view(db, cfgOf(3, () => ''));
  a.cfg.grids[0][0][0] = 'WIN';
  b.cfg.grids[0][0][2] = 'ALED';
  await a.sm.flush(); // B receives A's edit while its own is not written yet
  assert.equal(b.cfg.grids[0][0][2], 'ALED', 'pending local edit survives the remote update');
  assert.equal(b.cfg.grids[0][0][0], 'WIN');
  await b.sm.flush();
  assert.deepEqual(db.docs.get('rows/L0-0'), { c0: 'WIN', c1: 'DRAW', c2: 'ALED' });
  assert.equal(a.cfg.grids[0][0][2], 'ALED');
});

test('names, layout mode and team size are shared too', async () => {
  const db = fakeDb();
  const a = view(db, cfgOf(3, () => 'DRAW'));
  await a.sm.shareMine();
  const b = view(db, cfgOf(3, () => ''));
  a.cfg = { ...cfgOf(4, () => 'WIN'), us: ['A1', 'A2', 'A3', 'A4'], sameLayouts: true };
  await a.sm.flush();
  assert.equal(b.cfg.n, 4);
  assert.deepEqual(b.cfg.us, ['A1', 'A2', 'A3', 'A4']);
  assert.equal(b.cfg.sameLayouts, true);
  assert.equal(b.cfg.grids[2][3][3], 'WIN');
});

test('read-only viewer: writes are refused, the team matrix is still received', async () => {
  const db = fakeDb();
  const a = view(db, cfgOf(3, () => 'DRAW'));
  await a.sm.shareMine();
  const roDb = { ...db, doc: (p) => ({ ...db.doc(p), set: () => Promise.reject({ code: 'invalid_argument' }), update: () => Promise.reject({ code: 'invalid_argument' }) }),
    collection: (c) => ({ ...db.collection(c), doc: (id) => roDb.doc(`${c}/${id}`) }) };
  const r = view(roDb, cfgOf(3, () => ''));
  r.cfg.grids[0][0][0] = 'ALED';
  await r.sm.flush();
  assert.equal(r.sm.status, 'readonly');
  assert.equal(db.docs.get('rows/L0-0').c0, 'DRAW');
  a.cfg.grids[0][1][1] = 'WIN';
  await a.sm.flush();
  assert.equal(r.cfg.grids[0][1][1], 'WIN');
  assert.equal(r.cfg.grids[0][0][0], 'DRAW', 'read-only local edit is replaced by the team value');
});

test('sync turned off: nothing is applied or written', async () => {
  const db = fakeDb();
  const a = view(db, cfgOf(3, () => 'DRAW'));
  await a.sm.shareMine();
  const b = view(db, cfgOf(3, () => ''));
  b.sm.setEnabled(false);
  b.cfg.grids[0][0][0] = 'LOSE';
  await b.sm.flush();
  assert.equal(db.docs.get('rows/L0-0').c0, 'DRAW');
  a.cfg.grids[0][0][1] = 'WIN';
  await a.sm.flush();
  assert.equal(b.cfg.grids[0][0][1], 'DRAW');
  b.sm.setEnabled(true); // back on: the team matrix is applied again
  assert.equal(b.cfg.grids[0][0][1], 'WIN');
});
