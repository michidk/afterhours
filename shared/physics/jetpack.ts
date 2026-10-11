import type { Entity, Input } from "../world.ts";
import { clamp } from "./vehicle.ts";

export const JETPACK = { fuel: 45, drain: 1, speed: 10, ceiling: 80 };

/** Shared provisional fuel and thrust; equipment ownership stays on the server. */
export function jetpackThrust(e: Entity, input: Input, dt: number, floor: number) {
  const pack = e.jetpack;
  if (
    !pack?.active ||
    pack.fuel <= 0 ||
    (!input.ascend && !input.descend) ||
    e.vehicle ||
    e.down
  )
    return false;
  if (!input.ascend && e.y <= floor + 0.02) return false;
  const powered = Math.min(dt, pack.fuel / JETPACK.drain);
  pack.fuel = Math.max(0, pack.fuel - powered * JETPACK.drain);
  e.parachute = undefined;
  const target = input.ascend ? JETPACK.speed : -4;
  e.vy += (target - e.vy) * (1 - Math.exp(-4 * powered));
  e.y = clamp(e.y + e.vy * powered, floor, JETPACK.ceiling);
  if (e.y === JETPACK.ceiling || e.y === floor) e.vy = 0;
  return powered > 0;
}
