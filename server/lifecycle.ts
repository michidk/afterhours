import type { Entity, City } from "../shared/world.ts";
import { LIMIT } from "../shared/world.ts";
export function safeSpawn(city: City, entities: Entity[], ignore?: string) {
  // Generated cities carry their downtown reference; the authored map used the origin.
  const origin = { x: (city.centre?.x ?? 0) + 11, z: (city.centre?.z ?? 0) + 25 };
  for (let radius = 0; radius < 80; radius += 2)
    for (let i = 0; i < 16; i++) {
      const x = origin.x + Math.sin((i * Math.PI) / 8) * radius,
        z = origin.z + Math.cos((i * Math.PI) / 8) * radius;
      if (
        Math.abs(x) > LIMIT - 2 ||
        Math.abs(z) > LIMIT - 2 ||
        city.buildings.some(
          (b) => Math.abs(x - b.x) < b.w / 2 + 0.7 && Math.abs(z - b.z) < b.d / 2 + 0.7,
        )
      )
        continue;
      if (city.props.some((p) => Math.hypot(p.x - x, p.z - z) < 1)) continue;
      if (
        entities.some(
          (e) =>
            e.id !== ignore &&
            !e.vehicle &&
            e.y < 2 &&
            Math.hypot(e.x - x, e.z - z) <
              (e.kind === "player" || e.kind === "pedestrian" ? 1.2 : 4),
        )
      )
        continue;
      return { x, z };
    }
  return origin;
}
