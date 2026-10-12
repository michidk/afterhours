import { LIMIT, random, type City } from "../shared/world.ts";
import { TERRAIN_STEP } from "../shared/terrain.ts";

const smooth = (v: number) => {
  const t = Math.max(0, Math.min(1, v));
  return t * t * (3 - 2 * t);
};
/** Saved offline; the urban plateau keeps roads, foundations and the runway level. */
export function generateTerrain(seed: number): NonNullable<City["terrain"]> {
  const r = random(seed),
    phase = r() * Math.PI * 2,
    heights: number[] = [];
  for (let z = -LIMIT; z <= LIMIT; z += TERRAIN_STEP)
    for (let x = -LIMIT; x <= LIMIT; x += TERRAIN_STEP) {
      const angle = Math.atan2(z, x);
      const coast =
        1300 +
        85 * Math.sin(angle * 3 + phase) +
        65 * Math.cos(angle * 5 - phase) +
        35 * Math.sin(angle * 9 + phase);
      const inland = coast - Math.hypot(x, z * 1.06);
      const edge = smooth((Math.max(Math.abs(x), Math.abs(z)) - 800) / 180);
      const hills =
        30 +
        115 * Math.exp(-(((x + 350) / 580) ** 2) - ((z - 1030) / 260) ** 2) +
        90 * Math.exp(-(((x - 1080) / 270) ** 2) - ((z - 150) / 550) ** 2) +
        28 * Math.sin(x / 140 + phase) * Math.cos(z / 170);
      const height =
        inland < 0
          ? Math.max(-12, inland * 0.18 - 1.1)
          : edge * (-1.1 + smooth(inland / 110) * (1.1 + hills));
      heights.push(Math.round(height * 100) / 100);
    }
  return { heights };
}
