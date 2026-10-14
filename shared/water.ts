import { LIMIT, type Entity, type City, type Kind } from "./world.ts";
import { contact, entityBox, shape } from "./physics/collision.ts";
import { TERRAIN_SIDE, TERRAIN_STEP, terrainHeight } from "./terrain.ts";
import { pointInPolygon } from "./polygon.ts";
import { clamp } from "./physics/vehicle.ts";

export const WORLD_LIMIT = LIMIT + 256;
export const WATER_LEVEL = -1.1;
export type WatercraftKind = Extract<Kind, "boat" | "jetski" | "speedboat">;
export function watercraft(kind: Kind): kind is WatercraftKind {
  return kind === "boat" || kind === "jetski" || kind === "speedboat";
}
type WaterCity = Pick<City, "terrain" | "water">;
/** Lake surface per terrain grid point (NaN outside lakes), built once per map. */
const lakeGrids = new WeakMap<NonNullable<City["water"]>, Float32Array>();
function lakeGrid(water: NonNullable<City["water"]>) {
  let grid = lakeGrids.get(water);
  if (grid) return grid;
  grid = new Float32Array(TERRAIN_SIDE * TERRAIN_SIDE).fill(NaN);
  for (const lake of water.lakes) {
    const ring: { x: number; z: number }[] = [];
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (let i = 0; i < lake.outline.length; i += 2) {
      const p = { x: lake.outline[i], z: lake.outline[i + 1] };
      ring.push(p);
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      z0 = Math.min(z0, p.z);
      z1 = Math.max(z1, p.z);
    }
    for (
      let gz = Math.ceil((z0 + LIMIT) / TERRAIN_STEP);
      gz * TERRAIN_STEP - LIMIT <= z1;
      gz++
    )
      for (
        let gx = Math.ceil((x0 + LIMIT) / TERRAIN_STEP);
        gx * TERRAIN_STEP - LIMIT <= x1;
        gx++
      )
        if (
          gx >= 0 &&
          gz >= 0 &&
          gx < TERRAIN_SIDE &&
          gz < TERRAIN_SIDE &&
          pointInPolygon(
            { x: gx * TERRAIN_STEP - LIMIT, z: gz * TERRAIN_STEP - LIMIT },
            ring,
          )
        )
          grid[gz * TERRAIN_SIDE + gx] = lake.level;
  }
  lakeGrids.set(water, grid);
  return grid;
}
/** Water surface height here: a lake's level inside it, otherwise the sea's. */
export function waterLevel(x: number, z: number, city?: WaterCity) {
  // Lakes sit in terrain basins; without the terrain there is only the sea.
  if (
    !city?.terrain ||
    !city.water?.lakes.length ||
    Math.abs(x) > LIMIT ||
    Math.abs(z) > LIMIT
  )
    return WATER_LEVEL;
  const gx = Math.round((x + LIMIT) / TERRAIN_STEP),
    gz = Math.round((z + LIMIT) / TERRAIN_STEP),
    level = lakeGrid(city.water)[gz * TERRAIN_SIDE + gx];
  return Number.isNaN(level) ? WATER_LEVEL : level;
}
export const isWater = (x: number, z: number, city?: WaterCity) =>
  terrainHeight(x, z, city) < waterLevel(x, z, city);
export const groundLevel = (x: number, z: number, city?: WaterCity) =>
  Math.max(waterLevel(x, z, city), terrainHeight(x, z, city));

/** Full rotated hull against the island; a centre-only check strands long boats. */
export function resolveWorldBounds(e: Entity, city?: City) {
  let impact = 0;
  if (
    city?.terrain &&
    Math.abs(e.x) < LIMIT &&
    Math.abs(e.z) < LIMIT &&
    watercraft(e.kind)
  ) {
    impact = resolveShore(e, city);
  }
  if (watercraft(e.kind)) {
    const c = city?.terrain
      ? undefined
      : contact(entityBox(e), { x: 0, z: 0, w: LIMIT, d: LIMIT, angle: 0 });
    if (c) {
      e.x -= c.nx * (c.depth + 0.001);
      e.z -= c.nz * (c.depth + 0.001);
      const toward = e.vx * c.nx + e.vz * c.nz;
      if (toward > 0) {
        impact = toward;
        e.vx -= c.nx * toward * 1.15;
        e.vz -= c.nz * toward * 1.15;
      }
      e.angularVelocity = (e.angularVelocity || 0) * 0.5;
    }
    e.y = WATER_LEVEL;
    e.vy = 0;
  }
  const s = shape(e),
    c = Math.abs(Math.cos(e.angle)),
    n = Math.abs(Math.sin(e.angle));
  const limit = e.kind === "car" && !city?.terrain ? LIMIT : WORLD_LIMIT;
  const rx = c * s.w + n * s.d;
  const rz = n * s.w + c * s.d;
  if (Math.abs(e.x) > limit - rx) {
    impact = Math.max(impact, Math.abs(e.vx));
    e.x = clamp(e.x, -limit + rx, limit - rx);
    if (e.vx * e.x > 0) e.vx *= -0.15;
  }
  if (Math.abs(e.z) > limit - rz) {
    impact = Math.max(impact, Math.abs(e.vz));
    e.z = clamp(e.z, -limit + rz, limit - rz);
    if (e.vz * e.z > 0) e.vz *= -0.15;
  }
  // A flooded car sinks below the surface it would otherwise rest on.
  if (!watercraft(e.kind))
    e.y = Math.max(
      e.y,
      e.flooded !== undefined
        ? terrainHeight(e.x, e.z, city)
        : groundLevel(e.x, e.z, city),
    );
  return impact;
}

/** Sample the rotated footprint; move boats downhill and cars uphill at the coast. */
function resolveShore(e: Entity, city: City) {
  const boat = watercraft(e.kind),
    s = shape(e),
    c = Math.cos(e.angle),
    n = Math.sin(e.angle);
  let impact = 0;
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (const u of [-1, 0, 1])
      for (const v of [-1, 0, 1]) {
        const x = e.x + u * s.w * c + v * s.d * n;
        const z = e.z - u * s.w * n + v * s.d * c;
        const h = terrainHeight(x, z, city),
          target = WATER_LEVEL + (boat ? -0.05 : 0.05);
        if (boat ? h <= target : h >= target) continue;
        let dx = terrainHeight(x + 1, z, city) - terrainHeight(x - 1, z, city);
        let dz = terrainHeight(x, z + 1, city) - terrainHeight(x, z - 1, city);
        let length = Math.hypot(dx, dz);
        if (length < 0.0001) {
          dx = -x;
          dz = -z;
          length = Math.hypot(dx, dz) || 1;
        }
        const sign = boat ? -1 : 1,
          nx = (sign * dx) / length,
          nz = (sign * dz) / length;
        const distance = Math.min(
          32,
          Math.max(0.1, Math.abs(h - target) / Math.max(length / 2, 0.01)),
        );
        e.x += nx * distance;
        e.z += nz * distance;
        const speed = e.vx * nx + e.vz * nz;
        if (speed < 0) {
          impact = Math.max(impact, -speed);
          e.vx -= nx * speed * 1.15;
          e.vz -= nz * speed * 1.15;
        }
        moved = true;
      }
    if (!moved) break;
  }
  return impact;
}
