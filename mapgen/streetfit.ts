import {
  add,
  closestOnSegment,
  dist,
  mul,
  pointInPolygon,
  selfIntersects,
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
