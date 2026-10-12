import type { Point } from "./types.ts";

export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, z: a.z - b.z });
export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, z: a.z + b.z });
export const mul = (a: Point, s: number): Point => ({ x: a.x * s, z: a.z * s });
export const dot = (a: Point, b: Point) => a.x * b.x + a.z * b.z;
export const cross = (a: Point, b: Point) => a.x * b.z - a.z * b.x;
export const len = (a: Point) => Math.hypot(a.x, a.z);
export const norm = (a: Point): Point => {
  const l = len(a) || 1;
  return { x: a.x / l, z: a.z / l };
};
/** Left-hand perpendicular (counter-clockwise rotation by 90°). */
export const perp = (a: Point): Point => ({ x: -a.z, z: a.x });
export const lerpPoint = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  z: a.z + (b.z - a.z) * t,
});

/** Parameters (t, u) of the intersection of segments a→b and c→d, or undefined. */
export function segmentIntersection(a: Point, b: Point, c: Point, d: Point) {
  const r = sub(b, a),
    s = sub(d, c),
    denominator = cross(r, s);
  if (Math.abs(denominator) < 1e-9) return undefined;
  const qp = sub(c, a),
    t = cross(qp, s) / denominator,
    u = cross(qp, r) / denominator;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return undefined;
  return { t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)) };
}
/** Intersection of infinite lines p + t·r and q + u·s. */
export function lineIntersection(p: Point, r: Point, q: Point, s: Point) {
  const denominator = cross(r, s);
  if (Math.abs(denominator) < 1e-9) return undefined;
  const t = cross(sub(q, p), s) / denominator;
  return add(p, mul(r, t));
}
export function closestOnSegment(p: Point, a: Point, b: Point) {
  const ab = sub(b, a),
    l2 = dot(ab, ab);
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return { point: lerpPoint(a, b, t), t };
}
export const distanceToSegment = (p: Point, a: Point, b: Point) =>
  dist(p, closestOnSegment(p, a, b).point);
export function polylineLength(points: Point[]) {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += dist(points[i - 1], points[i]);
  return l;
}
/** Signed area; positive for counter-clockwise rings in the x/z plane. */
export function signedArea(poly: Point[]) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    a += cross(poly[j], poly[i]);
  return a / 2;
}
export const area = (poly: Point[]) => Math.abs(signedArea(poly));
export function centroid(poly: Point[]): Point {
  let x = 0,
    z = 0,
    a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = cross(poly[j], poly[i]);
    x += (poly[j].x + poly[i].x) * f;
    z += (poly[j].z + poly[i].z) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length;
    return {
      x: poly.reduce((s, p) => s + p.x, 0) / n,
      z: poly.reduce((s, p) => s + p.z, 0) / n,
    };
  }
  return { x: x / (3 * a), z: z / (3 * a) };
}
export function pointInPolygon(p: Point, poly: Point[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    )
      inside = !inside;
  }
  return inside;
}
/** Remove consecutive duplicates and collinear spikes. */
export function cleanRing(poly: Point[], epsilon = 0.05) {
  const out: Point[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > epsilon) out.push(p);
  }
  while (out.length > 1 && dist(out[0], out[out.length - 1]) <= epsilon) out.pop();
  for (let i = 0; i < out.length && out.length > 3;) {
    const a = out[(i + out.length - 1) % out.length],
      b = out[i],
      c = out[(i + 1) % out.length];
    const l = dist(a, c) || 1;
    if (Math.abs(cross(sub(b, a), sub(c, a))) / l < epsilon) out.splice(i, 1);
    else i++;
  }
  return out;
}
/**
 * Inset a simple polygon by moving every edge inward by `d` and intersecting
 * neighbouring edge lines. Vertices that would cross are collapsed; the result is
 * validated against collapsing to keep callers safe for convex-ish city blocks.
 */
export function insetPolygon(poly: Point[], d: number): Point[] | undefined {
  if (poly.length < 3) return undefined;
  const ccw = signedArea(poly) > 0;
  let ring = ccw ? [...poly] : [...poly].reverse();
  let out: Point[] = [];
  // Offset every edge and intersect neighbouring lines. Vertices whose offset edge
  // runs against its source edge (short edges that collapse under the inset) are
  // dropped and the offset is recomputed, which converges in at most n rounds.
  for (let round = 0; round < poly.length; round++) {
    const n = ring.length;
    if (n < 3) return undefined;
    out = [];
    for (let i = 0; i < n; i++) {
      const prev = ring[(i + n - 1) % n],
        cur = ring[i],
        next = ring[(i + 1) % n];
      const d0 = norm(sub(cur, prev)),
        d1 = norm(sub(next, cur));
      // Inward normal of a CCW ring is the left-hand perpendicular.
      const n0 = { x: -d0.z, z: d0.x },
        n1 = { x: -d1.z, z: d1.x };
      const p0 = add(cur, mul(n0, d)),
        p1 = add(cur, mul(n1, d));
      const hit = lineIntersection(p0, d0, p1, d1);
      if (!hit) {
        out.push(p0);
        continue;
      }
      // Very sharp corners produce far-off mitres; clamp them along the bisector.
      const limit = d * 2.5;
      if (dist(hit, cur) > limit) out.push(add(cur, mul(norm(sub(hit, cur)), limit)));
      else out.push(hit);
    }
    let reversed = -1;
    for (let i = 0; i < n; i++) {
      const dir = sub(ring[(i + 1) % n], ring[i]);
      const a = out[i],
        b = out[(i + 1) % n];
      if ((b.x - a.x) * dir.x + (b.z - a.z) * dir.z <= 1e-6) {
        reversed = i;
        break;
      }
    }
    if (reversed < 0) break;
    // Drop the endpoint of the collapsed edge that has the shorter neighbour edge.
    const i = reversed,
      j = (i + 1) % n;
    const before = dist(ring[(i + n - 1) % n], ring[i]),
      after = dist(ring[j], ring[(j + 1) % n]);
    ring.splice(before < after ? i : j, 1);
  }
  const cleaned = cleanRing(out, 0.05);
  if (cleaned.length < 3) return undefined;
  const result = ccw ? cleaned : cleaned.reverse();
  if (signedArea(result) * signedArea(poly) <= 0) return undefined;
  if (area(result) >= area(poly)) return undefined;
  // Reject self-intersection created by over-inset of thin regions.
  if (selfIntersects(result)) return undefined;
  return result;
}
export function selfIntersects(poly: Point[]) {
  const n = poly.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentIntersection(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n]))
        return true;
    }
  return false;
}
/** Minimum-area oriented bounding box using every edge direction as a candidate. */
export function orientedBox(poly: Point[]) {
  let best:
    { angle: number; w: number; d: number; centre: Point; area: number } | undefined;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    const angle = Math.atan2(b.z - a.z, b.x - a.x),
      c = Math.cos(-angle),
      s = Math.sin(-angle);
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const p of poly) {
      const x = p.x * c - p.z * s,
        z = p.x * s + p.z * c;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    const w = maxX - minX,
      d = maxZ - minZ,
      areaBox = w * d;
    if (!best || areaBox < best.area) {
      const mx = (minX + maxX) / 2,
        mz = (minZ + maxZ) / 2;
      const cc = Math.cos(angle),
        ss = Math.sin(angle);
      best = {
        angle,
        w,
        d,
        area: areaBox,
        centre: { x: mx * cc - mz * ss, z: mx * ss + mz * cc },
      };
    }
  }
  return best!;
}
/** Split a polygon by an infinite line through `p` with direction `dir`. */
export function splitPolygon(poly: Point[], p: Point, dir: Point): [Point[], Point[]] {
  const n = { x: -dir.z, z: dir.x },
    left: Point[] = [],
    right: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    const sa = dot(sub(a, p), n),
      sb = dot(sub(b, p), n);
    if (sa >= 0) left.push(a);
    if (sa <= 0) right.push(a);
    if ((sa > 0 && sb < 0) || (sa < 0 && sb > 0)) {
      const t = sa / (sa - sb),
        hit = lerpPoint(a, b, t);
      left.push(hit);
      right.push(hit);
    }
  }
  return [cleanRing(left), cleanRing(right)];
}
export function rotatedRect(
  centre: Point,
  w: number,
  d: number,
  angle: number,
): Point[] {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ].map(([x, z]) => ({ x: centre.x + x * c - z * s, z: centre.z + x * s + z * c }));
}
/** Separating-axis test for two convex polygons. */
export function convexOverlap(a: Point[], b: Point[]) {
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const edge = sub(poly[(i + 1) % poly.length], poly[i]),
        axis = { x: -edge.z, z: edge.x };
      let minA = Infinity,
        maxA = -Infinity,
        minB = Infinity,
        maxB = -Infinity;
      for (const p of a) {
        const v = dot(p, axis);
        minA = Math.min(minA, v);
        maxA = Math.max(maxA, v);
      }
      for (const p of b) {
        const v = dot(p, axis);
        minB = Math.min(minB, v);
        maxB = Math.max(maxB, v);
      }
      if (maxA < minB || maxB < minA) return false;
    }
  return true;
}
/** Uniform-grid spatial hash for cheap neighbourhood queries. */
export class SpatialHash<T extends Point> {
  private cells = new Map<string, T[]>();
  constructor(private cell: number) {}
  private key = (x: number, z: number) =>
    `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  insert(item: T) {
    const k = this.key(item.x, item.z),
      list = this.cells.get(k);
    if (list) list.push(item);
    else this.cells.set(k, [item]);
  }
  near(x: number, z: number, radius: number): T[] {
    const out: T[] = [],
      r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell),
      cz = Math.floor(z / this.cell);
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++) {
        const list = this.cells.get(`${cx + i},${cz + j}`);
        if (list) for (const item of list) out.push(item);
      }
    return out;
  }
}
export { earClip } from "../shared/polygon.ts";
