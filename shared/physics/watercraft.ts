import { DEFAULT_MODELS, VEHICLES } from "../catalog.ts";
import type { Entity } from "../world.ts";
import { WATER_LEVEL, watercraft } from "../water.ts";
import { clamp, type Drive } from "./vehicle.ts";

export function watercraftForces(e: Entity, drive: Drive, dt: number) {
  if (!watercraft(e.kind)) return;
  const model = VEHICLES[e.model || DEFAULT_MODELS[e.kind]];
  if (!("water" in model)) return;
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
  lateral *= Math.exp(-tuning.lateral * dt);
  e.vx = sx * forward + sz * lateral;
  e.vz = sz * forward - sx * lateral;
  const targetYaw = powered ? drive.steer * tuning.turn * clamp(forward / 4, -1, 1) : 0;
  e.angularVelocity =
    (e.angularVelocity || 0) +
    (targetYaw - (e.angularVelocity || 0)) * (1 - Math.exp(-4 * dt));
  e.y = WATER_LEVEL;
  e.vy = 0;
}
