import { DEFAULT_MODELS, VEHICLES } from "../catalog.ts";
import type { City, Entity } from "../world.ts";
import {
  groundLevel,
  isWater,
  SURF,
  surfaceLevel,
  surfaceSlope,
  watercraft,
} from "../water.ts";
import { clamp, type Drive } from "./vehicle.ts";

/** A beached hull slides on its keel: no thrust or steering, only friction and slope. */
export const BEACHED = { friction: 5, gravity: 18, spin: 4 };

export function watercraftForces(e: Entity, drive: Drive, dt: number, city?: City) {
  if (!watercraft(e.kind)) return;
  const model = VEHICLES[e.model || DEFAULT_MODELS[e.kind]];
  if (!("water" in model)) return;
  if (city?.terrain && !isWater(e.x, e.z, city)) {
    beach(e, city, dt);
    return;
  }
  const tuning = model.water,
    sx = Math.sin(e.angle),
    sz = Math.cos(e.angle);
  let forward = e.vx * sx + e.vz * sz;
  let lateral = e.vx * sz - e.vz * sx;
  const powered = !e.wreck && (!!e.driver || !!e.ai);
  const throttle = powered ? clamp(drive.throttle, -1, 1) : 0;
  forward += throttle * (throttle < 0 ? tuning.reverse : tuning.acceleration) * dt;
  forward *= Math.exp(-(tuning.drag + (drive.brake ? tuning.braking : 0)) * dt);
  forward = clamp(forward, -model.speed * 0.25, model.speed);
  // Like a car's rear axle, the hull loses side grip in hard turns at speed and drifts.
  const slip =
    0.6 *
    Math.abs(powered ? drive.steer : 0) *
    clamp((2 * forward) / model.speed, 0, 1);
  lateral *= Math.exp(-tuning.lateral * (1 - slip) * dt);
  e.vx = sx * forward + sz * lateral;
  e.vz = sz * forward - sx * lateral;
  const targetYaw = powered ? drive.steer * tuning.turn * clamp(forward / 4, -1, 1) : 0;
  e.angularVelocity =
    (e.angularVelocity || 0) +
    (targetYaw - (e.angularVelocity || 0)) * (1 - Math.exp(-4 * dt));
  // The swell rocks the hull back and forth down its slope.
  const slope = surfaceSlope(e.x, e.z, city);
  e.vx -= SURF.push * slope.x * dt;
  e.vz -= SURF.push * slope.z * dt;
  e.y = surfaceLevel(e.x, e.z, city);
  e.vy = 0;
}

function beach(e: Entity, city: City, dt: number) {
  const dx = groundLevel(e.x + 0.5, e.z, city) - groundLevel(e.x - 0.5, e.z, city),
    dz = groundLevel(e.x, e.z + 0.5, city) - groundLevel(e.x, e.z - 0.5, city);
  const gravity = (BEACHED.gravity * dt) / (1 + dx * dx + dz * dz);
  e.vx -= gravity * dx;
  e.vz -= gravity * dz;
  const speed = Math.hypot(e.vx, e.vz),
    k = speed > 0 ? Math.max(0, speed - BEACHED.friction * dt) / speed : 0;
  e.vx *= k;
  e.vz *= k;
  e.angularVelocity = (e.angularVelocity || 0) * Math.exp(-BEACHED.spin * dt);
  e.y = groundLevel(e.x, e.z, city);
  e.vy = 0;
}
