export function rng(seed) {
  return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

export function randomModel(n, seed, sdValue = 4) {
  const r = rng(seed);
  const base = Array.from({ length: n }, () => Array.from({ length: n }, () => 10 + (r() - 0.5) * 10));
  const mu = [0, 1, 2].map(() => base.map((row) => row.map((v) => Math.max(0, Math.min(20, v + (r() - 0.5) * 4)))));
  const sd = [0, 1, 2].map(() => base.map((row) => row.map(() => sdValue)));
  return { mu, sd };
}

export function constantModel(n, value, sdValue = 4) {
  const mk = (v) => [0, 1, 2].map(() => Array.from({ length: n }, () => Array(n).fill(v)));
  return { mu: mk(value), sd: mk(sdValue) };
}
