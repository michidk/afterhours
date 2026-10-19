import { WATER_LEVEL } from "../../shared/water.ts";

/**
 * Terrain colour in the manner of the Craftstead ground: a muted olive grass broken
 * into soft organic patches (lusher, drier, lighter accent, bare mud), a pale sand
 * beach, and grey rock where the ground is steep. Colours are per vertex and blend
 * across the triangles, so every patch edge is a gentle gradient.
 */
const SAND = [0.81, 0.75, 0.56],
  WET_SAND = [0.66, 0.6, 0.44],
  LUSH = [0.5, 0.64, 0.38],
  DRY = [0.66, 0.7, 0.44],
  ACCENT = [0.72, 0.76, 0.5],
  MUD = [0.66, 0.54, 0.38],
  ROCK = [0.6, 0.59, 0.53],
  ROCK_WARM = [0.64, 0.59, 0.5];

const mix = (a: number[], b: number[], t: number) =>
  a.map((v, i) => v + (b[i] - v) * t);
const ease = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Integer lattice hash to [0, 1). */
const hash = (ix: number, iz: number, seed: number) => {
  let h =
    (Math.imul(ix, 374761393) +
      Math.imul(iz, 668265263) +
      Math.imul(seed, 1274126177)) |
    0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** Smooth value noise in [0, 1]; one lattice cell per unit. */
function noise(x: number, z: number, seed: number) {
  const ix = Math.floor(x),
    iz = Math.floor(z),
    u = ease(0, 1, x - ix),
    v = ease(0, 1, z - iz);
  const a = hash(ix, iz, seed),
    b = hash(ix + 1, iz, seed),
    c = hash(ix, iz + 1, seed),
    d = hash(ix + 1, iz + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/**
 * RGBA per vertex for a height grid, `side` samples per row `step` metres apart and
 * centred on the origin.
 */
export function terrainColours(heights: ArrayLike<number>, side: number, step: number) {
  const out = new Float32Array(side * side * 4),
    half = ((side - 1) * step) / 2;
  const at = (x: number, z: number) =>
    heights[
      Math.min(side - 1, Math.max(0, z)) * side + Math.min(side - 1, Math.max(0, x))
    ];
  for (let gz = 0; gz < side; gz++)
    for (let gx = 0; gx < side; gx++) {
      const h = heights[gz * side + gx],
        x = gx * step - half,
        z = gz * step - half,
        above = h - WATER_LEVEL;
      // Steepness from the neighbouring samples, in metres of rise per metre.
      const slope =
        Math.hypot(at(gx + 1, gz) - at(gx - 1, gz), at(gx, gz + 1) - at(gx, gz - 1)) /
        (2 * step);
      // Broad lush/dry drift, then smaller patches on top of it.
      const drift = noise(x / 110, z / 110, 1) * 0.65 + noise(x / 45, z / 45, 2) * 0.35;
      let ground = mix(DRY, LUSH, ease(0.3, 0.7, drift));
      const accent = ease(0.55, 0.8, noise(x / 30 + 17, z / 30 - 5, 3));
      const mud = ease(0.62, 0.85, noise(x / 36 - 9, z / 36 + 23, 4));
      ground = mix(ground, ACCENT, accent * 0.55);
      // Bare earth only on level, dry ground away from the beach.
      ground = mix(
        ground,
        MUD,
        mud * 0.65 * ease(2.5, 5, above) * (1 - ease(0.25, 0.5, slope)),
      );
      // Ground close to the water is lusher.
      ground = mix(ground, LUSH, 0.35 * (1 - ease(2, 9, above)));
      const beach = mix(WET_SAND, SAND, ease(-0.2, 0.5, above));
      let colour = mix(beach, ground, ease(0.5, 1.8, above));
      const rockiness = Math.max(
        0.75 * ease(0.8, 1.4, slope) * (0.8 + 0.4 * noise(x / 14, z / 14, 5)),
        ease(90, 110, h),
      );
      colour = mix(
        colour,
        mix(ROCK, ROCK_WARM, noise(x / 40, z / 40, 6)),
        Math.min(1, rockiness),
      );
      const i = (gz * side + gx) * 4;
      out[i] = colour[0];
      out[i + 1] = colour[1];
      out[i + 2] = colour[2];
      out[i + 3] = 1;
    }
  return out;
}
