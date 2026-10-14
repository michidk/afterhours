export interface Point2 {
  x: number;
  z: number;
}
const cross = (a: Point2, b: Point2) => a.x * b.z - a.z * b.x;
const sub = (a: Point2, b: Point2): Point2 => ({ x: a.x - b.x, z: a.z - b.z });
export function signedArea2(poly: Point2[]) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    a += cross(poly[j], poly[i]);
  return a / 2;
}
/**
 * Ear-clipping triangulation of a simple polygon (any winding). Returns index
 * triples in counter-clockwise order; degenerate leftovers fall back to a fan.
 */
export function earClip(poly: Point2[]): [number, number, number][] {
  const n = poly.length;
  if (n < 3) return [];
  const idx = poly.map((_, i) => i);
  if (signedArea2(poly) < 0) idx.reverse();
  const tris: [number, number, number][] = [];
  const same = (p: Point2, q: Point2) =>
    Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.z - q.z) < 1e-6;
  const inTriangle = (p: Point2, a: Point2, b: Point2, c: Point2) =>
    cross(sub(b, a), sub(p, a)) >= -1e-9 &&
    cross(sub(c, b), sub(p, b)) >= -1e-9 &&
    cross(sub(a, c), sub(p, c)) >= -1e-9;
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length],
        ib = idx[i],
        ic = idx[(i + 1) % idx.length];
      const a = poly[ia],
        b = poly[ib],
        c = poly[ic];
      if (cross(sub(b, a), sub(c, b)) <= 1e-9) continue;
      let blocked = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const p = poly[j];
        if (same(p, a) || same(p, b) || same(p, c)) continue;
        if (inTriangle(p, a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      tris.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  for (let i = 1; i < idx.length - 1; i++) tris.push([idx[0], idx[i], idx[i + 1]]);
  return tris;
}
/** Even-odd test of a point against a simple polygon (any winding). */
export function pointInPolygon(p: Point2, poly: Point2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    if (
      poly[i].z > p.z !== poly[j].z > p.z &&
      p.x <
        ((poly[j].x - poly[i].x) * (p.z - poly[i].z)) / (poly[j].z - poly[i].z) +
          poly[i].x
    )
      inside = !inside;
  return inside;
}
