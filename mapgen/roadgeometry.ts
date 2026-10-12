import { sample } from "./field.ts";
import {
  add,
  dist,
  dot,
  lerpPoint,
  lineIntersection,
  mul,
  norm,
  perp,
  sub,
} from "./geom.ts";
import { smoothstep } from "./random.ts";
import type {
  Bridge,
  HeightField,
  Point,
  RoadEdge,
  RoadGeometry,
  RoadGraph,
  RoadKind,
} from "./types.ts";

export const SIDEWALK = 2.5;
const CURB_RADIUS: Record<RoadKind, number> = {
  highway: 14,
  avenue: 11,
  street: 7,
  lane: 4,
};
const LANES: Record<RoadKind, number> = { highway: 4, avenue: 4, street: 2, lane: 2 };
const RANK: Record<RoadKind, number> = { highway: 3, avenue: 2, street: 1, lane: 0 };

/* ------------------------------------------------------------ centrelines */

/** Douglas–Peucker simplification keeping both endpoints. */
export function simplifyPolyline(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = 0,
      index = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distanceToLine(points[i], points[a], points[b]);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index >= 0 && worst > tolerance) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
function distanceToLine(p: Point, a: Point, b: Point) {
  const ab = sub(b, a),
    l = Math.hypot(ab.x, ab.z) || 1;
  return Math.abs(ab.x * (p.z - a.z) - ab.z * (p.x - a.x)) / l;
}
/**
 * Centripetal Catmull–Rom through the control points, sampled every `step` metres.
 * End tangents follow the end chords so arms enter junctions straight.
 */
export function catmullRom(points: Point[], step: number): Point[] {
  if (points.length < 3) return points;
  const p = [
    sub(mul(points[0], 2), points[1]),
    ...points,
    sub(mul(points[points.length - 1], 2), points[points.length - 2]),
  ];
  const out: Point[] = [points[0]];
  const alpha = 0.5;
  const knot = (a: Point, b: Point) => Math.pow(Math.max(dist(a, b), 1e-4), alpha);
  for (let i = 1; i < p.length - 2; i++) {
    const p0 = p[i - 1],
      p1 = p[i],
      p2 = p[i + 1],
      p3 = p[i + 2];
    const t0 = 0,
      t1 = t0 + knot(p0, p1),
      t2 = t1 + knot(p1, p2),
      t3 = t2 + knot(p2, p3);
    const samples = Math.max(1, Math.ceil(dist(p1, p2) / step));
    for (let s = 1; s <= samples; s++) {
      const t = t1 + ((t2 - t1) * s) / samples;
      const a1 = lerpPoint(p0, p1, (t - t0) / (t1 - t0)),
        a2 = lerpPoint(p1, p2, (t - t1) / (t2 - t1)),
        a3 = lerpPoint(p2, p3, (t - t2) / (t3 - t2));
      const b1 = lerpPoint(a1, a2, (t - t0) / (t2 - t0)),
        b2 = lerpPoint(a2, a3, (t - t1) / (t3 - t1));
      out.push(lerpPoint(b1, b2, (t - t1) / (t2 - t1)));
    }
  }
  out[out.length - 1] = points[points.length - 1];
  return out;
}
/** Simplify and spline every edge so curves are smooth and straight runs stay straight. */
export function smoothCentrelines(graph: RoadGraph) {
  for (const e of graph.edges) {
    const simplified = simplifyPolyline(e.points, 0.9);
    e.points = e.bridge ? simplified : catmullRom(simplified, 4);
  }
}

/* ------------------------------------------------------------- junctions */

interface Arm {
  e: RoadEdge;
  atStart: boolean;
  dir: Point;
  hw: number;
  ang: number;
  cutL: number;
  cutR: number;
}
interface Corner {
  /** From arm k's left edge line to arm k+1's right edge line, in ring order. */
  points: Point[];
  /** Fillet circle for sidewalk construction, if any. */
  arc?: { centre: Point; radius: number; from: number; to: number };
}
const arcPoints = (
  centre: Point,
  radius: number,
  from: number,
  to: number,
  n: number,
) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / n;
    return { x: centre.x + Math.cos(a) * radius, z: centre.z + Math.sin(a) * radius };
  });
const signedAngle = (a: Point, b: Point) =>
  Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z);

/**
 * Explicit junction polygons with curb fillets. Incident arms are sorted by
 * departing angle; for each adjacent pair the left edge line of one meets the
 * right edge line of the next at a corner, which is rounded with a fillet. Arms are
 * trimmed back to their farthest tangent point so bands and rings share edges.
 */
export function buildRoadGeometry(graph: RoadGraph): RoadGeometry {
  const junctions: RoadGeometry["junctions"] = [],
    sidewalks: RoadGeometry["sidewalks"] = [],
    markings: RoadGeometry["markings"] = [];
  const trim = graph.edges.map(() => [0, 0] as [number, number]);
  const junctionNodes = new Set<number>();
  const departing = (edgeId: number, node: number): Arm => {
    const e = graph.edges[edgeId],
      atStart = e.a === node;
    const pts = atStart ? e.points : [...e.points].reverse();
    const dir = norm(sub(pts[Math.min(2, pts.length - 1)], pts[0]));
    return {
      e,
      atStart,
      dir,
      hw: e.width / 2,
      ang: Math.atan2(dir.z, dir.x),
      cutL: 0,
      cutR: 0,
    };
  };
  for (const n of graph.nodes) {
    const arms = n.edges.map((id) => departing(id, n.id)).sort((p, q) => p.ang - q.ang);
    if (arms.length === 0) continue;
    if (arms.length === 1) {
      culDeSac(n, arms[0], junctions, sidewalks, trim);
      continue;
    }
    if (arms.length === 2) {
      const bend = Math.abs(signedAngle(arms[0].dir, mul(arms[1].dir, -1)));
      // Gentle continuation with equal widths: the band mitres handle it.
      if (arms[0].e.width === arms[1].e.width && bend < (50 * Math.PI) / 180) continue;
    }
    const count = arms.length,
      corners: Corner[] = [];
    for (let k = 0; k < count; k++) {
      const a = arms[k],
        b = arms[(k + 1) % count];
      let turn = signedAngle(a.dir, b.dir);
      if (turn <= 0) turn += Math.PI * 2;
      const nA = perp(a.dir),
        nB = mul(perp(b.dir), -1);
      const pA = add(n, mul(nA, a.hw)),
        pB = add(n, mul(nB, b.hw));
      const hit =
        turn < Math.PI - 0.12 ? lineIntersection(pA, a.dir, pB, b.dir) : undefined;
      if (!hit) {
        // Straight-through or reflex pair: the outer edge simply continues.
        corners.push({ points: [] });
        continue;
      }
      let tA = dot(sub(hit, pA), a.dir),
        tB = dot(sub(hit, pB), b.dir);
      const maxCut = 2.4 * Math.max(a.hw, b.hw);
      if (tA < 0 || tB < 0 || tA > maxCut || tB > maxCut) {
        // Acute pair: bevel between clamped points instead of a far-off mitre.
        tA = Math.max(0, Math.min(tA, maxCut));
        tB = Math.max(0, Math.min(tB, maxCut));
        corners.push({ points: [add(pA, mul(a.dir, tA)), add(pB, mul(b.dir, tB))] });
        a.cutL = Math.max(a.cutL, tA);
        b.cutR = Math.max(b.cutR, tB);
        continue;
      }
      const radius = Math.min(CURB_RADIUS[a.e.kind], CURB_RADIUS[b.e.kind]);
      const half = turn / 2;
      let tangent = radius / Math.tan(half);
      let r = radius;
      if (tangent > 14) {
        tangent = 14;
        r = tangent * Math.tan(half);
      }
      const bisector = norm(add(a.dir, b.dir));
      const centre = add(hit, mul(bisector, r / Math.sin(half)));
      const ta = add(hit, mul(a.dir, tangent)),
        tb = add(hit, mul(b.dir, tangent));
      const from = Math.atan2(ta.z - centre.z, ta.x - centre.x);
      let to = Math.atan2(tb.z - centre.z, tb.x - centre.x);
      while (to - from > Math.PI) to -= Math.PI * 2;
      while (to - from < -Math.PI) to += Math.PI * 2;
      const steps = Math.max(3, Math.ceil((Math.abs(to - from) * r) / 1.5));
      corners.push({
        points: arcPoints(centre, r, from, to, steps),
        arc: { centre, radius: r, from, to },
      });
      a.cutL = Math.max(a.cutL, tA + tangent);
      b.cutR = Math.max(b.cutR, tB + tangent);
    }
    // Every arm needs enough room for the widest neighbour even without a corner.
    for (const a of arms) {
      const widest = Math.max(...arms.filter((o) => o !== a).map((o) => o.hw));
      a.cutL = Math.max(a.cutL, widest * 0.6);
      a.cutR = Math.max(a.cutR, widest * 0.6);
    }
    const ring: Point[] = [];
    for (let k = 0; k < count; k++) {
      const a = arms[k],
        cut = Math.max(a.cutL, a.cutR) + 0.3,
        end = add(n, mul(a.dir, cut)),
        l = perp(a.dir),
        endR = add(end, mul(l, -a.hw)),
        endL = add(end, mul(l, a.hw));
      ring.push(endR, endL, ...corners[k].points);
      const index = a.e.id;
      if (a.atStart) trim[index][0] = cut;
      else trim[index][1] = cut;
      // Sidewalk pieces: strip from the band end back to the corner on the left side,
      // the corner itself, and the strip on the next arm's right side.
      const b = arms[(k + 1) % count],
        cutB = Math.max(b.cutL, b.cutR) + 0.3,
        endB = add(n, mul(b.dir, cutB)),
        endRB = add(endB, mul(perp(b.dir), -b.hw)),
        nA = l,
        nB = mul(perp(b.dir), -1);
      const corner = corners[k];
      const first = corner.points[0] ?? endRB,
        last = corner.points[corner.points.length - 1] ?? endL;
      if (corner.points.length) {
        if (dist(endL, first) > 0.05)
          sidewalks.push({
            node: n.id,
            polygon: [
              first,
              endL,
              add(endL, mul(nA, SIDEWALK)),
              add(first, mul(nA, SIDEWALK)),
            ],
          });
        if (dist(last, endRB) > 0.05)
          sidewalks.push({
            node: n.id,
            polygon: [
              last,
              add(last, mul(nB, SIDEWALK)),
              add(endRB, mul(nB, SIDEWALK)),
              endRB,
            ],
          });
        if (corner.arc) {
          const { centre, radius, from, to } = corner.arc,
            steps = corner.points.length - 1;
          sidewalks.push({
            node: n.id,
            polygon: [
              ...corner.points,
              ...arcPoints(centre, radius + SIDEWALK, to, from, steps),
            ],
          });
        } else {
          const [p1, p2] = corner.points;
          sidewalks.push({
            node: n.id,
            polygon: [p1, p2, add(p2, mul(nB, SIDEWALK)), add(p1, mul(nA, SIDEWALK))],
          });
        }
      } else {
        // Continuous outer edge between the two arm ends.
        sidewalks.push({
          node: n.id,
          polygon: [
            endL,
            add(endL, mul(nA, SIDEWALK)),
            add(endRB, mul(nB, SIDEWALK)),
            endRB,
          ],
        });
      }
    }
    junctions.push({ node: n.id, polygon: ring });
    if (count >= 3) junctionNodes.add(n.id);
  }
  const bands: RoadGeometry["bands"] = [];
  for (const e of graph.edges) {
    const pts = trimPolyline(e.points, trim[e.id][0], trim[e.id][1]);
    if (pts.length < 2) continue;
    const { left, right } = offsetPolyline(pts, e.width / 2);
    bands.push({
      edge: e.id,
      polygon: [...left, ...[...right].reverse()],
      left,
      right,
      centre: pts,
    });
    const outer = offsetPolyline(pts, e.width / 2 + SIDEWALK);
    if (!e.bridge) {
      sidewalks.push({ edge: e.id, polygon: [...left, ...[...outer.left].reverse()] });
      sidewalks.push({
        edge: e.id,
        polygon: [...outer.right, ...[...right].reverse()],
      });
    }
    paintMarkings(e, pts, graph, junctionNodes, markings);
  }
  return { junctions, bands, sidewalks, markings };
}

/** Turning circle at a dead end, sized by the road kind. */
function culDeSac(
  n: { id: number; x: number; z: number },
  arm: Arm,
  junctions: RoadGeometry["junctions"],
  sidewalks: RoadGeometry["sidewalks"],
  trim: [number, number][],
) {
  const radius = arm.hw + (arm.e.kind === "street" || arm.e.kind === "lane" ? 4.5 : 2);
  const cut = Math.sqrt(Math.max(0, radius * radius - arm.hw * arm.hw));
  const end = add(n, mul(arm.dir, cut)),
    l = perp(arm.dir);
  const endR = add(end, mul(l, -arm.hw)),
    endL = add(end, mul(l, arm.hw));
  // Ring runs from the left end around the far side to the right end.
  const from = Math.atan2(endL.z - n.z, endL.x - n.x);
  let to = Math.atan2(endR.z - n.z, endR.x - n.x);
  while (to <= from) to += Math.PI * 2;
  const steps = Math.max(8, Math.ceil(((to - from) * radius) / 1.5));
  const arc = arcPoints(n, radius, from, to, steps);
  junctions.push({ node: n.id, polygon: [endR, endL, ...arc.slice(1, -1)] });
  sidewalks.push({
    node: n.id,
    polygon: [...arc, ...arcPoints(n, radius + SIDEWALK, to, from, steps)],
  });
  if (arm.atStart) trim[arm.e.id][0] = cut;
  else trim[arm.e.id][1] = cut;
}

/** Lane lines, centre lines, stop lines and zebra crossings for one band. */
function paintMarkings(
  e: RoadEdge,
  centre: Point[],
  graph: RoadGraph,
  junctionNodes: Set<number>,
  out: RoadGeometry["markings"],
) {
  if (e.kind === "lane") return;
  const length = centre.reduce((s, p, i) => (i ? s + dist(centre[i - 1], p) : 0), 0);
  if (length < 6) return;
  const hw = e.width / 2,
    lanes = LANES[e.kind],
    laneWidth = (e.width - 2) / lanes;
  const strip = (offset: number, width: number, color: "white" | "yellow") => {
    const path = offsetLine(centre, offset),
      { left, right } = offsetPolyline(path, width / 2);
    out.push({ edge: e.id, color, polygon: [...left, ...[...right].reverse()] });
  };
  const dashes = (
    offset: number,
    width: number,
    on: number,
    off: number,
    color: "white" | "yellow",
  ) => {
    const path = offsetLine(centre, offset);
    let s = 2;
    while (s + on < length - 2) {
      const a = pointAt(path, s),
        b = pointAt(path, s + on),
        d = norm(sub(b, a)),
        nrm = mul(perp(d), width / 2);
      out.push({
        edge: e.id,
        color,
        polygon: [add(a, nrm), add(b, nrm), sub(b, nrm), sub(a, nrm)],
      });
      s += on + off;
    }
  };
  if (lanes >= 4) {
    strip(0.15, 0.12, "yellow");
    strip(-0.15, 0.12, "yellow");
    dashes(laneWidth, 0.12, 3, 6, "white");
    dashes(-laneWidth, 0.12, 3, 6, "white");
    strip(hw - 0.5, 0.12, "white");
    strip(-(hw - 0.5), 0.12, "white");
  } else dashes(0, 0.12, 3, 6, "white");
  if (e.kind === "highway" || e.bridge || length < 16) return;
  // Crossings and stop lines at junction ends; incoming traffic keeps right, so the
  // stop line covers the left half of the band seen from the node.
  for (const [node, fromStart] of [
    [e.a, true],
    [e.b, false],
  ] as const) {
    if (!junctionNodes.has(node)) continue;
    const path = fromStart ? centre : [...centre].reverse();
    const origin = path[0],
      dir = norm(sub(pointAt(path, 4), origin)),
      side = perp(dir);
    const rect = (s0: number, s1: number, o0: number, o1: number) => [
      add(add(origin, mul(dir, s0)), mul(side, o0)),
      add(add(origin, mul(dir, s1)), mul(side, o0)),
      add(add(origin, mul(dir, s1)), mul(side, o1)),
      add(add(origin, mul(dir, s0)), mul(side, o1)),
    ];
    for (let o = -hw + 0.6; o + 0.5 <= hw - 0.6; o += 1.0)
      out.push({ edge: e.id, color: "white", polygon: rect(1.0, 3.6, o, o + 0.5) });
    out.push({ edge: e.id, color: "white", polygon: rect(4.2, 4.6, 0.2, hw - 0.3) });
  }
}
/** A polyline parallel to `centre` at a signed lateral offset (positive = left). */
function offsetLine(centre: Point[], offset: number) {
  if (Math.abs(offset) < 1e-6) return centre;
  const { left, right } = offsetPolyline(centre, Math.abs(offset));
  return offset > 0 ? left : right;
}

/* ---------------------------------------------------------------- helpers */

/** Left and right offset curves with mitre joins clamped to a bevel. */
export function offsetPolyline(points: Point[], halfWidth: number) {
  const left: Point[] = [],
    right: Point[] = [];
  if (points.length === 1) return { left: [points[0]], right: [points[0]] };
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const dIn = i > 0 ? norm(sub(p, points[i - 1])) : norm(sub(points[1], p));
    const dOut = i < points.length - 1 ? norm(sub(points[i + 1], p)) : dIn;
    let n = norm(add(perp(dIn), perp(dOut)));
    const cos = n.x * perp(dIn).x + n.z * perp(dIn).z;
    const scale = Math.min(1 / Math.max(cos, 0.35), 2.5);
    n = mul(n, scale);
    left.push(add(p, mul(n, halfWidth)));
    right.push(add(p, mul(n, -halfWidth)));
  }
  return { left, right };
}
export function trimPolyline(points: Point[], startCut: number, endCut: number) {
  const total = points.reduce((s, p, i) => (i ? s + dist(points[i - 1], p) : 0), 0);
  if (startCut + endCut >= total - 1) {
    const a = pointAt(points, Math.min(startCut, total / 2 - 0.5)),
      b = pointAt(points, Math.max(total - endCut, total / 2 + 0.5));
    return [a, b];
  }
  const out: Point[] = [pointAt(points, startCut)];
  let s = 0;
  for (let i = 1; i < points.length - 1; i++) {
    s += dist(points[i - 1], points[i]);
    if (s > startCut + 0.5 && s < total - endCut - 0.5) out.push(points[i]);
  }
  out.push(pointAt(points, total - endCut));
  return out;
}
export function pointAt(points: Point[], distance: number): Point {
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    const d = dist(points[i - 1], points[i]);
    if (s + d >= distance)
      return lerpPoint(points[i - 1], points[i], d ? (distance - s) / d : 0);
    s += d;
  }
  return points[points.length - 1];
}

/* --------------------------------------------------------------- profiles */

/**
 * Longitudinal profiles: node heights pinned to smoothed terrain, edge profiles low-pass
 * filtered and grade-limited from both ends, bridges straight between abutments.
 */
export function solveProfiles(graph: RoadGraph, f: HeightField) {
  const terrainAt = (p: Point) => Math.max(0.6, sample(f, p.x, p.z));
  const maxGrade = (kind: string) =>
    kind === "highway" ? 0.07 : kind === "avenue" ? 0.1 : 0.14;
  for (const n of graph.nodes) {
    let sum = 0,
      count = 0;
    for (const dx of [-6, 0, 6])
      for (const dz of [-6, 0, 6]) {
        sum += terrainAt({ x: n.x + dx, z: n.z + dz });
        count++;
      }
    n.y = sum / count;
  }
  for (const e of graph.edges) {
    const dense: Point[] = [];
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1],
        b = e.points[i],
        steps = Math.max(1, Math.ceil(dist(a, b) / 8));
      for (let s = 0; s < steps; s++) dense.push(lerpPoint(a, b, s / steps));
    }
    dense.push(e.points[e.points.length - 1]);
    e.points = dense;
    const n = dense.length,
      heights = dense.map(terrainAt);
    const ya = graph.nodes[e.a].y,
      yb = graph.nodes[e.b].y;
    if (e.bridge) {
      for (let i = 0; i < n; i++)
        heights[i] = ya + ((yb - ya) * i) / Math.max(1, n - 1);
      e.heights = heights;
      continue;
    }
    const smooth = heights.slice();
    for (let pass = 0; pass < 2; pass++)
      for (let i = 1; i < n - 1; i++)
        smooth[i] =
          (heights[Math.max(0, i - 2)] +
            heights[i - 1] +
            heights[i] +
            heights[i + 1] +
            heights[Math.min(n - 1, i + 2)]) /
          5;
    smooth[0] = ya;
    smooth[n - 1] = yb;
    const limit = maxGrade(e.kind);
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 1; i < n; i++) {
        const d = dist(dense[i - 1], dense[i]) || 1,
          delta = smooth[i] - smooth[i - 1];
        if (Math.abs(delta) > limit * d)
          smooth[i] = smooth[i - 1] + Math.sign(delta) * limit * d;
      }
      for (let i = n - 2; i >= 0; i--) {
        const d = dist(dense[i], dense[i + 1]) || 1,
          delta = smooth[i] - smooth[i + 1];
        if (Math.abs(delta) > limit * d)
          smooth[i] = smooth[i + 1] + Math.sign(delta) * limit * d;
      }
    }
    smooth[0] = ya;
    smooth[n - 1] = yb;
    e.heights = smooth;
  }
}

/** Stamp road corridors and junction plateaus into the heightfield (weighted blend). */
export function stampRoads(f: HeightField, graph: RoadGraph, geometry: RoadGeometry) {
  const { w, h } = f,
    original = Float32Array.from(f.data),
    acc = new Float32Array(w * h),
    weight = new Float32Array(w * h),
    best = new Float32Array(w * h);
  const shoulder = 1.5 + SIDEWALK * 0.5;
  const contribute = (i: number, wgt: number, y: number) => {
    if (wgt > best[i] + 1e-6) {
      best[i] = wgt;
      acc[i] = wgt * y;
      weight[i] = wgt;
    } else if (wgt >= best[i] - 1e-6) {
      acc[i] += wgt * y;
      weight[i] += wgt;
    }
  };
  const stampSegment = (a: Point, b: Point, ya: number, yb: number, hw: number) => {
    const reachMax = hw + shoulder + 16;
    const x0 = Math.max(
        0,
        Math.floor((Math.min(a.x, b.x) - reachMax + f.size / 2) / f.cell),
      ),
      x1 = Math.min(
        w - 1,
        Math.ceil((Math.max(a.x, b.x) + reachMax + f.size / 2) / f.cell),
      ),
      z0 = Math.max(
        0,
        Math.floor((Math.min(a.z, b.z) - reachMax + f.size / 2) / f.cell),
      ),
      z1 = Math.min(
        h - 1,
        Math.ceil((Math.max(a.z, b.z) + reachMax + f.size / 2) / f.cell),
      );
    const ab = sub(b, a),
      l2 = ab.x * ab.x + ab.z * ab.z || 1;
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const px = x * f.cell - f.size / 2,
          pz = z * f.cell - f.size / 2;
        const t = Math.max(
          0,
          Math.min(1, ((px - a.x) * ab.x + (pz - a.z) * ab.z) / l2),
        );
        const cx = a.x + ab.x * t,
          cz = a.z + ab.z * t,
          d = Math.hypot(px - cx, pz - cz);
        const y = ya + (yb - ya) * t,
          i = z * w + x,
          depth = y - original[i];
        const bank = Math.min(16, Math.max(3, 2.2 * Math.abs(depth)));
        const flat = hw + shoulder;
        if (d > flat + bank) continue;
        const wgt = d <= flat ? 1 : 1 - smoothstep(0, 1, (d - flat) / bank);
        contribute(i, wgt, y);
      }
  };
  for (const e of graph.edges) {
    if (e.bridge) continue;
    for (let i = 1; i < e.points.length; i++)
      stampSegment(
        e.points[i - 1],
        e.points[i],
        e.heights[i - 1],
        e.heights[i],
        e.width / 2,
      );
  }
  for (const j of geometry.junctions) {
    const n = graph.nodes[j.node];
    // A plateau as wide as the widest arm; the trimmed bands carry the profile
    // outward so sloping arms are not flattened across the whole ring.
    let r = 0;
    for (const id of n.edges) r = Math.max(r, graph.edges[id].width / 2);
    stampSegment(n, { x: n.x + 0.01, z: n.z }, n.y, n.y, r + 1);
  }
  for (let i = 0; i < w * h; i++) {
    if (weight[i] <= 0) continue;
    const target = acc[i] / weight[i],
      wgt = Math.min(1, best[i]);
    f.data[i] = original[i] + (target - 0.04 - original[i]) * wgt;
  }
  return best;
}

export function bridgeDecks(graph: RoadGraph): Bridge[] {
  const out: Bridge[] = [];
  for (const e of graph.edges) {
    if (!e.bridge) continue;
    const { left, right } = offsetPolyline(e.points, e.width / 2 + 1.2);
    out.push({ edge: e.id, polygon: [...left, ...[...right].reverse()] });
  }
  return out;
}
export { RANK as ROAD_RANK_BY_KIND };
