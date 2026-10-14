import type { City, Entity } from "../world.ts";
import { terrainHeight } from "../terrain.ts";
import { waterLevel } from "../water.ts";

/**
 * A car driven into water deeper than \`depth\` floods: its engine dies, it drifts to
 * a stop and sinks to the bed, and \`seconds\` later it explodes.
 */
export const FLOOD = { depth: 0.8, seconds: 10, sink: 0.8, drag: 1.5 };

/** Water depth above the terrain at a point; negative on dry land. */
export function waterDepth(x: number, z: number, city: City) {
  return waterLevel(x, z, city) - terrainHeight(x, z, city);
}
export function floods(e: Entity, city: City) {
  return (
    e.kind === "car" &&
    e.flooded === undefined &&
    e.wreck === undefined &&
    !!city.terrain &&
    waterDepth(e.x, e.z, city) > FLOOD.depth
  );
}
/** No drive reaches the wheels; the water slows the car and its spin. */
export function driftFlooded(e: Entity, dt: number) {
  const k = Math.exp(-FLOOD.drag * dt);
  e.vx *= k;
  e.vz *= k;
  e.angularVelocity = (e.angularVelocity || 0) * k;
}
/** Sink steadily from wherever the car entered the water down to the bed. */
export function sinkFlooded(e: Entity, city: City, dt: number) {
  const bed = terrainHeight(e.x, e.z, city);
  e.y = Math.max(bed, e.y - FLOOD.sink * dt);
  e.vy = e.y > bed ? -FLOOD.sink : 0;
}
