// Live pairing state machine (Teams Event Companion, section 2 "Pairing System").
// Pure functions: every transition returns a new state.
//
// Steps inside Initial Skirmish (S) / Main Engagement (M):
//   'defenders' -> 'attackers' -> 'choices' -> 'layouts'
// Champion System (C) is resolved automatically.

import { MODULES_BY_SIZE, layoutForRound } from './rules.js';
import { bits } from './engine.js';

export function initialState(n, round = 1) {
  const modules = MODULES_BY_SIZE[n];
  if (!modules) throw new Error(`Unsupported team size ${n}`);
  const full = (1 << n) - 1;
  return resolveForced({ n, round, modules, mod: 0, remA: full, remB: full, games: [], step: 'defenders' });
}

// Resolves Champion modules and end of pairing.
function resolveForced(s) {
  s = { ...s };
  while (s.mod < s.modules.length && s.modules[s.mod] === 'C') {
    const a = bits(s.remA)[0], b = bits(s.remB)[0];
    s.games = [...s.games, { a, b, layout: layoutForRound(s.round), role: 'champion', module: s.mod }];
    s.remA = 0; s.remB = 0; s.mod++;
  }
  if (s.mod >= s.modules.length) s.step = 'done';
  return s;
}

function has(mask, i) {
  return (mask >> i) & 1;
}

export function setDefenders(s, dA, dB) {
  if (s.step !== 'defenders') throw new Error('Not at defender step');
  if (!has(s.remA, dA) || !has(s.remB, dB)) throw new Error('Defender not available');
  return { ...s, dA, dB, step: 'attackers' };
}

// pa: our two attackers (against their defender), pb: their two attackers.
export function setAttackers(s, pa, pb) {
  if (s.step !== 'attackers') throw new Error('Not at attacker step');
  const okA = pa.length === 2 && pa[0] !== pa[1] && pa.every((x) => x !== s.dA && has(s.remA, x));
  const okB = pb.length === 2 && pb[0] !== pb[1] && pb.every((x) => x !== s.dB && has(s.remB, x));
  if (!okA || !okB) throw new Error('Invalid attackers');
  return { ...s, pa: [...pa].sort((x, y) => x - y), pb: [...pb].sort((x, y) => x - y), step: 'choices' };
}

// k: index in pb of the attacker OUR defender accepts.
// l: index in pa of the attacker THEIR defender accepts.
export function setChoices(s, k, l) {
  if (s.step !== 'choices') throw new Error('Not at choice step');
  if (![0, 1].includes(k) || ![0, 1].includes(l)) throw new Error('Invalid choice');
  return { ...s, k, l, step: 'layouts' };
}

// Layout declared by each defender for its own game (0 = A, 1 = B, 2 = C).
export function setLayouts(s, ourLayout, theirLayout) {
  if (s.step !== 'layouts') throw new Error('Not at layout step');
  const { dA, dB, pa, pb, k, l } = s;
  const type = s.modules[s.mod];
  const games = [
    ...s.games,
    { a: dA, b: pb[k], layout: ourLayout, role: 'ourDefender', module: s.mod },
    { a: pa[l], b: dB, layout: theirLayout, role: 'theirDefender', module: s.mod },
  ];
  let remA, remB;
  if (type === 'M') {
    games.push({ a: pa[1 - l], b: pb[1 - k], layout: layoutForRound(s.round), role: 'refused', module: s.mod });
    remA = s.remA & ~(1 << dA) & ~(1 << pa[0]) & ~(1 << pa[1]);
    remB = s.remB & ~(1 << dB) & ~(1 << pb[0]) & ~(1 << pb[1]);
  } else {
    remA = s.remA & ~(1 << dA) & ~(1 << pa[l]);
    remB = s.remB & ~(1 << dB) & ~(1 << pb[k]);
  }
  const next = { n: s.n, round: s.round, modules: s.modules, mod: s.mod + 1, remA, remB, games, step: 'defenders' };
  return resolveForced(next);
}

// Accumulated mean / variance of our BP from the games already fixed.
export function accumulated(s, mu, sd) {
  let M = 0, V = 0;
  for (const g of s.games) {
    M += mu[g.layout][g.a][g.b];
    V += sd[g.layout][g.a][g.b] ** 2;
  }
  return { M, V };
}
