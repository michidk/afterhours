import type { Character } from "./character.ts";
import type { City } from "./world.ts";

export type PropKind =
  "palm" | "tree" | "lamp" | "bench" | "signal" | "hydrant" | "crate";
export const PROP_HEALTH: Record<PropKind, number> = {
  palm: 65,
  tree: 90,
  lamp: 45,
  bench: 40,
  signal: 50,
  hydrant: 45,
  crate: 35,
};

/** Provisional broken colliders and impact directions, private to one prediction. */
export type PredictedImpacts = Map<string, Vec3>;

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
        character?: Character;
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
    // Short segments carry street furniture only where a stop line sits on them.
    if (length < 15 && road.stopA === undefined && road.stopB === undefined) continue;
    const nx = dz / length,
      nz = -dx / length;
    for (const [end, controlled, stop, phase] of [
      [-1, road.signalA, road.stopA, road.phaseA],
      [1, road.signalB, road.stopB, road.phaseB],
    ] as const) {
      if (!controlled) continue;
      // Generated cities give the stop line's distance, so the pole stands on the
      // kerb beside it rather than inside the junction.
      const along = end * (length / 2 - (stop ?? 9)),
        lateral = end * (road.width / 2 + 0.5);
      result.push(
        prop(
          "signal",
          road.x + nx * lateral + (dx / length) * along,
          road.z + nz * lateral + (dz / length) * along,
          4.8,
          0.4,
          0.4,
          phase ?? (Math.abs(dx) > Math.abs(dz) ? "x" : "z"),
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
    // Weapon crates on the kerb side of about one mid-street segment in three, opposite
    // the hydrant. Breaking one open drops a loaded weapon; the crate comes back.
    // Segments ending at a junction are skipped so no crate stands in its mouth;
    // the test needs only the segment itself, so every chunk agrees on crates.
    if (
      length >= 20 &&
      !road.signalA &&
      !road.signalB &&
      !road.noCrate &&
      road.kind !== "coast" &&
      road.kind !== "service" &&
      Math.abs(Math.round(road.x * 7 + road.z * 13)) % 3 === 0
    )
      result.push(
        prop(
          "crate",
          road.x - nx * (road.width / 2 + 1.3),
          road.z - nz * (road.width / 2 + 1.3),
          0.9,
          0.9,
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
