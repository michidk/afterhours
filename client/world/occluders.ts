type P = { x: number; y: number; z: number };
/** Does segment a→b pass within `pad` of the axis-aligned box [min, max]? (slab test) */
export function segmentHitsBox(a: P, b: P, min: P, max: P, pad = 0) {
  let t0 = 0,
    t1 = 1;
  for (const axis of ["x", "y", "z"] as const) {
    const d = b[axis] - a[axis],
      lo = min[axis] - pad - a[axis],
      hi = max[axis] + pad - a[axis];
    if (Math.abs(d) < 1e-9) {
      if (lo > 0 || hi < 0) return false;
      continue;
    }
    const n = Math.min(lo / d, hi / d),
      f = Math.max(lo / d, hi / d);
    t0 = Math.max(t0, n);
    t1 = Math.min(t1, f);
    if (t0 > t1) return false;
  }
  return true;
}

/** The solid volume of a building: a rotated footprint standing from `y` up to the roof `h`. */
export type Footprint = {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  y?: number;
  angle?: number;
};
/**
 * Does the sight line a→b pass through the building, or within `pad` of it? The segment is
 * moved into the footprint's own frame (the one `insideBuilding` uses for collision), so a
 * rotated lot is tested as the rectangle it is, not as its larger axis-aligned bounds.
 */
export function segmentHitsBuilding(a: P, b: P, building: Footprint, pad = 0) {
  const angle = building.angle ?? 0,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  const local = (p: P): P => {
    const dx = p.x - building.x,
      dz = p.z - building.z;
    return { x: dx * cos + dz * sin, y: p.y, z: -dx * sin + dz * cos };
  };
  return segmentHitsBox(
    local(a),
    local(b),
    { x: -building.w / 2, y: building.y ?? -1e6, z: -building.d / 2 },
    { x: building.w / 2, y: building.h, z: building.d / 2 },
    pad,
  );
}
