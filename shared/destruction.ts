import type { City } from "./world.ts";

export type PropKind = "palm" | "tree" | "lamp" | "bench" | "signal" | "hydrant";
export interface Destructible {
  id: string;
  kind: PropKind;
  x: number;
  z: number;
  h: number;
  w: number;
  d: number;
  axis?: "x" | "z";
  angle?: number;
}
export type Vec3 = { x: number; y: number; z: number };
export type Rotation = Vec3 & { w: number };
export interface DebrisState {
  id: string;
  source:
    | Destructible
    | {
        id: string;
        kind: "corpse";
        x: number;
        z: number;
        h: number;
        w: number;
        d: number;
        color: string;
      };
  position: Vec3;
  rotation: Rotation;
  velocity: Vec3;
  angularVelocity: Vec3;
  brokenAt: number;
  expiresAt: number;
}
const idFor = (kind: PropKind, x: number, z: number) =>
  `${kind}:${x.toFixed(4)},${z.toFixed(4)}`;
const prop = (
  kind: PropKind,
  x: number,
  z: number,
  h: number,
  w: number,
  d = w,
  axis?: "x" | "z",
): Destructible => ({ id: idFor(kind, x, z), kind, x, z, h, w, d, axis });

/** Deterministic runtime fixtures derived from the saved map, never written into it. */
export function destructibles(
  city: Pick<City, "props" | "parks" | "roads">,
): Destructible[] {
  const result = city.props.map((p) =>
    prop(p.kind, p.x, p.z, p.h, p.kind === "tree" ? 0.5 : 0.38),
  );
  for (const park of city.parks) {
    if (park.kind === "woodland") continue;
    for (const side of [-1, 1])
      for (const offset of [-9, 9])
        result.push({
          ...prop("bench", park.x + side * 4, park.z + offset, 1.4, 1.2, 2.8),
          angle: side < 0 ? Math.PI : 0,
        });
  }
  for (const road of city.roads) {
    const dx = road.bx - road.ax,
      dz = road.bz - road.az,
      length = Math.hypot(dx, dz);
    if (length < 15) continue;
    const nx = dz / length,
      nz = -dx / length;
    for (const [end, controlled] of [
      [-1, road.signalA],
      [1, road.signalB],
    ] as const) {
      if (!controlled) continue;
      const along = end * (length / 2 - 9),
        lateral = end * (road.width / 2 + 2);
      result.push(
        prop(
          "signal",
          road.x + nx * lateral + (dx / length) * along,
          road.z + nz * lateral + (dz / length) * along,
          4.8,
          0.4,
          0.4,
          Math.abs(dx) > Math.abs(dz) ? "x" : "z",
        ),
      );
    }
    // One hydrant on long city streets, beside the sidewalk rather than in traffic.
    if (length >= 40 && road.kind !== "coast" && road.kind !== "service")
      result.push(
        prop(
          "hydrant",
          road.x + nx * (road.width / 2 + 3),
          road.z + nz * (road.width / 2 + 3),
          1,
          0.65,
        ),
      );
  }
  return [...new Map(result.map((p) => [p.id, p])).values()];
}

const overlays = new WeakMap<City, { ids: Set<string>; revision: number }>();
export function destructionOverlay(city: City) {
  let overlay = overlays.get(city);
  if (!overlay) {
    overlay = { ids: new Set(), revision: 0 };
    overlays.set(city, overlay);
  }
  return overlay;
}
export function setBrokenProps(city: City, ids: Iterable<string>) {
  const overlay = destructionOverlay(city),
    next = new Set(ids);
  if (next.size === overlay.ids.size && [...next].every((id) => overlay.ids.has(id)))
    return;
  overlay.ids = next;
  overlay.revision++;
}
