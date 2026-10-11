import type { Entity, WorldEvent } from "../../shared/world.ts";
import { CAR_WHEEL_MOUNTS, displayedWheelPoint } from "../models/car-wheels.ts";

type Anchor = { x: number; z: number; slipping: boolean };
/** Cosmetic tracks follow displayed tyres, including prediction, rather than packet arrival. */
export class TyreTracks {
  private anchors = new Map<string, Anchor[]>();
  sample(entities: Entity[], emit: (mark: WorldEvent) => void) {
    const present = new Set<string>();
    for (const e of entities) {
      if (e.kind !== "car" || e.wreck || e.y > 0.08) continue;
      present.add(e.id);
      const previous = this.anchors.get(e.id),
        next: Anchor[] = [];
      for (let i = 0; i < CAR_WHEEL_MOUNTS.length; i++) {
        const point = displayedWheelPoint(e, i),
          slipping = !!e.wheelSkids?.[i],
          a = previous?.[i],
          distance = a ? Math.hypot(point.x - a.x, point.z - a.z) : 0;
        // Avoid bridges over teleports/corrections. Accumulate tiny movements so
        // high refresh rates do not consume the mark budget faster than low ones.
        if (slipping && (!a?.slipping || distance > 3))
          emit({
            kind: "skid",
            x: point.x,
            z: point.z,
            y: 0.105,
            angle: e.angle,
            length: 0.15,
          });
        else if (slipping && a && distance >= 0.12)
          emit({
            kind: "skid",
            x: (a.x + point.x) / 2,
            z: (a.z + point.z) / 2,
            y: 0.105,
            angle: Math.atan2(point.x - a.x, point.z - a.z),
            length: distance + 0.06,
          });
        next.push(
          slipping && a?.slipping && distance < 0.12 ? a : { ...point, slipping },
        );
      }
      this.anchors.set(e.id, next);
    }
    for (const id of this.anchors.keys()) if (!present.has(id)) this.anchors.delete(id);
  }
}
