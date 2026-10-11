import type { Entity, Input } from "../world.ts";
import { clamp } from "./vehicle.ts";
/** Arcade aeroplane: lift needs airspeed, ground braking and airborne stalls. */
export function flyPlane(e: Entity, input: Input, dt: number) {
  const sx = Math.sin(e.angle),
    sz = Math.cos(e.angle),
    speed = Math.hypot(e.vx, e.vz);
  e.angularVelocity =
    (e.wreck ? 0 : Number(input.right) - Number(input.left)) *
    Math.min(speed / 8, 1) *
    (e.y > 0.2 ? 0.7 : 1);
  const thrust = e.wreck ? 0 : (Number(input.up) - Number(input.down)) * 17;
  const damping = e.y < 0.1 && input.brake ? 3 : 0.35;
  e.vx = (e.vx + sx * thrust * dt) * Math.exp(-damping * dt);
  e.vz = (e.vz + sz * thrust * dt) * Math.exp(-damping * dt);
  const vertical =
    e.wreck || speed < 19 ? -9 : (Number(input.ascend) - Number(input.descend)) * 12;
  e.vy = clamp((e.vy + vertical * dt) * Math.exp(-2 * dt), -8, 8);
  e.y = Math.max(0, Math.min(80, e.y + e.vy * dt));
  if (e.y === 0 || e.y === 80) e.vy = 0;
}
