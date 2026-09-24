// Team matrix shared through the Claude artifact `db` capability.
//
// Store layout (at most 1 + 3 * 8 = 25 documents):
//   team/meta          { n, us, them, sameLayouts, codes, swing, updatedAt }
//   rows/L<l>-<i>      { c0, c1, ... }  one document per layout and player
// One field per cell lets two teammates edit different cells of the same
// row at the same time: `update({ c3 })` merges that field only.
//
// The pairing itself (who defends, etc.) stays local to each viewer.

export const META_KEYS = ['n', 'us', 'them', 'sameLayouts', 'codes', 'swing'];

export const rowId = (l, i) => `L${l}-${i}`;

// Shared part of the local configuration, in store shape.
export function toShared(cfg) {
  const n = cfg.n;
  const meta = {
    n,
    us: cfg.us.slice(0, n),
    them: cfg.them.slice(0, n),
    sameLayouts: !!cfg.sameLayouts,
    codes: cfg.codes.map((c) => ({ ...c })),
    swing: { ...cfg.swing },
  };
  const rows = {};
  for (let l = 0; l < 3; l++) {
    for (let i = 0; i < n; i++) {
      const row = cfg.grids[l]?.[i] ?? [];
      rows[rowId(l, i)] = Object.fromEntries(Array.from({ length: n }, (_, j) => [`c${j}`, row[j] ?? '']));
    }
  }
  return { meta, rows };
}

// Store shape -> configuration fields. Missing cells read as ''.
export function fromShared(meta, rows) {
  const n = meta.n;
  const grids = [0, 1, 2].map((l) => Array.from({ length: n }, (_, i) => {
    const r = rows[rowId(l, i)] ?? {};
    return Array.from({ length: n }, (_, j) => String(r[`c${j}`] ?? ''));
  }));
  const out = { n, grids, sameLayouts: !!meta.sameLayouts };
  out.us = Array.from({ length: n }, (_, i) => meta.us?.[i] ?? `Nous ${i + 1}`);
  out.them = Array.from({ length: n }, (_, j) => meta.them?.[j] ?? `Eux ${j + 1}`);
  if (Array.isArray(meta.codes)) out.codes = meta.codes.map((c) => ({ ...c }));
  if (meta.swing) out.swing = { ...meta.swing };
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What must be written so that the store (base) matches next.
//   meta : changed meta fields, or null
//   rows : [{ id, full }] for documents to create, [{ id, fields }] to merge
export function diffShared(base, next) {
  const meta = {};
  for (const k of META_KEYS) if (!same(base?.meta?.[k], next.meta[k])) meta[k] = next.meta[k];
  const rows = [];
  for (const [id, body] of Object.entries(next.rows)) {
    const b = base?.rows?.[id];
    if (!b) { rows.push({ id, full: body }); continue; }
    const fields = {};
    for (const [k, v] of Object.entries(body)) if (b[k] !== v) fields[k] = v;
    if (Object.keys(fields).length) rows.push({ id, fields });
  }
  return { meta: Object.keys(meta).length ? meta : null, rows };
}

// Applies a diff to a store-shaped state (used to keep local, not yet
// written edits on top of a newer remote state).
export function patchShared(state, diff) {
  const out = { meta: { ...state.meta, ...(diff.meta ?? {}) }, rows: { ...state.rows } };
  for (const w of diff.rows) out.rows[w.id] = w.full ? { ...w.full } : { ...(out.rows[w.id] ?? {}), ...w.fields };
  return out;
}

// Keeps the local configuration and the store in sync.
//   getLocal()        -> current local configuration
//   applyRemote(part) -> replace the shared fields of the local configuration
//   onStatus(status)  -> 'connecting' | 'empty' | 'live' | 'readonly' | 'error' | 'off'
export class SharedMatrix {
  constructor(db, { getLocal, applyRemote, onStatus, debounceMs = 400, now = () => new Date().toISOString() }) {
    this.db = db;
    this.getLocal = getLocal;
    this.applyRemote = applyRemote;
    this.onStatus = onStatus ?? (() => {});
    this.debounceMs = debounceMs;
    this.now = now;
    this.enabled = true;
    this.status = 'connecting';
    this.error = null;
    this.metaKnown = false;
    this.rowsKnown = false;
    this.remoteMeta = null;
    this.remoteRows = {};
    this.base = null; // last store state known to this view, in local shape
    this.existingRows = new Set(); // row documents present in the store
    this.timer = null;
    this.flushing = null;
    this.again = false;
    this.updatedAt = null;
    this.unsub = [];
  }

  start() {
    const fail = (e) => this.setStatus('error', e);
    this.unsub.push(this.db.doc('team/meta').onSnapshot((snap) => {
      this.metaKnown = true;
      this.remoteMeta = snap.exists ? snap.data() : null;
      this.sync();
    }, fail));
    this.unsub.push(this.db.collection('rows').onSnapshot((qs) => {
      this.rowsKnown = true;
      this.remoteRows = Object.fromEntries(qs.docs.map((d) => [d.id, d.data()]));
      this.sync();
    }, fail));
    this.onStatus(this.status);
  }

  stop() {
    for (const u of this.unsub) u();
    this.unsub = [];
    clearTimeout(this.timer);
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.onStatus(status);
  }

  setEnabled(on) {
    this.enabled = on;
    // Turning sync back on: the team matrix wins over local edits.
    if (on) { this.base = null; this.sync(true); }
    else this.onStatus(this.status);
  }

  // Remote -> local.
  sync(force = false) {
    if (!this.metaKnown || !this.rowsKnown) return;
    if (!this.remoteMeta) {
      this.base = null;
      if (this.status !== 'readonly') this.setStatus('empty');
      return;
    }
    // Normalise the store state to the local shape (missing cells read as ''),
    // so that a cell the store does not have yet never looks like a local edit.
    const remote = toShared({
      codes: [], swing: {},
      ...fromShared(this.remoteMeta, this.remoteRows),
    });
    this.existingRows = new Set(Object.keys(this.remoteRows));
    this.updatedAt = this.remoteMeta.updatedAt ?? null;
    let target = remote;
    // Keep local edits that are not written yet. On the very first remote
    // state the team matrix wins entirely.
    if (this.base && this.enabled && this.status === 'live') {
      const pending = diffShared(this.base, toShared(this.getLocal()));
      target = patchShared(remote, pending);
    }
    this.base = remote;
    if (this.enabled) {
      const local = toShared(this.getLocal());
      if (force || diffShared(local, target).meta || diffShared(local, target).rows.length) {
        this.applyRemote(fromShared(target.meta, target.rows));
      }
    }
    if (this.status !== 'readonly') this.setStatus('live');
    else this.onStatus(this.status);
  }

  // Local -> remote, debounced.
  localChanged() {
    if (!this.enabled || this.status !== 'live') return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  async flush() {
    if (this.flushing) { this.again = true; return this.flushing; }
    this.flushing = (async () => {
      try {
        do {
          this.again = false;
          if (!this.base || !this.enabled || this.status !== 'live') return;
          const diff = diffShared(this.base, toShared(this.getLocal()));
          if (!diff.meta && !diff.rows.length) return;
          const local = toShared(this.getLocal());
          // Rows first, then meta: a larger team size only shows up once its
          // rows exist.
          for (const w of diff.rows) {
            const ref = this.db.collection('rows').doc(w.id);
            if (w.full || !this.existingRows.has(w.id)) {
              await ref.set(local.rows[w.id]);
              this.existingRows.add(w.id);
            } else {
              await ref.update(w.fields);
            }
            this.base.rows[w.id] = { ...local.rows[w.id] };
          }
          const stamp = this.now();
          await this.db.doc('team/meta').update({ ...(diff.meta ?? {}), updatedAt: stamp });
          this.base.meta = { ...this.base.meta, ...(diff.meta ?? {}) };
        } while (this.again);
      } catch (e) {
        if (e?.code === 'invalid_argument') this.setStatus('readonly', e);
        else this.setStatus('error', e);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  // Creates (or replaces) the team matrix with the local one.
  async shareMine() {
    const mine = toShared(this.getLocal());
    try {
      await this.db.doc('team/meta').set({ ...mine.meta, updatedAt: this.now() });
      for (const [id, body] of Object.entries(mine.rows)) await this.db.collection('rows').doc(id).set(body);
      this.base = mine;
      this.existingRows = new Set(Object.keys(mine.rows));
      this.enabled = true;
      this.setStatus('live');
    } catch (e) {
      if (e?.code === 'invalid_argument') this.setStatus('readonly', e);
      else this.setStatus('error', e);
    }
  }
}
