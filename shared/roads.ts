import type { Road, Building } from "./world.ts";
export interface Point {
  x: number;
  z: number;
}
export function roadDistance(p: Point, road: Road) {
  const dx = road.bx - road.ax,
    dz = road.bz - road.az;
  const t = Math.max(
    0,
    Math.min(1, ((p.x - road.ax) * dx + (p.z - road.az) * dz) / (dx * dx + dz * dz)),
  );
  return Math.hypot(p.x - road.ax - t * dx, p.z - road.az - t * dz);
}
/** Conservative segment vs expanded AABB, shared by offline clearance validation. */
export function roadIntersectsBox(
  road: Road,
  b: Pick<Building, "x" | "z" | "w" | "d">,
  clearance = 5,
) {
  const pad = road.width / 2 + clearance;
  let lo = 0,
    hi = 1;
  for (const [a, delta, min, max] of [
    [road.ax, road.bx - road.ax, b.x - b.w / 2 - pad, b.x + b.w / 2 + pad],
    [road.az, road.bz - road.az, b.z - b.d / 2 - pad, b.z + b.d / 2 + pad],
  ]) {
    if (Math.abs(delta) < 1e-8) {
      if (a < min || a > max) return false;
      continue;
    }
    const t0 = (min - a) / delta,
      t1 = (max - a) / delta;
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
    if (lo > hi) return false;
  }
  return true;
}
