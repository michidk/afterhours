import { LIMIT, type Entity, type City, type Kind } from "./world.ts";
import { contact, entityBox, shape, vehicle } from "./physics/collision.ts";
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
/** The still surface: static placement and rest checks. Floating bodies use surfaceLevel. */
export const groundLevel = (x: number, z: number, city?: WaterCity) =>
  Math.max(waterLevel(x, z, city), terrainHeight(x, z, city));

/**
 * Sea swell: deep-water sine waves (lengths and heights in metres) summed along their
 * headings. Lakes and rivers stay calm. The client's water shader is generated from this.
 */
export const WAVES = [
  { heading: 0.55, length: 46, height: 0.3, phase: 0 },
  { heading: 1.05, length: 27, height: 0.15, phase: 1.7 },
  { heading: 0.15, length: 15, height: 0.075, phase: 4.1 },
  { heading: 1.5, length: 8.5, height: 0.035, phase: 2.6 },
].map((w) => {
  const k = (2 * Math.PI) / w.length;
  return { ...w, k, omega: Math.sqrt(9.81 * k), dx: Math.sin(w.heading), dz: Math.cos(w.heading) };
});
/** Swell dies out over `shoal` metres of depth; the shore laps `swash` metres up the beach. */
export const SURF = { shoal: 6, swash: 0.18, reach: 3, push: 4 };
export const WAVE_MAX = WAVES.reduce((sum, w) => sum + w.height, SURF.swash);
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Sea surface offset from WATER_LEVEL at a point `depth` metres deep. */
export function seaWave(x: number, z: number, time: number, depth: number) {
  let h = 0;
  for (const w of WAVES)
    h += w.height * Math.sin(w.k * (w.dx * x + w.dz * z) - w.omega * time + w.phase);
  // Shoreward-running swash rises a little way up the beach and drains back.
  const lap = smoothstep(-0.5, 0, depth) * (1 - smoothstep(0.5, SURF.reach, depth));
  return (
    h * smoothstep(0, SURF.shoal, depth) +
    SURF.swash * lap * Math.sin(1.2 * time + 1.4 * depth + 0.02 * (x + z))
  );
}
// shortcut: one wave clock per process; give each Simulation its own if a server hosts several worlds.
let clock = 0;
/** The server sets its simulation time every substep; clients set their estimate of it. */
export const setWaveTime = (time: number) => void (clock = time);
export const waveTime = () => clock;
/** Where floating bodies rest: on the swell at sea, a still lake, or dry ground. */
export function surfaceLevel(x: number, z: number, city?: WaterCity, time = clock) {
  const level = waterLevel(x, z, city),
    ground = terrainHeight(x, z, city);
  return Math.max(
    ground,
    level === WATER_LEVEL ? level + seaWave(x, z, time, level - ground) : level,
  );
}
/** Surface gradient over a hull-sized span. */
export function surfaceSlope(x: number, z: number, city?: WaterCity, span = 1.5) {
  return {
    x: (surfaceLevel(x + span, z, city) - surfaceLevel(x - span, z, city)) / (2 * span),
    z: (surfaceLevel(x, z + span, city) - surfaceLevel(x, z - span, city)) / (2 * span),
  };
}
export const swimming = (e: Entity, city?: WaterCity) =>
  isWater(e.x, e.z, city) && e.y <= surfaceLevel(e.x, e.z, city) + 0.1;

/** Keep bodies inside the world edge and on the ground or water surface. */
export function resolveWorldBounds(e: Entity, city?: City) {
  let impact = 0;
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
    // Boats keep their momentum onto land and slide to a halt (physics/watercraft.ts).
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
  if (watercraft(e.kind)) {
    e.y = surfaceLevel(e.x, e.z, city);
    e.vy = 0;
  }
  // A flooded car sinks below the surface it would otherwise rest on.
  else
    e.y = Math.max(
      e.y,
      e.flooded !== undefined
        ? terrainHeight(e.x, e.z, city)
        : vehicle(e)
          ? groundLevel(e.x, e.z, city)
          : surfaceLevel(e.x, e.z, city),
    );
  return impact;
}
