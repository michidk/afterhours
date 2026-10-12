/** Deterministic randomness and gradient noise; every stage derives its own stream. */
export type Rng = () => number;

export function mulberry(seed: number): Rng {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Independent sub-stream so stages can be reordered without reshuffling each other. */
export function derive(seed: number, label: string) {
  let h = seed ^ 0x9e3779b9;
  for (let i = 0; i < label.length; i++)
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193);
  return mulberry(h);
}
export const range = (r: Rng, lo: number, hi: number) => lo + r() * (hi - lo);
export const pick = <T>(r: Rng, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
export function shuffle<T>(r: Rng, xs: T[]) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

const GRAD = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const F2 = 0.5 * (Math.sqrt(3) - 1),
  G2 = (3 - Math.sqrt(3)) / 6;
/** 2D simplex noise in [-1, 1] with a seeded permutation table. */
export class Noise {
  private perm = new Uint8Array(512);
  constructor(r: Rng) {
    const p = Array.from({ length: 256 }, (_, i) => i);
    shuffle(r, p);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  at(x: number, y: number) {
    const s = (x + y) * F2,
      i = Math.floor(x + s),
      j = Math.floor(y + s),
      t = (i + j) * G2,
      x0 = x - (i - t),
      y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0,
      j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2,
      y1 = y0 - j1 + G2,
      x2 = x0 - 1 + 2 * G2,
      y2 = y0 - 1 + 2 * G2;
    const ii = i & 255,
      jj = j & 255,
      p = this.perm;
    let n = 0;
    const corner = (dx: number, dy: number, gi: number) => {
      let t = 0.5 - dx * dx - dy * dy;
      if (t < 0) return;
      t *= t;
      const g = GRAD[gi & 7];
      n += t * t * (g[0] * dx + g[1] * dy);
    };
    corner(x0, y0, p[ii + p[jj]]);
    corner(x1, y1, p[ii + i1 + p[jj + j1]]);
    corner(x2, y2, p[ii + 1 + p[jj + 1]]);
    return 70 * n;
  }
  /** Fractal Brownian motion in [-1, 1]. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5) {
    let sum = 0,
      amp = 1,
      norm = 0,
      f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.at(x * f, y * f);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }
  /** Ridged multifractal in [0, 1]: sharp crests for mountain spines. */
  ridged(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5) {
    let sum = 0,
      amp = 1,
      norm = 0,
      f = 1,
      weight = 1;
    for (let o = 0; o < octaves; o++) {
      let signal = 1 - Math.abs(this.at(x * f, y * f));
      signal *= signal * weight;
      weight = Math.min(1, Math.max(0, signal * 2));
      sum += amp * signal;
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }
}
export const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
