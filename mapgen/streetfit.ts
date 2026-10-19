import {
  add,
  closestOnSegment,
  dist,
  mul,
  pointInPolygon,
  selfIntersects,
  signedArea,
} from "./geom.ts";
import { earClip } from "../shared/polygon.ts";
import type { Point, RoadEdge, RoadGeometry, RoadGraph } from "./types.ts";

/**
 * A square height grid matching the game terrain mesh: `side` points per row,
 * `step` metres apart, centred on the origin (`half` metres to each edge), with
 * each cell split along its (x+1, z)–(x, z+1) diagonal.
 */
export interface TerrainGrid {
  heights: { length: number; [index: number]: number };
  side: number;
  step: number;
  half: number;
}

/** Height of a road surface point from the nearest profile sample of its edge. */
export function edgeHeightAt(e: RoadEdge, p: Point) {
  let best = Infinity,
    y = e.heights[0] ?? 0;
  for (let i = 1; i < e.points.length; i++) {
    const { point, t } = closestOnSegment(p, e.points[i - 1], e.points[i]);
    const d = dist(point, p);
    if (d < best) {
      best = d;
      y = e.heights[i - 1] + (e.heights[i] - e.heights[i - 1]) * t;
    }
  }
  return y;
}

/**
 * The terrain mesh interpolates a coarse grid, so between grid points its triangles
 * can rise through street polygons that the road stamp kept clear only at the grid
 * points. Terrain minus street height is linear wherever a street triangle overlaps
 * a terrain triangle, so it peaks at a corner of such an overlap: a street corner, a
 * grid point inside the street triangle, or where a street edge crosses a grid line
 * or cell diagonal. Each such sample whose terrain lies above the drawn surface
 * lowers its terrain triangle's corners by the least change that clears it,
 * repeated until no sample is violated. Grid points
 * under a street already carry its height and are what vehicles drive on, so the
 * change goes almost entirely to the corners beside the street, none of which sinks
 * more than half a metre below the lowest street surface it supports. Grid points
 * under a building or the airfield keep their pad.
 */
export function sinkUnderStreets(
  grid: TerrainGrid,
  layers: { polygons: number[][]; top: number }[],
  pads: { x: number; z: number; w: number; d: number; y?: number; angle?: number }[],
) {
  const heights = grid.heights;
  const CLEARANCE = 0.06,
    corners: number[] = [],
    weights: number[] = [],
    limits: number[] = [],
    give = new Float32Array(heights.length).fill(1);
  const constrain = (x: number, z: number, y: number) => {
    const gx = (x + grid.half) / grid.step,
      gz = (z + grid.half) / grid.step;
    if (gx < 0 || gz < 0 || gx > grid.side - 1 || gz > grid.side - 1) return;
    const ix = Math.min(grid.side - 2, Math.floor(gx)),
      iz = Math.min(grid.side - 2, Math.floor(gz)),
      u = gx - ix,
      v = gz - iz,
      i = iz * grid.side + ix;
    // Same triangle split as shared/terrain.ts.
    if (u + v <= 1) {
      corners.push(i, i + 1, i + grid.side);
      weights.push(1 - u - v, u, v);
    } else {
      corners.push(i + grid.side + 1, i + grid.side, i + 1);
      weights.push(u + v - 1, 1 - u, 1 - v);
    }
    limits.push(y - CLEARANCE);
  };
  for (const { polygons, top } of layers)
    for (const flat of polygons) {
      const p: { x: number; y: number; z: number }[] = [];
      for (let i = 0; i < flat.length; i += 3)
        p.push({ x: flat[i], y: flat[i + 1] + top, z: flat[i + 2] });
      for (const [a, b, c] of earClip(p)) {
        const A = p[a],
          B = p[b],
          C = p[c];
        const x0 = Math.max(
            0,
            Math.floor((Math.min(A.x, B.x, C.x) + grid.half) / grid.step),
          ),
          x1 = Math.min(
            grid.side - 1,
            Math.ceil((Math.max(A.x, B.x, C.x) + grid.half) / grid.step),
          ),
          z0 = Math.max(
            0,
            Math.floor((Math.min(A.z, B.z, C.z) + grid.half) / grid.step),
          ),
          z1 = Math.min(
            grid.side - 1,
            Math.ceil((Math.max(A.z, B.z, C.z) + grid.half) / grid.step),
          );
        const side = (p: { x: number; z: number }, q: typeof A, r: typeof A) =>
          (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
        for (let gz = z0; gz <= z1; gz++)
          for (let gx = x0; gx <= x1; gx++) {
            const g = { x: gx * grid.step - grid.half, z: gz * grid.step - grid.half },
              s1 = side(g, A, B),
              s2 = side(g, B, C),
              s3 = side(g, C, A);
            const total = s1 + s2 + s3;
            if (
              Math.abs(total) < 1e-9 ||
              !((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0))
            )
              continue;
            give[gz * grid.side + gx] = 1e-4;
            constrain(g.x, g.z, (C.y * s1 + A.y * s2 + B.y * s3) / total);
          }
        for (const P of [A, B, C]) constrain(P.x, P.z, P.y);
        for (const [P, Q] of [
          [A, B],
          [B, C],
          [C, A],
        ]) {
          const cell = (q: typeof A) => [
            (q.x + grid.half) / grid.step,
            (q.z + grid.half) / grid.step,
          ];
          const [px, pz] = cell(P),
            [qx, qz] = cell(Q);
          for (const [from, to] of [
            [px, qx],
            [pz, qz],
            [px + pz, qx + qz],
          ])
            for (
              let k = Math.ceil(Math.min(from, to));
              k <= Math.floor(Math.max(from, to));
              k++
            ) {
              const t = (k - from) / (to - from);
              if (t > 0 && t < 1)
                constrain(
                  P.x + (Q.x - P.x) * t,
                  P.z + (Q.z - P.z) * t,
                  P.y + (Q.y - P.y) * t,
                );
            }
        }
      }
    }
  const floor = new Float32Array(heights.length).fill(Infinity);
  for (let k = 0; k < limits.length; k++)
    for (let m = 0; m < 3; m++) {
      const v = corners[k * 3 + m];
      floor[v] = Math.min(floor[v], limits[k] - 0.5);
    }
  for (const b of pads) {
    const c = Math.cos(b.angle ?? 0),
      s = Math.sin(b.angle ?? 0),
      reach = Math.hypot(b.w, b.d) / 2 + 2;
    for (
      let gz = Math.max(0, Math.floor((b.z - reach + grid.half) / grid.step));
      gz <= Math.min(grid.side - 1, Math.ceil((b.z + reach + grid.half) / grid.step));
      gz++
    )
      for (
        let gx = Math.max(0, Math.floor((b.x - reach + grid.half) / grid.step));
        gx <= Math.min(grid.side - 1, Math.ceil((b.x + reach + grid.half) / grid.step));
        gx++
      ) {
        const dx = gx * grid.step - grid.half - b.x,
          dz = gz * grid.step - grid.half - b.z;
        if (
          Math.abs(dx * c + dz * s) > b.w / 2 + 2 ||
          Math.abs(-dx * s + dz * c) > b.d / 2 + 2
        )
          continue;
        const v = gz * grid.side + gx;
        give[v] = 1e-4;
        floor[v] = Math.min(floor[v], (b.y ?? heights[v]) - 0.3);
      }
  }
  for (let v = 0; v < heights.length; v++) floor[v] = Math.min(floor[v], heights[v]);
  // Ground falling away beside a street is pulled up by its free corners (beside the
  // street, not under it or a pad) until it lies at most SAG below the surface;
  // concrete under the street hides the rest. Sinking always wins: raising stops
  // after RAISE passes, and a far corner with little weight is left to the concrete
  // because it would have to rise steeply and would push through other streets.
  const SAG = 0.35,
    RAISE = 200;
  for (let pass = 0; pass < RAISE + 400; pass++) {
    let worst = 0,
      sag = 0;
    for (let k = 0; k < limits.length; k++) {
      const c = k * 3;
      let h = 0,
        norm = 0,
        free = 0,
        freeNorm = 0;
      for (let m = 0; m < 3; m++) {
        const v = corners[c + m],
          w = weights[c + m];
        h += w * heights[v];
        if (heights[v] > floor[v]) norm += give[v] * w ** 2;
        if (give[v] === 1) {
          free += w;
          freeNorm += w ** 2;
        }
      }
      const excess = h - limits[k];
      if (excess > 0) {
        if (norm <= 0) continue;
        worst = Math.max(worst, excess);
        for (let m = 0; m < 3; m++) {
          const v = corners[c + m];
          if (heights[v] > floor[v])
            heights[v] = Math.max(
              floor[v],
              heights[v] - (give[v] * weights[c + m] * excess) / norm,
            );
        }
        continue;
      }
      const deficit = -excess - SAG;
      if (pass >= RAISE || deficit <= 0 || free < 0.3) continue;
      sag = Math.max(sag, deficit);
      for (let m = 0; m < 3; m++) {
        const v = corners[c + m];
        if (give[v] === 1) heights[v] += (weights[c + m] * deficit) / freeNorm;
      }
    }
    if (worst < 0.002 && (pass >= RAISE || sag < 0.01)) break;
  }
}

/**
 * Flat [x, y, z, ...] polygons cut along the terrain mesh's triangles, as pieces
 * that each lie in one of them with every corner at the terrain height. A street
 * draped this way is exactly the ground that people and vehicles move on, so it
 * can neither float over a dip between grid points nor be crossed by the terrain.
 * Convex polygons are clipped whole, others per ear-clipped triangle; neighbouring
 * pieces in one terrain triangle are then merged while they stay simple. Ground
 * covered by any `avoid` polygon is left out, so a sidewalk never lies on asphalt.
 */
export function drapeOnTerrain(
  polygons: number[][],
  grid: TerrainGrid,
  avoid: number[][] = [],
): number[][] {
  const groups = new Map<number, number[][]>(),
    { step, side, half, heights: h } = grid;
  // Triangles to leave out, in grid-cell units, listed under each cell they touch.
  const avoided = new Map<number, Point[][]>();
  for (const flat of avoid) {
    const points: Point[] = [];
    for (let i = 0; i < flat.length; i += 3)
      points.push({ x: (flat[i] + half) / step, z: (flat[i + 2] + half) / step });
    for (const t of earClip(points)) {
      const tri = t.map((i) => points[i]);
      for (
        let iz = Math.max(0, Math.floor(Math.min(...tri.map((q) => q.z))));
        iz <= Math.min(side - 2, Math.floor(Math.max(...tri.map((q) => q.z))));
        iz++
      )
        for (
          let ix = Math.max(0, Math.floor(Math.min(...tri.map((q) => q.x))));
          ix <= Math.min(side - 2, Math.floor(Math.max(...tri.map((q) => q.x))));
          ix++
        ) {
          const k = iz * side + ix;
          if (avoided.has(k)) avoided.get(k)!.push(tri);
          else avoided.set(k, [tri]);
        }
    }
  }
  for (const flat of polygons) {
    const points: Point[] = [];
    for (let i = 0; i < flat.length; i += 3)
      points.push({ x: flat[i], z: flat[i + 2] });
    const parts = convex(points)
      ? [points]
      : earClip(points).map((t) => t.map((i) => points[i]));
    for (const part of parts) {
      const xs = part.map((p) => (p.x + half) / step),
        zs = part.map((p) => (p.z + half) / step);
      const x0 = Math.max(0, Math.floor(Math.min(...xs))),
        x1 = Math.min(side - 2, Math.floor(Math.max(...xs))),
        z0 = Math.max(0, Math.floor(Math.min(...zs))),
        z1 = Math.min(side - 2, Math.floor(Math.max(...zs)));
      for (let iz = z0; iz <= z1; iz++)
        for (let ix = x0; ix <= x1; ix++)
          for (const upper of [false, true]) {
            // Same triangle split as shared/terrain.ts, in cell units u, v.
            const toCell = (p: Point) => ({
              x: (p.x + half) / step - ix,
              z: (p.z + half) / step - iz,
            });
            let piece = part.map(toCell);
            for (const inside of upper
              ? [
                  (q: Point) => 1 - q.x,
                  (q: Point) => 1 - q.z,
                  (q: Point) => q.x + q.z - 1,
                ]
              : [(q: Point) => q.x, (q: Point) => q.z, (q: Point) => 1 - q.x - q.z])
              piece = clip(piece, inside);
            const i = iz * side + ix,
              y = (q: Point) =>
                upper
                  ? h[i + side + 1] +
                    (1 - q.x) * (h[i + side] - h[i + side + 1]) +
                    (1 - q.z) * (h[i + 1] - h[i + side + 1])
                  : h[i] + q.x * (h[i + 1] - h[i]) + q.z * (h[i + side] - h[i]);
            let pieces = [piece];
            for (const t of avoided.get(i) ?? []) {
              pieces = pieces.flatMap((p) =>
                subtractTriangle(
                  p,
                  t.map((q) => ({ x: q.x - ix, z: q.z - iz })),
                ),
              );
              if (!pieces.length) break;
            }
            for (let sub of pieces) {
              // A corner on a grid point is cut by several lines and comes out repeated.
              sub = sub.filter((q, k) => {
                const r = sub[(k + 1) % sub.length];
                return Math.hypot((r.x - q.x) * step, (r.z - q.z) * step) > 1e-6;
              });
              // Pieces left beside an avoided triangle can be hairline slivers.
              if (
                sub.length < 3 ||
                Math.abs(signedArea(sub)) * step * step < (avoided.has(i) ? 2e-3 : 1e-4)
              )
                continue;
              // Counter-clockwise in x, z, so pieces sharing an edge run it oppositely.
              if (signedArea(sub) < 0) sub.reverse();
              const id = i * 2 + +upper,
                flat = sub.flatMap((q) => [
                  (q.x + ix) * step - half,
                  y(q),
                  (q.z + iz) * step - half,
                ]);
              if (groups.has(id)) groups.get(id)!.push(flat);
              else groups.set(id, [flat]);
            }
          }
    }
  }
  let rings = [...groups.values()].flatMap(mergePieces);
  if (avoid.length) {
    // Cutting asphalt out can strand small shards that touch nothing else.
    const holders = new Map<string, number>();
    for (const ring of rings)
      for (let i = 0; i < ring.length; i += 3) {
        const key = cornerKey(ring, i);
        holders.set(key, (holders.get(key) ?? 0) + 1);
      }
    rings = rings.filter((ring) => {
      let area = 0,
        shared = false;
      for (let i = 0; i < ring.length; i += 3) {
        const j = (i + 3) % ring.length;
        area += ring[i] * ring[j + 2] - ring[j] * ring[i + 2];
        shared ||= holders.get(cornerKey(ring, i))! > 1;
      }
      return shared || Math.abs(area) / 2 > 1.5;
    });
  }
  // A corner can go only where every ring holding it runs straight through it:
  // dropping it anywhere else would leave a T-junction that opens once rounded.
  const needed = new Set<string>();
  for (const ring of rings)
    eachCorner(ring, (key, straight) => straight || needed.add(key));
  return closeTJunctions(
    weldCorners(
      rings.map((ring) => {
        const out: number[] = [];
        eachCorner(
          ring,
          (key, _, i) => needed.has(key) && out.push(...ring.slice(i, i + 3)),
        );
        return out;
      }),
    ),
  );
}
/**
 * Moves corners lying within 1.5 cm of an earlier one onto it. Pieces cut from
 * differently rounded source polygons meet a centimetre apart, which would leave
 * a hairline crack through which the terrain shows.
 */
function weldCorners(rings: number[][]) {
  const TOLERANCE = 0.015,
    CELL = 0.02,
    seen = new Map<string, number[][]>();
  const cell = (v: number) => Math.floor(v / CELL);
  return rings.flatMap((ring) => {
    const out: number[] = [];
    for (let i = 0; i < ring.length; i += 3) {
      const cx = cell(ring[i]),
        cz = cell(ring[i + 2]);
      let at: number[] | undefined;
      for (let dx = -1; dx <= 1 && !at; dx++)
        for (let dz = -1; dz <= 1 && !at; dz++)
          at = seen
            .get(`${cx + dx},${cz + dz}`)
            ?.find((c) => Math.hypot(c[0] - ring[i], c[1] - ring[i + 2]) <= TOLERANCE);
      const x = at?.[0] ?? ring[i],
        z = at?.[1] ?? ring[i + 2];
      if (!at) {
        const key = `${cx},${cz}`;
        if (seen.has(key)) seen.get(key)!.push([x, z]);
        else seen.set(key, [[x, z]]);
      }
      // Corners welded together leave a zero-length edge.
      if (out.length >= 3 && out[out.length - 3] === x && out[out.length - 1] === z)
        continue;
      out.push(x, ring[i + 1], z);
    }
    if (
      out.length >= 6 &&
      out[0] === out[out.length - 3] &&
      out[2] === out[out.length - 1]
    )
      out.length -= 3;
    return out.length >= 9 ? [out] : [];
  });
}
/**
 * Adds every corner that lies on another ring's edge to that edge, so neighbouring
 * pieces share all their vertices and no hairline crack can open between them.
 */
function closeTJunctions(rings: number[][]) {
  const CELL = 2,
    corners = new Map<string, number[][]>();
  const cellKey = (x: number, z: number) =>
    `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  for (const ring of rings)
    for (let i = 0; i < ring.length; i += 3) {
      const k = cellKey(ring[i], ring[i + 2]),
        corner = ring.slice(i, i + 3);
      if (corners.has(k)) corners.get(k)!.push(corner);
      else corners.set(k, [corner]);
    }
  return rings.map((ring) => {
    const n = ring.length / 3,
      out: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = ring.slice(i * 3, i * 3 + 3),
        b = ring.slice(((i + 1) % n) * 3, ((i + 1) % n) * 3 + 3),
        ux = b[0] - a[0],
        uz = b[2] - a[2],
        length = Math.hypot(ux, uz);
      out.push(...a);
      if (length < 0.02) continue;
      const found = new Map<string, { t: number; corner: number[] }>();
      for (
        let cx = Math.floor(Math.min(a[0], b[0]) / CELL);
        cx <= Math.floor(Math.max(a[0], b[0]) / CELL);
        cx++
      )
        for (
          let cz = Math.floor(Math.min(a[2], b[2]) / CELL);
          cz <= Math.floor(Math.max(a[2], b[2]) / CELL);
          cz++
        )
          for (const c of corners.get(`${cx},${cz}`) ?? []) {
            const t = ((c[0] - a[0]) * ux + (c[2] - a[2]) * uz) / length ** 2;
            if (t * length < 0.01 || (1 - t) * length < 0.01) continue;
            if (Math.abs((c[0] - a[0]) * uz - (c[2] - a[2]) * ux) / length > 0.01)
              continue;
            found.set(cornerKey(c, 0), { t, corner: c });
          }
      for (const { corner } of [...found.values()].sort((p, q) => p.t - q.t))
        out.push(...corner);
    }
    return out;
  });
}
/** Greedily joins coplanar pieces across shared edges while the union stays simple. */
function mergePieces(pieces: number[][]) {
  const key = (f: number[], i: number) =>
    `${Math.round(f[i * 3] * 100)},${Math.round(f[i * 3 + 2] * 100)}`;
  const union = (a: number[], b: number[]) => {
    const n = a.length / 3,
      m = b.length / 3;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < m; j++) {
        if (key(a, i) !== key(b, (j + 1) % m) || key(a, (i + 1) % n) !== key(b, j))
          continue;
        // a from its edge end q round to p, then b's corners strictly between p and q.
        const out: number[] = [];
        for (let k = 1; k <= n; k++)
          out.push(...a.slice(((i + k) % n) * 3, ((i + k) % n) * 3 + 3));
        for (let k = 2; k < m; k++)
          out.push(...b.slice(((j + k) % m) * 3, ((j + k) % m) * 3 + 3));
        const ring = out;
        if (ring.length < 9) return undefined;
        const points: Point[] = [];
        for (let k = 0; k < ring.length; k += 3)
          points.push({ x: ring[k], z: ring[k + 2] });
        // Coplanar, so any simple polygon triangulates exactly; a corner visited
        // twice would pinch it.
        const keys = new Set(
          points.map((q) => `${Math.round(q.x * 100)},${Math.round(q.z * 100)}`),
        );
        return keys.size === points.length && !selfIntersects(points)
          ? ring
          : undefined;
      }
    return undefined;
  };
  for (let merged = true; merged;) {
    merged = false;
    search: for (let a = 0; a < pieces.length; a++)
      for (let b = a + 1; b < pieces.length; b++) {
        const joined = union(pieces[a], pieces[b]);
        if (!joined) continue;
        pieces[a] = joined;
        pieces.splice(b, 1);
        merged = true;
        break search;
      }
  }
  return pieces;
}
/**
 * Whole centimetres, rounded the same way for every piece: a corner lying exactly
 * on a half centimetre would otherwise round either way depending on float noise,
 * and neighbouring pieces would end up a centimetre apart.
 */
export const snapCm = (v: number) => Math.round(v * 100 + 1e-4) / 100 + 0;
const cornerKey = (flat: number[], i: number) =>
  `${Math.round(snapCm(flat[i]) * 100)},${Math.round(snapCm(flat[i + 2]) * 100)}`;
/** Visits each corner (flat index `i`) with whether its ring runs straight through it. */
function eachCorner(
  flat: number[],
  visit: (key: string, straight: boolean, i: number) => unknown,
) {
  const n = flat.length / 3;
  for (let k = 0; k < n; k++) {
    const a = ((k + n - 1) % n) * 3,
      b = k * 3,
      c = ((k + 1) % n) * 3,
      turn =
        (flat[b] - flat[a]) * (flat[c + 2] - flat[b + 2]) -
        (flat[b + 2] - flat[a + 2]) * (flat[c] - flat[b]);
    visit(cornerKey(flat, b), Math.abs(turn) < 1e-6, b);
  }
}
/** Separating-axis test: whether two convex polygons share no area. */
function apart(a: Point[], b: Point[]) {
  const EPS = 1e-9;
  for (const [p, q] of [
    [a, b],
    [b, a],
  ])
    for (let i = 0; i < p.length; i++) {
      const u = p[i],
        v = p[(i + 1) % p.length],
        length = Math.hypot(v.z - u.z, u.x - v.x);
      // A repeated corner has no direction, so it cannot separate anything.
      if (length < 1e-12) continue;
      const nx = (v.z - u.z) / length,
        nz = (u.x - v.x) / length;
      let lo = Infinity,
        hi = -Infinity,
        lo2 = Infinity,
        hi2 = -Infinity;
      for (const w of p) {
        const d = nx * w.x + nz * w.z;
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
      for (const w of q) {
        const d = nx * w.x + nz * w.z;
        lo2 = Math.min(lo2, d);
        hi2 = Math.max(hi2, d);
      }
      if (hi < lo2 + EPS || hi2 < lo + EPS) return true;
    }
  return false;
}
/** The part of a polygon outside a triangle, as convex pieces (the polygon must be convex). */
function subtractTriangle(polygon: Point[], tri: Point[]): Point[][] {
  const edge = (a: Point, b: Point, q: Point) =>
    (b.x - a.x) * (q.z - a.z) - (b.z - a.z) * (q.x - a.x);
  const centre = {
    x: (tri[0].x + tri[1].x + tri[2].x) / 3,
    z: (tri[0].z + tri[1].z + tri[2].z) / 3,
  };
  const sign = Math.sign(edge(tri[0], tri[1], centre));
  if (!sign || apart(polygon, tri)) return [polygon];
  const out: Point[][] = [];
  let rest = polygon;
  for (let k = 0; k < 3 && rest.length >= 3; k++) {
    const a = tri[k],
      b = tri[(k + 1) % 3];
    const outside = clip(rest, (q) => -sign * edge(a, b, q));
    if (outside.length >= 3) out.push(outside);
    rest = clip(rest, (q) => sign * edge(a, b, q));
  }
  return out;
}
/** Sutherland–Hodgman: the part of a polygon where `inside` is non-negative. */
function clip(polygon: Point[], inside: (p: Point) => number) {
  const out: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length],
      da = inside(a),
      db = inside(b);
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}
function convex(polygon: Point[]) {
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length],
      c = polygon[(i + 2) % polygon.length],
      turn = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(turn) < 1e-9) continue;
    if (sign && Math.sign(turn) !== sign) return false;
    sign = Math.sign(turn);
  }
  return true;
}

/**
 * Street surfaces as flat [x, y, z, ...] polygons at their profile heights: band
 * and kerb-strip quads per centreline step (so no triangle spans a slope), junction
 * rings, and junction sidewalk pieces.
 */
export function streetPolygons(graph: RoadGraph, geometry: RoadGeometry) {
  const flat = (points: Point[], y: (p: Point) => number) =>
    points.flatMap((p) => [p.x, y(p), p.z]);
  const asphalt: number[][] = [],
    sidewalks: number[][] = [];
  /** Edge polygons are `[...left, ...right reversed]` with equal halves. */
  const quads = (polygon: Point[], e: RoadEdge, out: number[][]) => {
    const n = polygon.length / 2;
    if (polygon.length % 2 || n < 2) {
      out.push(flat(polygon, (p) => edgeHeightAt(e, p)));
      return;
    }
    for (let i = 1; i < n; i++) {
      const quad = [
        polygon[i - 1],
        polygon[i],
        polygon[2 * n - 1 - i],
        polygon[2 * n - i],
      ];
      // Edges crossing on a tight bend would fold the quad; order it around its middle.
      if (selfIntersects(quad)) {
        const c = mul(quad.reduce(add, { x: 0, z: 0 }), 0.25);
        quad.sort(
          (a, b) => Math.atan2(a.z - c.z, a.x - c.x) - Math.atan2(b.z - c.z, b.x - c.x),
        );
      }
      out.push(flat(quad, (p) => edgeHeightAt(e, p)));
    }
  };
  for (const band of geometry.bands)
    quads(band.polygon, graph.edges[band.edge], asphalt);
  for (const j of geometry.junctions)
    asphalt.push(flat(j.polygon, () => graph.nodes[j.node].y));
  for (const s of geometry.sidewalks)
    if (s.node !== undefined)
      sidewalks.push(flat(s.polygon, () => graph.nodes[s.node!].y));
    else quads(s.polygon, graph.edges[s.edge!], sidewalks);
  return { asphalt, sidewalks };
}

/**
 * Whether a point lies on asphalt (a band or junction) or within `margin` metres of
 * it, using a coarse grid of polygon bounds.
 */
export function streetTest(geometry: RoadGeometry, margin = 0.25) {
  const cell = 32,
    grid = new Map<string, Point[][]>();
  for (const polygon of [
    ...geometry.bands.map((b) => b.polygon),
    ...geometry.junctions.map((j) => j.polygon),
  ]) {
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const p of polygon) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      z0 = Math.min(z0, p.z);
      z1 = Math.max(z1, p.z);
    }
    for (
      let x = Math.floor((x0 - margin) / cell);
      x <= Math.floor((x1 + margin) / cell);
      x++
    )
      for (
        let z = Math.floor((z0 - margin) / cell);
        z <= Math.floor((z1 + margin) / cell);
        z++
      ) {
        const key = `${x},${z}`,
          list = grid.get(key);
        if (list) list.push(polygon);
        else grid.set(key, [polygon]);
      }
  }
  return (p: Point) =>
    [
      p,
      { x: p.x + margin, z: p.z },
      { x: p.x - margin, z: p.z },
      { x: p.x, z: p.z + margin },
      { x: p.x, z: p.z - margin },
    ].some((q) =>
      (grid.get(`${Math.floor(q.x / cell)},${Math.floor(q.z / cell)}`) ?? []).some(
        (polygon) => pointInPolygon(q, polygon),
      ),
    );
}
