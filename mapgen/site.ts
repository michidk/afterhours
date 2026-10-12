import { blur, cellSlope, toWorld } from "./field.ts";
import type { Hydrology } from "./hydrology.ts";
import { Noise, derive } from "./random.ts";
import type { HeightField, Point } from "./types.ts";

/**
 * Settlement desirability in [0, 1]: flat land, moderate elevation, close to (but
 * not in) water, with a navigable river mouth as the most attractive site. Later
 * stages use it for the city centre, the road density and zoning.
 */
export function desirabilityField(f: HeightField, hydro: Hydrology, seed: number) {
  const { w, h, data } = f,
    out = new Float32Array(w * h),
    noise = new Noise(derive(seed, "desire"));
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (data[i] <= 0 || hydro.riverMask[i]) continue;
      const s = cellSlope(f, x, z),
        flat = Math.max(0, 1 - s / 0.14),
        low = Math.max(0, 1 - Math.max(0, data[i] - 12) / 70),
        water = hydro.waterDistance[i],
        coast = hydro.coastDistance[i];
      const nearWater = water < 14 ? water / 14 : Math.max(0, 1 - (water - 14) / 600);
      const nearCoast = Math.max(0, 1 - coast / 1100);
      const edge = Math.min(x, z, w - 1 - x, h - 1 - z) * f.cell;
      const inside = Math.min(1, edge / 300);
      const n = 0.85 + 0.15 * noise.fbm(x * 0.03, z * 0.03, 3);
      out[i] =
        flat * low * (0.35 + 0.65 * nearWater) * (0.4 + 0.6 * nearCoast) * inside * n;
    }
  const blurred = blur(out, w, h, 3, 2);
  // Normalise so thresholds in later stages mean the same thing on every seed.
  const sorted = Float32Array.from(blurred).sort();
  const top = sorted[Math.floor(sorted.length * 0.995)] || 1;
  for (let i = 0; i < blurred.length; i++) blurred[i] = Math.min(1, blurred[i] / top);
  return blurred;
}

/** The best large flat patch: maximise desirability integrated over a ~400 m radius. */
export function chooseCentre(f: HeightField, desirability: Float32Array): Point {
  const radius = Math.round(220 / f.cell),
    wide = blur(desirability, f.w, f.h, radius, 1);
  let best = 0,
    bestValue = -1;
  for (let i = 0; i < wide.length; i++)
    if (desirability[i] > 0.05 && wide[i] > bestValue) {
      bestValue = wide[i];
      best = i;
    }
  const x = best % f.w;
  return toWorld(f, x, (best - x) / f.w);
}
