// Times the full pairing solve on random matrices: node tools/bench.js [n]
import { createEngine } from '../src/engine.js';

const n = Number(process.argv[2] ?? 8);
let seed = 42;
const r = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const base = Array.from({ length: n }, () => Array.from({ length: n }, () => 10 + (r() - 0.5) * 10));
const mu = [0, 1, 2].map(() => base.map((row) => row.map((v) => Math.max(0, Math.min(20, v + (r() - 0.5) * 4)))));
const sd = [0, 1, 2].map(() => base.map((row) => row.map(() => 4)));
for (const [name, quantum] of [['standard', undefined], ['rapide', { mean: 1, variance: 8 }]]) {
  const e = createEngine({ n, mu, sd, quantum });
  const t = Date.now();
  const v = e.metModule((1 << n) - 1, (1 << n) - 1, 0, 0, 0);
  console.log(`${n} joueurs, ${name}: ${Date.now() - t} ms, P(V/N/D) = ${v.slice(1, 4).map((x) => x.toFixed(3)).join(' / ')}`, e.stats());
}
