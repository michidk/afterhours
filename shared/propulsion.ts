import type { Entity } from "./world.ts";

/** Motion from a collision or windmilling does not power an engine. */
export function propulsionRunning(e: Entity) {
  if (
    e.wreck !== undefined ||
    e.flooded !== undefined ||
    e.health <= 0 ||
    !(e.driver || e.ai)
  )
    return false;
  if (e.kind === "helicopter")
    return (
      e.flight === "takingOff" || e.flight === "cruising" || e.flight === "landing"
    );
  return e.kind !== "player" && e.kind !== "pedestrian";
}
