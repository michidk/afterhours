import type { Entity, Input } from "../world.ts";
import { clamp } from "./vehicle.ts";

export const JETPACK = { fuel: 45, drain: 1, speed: 10, ceiling: 80 };

/** Shared provisional fuel and thrust; equipment ownership stays on the server. */
export function jetpackThrust(e: Entity, input: Input, dt: number) {
  const pack = e.jetpack;
  if (!pack?.active || pack.fuel <= 0 || !input.ascend || e.vehicle || e.down)
    return false;
  const powered = Math.min(dt, pack.fuel / JETPACK.drain);
  pack.fuel = Math.max(0, pack.fuel - powered * JETPACK.drain);
  e.parachute = undefined;
  e.vy += (JETPACK.speed - e.vy) * (1 - Math.exp(-4 * powered));
  e.y = clamp(e.y + e.vy * powered, -2, JETPACK.ceiling);
  if (e.y === JETPACK.ceiling) e.vy = 0;
  return powered > 0;
}
