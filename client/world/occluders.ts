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
