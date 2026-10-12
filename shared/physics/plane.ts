import { inputX, inputY, type City, type Entity, type Input } from "../world.ts";
import { clamp } from "./vehicle.ts";
import { VEHICLES } from "../catalog.ts";
import { groundLevel } from "../water.ts";
/** Arcade aeroplane: lift needs airspeed, climbs trade speed, dives earn it back. */
export function flyPlane(e: Entity, input: Input, dt: number, city?: City) {
  const model = VEHICLES[e.model || "plane"];
  if (model.kind !== "plane") return;
  const tuning = model.flight,
    floor = groundLevel(e.x, e.z, city),
    ceiling = floor + tuning.ceiling,
    airborne = e.y > floor + 0.2;
  const sx = Math.sin(e.angle),
    sz = Math.cos(e.angle);
  // Planes travel along their nose; carrying scalar airspeed removes sideways drift.
  let speed = Math.max(0, e.vx * sx + e.vz * sz);
  const control = !e.wreck && !!e.driver,
    throttle = control ? inputY(input) : 0;
  e.angularVelocity =
    (control ? inputX(input) : 0) *
    Math.min(speed / 8, 1) *
    (airborne ? tuning.turn : tuning.taxiTurn);
  // W throttles up; S brakes on the runway and acts as an airbrake aloft.
  speed += Math.max(0, throttle) * tuning.thrust * dt;
  speed -= e.vy * 0.4 * dt;
  speed = Math.max(
    0,
    speed * Math.exp(-(throttle < 0 ? tuning.braking : tuning.drag) * dt),
  );
  e.vx = sx * speed;
  e.vz = sz * speed;
  const pitch = control ? Number(input.ascend) - Number(input.descend) : 0;
  const vertical =
    e.wreck || speed < tuning.stall
      ? -8
      : pitch > 0
        ? tuning.climb
        : pitch < 0
          ? -tuning.descend
          : 0;
  e.vy += (vertical - e.vy) * (1 - Math.exp(-tuning.vertical * dt));
  e.y = clamp(e.y + e.vy * dt, floor, ceiling);
  if (e.y === floor || e.y === ceiling) e.vy = 0;
}
