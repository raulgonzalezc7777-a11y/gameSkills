// Deterministic RNG so a replay, a seeded fighter, or a screenshot run is
// reproducible. mulberry32 is small, fast and has good enough distribution.
export function makeRng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  const r = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + r() * (hi - lo);
  r.int = (lo, hi) => Math.floor(lo + r() * (hi - lo + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.chance = (p) => r() < p;
  r.sign = () => (r() < 0.5 ? -1 : 1);
  // Box-Muller, cached second sample.
  let spare = null;
  r.gauss = (mean = 0, sd = 1) => {
    if (spare !== null) { const s = spare; spare = null; return mean + s * sd; }
    let u, v, s;
    do { u = r() * 2 - 1; v = r() * 2 - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m;
    return mean + u * m * sd;
  };
  r.seed = (s) => { a = s >>> 0; spare = null; };
  return r;
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const rng = makeRng(20260922);
