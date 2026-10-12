import { encode, decode } from "@msgpack/msgpack";
import type { Snapshot } from "./protocol.ts";
import type { Entity } from "./world.ts";
export type EntityPatch = { [P in keyof Entity]?: Entity[P] | null } & { id: string };
const scales = {
  x: 1000,
  y: 1000,
  z: 1000,
  vx: 1000,
  vy: 1000,
  vz: 1000,
  angle: 100000,
} as const;
function scale(patch: EntityPatch, direction: 1 | -1) {
  const result = { ...patch };
  for (const [key, factor] of Object.entries(scales)) {
    const k = key as keyof typeof scales;
    if (typeof result[k] === "number")
      result[k] =
        direction === 1 ? Math.round(result[k]! * factor) : result[k]! / factor;
  }
  return result;
}
export function encodeSnapshot(s: Snapshot) {
  // Omit absent object fields; null is reserved for explicit delta removals.
  return encode(
    { ...s, entities: s.entities.map((e) => scale(e, 1)) },
    { ignoreUndefined: true },
  );
}
export function decodeSnapshot(raw: ArrayBuffer | Uint8Array) {
  const s = decode(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw) as Snapshot;
  return { ...s, entities: s.entities.map((e) => scale(e, -1)) };
}
export function applyPatch(entities: Map<string, Entity>, patch: EntityPatch) {
  const result = { ...entities.get(patch.id), ...patch };
  for (const [key, value] of Object.entries(result))
    if (value === null) delete result[key as keyof Entity];
  entities.set(patch.id, result as Entity);
}
