import { VEHICLES } from "../../shared/catalog.ts";
import { wheelPoint } from "../../shared/physics/vehicle.ts";
import type { Entity } from "../../shared/world.ts";

/** Display mounts, ordered like the force model: front left/right, rear left/right. */
export const CAR_WHEEL_MOUNTS = [
  { x: -1, z: 1.3 },
  { x: 1, z: 1.3 },
  { x: -1, z: -1.25 },
  { x: 1, z: -1.25 },
];
export function displayedWheelPoint(e: Entity, index: number) {
  const model = VEHICLES[e.model ?? "sedan"],
    mount = CAR_WHEEL_MOUNTS[index];
  return wheelPoint(e, {
    x: (mount.x * model.width) / 2,
    z: (mount.z * model.length) / 4.3,
  });
}
