import type { City, Entity } from "../world.ts";
import { staticGeometry } from "./static.ts";
import { buildingBox, contact, entityBox } from "./collision.ts";
import { groundLevel } from "../water.ts";

/** Unpiloted aircraft keep their course, lose altitude, and hit the world. */
export function fallAircraft(e: Entity, city: City, dt: number) {
  e.flight = "falling";
  e.vx *= Math.exp(-0.05 * dt);
  e.vz *= Math.exp(-0.05 * dt);
  e.angularVelocity = (e.angularVelocity || 0) * Math.exp(-2 * dt);
  let floor = groundLevel(e.x, e.z);
  for (const b of staticGeometry(city).query(e.x, e.z, 6)) {
    const top = b.obstacle ? b.h : b.h + 1.8;
    if (top <= e.y + 0.02 && contact(entityBox(e), buildingBox(b)))
      floor = Math.max(floor, top);
  }
  const previous = e.y;
  e.vy -= 9.81 * dt;
  e.y = Math.max(floor, e.y + e.vy * dt);
  if (e.y <= floor) {
    const impact = previous > floor + 1e-6 ? Math.abs(e.vy) : 0;
    e.vy = 0;
    e.flight = "grounded";
    return impact;
  }
  return 0;
}
