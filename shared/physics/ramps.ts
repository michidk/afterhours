import type { City, Entity } from "../world.ts";
import { groundLevel } from "../water.ts";
import { contact, entityBox, shape, type Contact } from "./collision.ts";
import { sinkFlooded } from "./flooding.ts";

/** City artifacts store positions; geometry is identical on authority and client. */
export const RAMP = { width: 5, length: 7, height: 1.6 };
export const rampSlope = RAMP.height / RAMP.length;
export function rampHeight(x: number, z: number, city: City) {
  let height = groundLevel(x, z, city);
  for (const r of city.ramps)
    if (Math.abs(x - r.x) <= RAMP.width / 2 && Math.abs(z - r.z) <= RAMP.length / 2)
      height = Math.max(height, (z - r.z + RAMP.length / 2) * rampSlope);
  return height;
}
export function carGrounded(e: Pick<Entity, "x" | "y" | "z" | "vy">, city: City) {
  const floor = rampHeight(e.x, e.z, city);
  return Math.abs(e.y - floor) < 0.03;
}
/** Follow the slope from its toe; retain slope velocity when leaving its lip. */
export function carAltitude(
  e: Entity,
  previous: Pick<Entity, "x" | "y" | "z" | "vy" | "vz">,
  city: City,
  dt: number,
) {
  if (e.flooded !== undefined) {
    sinkFlooded(e, city, dt);
    return;
  }
  const floor = rampHeight(e.x, e.z, city),
    oldFloor = rampHeight(previous.x, previous.z, city),
    supported = carGrounded(previous, city),
    toeEntry = city.ramps.some(
      (r) =>
        previous.z <= r.z - RAMP.length / 2 &&
        e.z >= r.z - RAMP.length / 2 &&
        Math.abs(e.x - r.x) <= RAMP.width / 2 &&
        Math.abs(previous.x - r.x) <= RAMP.width / 2,
    );
  const onTerrain =
    groundLevel(e.x, e.z, city) === floor &&
    groundLevel(previous.x, previous.z, city) === oldFloor;
  if (supported && onTerrain) {
    const fallingVelocity = previous.vy - 18 * dt;
    const fallingHeight = previous.y + fallingVelocity * dt;
    // Ground can push a car up, but cannot pull it down over a crest.
    if (floor >= fallingHeight) {
      e.y = floor;
      e.vy = (floor - oldFloor) / dt;
      const dx =
          (groundLevel(e.x + 0.05, e.z, city) - groundLevel(e.x - 0.05, e.z, city)) /
          0.1,
        dz =
          (groundLevel(e.x, e.z + 0.05, city) - groundLevel(e.x, e.z - 0.05, city)) /
          0.1;
      const gravity = (18 * dt) / (1 + dx * dx + dz * dz);
      e.vx -= gravity * dx;
      e.vz -= gravity * dz;
    } else {
      e.vy = fallingVelocity;
      e.y = fallingHeight;
    }
    return;
  }
  if (
    supported &&
    ((floor > 0 && (oldFloor > 0 || toeEntry)) ||
      (floor === 0 &&
        (oldFloor === 0 ||
          (previous.vz < 0 &&
            oldFloor <= Math.abs(previous.vz * dt * rampSlope) + 0.03))))
  ) {
    e.y = floor;
    e.vy = floor > 0 ? (floor - oldFloor) / dt : 0;
    return;
  }
  e.vy -= 18 * dt;
  e.y += e.vy * dt;
  // A descending body can land on the slope, but a side/back approach cannot teleport up.
  const landing =
    previous.y >= floor - 0.02 && e.vy <= 0 ? floor : groundLevel(e.x, e.z, city);
  if (e.y <= landing) {
    e.y = landing;
    e.vy = 0;
  }
}
/** The solid high face and sides remain obstacles below the wedge surface. */
export function rampContacts(e: Entity, city: City): Contact[] {
  const result: Contact[] = [];
  for (const r of city.ramps) {
    if (
      Math.abs(e.x - r.x) > RAMP.width / 2 + 6 ||
      Math.abs(e.z - r.z) > RAMP.length / 2 + 6 ||
      e.y >= RAMP.height - 0.02
    )
      continue;
    const start = r.z - RAMP.length / 2,
      floor =
        Math.abs(e.x - r.x) <= RAMP.width / 2 && Math.abs(e.z - r.z) <= RAMP.length / 2
          ? (e.z - start) * rampSlope
          : 0;
    if (floor > 0 && e.y >= floor - 0.03) continue;
    // Wheels meet a traversable toe rather than a vertical wall.
    if (
      e.kind === "car" &&
      e.z <= start &&
      Math.abs(e.x - r.x) <= RAMP.width / 2 - shape(e).w
    )
      continue;
    const low = start + Math.max(0, e.y + 0.15) / rampSlope,
      high = r.z + RAMP.length / 2;
    if (low >= high) continue;
    const c = contact(entityBox(e), {
      x: r.x,
      z: (low + high) / 2,
      w: RAMP.width / 2,
      d: (high - low) / 2,
      angle: 0,
    });
    if (c) result.push(c);
  }
  return result;
}
