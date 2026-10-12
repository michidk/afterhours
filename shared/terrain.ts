import { LIMIT, type City } from "./world.ts";

export const TERRAIN_STEP = 32;
export const TERRAIN_SIDE = (LIMIT * 2) / TERRAIN_STEP + 1;
/** Triangle interpolation matches the rendered mesh, including its diagonal. */
export function terrainHeight(x: number, z: number, city?: Pick<City, "terrain">) {
  if (Math.abs(x) > LIMIT || Math.abs(z) > LIMIT) return -12;
  if (!city?.terrain) return 0;
  const gx = (x + LIMIT) / TERRAIN_STEP,
    gz = (z + LIMIT) / TERRAIN_STEP;
  const ix = Math.min(TERRAIN_SIDE - 2, Math.floor(gx));
  const iz = Math.min(TERRAIN_SIDE - 2, Math.floor(gz));
  const u = gx - ix,
    v = gz - iz,
    i = iz * TERRAIN_SIDE + ix;
  const h = city.terrain.heights;
  return u + v <= 1
    ? h[i] + u * (h[i + 1] - h[i]) + v * (h[i + TERRAIN_SIDE] - h[i])
    : h[i + TERRAIN_SIDE + 1] +
        (1 - u) * (h[i + TERRAIN_SIDE] - h[i + TERRAIN_SIDE + 1]) +
        (1 - v) * (h[i + 1] - h[i + TERRAIN_SIDE + 1]);
}
export function terrainMesh(terrain: NonNullable<City["terrain"]>) {
  const positions: number[] = [],
    indices: number[] = [];
  for (let z = 0; z < TERRAIN_SIDE; z++)
    for (let x = 0; x < TERRAIN_SIDE; x++) {
      const i = z * TERRAIN_SIDE + x;
      positions.push(
        x * TERRAIN_STEP - LIMIT,
        terrain.heights[i],
        z * TERRAIN_STEP - LIMIT,
      );
      if (x < TERRAIN_SIDE - 1 && z < TERRAIN_SIDE - 1)
        indices.push(
          i,
          i + TERRAIN_SIDE,
          i + 1,
          i + 1,
          i + TERRAIN_SIDE,
          i + TERRAIN_SIDE + 1,
        );
    }
  return { positions, indices };
}
