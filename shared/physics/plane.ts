import type { City, Entity, Input } from "../world.ts";
import { clamp } from "./vehicle.ts";
import { VEHICLES } from "../catalog.ts";
import { groundLevel } from "../water.ts";
/** Arcade aeroplane: lift needs airspeed, ground braking and airborne stalls. */
export function flyPlane(e: Entity, input: Input, dt: number, city?: City) {
  const model = VEHICLES[e.model || "plane"];
  if (model.kind !== "plane") return;
  const tuning = model.flight,
    floor = groundLevel(e.x, e.z, city),
    ceiling = floor + tuning.ceiling;
  const sx = Math.sin(e.angle),
    sz = Math.cos(e.angle),
    speed = Math.hypot(e.vx, e.vz);
  e.angularVelocity =
    (e.wreck ? 0 : Number(input.right) - Number(input.left)) *
    Math.min(speed / 8, 1) *
    (e.y > floor + 0.2 ? tuning.turn : tuning.taxiTurn);
  const thrust =
    e.wreck || !e.driver ? 0 : (Number(input.up) - Number(input.down)) * tuning.thrust;
  const damping = input.brake ? tuning.braking : tuning.drag;
  e.vx = (e.vx + sx * thrust * dt) * Math.exp(-damping * dt);
  e.vz = (e.vz + sz * thrust * dt) * Math.exp(-damping * dt);
  const vertical =
    e.wreck || speed < tuning.stall
      ? -8
      : input.ascend
        ? tuning.climb
        : input.descend
          ? -tuning.descend
          : 0;
  e.vy += (vertical - e.vy) * (1 - Math.exp(-tuning.vertical * dt));
  e.y = clamp(e.y + e.vy * dt, floor, ceiling);
  if (e.y === floor || e.y === ceiling) e.vy = 0;
}
