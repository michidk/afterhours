import { LIMIT, type Entity, type Kind } from "./world.ts";
import { contact, entityBox, shape } from "./physics/collision.ts";
import { clamp } from "./physics/vehicle.ts";

export const WORLD_LIMIT = LIMIT + 256;
export const WATER_LEVEL = -1.1;
export type WatercraftKind = Extract<Kind, "boat" | "jetski" | "speedboat">;
export function watercraft(kind: Kind): kind is WatercraftKind {
  return kind === "boat" || kind === "jetski" || kind === "speedboat";
}
export const isWater = (x: number, z: number) =>
  Math.abs(x) > LIMIT || Math.abs(z) > LIMIT;
export const groundLevel = (x: number, z: number) => (isWater(x, z) ? WATER_LEVEL : 0);

/** Full rotated hull against the island; a centre-only check strands long boats. */
export function resolveWorldBounds(e: Entity) {
  let impact = 0;
  if (watercraft(e.kind)) {
    const c = contact(entityBox(e), { x: 0, z: 0, w: LIMIT, d: LIMIT, angle: 0 });
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
  const limit = e.kind === "car" ? LIMIT : WORLD_LIMIT;
  const rx = watercraft(e.kind) ? c * s.w + n * s.d : Math.max(s.w, s.d);
  const rz = watercraft(e.kind) ? n * s.w + c * s.d : Math.max(s.w, s.d);
  if (Math.abs(e.x) > limit - rx) {
    impact = Math.max(impact, Math.abs(e.vx));
    e.x = clamp(e.x, -limit + rx, limit - rx);
    e.vx *= -0.15;
  }
  if (Math.abs(e.z) > limit - rz) {
    impact = Math.max(impact, Math.abs(e.vz));
    e.z = clamp(e.z, -limit + rz, limit - rz);
    e.vz *= -0.15;
  }
  return impact;
}
