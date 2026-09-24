// User interface (vanilla JS, no framework).
import { parseCell, parseMatrix, buildModel, toBp, DEFAULT_CODES, DEFAULT_SWING, isMissingCode, formatCodeCell } from './matrix.js';
import { initialState, setDefenders, setAttackers, setChoices, setLayouts } from './pairing.js';
import { MODULES_BY_SIZE, thresholds, LAYOUTS, layoutForRound } from './rules.js';
import { createEngine } from './engine.js';
import { advise } from './advisor.js';

const STORAGE_KEY = 'w40k-teams-pairing/v1';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x) => `${Math.round(x * 100)} %`;
const score = (x) => (x * 100).toFixed(1);
const signed = (x) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1);

const MODULE_NAMES = { S: 'Initial Skirmish', M: 'Main Engagement', C: 'Champion' };
const STEP_NAMES = {
  defenders: 'Défenseurs',
  attackers: 'Attaquants',
  choices: 'Attaquant retenu',
  layouts: 'Layouts',
};
const ROLE_NAMES = { ourDefender: 'Notre défenseur', theirDefender: 'Leur défenseur', refused: 'Attaquants refusés', champion: 'Champions' };

// ------------------------------------------------------------------ config

const EX_US = ['Space Marines', 'Aeldari', 'Necrons', "T'au Empire", 'Death Guard', 'Astra Militarum', 'Adepta Sororitas', 'Chaos Knights'];
const EX_THEM = ['Orks', 'Tyranids', 'Adeptus Custodes', 'Drukhari', 'Grey Knights', 'World Eaters', 'Thousand Sons', 'Imperial Knights'];

function exampleConfig(n = 6) {
  let seed = 17;
  const r = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const base = Array.from({ length: n }, () => Array.from({ length: n }, () => Math.round(4 + r() * 12)));
  const toCode = (v) => (v >= 15 ? 'FACILE' : v >= 13 ? 'WIN' : v >= 11 ? 'p_WIN' : v >= 9 ? 'DRAW' : v >= 7 ? 'p_LOSE' : v >= 5 ? 'LOSE' : 'ALED');
  const grids = [0, 1, 2].map((l) => base.map((row) => row.map((v) => {
    const x = l === 0 ? v : Math.max(0, Math.min(20, v + Math.round((r() - 0.5) * 6)));
    return r() < 0.06 ? 'GAMBLE' : toCode(x);
  })));
  return {
    version: 1, example: true, n, round: 1,
    us: EX_US.slice(0, n), them: EX_THEM.slice(0, n),
    grids, sameLayouts: false, defaultSd: 4,
    scale: { type: 'bp', inMin: -2, inMax: 2, outMin: 4, outMax: 16 },
    objective: { marginWeight: 0, drawValue: 0.5 },
    precision: 'standard',
    codes: defaultCodes(),
    swing: { ...DEFAULT_SWING },
  };
}

function defaultCodes() {
  return DEFAULT_CODES.map((c) => ({ ...c }));
}

function resize(c, n) {
  const fit = (arr, fill) => Array.from({ length: n }, (_, i) => arr[i] ?? fill(i));
  c.us = fit(c.us, (i) => `Nous ${i + 1}`);
  c.them = fit(c.them, (i) => `Eux ${i + 1}`);
  c.grids = c.grids.map((g) => fit(g, () => []).map((row) => fit(row, () => '10')));
  c.n = n;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.cfg?.grids || !MODULES_BY_SIZE[data.cfg.n]) return null;
    return data;
  } catch { return null; }
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ cfg, live })); } catch { /* storage unavailable */ }
}

const saved = load();
let cfg = saved?.cfg ?? exampleConfig(6);
if (!Array.isArray(cfg.codes)) cfg.codes = defaultCodes();
cfg.swing = { ...DEFAULT_SWING, ...cfg.swing };
delete cfg.nuanceStep;
let live = saved?.live ?? { history: [], state: initialState(cfg.n, cfg.round) };
if (live.state.n !== cfg.n) live = { history: [], state: initialState(cfg.n, cfg.round) };
let tab = 'pairing';
let editLayout = 0;
let selCell = null; // { i, j } cell open in the cell editor
let ceAll = false; // cell editor: apply to the three layouts

const us = (i) => cfg.us[i] || `Nous ${i + 1}`;
const them = (j) => cfg.them[j] || `Eux ${j + 1}`;
const usPair = (p) => `${us(p[0])} + ${us(p[1])}`;
const themPair = (p) => `${them(p[0])} + ${them(p[1])}`;

function currentModel() {
  const parsed = [0, 1, 2].map((l) => ({
    cells: (cfg.sameLayouts ? cfg.grids[0] : cfg.grids[l]).map((row) => row.map((v) => parseCell(v, cfg.codes, { swing: cfg.swing }))),
  }));
  return buildModel(parsed, cfg.n, cfg.scale, Number(cfg.defaultSd) || 4);
}

function engineConfig() {
  const m = currentModel();
  return {
    n: cfg.n, round: cfg.round, mu: m.mu, sd: m.sd,
    objective: { marginWeight: Number(cfg.objective.marginWeight), drawValue: Number(cfg.objective.drawValue) },
    quantum: cfg.precision === 'fast' ? { mean: 1, variance: 8 } : { mean: 0.5, variance: 4 },
    missing: m.missing.length,
  };
}

function resetPairing() {
  live = { history: [], state: initialState(cfg.n, cfg.round) };
  save();
}

// ------------------------------------------------------------- computation

let advice = null, adviceKey = null, adviceError = null, computing = false, progress = 0;
let worker = null, workerKey = null, workerBusy = false, pending = null, useSync = false;
let syncEngine = null, syncKey = null, reqId = 0;

function makeWorker() {
  if (window.__CORE_SOURCE__) {
    const url = URL.createObjectURL(new Blob([window.__CORE_SOURCE__], { type: 'text/javascript' }));
    return new Worker(url);
  }
  return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}

function ensureAdvice() {
  const ec = engineConfig();
  const eKey = JSON.stringify(ec);
  const key = eKey + JSON.stringify(live.state);
  if (key === adviceKey) return;
  adviceKey = key; advice = null; adviceError = null; computing = true; progress = 0;
  compute(eKey, ec, live.state, key);
}

function compute(eKey, ec, state, key) {
  const id = ++reqId;
  pending = { id, key };
  if (!useSync) {
    try {
      if (!worker || workerKey !== eKey || workerBusy) {
        if (worker) worker.terminate();
        worker = makeWorker();
        workerKey = eKey;
        worker.onmessage = (e) => onWorker(e.data);
        worker.onerror = (e) => {
          e.preventDefault?.();
          useSync = true; worker?.terminate(); worker = null; workerBusy = false;
          compute(eKey, ec, state, key);
        };
        worker.postMessage({ type: 'init', config: ec });
      }
      workerBusy = true;
      worker.postMessage({ type: 'advise', id, state });
      return;
    } catch {
      useSync = true;
    }
  }
  setTimeout(() => {
    if (pending?.id !== id) return;
    try {
      if (syncKey !== eKey) { syncEngine = createEngine(ec); syncKey = eKey; }
      finish(key, advise(syncEngine, state, ec.mu, ec.sd), null);
    } catch (err) { finish(key, null, String(err?.message ?? err)); }
  }, 30);
}

function onWorker(msg) {
  if (!pending || msg.id !== pending.id) return;
  if (msg.type === 'progress') {
    progress = msg.p;
    const bar = $('#progress-bar');
    if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
    return;
  }
  workerBusy = false;
  finish(pending.key, msg.type === 'advice' ? msg.advice : null, msg.type === 'error' ? msg.message : null);
}

function finish(key, adv, err) {
  if (key !== adviceKey) return;
  computing = false;
  advice = adv; adviceError = err;
  if (tab === 'pairing') render();
}

// -------------------------------------------------------------- rendering

function render() {
  $$('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  const app = $('#app');
  if (tab === 'pairing') { ensureAdvice(); app.innerHTML = pairingView(); bindPairing(); }
  else if (tab === 'matrix') { app.innerHTML = matrixView(); bindMatrix(); }
  else { app.innerHTML = methodView(); }
}

function vdlBar(m) {
  const w = m.win * 100, d = m.draw * 100, l = m.loss * 100;
  const lab = (x, t) => (x >= 12 ? `${t} ${Math.round(x)} %` : x >= 6 ? `${Math.round(x)}` : '');
  return `<div class="vdl" role="img" aria-label="Victoire ${Math.round(w)} %, nul ${Math.round(d)} %, défaite ${Math.round(l)} %">
    <div class="w" style="width:${w}%">${lab(w, 'V')}</div><div class="d" style="width:${d}%">${lab(d, 'N')}</div><div class="l" style="width:${l}%">${lab(l, 'D')}</div></div>`;
}

function miniBar(m) {
  return `<span class="minibar" title="V ${pct(m.win)} · N ${pct(m.draw)} · D ${pct(m.loss)}"><i class="w" style="width:${m.win * 100}%"></i><i class="d" style="width:${m.draw * 100}%"></i><i class="l" style="width:${m.loss * 100}%"></i></span>`;
}

function projectionPanel() {
  const th = thresholds(cfg.n);
  const p = advice?.projection;
  const body = p ? `
    ${vdlBar(p)}
    <div class="bigline"><span class="big num">${score(p.obj)}</span><span class="muted">score objectif (sur 100)</span></div>
    <dl class="kv">
      <dt>Victoire / nul / défaite</dt><dd>${pct(p.win)} / ${pct(p.draw)} / ${pct(p.loss)}</dd>
      <dt>BP attendus</dt><dd>${p.bp.toFixed(1)} – ${(th.total - p.bp).toFixed(1)}</dd>
      <dt>Points d'équipe attendus</dt><dd>${p.tp.toFixed(2)}</dd>
      <dt>Seuil de victoire</dt><dd>≥ ${th.win} BP (écart ${th.differential})</dd>
    </dl>
    <p class="note">Projection si les deux équipes jouent au mieux à partir d'ici.</p>` : `<p class="muted">${computing ? 'Calcul en cours…' : '—'}</p>`;
  return `<section class="panel proj" aria-live="polite"><h3>Projection du match</h3>${body}</section>`;
}

function timeline() {
  const s = live.state;
  const items = [];
  s.modules.forEach((m, i) => {
    if (m === 'C') {
      items.push(`<li class="${s.mod > i || s.step === 'done' ? 'past' : ''}">Champion</li>`);
      return;
    }
    for (const step of ['defenders', 'attackers', 'choices', 'layouts']) {
      const cls = i < s.mod || s.step === 'done' ? 'past' : i === s.mod && s.step === step ? 'now' : '';
      const past = i === s.mod && ['defenders', 'attackers', 'choices', 'layouts'].indexOf(step) < ['defenders', 'attackers', 'choices', 'layouts'].indexOf(s.step);
      items.push(`<li class="${past ? 'past' : cls}">${esc(MODULE_NAMES[m])} · ${STEP_NAMES[step]}</li>`);
    }
  });
  return `<ol class="timeline">${items.join('')}</ol>`;
}

function gamesList() {
  const m = currentModel();
  const s = live.state;
  if (!s.games.length) return '<p class="muted">Aucune partie fixée pour l\'instant.</p>';
  return `<ul class="games">${s.games.map((g) => `
    <li><span>${esc(us(g.a))} <span class="muted">vs</span> ${esc(them(g.b))}</span>
      <span class="num">${m.mu[g.layout][g.a][g.b].toFixed(1)}±${m.sd[g.layout][g.a][g.b].toFixed(0)}</span>
      <span class="role">${ROLE_NAMES[g.role]} · layout ${LAYOUTS[g.layout]}</span><span></span></li>`).join('')}</ul>`;
}

function pairingView() {
  const s = live.state;
  const ec = engineConfig();
  const main = computing
    ? `<section class="panel"><h2>Calcul des recommandations…</h2><div class="progress"><i id="progress-bar" style="width:${Math.round(progress * 100)}%"></i></div>
       <p class="note">${cfg.n === 8 && s.mod === 0 && s.step === 'defenders' ? 'À 8 joueurs, le premier calcul explore tout l\'arbre de pairing (15 à 40 s). Les étapes suivantes seront instantanées.' : 'Quelques instants.'}</p></section>`
    : adviceError ? `<section class="panel"><h2>Erreur de calcul</h2><p class="warn">${esc(adviceError)}</p></section>`
      : stepView();
  return `
  <div class="grid-2">
    <div class="stack">
      <section class="panel">
        <div class="row" style="justify-content:space-between">
          <h2>Ronde ${cfg.round} · ${cfg.n} joueurs</h2>
          <div class="row">
            <button class="btn small" id="undo" ${live.history.length ? '' : 'disabled'}>Annuler la dernière étape</button>
            <button class="btn small" id="restart">Recommencer le pairing</button>
          </div>
        </div>
        ${timeline()}
        ${cfg.example ? '<p class="note">Données d\'exemple. Remplacez-les dans l\'onglet Matrice.</p>' : ''}
        ${ec.missing ? `<p class="warn">${ec.missing} case(s) de matrice à estimer (vides, SAIS-PÔ ou illisibles), comptées comme DRAW (10 BP) en attendant.</p>` : ''}
      </section>
      ${main}
    </div>
    <aside class="stack">
      ${projectionPanel()}
      <section class="panel"><h3>Parties fixées</h3>${gamesList()}</section>
    </aside>
  </div>`;
}

function chips(r, adv, best) {
  if (r.prob > 0.005) return `<span class="chip best">à jouer ${pct(r.prob)}</span>`;
  if (r.vsEq >= best - 0.005) return '<span class="chip eq">équivalent</span>';
  if (r.vsEq < best - 0.03) return '<span class="chip bad">à éviter</span>';
  return '';
}

function optionsTable(adv, rowLabel, colLabel) {
  const best = Math.max(...adv.rows.map((r) => r.vsEq));
  const sorted = [...adv.rows].sort((a, b) => b.vsEq - a.vsEq);
  return `<div class="tablewrap"><table>
    <thead><tr><th>Notre option</th><th></th><th class="num" title="Score si l'adversaire joue sa meilleure stratégie">Score</th><th class="num">Écart</th>
      <th class="num" title="Score si l'adversaire devine notre choix et contre au mieux">Pire cas</th><th>Contré par</th><th class="num">Meilleur cas</th><th>V / N / D</th><th class="num">BP</th></tr></thead>
    <tbody>${sorted.map((r) => `<tr class="${r.prob > 0.005 ? 'picked' : ''}">
      <td>${esc(rowLabel(r.label))}</td><td>${chips(r, adv, best)}</td>
      <td class="num">${score(r.vsEq)}</td><td class="num">${signed(r.vsEq - best)}</td>
      <td class="num">${score(r.worst)}</td><td class="muted">${esc(colLabel(adv.cols[r.worstCol].label))}</td>
      <td class="num">${score(r.best)}</td><td>${miniBar(r.metrics)}</td><td class="num">${r.metrics.bp.toFixed(1)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function opponentBlock(adv, rowLabel, colLabel) {
  const mix = adv.cols.filter((c) => c.prob > 0.005).sort((a, b) => b.prob - a.prob);
  const opts = adv.cols.map((c, j) => `<option value="${j}">${esc(colLabel(c.label))}</option>`).join('');
  return `<div class="field"><span>Côté adversaire</span>
    <p>Leur meilleure stratégie : ${mix.map((c) => `<strong>${esc(colLabel(c.label))}</strong> (${pct(c.prob)})`).join(', ')}.</p>
    <div class="row"><label class="field"><span>Si vous pensez qu'ils vont jouer</span><select class="inp" id="predict">${opts}</select></label>
    <p id="predict-out" class="note"></p></div></div>`;
}

function heatmap(adv, rowLabel, colLabel) {
  const cell = (v) => {
    const d = v - adv.value;
    const k = Math.min(1, Math.abs(d) / 0.15) * 55;
    const col = d >= 0 ? 'var(--good)' : 'var(--bad)';
    return `<td style="background:color-mix(in srgb, ${col} ${k.toFixed(0)}%, var(--surface))">${score(v)}</td>`;
  };
  return `<details><summary>Matrice complète (score pour chaque combinaison de choix)</summary>
    <div class="tablewrap"><table class="heat"><thead><tr><th></th>${adv.cols.map((c) => `<th class="col">${esc(colLabel(c.label))}</th>`).join('')}</tr></thead>
    <tbody>${adv.A.map((row, i) => `<tr><th>${esc(rowLabel(adv.rows[i].label))}</th>${row.map(cell).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="note">Lignes : nos options. Colonnes : leurs options. Vert : mieux que la valeur d'équilibre (${score(adv.value)}). Rouge : moins bien.</p></details>`;
}

function recommendation(adv, rowLabel, verb) {
  const mix = adv.rows.filter((r) => r.prob > 0.005).sort((a, b) => b.prob - a.prob);
  const best = Math.max(...adv.rows.map((r) => r.vsEq));
  const eqs = adv.rows.filter((r) => r.prob <= 0.005 && r.vsEq >= best - 0.005);
  let txt;
  if (mix.length === 1) {
    txt = `<p>${verb} <strong>${esc(rowLabel(mix[0].label))}</strong>.</p>`;
  } else {
    txt = `<p>${verb} en variant : ${mix.map((r) => `<strong>${esc(rowLabel(r.label))}</strong> ${pct(r.prob)}`).join(', ')}.</p>
      <p class="note">Aucun choix fixe n'est sûr ici : un choix prévisible se fait contrer. Tirez au sort selon ces proportions.</p>
      <div class="row"><button class="btn small" id="draw">Tirer au sort</button><span id="draw-out"></span></div>`;
  }
  if (eqs.length) txt += `<p class="note">Presque aussi bon (moins de 0,5 point d'écart) : ${eqs.map((r) => esc(rowLabel(r.label))).join(', ')}.</p>`;
  return `<div class="reco">${txt}</div>`;
}

function select(id, options, selected) {
  return `<select class="inp" id="${id}">${options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
}

function topIndex(list) {
  let b = 0;
  list.forEach((x, i) => { if (x.prob > list[b].prob) b = i; });
  return b;
}

function stepView() {
  const s = live.state, adv = advice;
  if (!adv) return '';
  const mod = MODULE_NAMES[s.modules[s.mod]] ?? '';
  if (s.step === 'done') {
    return `<section class="panel"><h2>Pairing terminé</h2>
      <p>Toutes les parties sont fixées. Projection finale : ${pct(adv.projection.win)} de victoire, ${pct(adv.projection.draw)} de nul, ${pct(adv.projection.loss)} de défaite, ${adv.projection.bp.toFixed(1)} BP attendus.</p>
      <p class="note">Passez à la ronde suivante dans l'onglet Matrice (le layout des attaquants refusés et des champions change à chaque ronde).</p></section>`;
  }
  if (s.step === 'defenders') {
    const rl = (i) => us(i), cl = (j) => them(j);
    return `<section class="panel"><h2>${mod} · choix du défenseur</h2>
      <p class="note">Chaque équipe choisit secrètement un défenseur, puis les deux sont révélés.</p>
      ${recommendation(adv, rl, 'Défendre avec')}
      ${optionsTable(adv, rl, cl)}
      ${opponentBlock(adv, rl, cl)}
      ${heatmap(adv, rl, cl)}
      <form class="choose" id="apply">
        <label class="field"><span>Notre défenseur</span>${select('in-a', adv.rows.map((r) => [r.label, us(r.label)]), adv.rows[topIndex(adv.rows)].label)}</label>
        <label class="field"><span>Leur défenseur (révélé)</span>${select('in-b', adv.cols.map((c) => [c.label, them(c.label)]), adv.cols[topIndex(adv.cols)].label)}</label>
        <button class="btn primary" type="submit">Valider les défenseurs révélés</button>
      </form></section>`;
  }
  if (s.step === 'attackers') {
    const rl = usPair, cl = themPair;
    return `<section class="panel"><h2>${mod} · choix des attaquants</h2>
      <p class="note">Défenseurs révélés : <strong>${esc(us(s.dA))}</strong> pour nous, <strong>${esc(them(s.dB))}</strong> pour eux. Chaque équipe envoie secrètement deux attaquants contre le défenseur adverse.</p>
      ${recommendation(adv, rl, `Envoyer contre ${esc(them(s.dB))}`)}
      ${optionsTable(adv, rl, cl)}
      ${opponentBlock(adv, rl, cl)}
      ${heatmap(adv, rl, cl)}
      <form class="choose" id="apply">
        <label class="field"><span>Nos attaquants</span>${select('in-a', adv.rows.map((r, i) => [i, usPair(r.label)]), topIndex(adv.rows))}</label>
        <label class="field"><span>Leurs attaquants (révélés)</span>${select('in-b', adv.cols.map((c, j) => [j, themPair(c.label)]), topIndex(adv.cols))}</label>
        <button class="btn primary" type="submit">Valider les attaquants révélés</button>
      </form></section>`;
  }
  if (s.step === 'choices') {
    const rl = (b) => `${us(s.dA)} affronte ${them(b)}`;
    const cl = (a) => `${them(s.dB)} affronte ${us(a)}`;
    return `<section class="panel"><h2>${mod} · attaquant retenu</h2>
      <p class="note">Leurs attaquants contre ${esc(us(s.dA))} : <strong>${esc(themPair(s.pb))}</strong>. Nos attaquants contre ${esc(them(s.dB))} : <strong>${esc(usPair(s.pa))}</strong>.
      ${s.modules[s.mod] === 'M' ? 'Les deux attaquants refusés joueront l\'un contre l\'autre sur le layout ' + LAYOUTS[layoutForRound(cfg.round)] + '.' : 'Les attaquants refusés retournent dans le groupe.'}</p>
      ${recommendation(adv, rl, 'Choisir :')}
      ${optionsTable(adv, rl, cl)}
      ${opponentBlock(adv, rl, cl)}
      <form class="choose" id="apply">
        <label class="field"><span>Notre défenseur affronte</span>${select('in-a', adv.rows.map((r, i) => [i, them(r.label)]), topIndex(adv.rows))}</label>
        <label class="field"><span>Leur défenseur affronte (révélé)</span>${select('in-b', adv.cols.map((c, j) => [j, us(c.label)]), topIndex(adv.cols))}</label>
        <button class="btn primary" type="submit">Valider les choix révélés</button>
      </form></section>`;
  }
  if (s.step === 'layouts') {
    const bestObj = adv.options[adv.best].metrics.obj;
    return `<section class="panel"><h2>${mod} · layouts</h2>
      <p class="note">Chaque défenseur déclare le layout de sa partie. Notre partie : <strong>${esc(us(adv.ourGame.a))}</strong> contre <strong>${esc(them(adv.ourGame.b))}</strong>.</p>
      <div class="reco"><p>Déclarer le <strong>layout ${LAYOUTS[adv.best]}</strong>.</p>
      <p class="note">Calculé en supposant que leur défenseur prend le layout le plus défavorable pour nous (${LAYOUTS[adv.theirAssumed]}).</p></div>
      <div class="tablewrap"><table><thead><tr><th>Layout</th><th class="num">BP de cette partie</th><th class="num">Score du match</th><th class="num">Écart</th><th>V / N / D</th></tr></thead>
      <tbody>${adv.options.map((o) => `<tr class="${o.layout === adv.best ? 'picked' : ''}"><td>${LAYOUTS[o.layout]}</td><td class="num">${o.gameMean.toFixed(1)}±${o.gameSd.toFixed(0)}</td>
        <td class="num">${score(o.metrics.obj)}</td><td class="num">${signed(o.metrics.obj - bestObj)}</td><td>${miniBar(o.metrics)}</td></tr>`).join('')}</tbody></table></div>
      <form class="choose" id="apply">
        <label class="field"><span>Notre layout</span>${select('in-a', [0, 1, 2].map((l) => [l, `Layout ${LAYOUTS[l]}`]), adv.best)}</label>
        <label class="field"><span>Leur layout (${esc(them(adv.theirGame.b))} contre ${esc(us(adv.theirGame.a))})</span>${select('in-b', adv.theirOptions.map((o) => [o.layout, `Layout ${LAYOUTS[o.layout]} (${o.gameMean.toFixed(1)} BP pour nous)`]), adv.theirAssumed)}</label>
        <button class="btn primary" type="submit">Valider les layouts</button>
      </form></section>`;
  }
  return '';
}

function commit(next) {
  live = { history: [...live.history, live.state], state: next };
  save();
  render();
}

function bindPairing() {
  $('#undo')?.addEventListener('click', () => {
    if (!live.history.length) return;
    live = { history: live.history.slice(0, -1), state: live.history[live.history.length - 1] };
    save(); render();
  });
  $('#restart')?.addEventListener('click', () => { resetPairing(); render(); });
  const adv = advice, s = live.state;
  if (!adv || s.step === 'done') return;

  $('#draw')?.addEventListener('click', () => {
    let r = Math.random(), pick = adv.rows[adv.rows.length - 1];
    for (const row of adv.rows) { r -= row.prob; if (r <= 0) { pick = row; break; } }
    const idx = adv.rows.indexOf(pick);
    const sel = $('#in-a');
    sel.value = s.step === 'defenders' ? String(pick.label) : String(idx);
    const label = s.step === 'defenders' ? us(pick.label) : s.step === 'attackers' ? usPair(pick.label) : them(pick.label);
    $('#draw-out').innerHTML = `Tirage : <strong>${esc(label)}</strong>`;
  });

  const predict = $('#predict');
  if (predict) {
    const rowLabel = s.step === 'defenders' ? us : s.step === 'attackers' ? usPair : (b) => `${us(s.dA)} affronte ${them(b)}`;
    const show = () => {
      const c = adv.cols[Number(predict.value)];
      const r = adv.rows[c.bestResponse];
      $('#predict-out').innerHTML = `Meilleure réponse : <strong>${esc(rowLabel(r.label))}</strong> (score ${score(c.bestResponseValue)}, contre ${score(adv.value)} à l'équilibre).`;
    };
    predict.value = String(topIndex(adv.cols));
    predict.addEventListener('change', show);
    show();
  }

  $('#apply')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const a = Number($('#in-a').value), b = Number($('#in-b').value);
    try {
      if (s.step === 'defenders') commit(setDefenders(s, a, b));
      else if (s.step === 'attackers') commit(setAttackers(s, adv.rows[a].label, adv.cols[b].label));
      else if (s.step === 'choices') commit(setChoices(s, a, b));
      else if (s.step === 'layouts') commit(setLayouts(s, a, b));
    } catch (err) {
      alertInline(String(err.message ?? err));
    }
  });
}

function alertInline(msg) {
  const f = $('#apply');
  if (!f) return;
  let p = $('.warn', f);
  if (!p) { p = document.createElement('p'); p.className = 'warn'; f.appendChild(p); }
  p.textContent = msg;
}

// ----------------------------------------------------------- matrix view

function cellColor(raw) {
  const c = parseCell(raw, cfg.codes, { swing: cfg.swing });
  if (!c) {
    if (!raw || !String(raw).trim() || isMissingCode(raw)) return 'var(--surface-2)';
    return 'color-mix(in srgb, var(--bad) 30%, var(--surface))';
  }
  if (c.code === 'GAMBLE' || (c.sd ?? 0) >= 5) return 'color-mix(in srgb, #8a63c9 35%, var(--surface))';
  const bp = c.bp ? c.value : toBp(c.value, cfg.scale);
  const d = (bp - 10) / 10;
  const k = Math.min(1, Math.abs(d)) * 50;
  return `color-mix(in srgb, ${d >= 0 ? 'var(--good)' : 'var(--bad)'} ${k.toFixed(0)}%, var(--surface))`;
}

function cellTitle(raw) {
  const c = parseCell(raw, cfg.codes, { swing: cfg.swing });
  if (!c) return raw && String(raw).trim() && !isMissingCode(raw) ? 'Case illisible' : 'Estimation manquante';
  const bp = c.bp ? c.value : toBp(c.value, cfg.scale);
  const sd = c.sd ?? Number(cfg.defaultSd);
  const fr = (x) => Number(x).toFixed(1).replace('.', ',');
  const base = `≈ ${fr(bp)} BP ± ${fr(sd)}`;
  if (!c.swing) return base;
  const what = c.swing.kind === 'punish'
    ? `${c.swing.chance} % de chances de punir (≈ ${c.swing.target} BP)`
    : `${c.swing.chance} % de risque de se faire punir (≈ ${c.swing.target} BP)`;
  return `${c.code} stable (${c.swing.base} BP), ${what} : ${base}`;
}

function cellEditor() {
  if (!selCell) return '<p class="note">Cliquez sur une case de la matrice pour la modifier avec des boutons.</p>';
  const { i, j } = selCell;
  const l = cfg.sameLayouts ? 0 : editLayout;
  const raw = cfg.grids[l][i][j];
  const c = parseCell(raw, cfg.codes, { swing: cfg.swing });
  const code = c?.code ?? null;
  const kind = c?.swing?.kind ?? null;
  const chance = c?.swing?.chance ?? cfg.swing.chance;
  const target = c?.swing?.target ?? (kind === 'punished' ? cfg.swing.low : cfg.swing.high);
  const missing = !c && (!raw || isMissingCode(raw));
  return `
    <div class="row" style="justify-content:space-between">
      <h3>${esc(us(i))} contre ${esc(them(j))}${cfg.sameLayouts ? '' : ` · layout ${LAYOUTS[l]}`}</h3>
      <span class="note">${esc(cellTitle(raw))}</span>
    </div>
    <div class="code-buttons">${cfg.codes.map((k) => `<button type="button" class="codebtn" data-set-code="${esc(k.code)}" aria-pressed="${k.code === code}" style="background:${cellColor(k.code)}" title="${esc(k.label ?? '')}">${esc(k.code)}</button>`).join('')}<button type="button" class="codebtn" data-set-code="SAIS-PÔ" aria-pressed="${missing}">SAIS-PÔ</button></div>
    ${code ? `<div class="row">
      <div class="seg" role="group" aria-label="Scénario">${[['', 'Stable'], ['punish', 'Peut punir (!)'], ['punished', 'Peut se faire punir (?)']].map(([k, t]) => `<button type="button" data-set-kind="${k}" aria-pressed="${(kind ?? '') === k}">${t}</button>`).join('')}</div>
      ${kind ? `<label class="field"><span>Chance (%)</span><input id="ce-chance" type="number" min="0" max="100" step="5" value="${chance}" style="width:80px"></label>
      <label class="field"><span>${kind === 'punish' ? 'Score visé (BP)' : 'Score restant (BP)'}</span><input id="ce-target" type="number" min="0" max="20" step="1" value="${target}" style="width:80px"></label>` : ''}
    </div>` : ''}
    ${cfg.sameLayouts ? '' : `<label class="row" style="gap:6px"><input type="checkbox" id="ce-all" ${ceAll ? 'checked' : ''}> Appliquer aux 3 layouts</label>`}`;
}

function refreshCellEditor() {
  const box = $('#cell-editor');
  if (!box) return;
  box.innerHTML = cellEditor();
  bindCellEditor();
}

function writeSelectedCell(text) {
  const { i, j } = selCell;
  const l = cfg.sameLayouts ? 0 : editLayout;
  const layouts = ceAll && !cfg.sameLayouts ? [0, 1, 2] : [l];
  for (const x of layouts) cfg.grids[x][i][j] = text;
  const inp = $(`input[data-cell="${i},${j}"]`);
  if (inp) {
    inp.value = text;
    inp.parentElement.style.background = cellColor(text);
    inp.parentElement.title = cellTitle(text);
  }
  changed();
  refreshCellEditor();
}

function bindCellEditor() {
  if (!selCell) return;
  const { i, j } = selCell;
  const current = () => {
    const raw = cfg.grids[cfg.sameLayouts ? 0 : editLayout][i][j];
    const c = parseCell(raw, cfg.codes, { swing: cfg.swing });
    const sdm = /(?:±|\+-|\+\/-)\s*(\d+(?:[.,]\d+)?)\s*$/.exec(String(raw ?? ''));
    return {
      code: c?.code ?? null,
      kind: c?.swing?.kind ?? null,
      chance: c?.swing?.chance ?? cfg.swing.chance,
      target: c?.swing?.target ?? null,
      sd: c?.code && sdm ? Number(sdm[1].replace(',', '.')) : null,
    };
  };
  const write = (st) => writeSelectedCell(formatCodeCell(st, cfg.swing));
  $$('[data-set-code]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.setCode === 'SAIS-PÔ') { writeSelectedCell('SAIS-PÔ'); return; }
    write({ ...current(), code: b.dataset.setCode });
  }));
  $$('[data-set-kind]').forEach((b) => b.addEventListener('click', () => {
    const st = current();
    const kind = b.dataset.setKind || null;
    const target = kind === st.kind ? st.target : kind === 'punished' ? cfg.swing.low : cfg.swing.high;
    write({ ...st, kind, target });
  }));
  $('#ce-chance')?.addEventListener('change', (e) => {
    const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value))));
    write({ ...current(), chance: Number.isFinite(v) ? v : cfg.swing.chance });
  });
  $('#ce-target')?.addEventListener('change', (e) => {
    const v = Math.max(0, Math.min(20, Number(e.target.value)));
    write({ ...current(), target: Number.isFinite(v) ? v : null });
  });
  $('#ce-all')?.addEventListener('change', (e) => { ceAll = e.target.checked; });
}

function matrixView() {
  const l = cfg.sameLayouts ? 0 : editLayout;
  const g = cfg.grids[l];
  const lin = cfg.scale.type === 'linear';
  return `<div class="stack" style="margin-top:16px">
    <section class="panel">
      <h2>Paramètres du match</h2>
      <div class="row">
        <label class="field"><span>Joueurs par équipe</span>${select('p-n', [3, 4, 5, 6, 7, 8].map((x) => [x, `${x} joueurs · ${MODULES_BY_SIZE[x].map((m) => MODULE_NAMES[m]).join(', ')}`]), cfg.n)}</label>
        <label class="field"><span>Ronde</span><input id="p-round" type="number" min="1" max="12" value="${cfg.round}" style="width:80px"></label>
        <p class="note">Ronde ${cfg.round} : attaquants refusés et champions jouent le layout ${LAYOUTS[layoutForRound(cfg.round)]}. Victoire à ${thresholds(cfg.n).differential} BP d'écart.</p>
      </div>
      <div class="row">
        <label class="field" style="min-width:260px;flex:1"><span>Objectif : gagner le match ↔ maximiser l'écart de BP (${Math.round(cfg.objective.marginWeight * 100)} %)</span>
          <input id="p-margin" type="range" min="0" max="1" step="0.05" value="${cfg.objective.marginWeight}"></label>
        <label class="field"><span>Valeur d'un nul</span>${select('p-draw', [[0.5, 'Demi-victoire (barème 3/2/1)'], [0, 'Nul = défaite (il faut gagner)'], [1, 'Nul = victoire (un nul suffit)']], cfg.objective.drawValue)}</label>
      </div>
      <div class="row">
        <label class="field"><span>Incertitude des BP saisis sans ± (écart-type)</span><input id="p-sd" type="number" min="0.5" max="10" step="0.5" value="${cfg.defaultSd}" style="width:90px"></label>
        <label class="field"><span>Précision du calcul</span>${select('p-prec', [['standard', 'Standard'], ['fast', 'Rapide (8 joueurs ≈ 2× plus vite)']], cfg.precision)}</label>
        <label class="field"><span>Format des valeurs</span>${select('p-scale', [['bp', 'BP attendus (0 à 20)'], ['linear', 'Autre échelle (conversion linéaire)']], cfg.scale.type)}</label>
        ${lin ? `<label class="field"><span>Valeur min → BP</span><span class="row" style="gap:4px"><input id="s-inmin" type="number" value="${cfg.scale.inMin}" style="width:64px">→<input id="s-outmin" type="number" value="${cfg.scale.outMin}" style="width:64px"></span></label>
        <label class="field"><span>Valeur max → BP</span><span class="row" style="gap:4px"><input id="s-inmax" type="number" value="${cfg.scale.inMax}" style="width:64px">→<input id="s-outmax" type="number" value="${cfg.scale.outMax}" style="width:64px"></span></label>` : ''}
      </div>
    </section>

    <section class="panel">
      <div class="row" style="justify-content:space-between">
        <h2>Matrice des matchups</h2>
        <div class="row">
          <label class="row" style="gap:6px"><input type="checkbox" id="p-same" ${cfg.sameLayouts ? 'checked' : ''}> Même estimation pour les 3 layouts</label>
          ${cfg.sameLayouts ? '' : `<div class="layout-tabs" role="tablist">${[0, 1, 2].map((x) => `<button role="tab" data-layout="${x}" aria-selected="${x === editLayout}">Layout ${LAYOUTS[x]}</button>`).join('')}</div>`}
        </div>
      </div>
      <p class="note">Cliquez sur une case pour la modifier avec les boutons sous la matrice, ou tapez directement. Chaque case : un code du référentiel (<span class="mono">${cfg.codes.map((c) => esc(c.code)).join(', ')}</span>), éventuellement suivi de <span class="mono">!</span> (peut punir) ou <span class="mono">?</span> (peut se faire punir), ou des BP attendus pour notre joueur (ligne) contre le leur (colonne). En BP, ajoutez l'incertitude avec ± : <span class="mono">12±6</span> pour un matchup incertain, <span class="mono">12±2</span> pour un matchup bien connu.</p>
      <datalist id="codes-list">${cfg.codes.map((c) => `<option value="${esc(c.code)}">${esc(c.label ?? '')}</option>`).join('')}<option value="SAIS-PÔ">Estimation manquante</option></datalist>
      <div class="tablewrap"><table class="editor"><thead><tr><th></th>${cfg.them.map((t, j) => `<th><input class="name" data-them="${j}" value="${esc(t)}" aria-label="Adversaire ${j + 1}"></th>`).join('')}</tr></thead>
      <tbody>${g.map((row, i) => `<tr><th><input class="name" data-us="${i}" value="${esc(cfg.us[i])}" aria-label="Joueur ${i + 1}"></th>${row.map((v, j) => `<td class="${selCell && selCell.i === i && selCell.j === j ? 'sel' : ''}" style="background:${cellColor(v)}" title="${esc(cellTitle(v))}"><input data-cell="${i},${j}" list="codes-list" value="${esc(v)}" aria-label="${esc(cfg.us[i])} contre ${esc(cfg.them[j])}"></td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div id="cell-editor" class="cell-editor">${cellEditor()}</div>
    </section>

    <section class="panel">
      <h2>Référentiel des estimés</h2>
      <p class="note">Chaque code est converti en BP attendus (centre) et en incertitude (écart-type en BP). Plus l'écart-type est grand, plus le résultat de la partie est imprévisible. Les centres viennent de votre tableur. Les écarts-types sont une proposition à ajuster.</p>
      <div class="tablewrap"><table class="codes"><thead><tr><th>Code</th><th>Lecture</th><th class="num">Centre (BP)</th><th class="num">Écart-type</th></tr></thead>
      <tbody>${cfg.codes.map((c, i) => `<tr><td class="mono">${esc(c.code)}</td><td class="muted">${esc(c.label ?? '')}</td>
        <td class="num"><input class="inp" type="number" min="0" max="20" step="0.5" data-code-mean="${i}" value="${c.mean}" style="width:72px"></td>
        <td class="num"><input class="inp" type="number" min="0.5" max="10" step="0.5" data-code-sd="${i}" value="${c.sd}" style="width:72px"></td></tr>`).join('')}</tbody></table></div>
      <h3>Punir / se faire punir</h3>
      <div class="row">
        <label class="field"><span>Chance par défaut (%)</span><input id="sw-chance" type="number" min="0" max="100" step="5" value="${cfg.swing.chance}" style="width:80px"></label>
        <label class="field"><span>BP si on punit</span><input id="sw-high" type="number" min="0" max="20" step="0.5" value="${cfg.swing.high}" style="width:80px"></label>
        <label class="field"><span>BP si on se fait punir</span><input id="sw-low" type="number" min="0" max="20" step="0.5" value="${cfg.swing.low}" style="width:80px"></label>
      </div>
      <p class="note">Ajoutez <span class="mono">!</span> après un code quand le résultat est stable mais que le joueur peut punir une erreur adverse : <span class="mono">p_WIN!</span> = « p_WIN stable, et ${cfg.swing.chance} % de chances d'aller chercher ≈ ${cfg.swing.high} BP ». Ajoutez <span class="mono">?</span> pour le risque inverse : <span class="mono">WIN?</span> = « WIN, mais ${cfg.swing.chance} % de risque de se faire punir (≈ ${cfg.swing.low} BP) ». Précisez la chance et le score si besoin : <span class="mono">p_WIN!40</span> (40 % de chances), <span class="mono">p_WIN!40_20</span> (40 % de chances de mettre un 20-0), <span class="mono">p_LOSE?50_3</span> (50 % de risque de ne marquer que 3 BP). Pour un matchup plus ou moins prévisible que son code : <span class="mono">p_WIN±5</span>. Survolez une case pour voir sa valeur.</p>
      <div class="row"><button class="btn small" id="codes-reset">Revenir aux valeurs par défaut</button></div>
    </section>

    <section class="panel">
      <h2>Importer depuis un tableur</h2>
      <p class="note">Dans Google Sheets, sélectionnez la matrice et copiez-la, puis collez-la ici. Deux formats sont reconnus : la <strong>Matrice globale</strong> (une ligne par joueur et par layout, colonne « Layout » avec Layout A / B / C, en-tête compris), ou une grille carrée simple (noms en première ligne et première colonne, facultatifs).</p>
      <textarea id="paste" placeholder="Collez ici les cellules copiées"></textarea>
      <div class="row">
        <label class="field"><span>Destination</span>${select('paste-target', [['all', 'Les 3 layouts'], ['0', 'Layout A'], ['1', 'Layout B'], ['2', 'Layout C']], 'all')}</label>
        <button class="btn primary" id="paste-go">Importer</button>
        <span id="paste-msg" class="note"></span>
      </div>
    </section>

    <section class="panel">
      <h2>Sauvegarde</h2>
      <p class="note">La configuration est gardée dans ce navigateur. Pour la partager avec votre équipe, copiez le texte ci-dessous et collez-le chez eux.</p>
      <textarea id="cfg-json">${esc(JSON.stringify(cfg))}</textarea>
      <div class="row">
        <button class="btn" id="cfg-copy">Copier</button>
        <button class="btn" id="cfg-load">Charger le texte collé</button>
        <button class="btn" id="cfg-example">Remettre l'exemple</button>
        <span id="cfg-msg" class="note"></span>
      </div>
    </section>
  </div>`;
}

function changed(resetLive = false) {
  cfg.example = false;
  if (resetLive) resetPairing();
  save();
}

function bindMatrix() {
  $('#p-n').addEventListener('change', (e) => { resize(cfg, Number(e.target.value)); selCell = null; changed(true); render(); });
  $('#p-round').addEventListener('change', (e) => { cfg.round = Math.max(1, Number(e.target.value) || 1); changed(true); render(); });
  $('#p-margin').addEventListener('input', (e) => {
    cfg.objective.marginWeight = Number(e.target.value); changed();
    e.target.closest('label').querySelector('span').textContent = `Objectif : gagner le match ↔ maximiser l'écart de BP (${Math.round(cfg.objective.marginWeight * 100)} %)`;
  });
  $('#p-draw').addEventListener('change', (e) => { cfg.objective.drawValue = Number(e.target.value); changed(); });
  $('#p-sd').addEventListener('change', (e) => { cfg.defaultSd = Math.max(0.5, Number(e.target.value) || 4); changed(); });
  $('#p-prec').addEventListener('change', (e) => { cfg.precision = e.target.value; changed(); });
  $('#p-scale').addEventListener('change', (e) => { cfg.scale.type = e.target.value; changed(); render(); });
  for (const k of ['inmin', 'inmax', 'outmin', 'outmax']) {
    $(`#s-${k}`)?.addEventListener('change', (e) => {
      const key = { inmin: 'inMin', inmax: 'inMax', outmin: 'outMin', outmax: 'outMax' }[k];
      cfg.scale[key] = Number(e.target.value); changed(); render();
    });
  }
  $('#p-same').addEventListener('change', (e) => { cfg.sameLayouts = e.target.checked; editLayout = 0; changed(); render(); });
  $$('.layout-tabs button').forEach((b) => b.addEventListener('click', () => { editLayout = Number(b.dataset.layout); render(); }));
  $$('input[data-us]').forEach((inp) => inp.addEventListener('change', () => { cfg.us[Number(inp.dataset.us)] = inp.value; changed(); }));
  $$('input[data-them]').forEach((inp) => inp.addEventListener('change', () => { cfg.them[Number(inp.dataset.them)] = inp.value; changed(); }));
  $$('input[data-cell]').forEach((inp) => {
    const [i, j] = inp.dataset.cell.split(',').map(Number);
    inp.addEventListener('focus', () => {
      selCell = { i, j };
      $$('table.editor td.sel').forEach((td) => td.classList.remove('sel'));
      inp.parentElement.classList.add('sel');
      refreshCellEditor();
    });
    inp.addEventListener('input', () => {
      const l = cfg.sameLayouts ? 0 : editLayout;
      cfg.grids[l][i][j] = inp.value.trim();
      inp.parentElement.style.background = cellColor(inp.value);
      inp.parentElement.title = cellTitle(inp.value);
      changed();
      if (selCell && selCell.i === i && selCell.j === j) refreshCellEditor();
    });
  });
  bindCellEditor();

  $$('input[data-code-mean]').forEach((inp) => inp.addEventListener('change', () => {
    cfg.codes[Number(inp.dataset.codeMean)].mean = Math.max(0, Math.min(20, Number(inp.value) || 0)); changed(); render();
  }));
  $$('input[data-code-sd]').forEach((inp) => inp.addEventListener('change', () => {
    cfg.codes[Number(inp.dataset.codeSd)].sd = Math.max(0.5, Number(inp.value) || 3); changed(); render();
  }));
  $('#codes-reset').addEventListener('click', () => { cfg.codes = defaultCodes(); cfg.swing = { ...DEFAULT_SWING }; changed(); render(); });
  for (const [id, key, lo, hi] of [['sw-chance', 'chance', 0, 100], ['sw-high', 'high', 0, 20], ['sw-low', 'low', 0, 20]]) {
    $(`#${id}`).addEventListener('change', (e) => {
      const v = Number(e.target.value);
      cfg.swing[key] = Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : DEFAULT_SWING[key];
      changed(); render();
    });
  }

  $('#paste-go').addEventListener('click', () => {
    const msg = $('#paste-msg');
    try {
      const p = parseMatrix($('#paste').value, cfg.codes);
      const n = p.cells.length;
      if (n < 3 || n > 8 || p.cells.some((r) => r.length !== n) || p.colNames.length !== n) {
        throw new Error(`La matrice collée fait ${n} × ${p.cells[0]?.length ?? 0}. Il faut une matrice carrée de 3 à 8 joueurs.`);
      }
      if (n !== cfg.n) { resize(cfg, n); resetPairing(); }
      const target = $('#paste-target').value;
      const copy = (g) => g.map((r) => [...r]);
      if (p.layouts) { cfg.grids = p.layouts.map((x) => copy(x.raw)); cfg.sameLayouts = false; editLayout = 0; }
      else if (target === 'all') { cfg.grids = [0, 1, 2].map(() => copy(p.raw)); cfg.sameLayouts = true; }
      else { cfg.grids[Number(target)] = copy(p.raw); cfg.sameLayouts = false; editLayout = Number(target); }
      if (!p.rowNames[0].startsWith('Nous ')) cfg.us = p.rowNames;
      if (!p.colNames[0].startsWith('Eux ')) cfg.them = p.colNames;
      const bad = (p.layouts ?? [p]).flatMap((x) => x.cells.flat()).filter((c) => !c).length;
      changed();
      render();
      $('#paste-msg').textContent = `Matrice ${n} × ${n}${p.layouts ? ' (layouts A, B et C)' : ''} importée${bad ? `, ${bad} case(s) à estimer ou à vérifier` : ''}.`;
    } catch (err) {
      msg.textContent = String(err.message ?? err);
    }
  });

  $('#cfg-copy').addEventListener('click', () => {
    const ta = $('#cfg-json');
    navigator.clipboard?.writeText(ta.value).then(
      () => { $('#cfg-msg').textContent = 'Copié.'; },
      () => { ta.select(); $('#cfg-msg').textContent = 'Texte sélectionné : copiez-le avec Ctrl+C.'; },
    ) ?? (ta.select(), $('#cfg-msg').textContent = 'Texte sélectionné : copiez-le avec Ctrl+C.');
  });
  $('#cfg-load').addEventListener('click', () => {
    try {
      const c = JSON.parse($('#cfg-json').value);
      if (!c.grids || !MODULES_BY_SIZE[c.n]) throw new Error('Configuration invalide.');
      cfg = { ...exampleConfig(c.n), ...c };
      if (!Array.isArray(cfg.codes)) cfg.codes = defaultCodes();
      cfg.swing = { ...DEFAULT_SWING, ...cfg.swing };
      resetPairing(); render();
      $('#cfg-msg').textContent = 'Configuration chargée.';
    } catch (err) { $('#cfg-msg').textContent = `Lecture impossible : ${err.message}`; }
  });
  $('#cfg-example').addEventListener('click', () => { cfg = exampleConfig(cfg.n); resetPairing(); render(); });
}

// ----------------------------------------------------------- method view

function methodView() {
  return `<article class="panel method" style="margin-top:16px">
    <h2>Ce que calcule l'outil</h2>
    <p>Le pairing suit le Warhammer 40,000 Teams Event Companion v1.0. Selon la taille des équipes, il enchaîne l'Initial Skirmish, le Main Engagement et le Champion System. À 6 joueurs : une Initial Skirmish, un Main Engagement, puis les champions. À 8 joueurs : deux Initial Skirmish, un Main Engagement, puis les champions.</p>
    <p>Chaque étape est un choix secret et simultané des deux capitaines. L'outil la traite comme un jeu à deux joueurs à somme nulle. Il calcule, en remontant tout l'arbre du pairing jusqu'à la dernière partie, la stratégie qui garantit le meilleur résultat face à un adversaire qui joue parfaitement.</p>

    <h2>Le score objectif</h2>
    <p>Chaque partie est modélisée par ses BP attendus et une incertitude (écart-type). Le total de l'équipe suit alors une loi normale, ce qui donne les probabilités de victoire, de nul et de défaite du match, avec le seuil officiel (par exemple 8 BP d'écart à 6 joueurs, 12 BP à 8 joueurs).</p>
    <ul>
      <li><strong>Curseur à 0 %</strong> : on maximise P(victoire) + valeur du nul × P(nul). Avec le barème 3/2/1, cela revient à maximiser les points d'équipe attendus.</li>
      <li><strong>Curseur à 100 %</strong> : on maximise les BP attendus, c'est-à-dire l'écart moyen, utile quand le classement se joue aux BP.</li>
      <li>Entre les deux : un mélange pondéré des deux critères.</li>
    </ul>
    <p>Avec l'objectif « gagner le match », l'outil arbitre automatiquement le risque. Favori, il préfère des matchups sûrs (faible incertitude) qui assurent le seuil. Outsider, il préfère des matchups incertains qui gardent une chance de passer le seuil.</p>

    <h2>Lire une recommandation</h2>
    <ul>
      <li><strong>Score</strong> : le score du match si l'on joue cette option et que l'adversaire joue sa meilleure stratégie.</li>
      <li><strong>Pire cas</strong> : le score si l'adversaire devine notre choix et le contre au mieux. Une option avec un bon score mais un pire cas faible est un pari sur la lecture de l'adversaire.</li>
      <li><strong>Mix</strong> : quand aucun choix fixe n'est sûr, la bonne stratégie est de varier au hasard dans les proportions indiquées. Le bouton « Tirer au sort » fait le tirage.</li>
      <li><strong>Si vous pensez qu'ils vont jouer…</strong> : si vous avez une lecture de l'adversaire, l'outil donne la meilleure réponse à ce choix précis.</li>
      <li>Des scores qui diffèrent de moins de 0,5 point sont équivalents compte tenu de l'imprécision des estimations.</li>
    </ul>

    <h2>Simplifications assumées</h2>
    <ul>
      <li>Les parties sont supposées indépendantes, et le total d'équipe est approché par une loi normale.</li>
      <li>Pour anticiper les étapes futures, chaque défenseur est supposé prendre le layout le plus favorable à son camp d'après la matrice. À l'étape des layouts, l'outil compare les trois layouts de notre défenseur sur le score complet.</li>
      <li>Pour accélérer le calcul, les BP cumulés sont arrondis à 0,5 BP (1 BP en mode rapide) quand l'outil réutilise un sous-arbre déjà calculé.</li>
      <li>La matrice est la seule source de vérité : la qualité des recommandations dépend de la qualité des estimations.</li>
    </ul>
  </article>`;
}

// ---------------------------------------------------------------- startup

$$('nav.tabs button').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; render(); }));
render();
