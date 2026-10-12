import type { Entity, Building } from "../world.ts";
import { DEFAULT_MODELS, VEHICLES } from "../catalog.ts";
export const vehicle = (e: Entity) => e.kind !== "player" && e.kind !== "pedestrian";
export function shape(e: Entity) {
  if (e.kind === "player" || e.kind === "pedestrian") return { w: 0.42, d: 0.42 };
  const model = VEHICLES[e.model || DEFAULT_MODELS[e.kind]];
  return { w: model.width / 2, d: model.length / 2 };
}
export const mass = (e: Entity) =>
  e.kind === "player" || e.kind === "pedestrian"
    ? 80
    : VEHICLES[e.model || DEFAULT_MODELS[e.kind]].mass;
export const inertia = (e: Entity) =>
  !vehicle(e)
    ? Infinity
    : (mass(e) * ((shape(e).w * 2) ** 2 + (shape(e).d * 2) ** 2)) / 12;
export type Box = { x: number; z: number; angle: number; w: number; d: number };
export function rayDistance(
  x: number,
  z: number,
  dx: number,
  dz: number,
  box: Box,
  range: number,
) {
  let near = 0,
    far = range;
  for (const [axis, extent] of axes(box).map(
    (a, i) => [a, i === 0 ? box.w : box.d] as const,
  )) {
    const origin = (x - box.x) * axis.x + (z - box.z) * axis.z,
      direction = dx * axis.x + dz * axis.z;
    if (Math.abs(direction) < 1e-8) {
      if (Math.abs(origin) > extent) return Infinity;
      continue;
    }
    const a = (-extent - origin) / direction,
      b = (extent - origin) / direction;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return Infinity;
  }
  return near;
}
export type Contact = {
  nx: number;
  nz: number;
  depth: number;
  x: number;
  z: number;
};
const axes = (b: Box) => [
  { x: Math.cos(b.angle), z: -Math.sin(b.angle) },
  { x: Math.sin(b.angle), z: Math.cos(b.angle) },
];
function extent(b: Box, a: ReturnType<typeof axes>, x: number, z: number) {
  return (
    Math.abs(a[0].x * x + a[0].z * z) * b.w + Math.abs(a[1].x * x + a[1].z * z) * b.d
  );
}
export function contact(a: Box, b: Box): Contact | undefined {
  let depth = Infinity,
    nx = 0,
    nz = 0;
  const aAxes = axes(a),
    bAxes = axes(b);
  for (const axis of [...aAxes, ...bAxes]) {
    const delta = (b.x - a.x) * axis.x + (b.z - a.z) * axis.z;
    const overlap =
      extent(a, aAxes, axis.x, axis.z) +
      extent(b, bAxes, axis.x, axis.z) -
      Math.abs(delta);
    if (overlap <= 0) return;
    if (overlap < depth) {
      depth = overlap;
      nx = axis.x * (delta >= 0 ? 1 : -1);
      nz = axis.z * (delta >= 0 ? 1 : -1);
    }
  }
  const tx = -nz,
    tz = nx,
    at = a.x * tx + a.z * tz,
    bt = b.x * tx + b.z * tz;
  const tangent =
    (Math.max(at - extent(a, aAxes, tx, tz), bt - extent(b, bAxes, tx, tz)) +
      Math.min(at + extent(a, aAxes, tx, tz), bt + extent(b, bAxes, tx, tz))) /
    2;
  const normal =
    (a.x * nx +
      a.z * nz +
      extent(a, aAxes, nx, nz) +
      b.x * nx +
      b.z * nz -
      extent(b, bAxes, nx, nz)) /
    2;
  return {
    nx,
    nz,
    depth,
    x: nx * normal + tx * tangent,
    z: nz * normal + tz * tangent,
  };
}
export const entityBox = (e: Entity): Box => ({
  ...shape(e),
  x: e.x,
  z: e.z,
  angle: vehicle(e) ? e.angle : 0,
});
export const buildingBox = (b: Building): Box => ({
  x: b.x,
  z: b.z,
  w: b.w / 2,
  d: b.d / 2,
  // Box axes rotate the opposite way from the footprint frame used by the
  // generator and the client (local x -> (cos a, sin a)), hence the sign flip.
  angle: -(b.angle ?? 0),
});
export function pointVelocity(e: Entity, x: number, z: number) {
  return {
    x: e.vx + (e.angularVelocity || 0) * (z - e.z),
    z: e.vz - (e.angularVelocity || 0) * (x - e.x),
  };
}
function impulse(e: Entity, x: number, z: number, px: number, pz: number) {
  e.vx += x / mass(e);
  e.vz += z / mass(e);
  if (vehicle(e))
    e.angularVelocity =
      (e.angularVelocity || 0) + ((pz - e.z) * x - (px - e.x) * z) / inertia(e);
}
// Normal points A -> B. A static B has infinite mass. Off-centre contacts spin bodies.
export function resolveContact(a: Entity, b: Entity | undefined, c: Contact) {
  const ia = 1 / mass(a),
    ib = b ? 1 / mass(b) : 0,
    total = ia + ib;
  const correction = Math.max(0, c.depth - 0.002) * 0.85;
  a.x -= (c.nx * correction * ia) / total;
  a.z -= (c.nz * correction * ia) / total;
  if (b) {
    b.x += (c.nx * correction * ib) / total;
    b.z += (c.nz * correction * ib) / total;
  }
  const av = pointVelocity(a, c.x, c.z),
    bv = b ? pointVelocity(b, c.x, c.z) : { x: 0, z: 0 };
  const speed = (av.x - bv.x) * c.nx + (av.z - bv.z) * c.nz;
  if (speed <= 0) return 0;
  const armA = (c.z - a.z) * c.nx - (c.x - a.x) * c.nz,
    armB = b ? (c.z - b.z) * c.nx - (c.x - b.x) * c.nz : 0;
  const j =
    ((1 + (speed > 2 ? 0.18 : 0)) * speed) /
    (total + armA ** 2 / inertia(a) + (b ? armB ** 2 / inertia(b) : 0));
  impulse(a, -c.nx * j, -c.nz * j, c.x, c.z);
  if (b) impulse(b, c.nx * j, c.nz * j, c.x, c.z);
  return speed;
}
/** Point test against a building footprint in its own (possibly rotated) frame. */
export function insideBuilding(b: Building, x: number, z: number, pad = 0) {
  const a = b.angle ?? 0,
    dx = x - b.x,
    dz = z - b.z;
  const u = dx * Math.cos(a) + dz * Math.sin(a),
    v = -dx * Math.sin(a) + dz * Math.cos(a);
  return Math.abs(u) < b.w / 2 + pad && Math.abs(v) < b.d / 2 + pad;
}

/** Stable pair order for authority and replay, with 6 m of contact-correction margin. */
export function collisionPairs(entities: Entity[]): [Entity, Entity][] {
  const byId = (a: Entity, b: Entity) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sorted = entities
    .filter((e) => !e.vehicle && (vehicle(e) || e.health > 0))
    .sort((a, b) => a.x - b.x || byId(a, b));
  const pairs: [Entity, Entity][] = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (b.x - a.x > 16) break;
      if (Math.abs(a.z - b.z) > 16 || Math.abs(a.y - b.y) > 1.8) continue;
      pairs.push(byId(a, b) < 0 ? [a, b] : [b, a]);
    }
  }
  return pairs.sort((a, b) => byId(a[0], b[0]) || byId(a[1], b[1]));
}
