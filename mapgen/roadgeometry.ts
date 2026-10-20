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
  polylineLength,
  segmentIntersection,
  selfIntersects,
  signedArea,
  sub,
} from "./geom.ts";
import { smoothstep } from "./random.ts";
import type {
  Bridge,
  Phase,
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
    l = Math.hypot(ab.x, ab.z);
  // A ring road starts and ends at one node; measure from that node instead.
  if (l < 1e-6) return dist(p, a);
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
/**
 * Replace sharp interior vertices with circular arcs of about `radius`, shrunk so
 * each arc uses at most 45 % of its neighbouring segments. A spline alone keeps the
 * kink because it passes through every control point.
 */
export function roundCorners(points: Point[], radius: number, minTurn = 0.4) {
  if (points.length < 3) return points;
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i],
      before = sub(points[i - 1], p),
      after = sub(points[i + 1], p),
      turn =
        Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(norm(before), norm(after)))));
    if (turn < minTurn) {
      out.push(p);
      continue;
    }
    const half = turn / 2,
      tangent = Math.min(
        radius * Math.tan(half),
        0.45 * Math.hypot(before.x, before.z),
        0.45 * Math.hypot(after.x, after.z),
      ),
      r = tangent / Math.tan(half),
      a = add(p, mul(norm(before), tangent)),
      b = add(p, mul(norm(after), tangent)),
      centre = add(p, mul(norm(add(norm(before), norm(after))), r / Math.cos(half)));
    const from = Math.atan2(a.z - centre.z, a.x - centre.x);
    let to = Math.atan2(b.z - centre.z, b.x - centre.x);
    while (to - from > Math.PI) to -= Math.PI * 2;
    while (to - from < -Math.PI) to += Math.PI * 2;
    const steps = Math.max(2, Math.ceil((Math.abs(to - from) * r) / 3));
    for (let s = 0; s <= steps; s++) {
      const angle = from + ((to - from) * s) / steps;
      out.push({
        x: centre.x + Math.cos(angle) * r,
        z: centre.z + Math.sin(angle) * r,
      });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
/** Simplify and spline every edge so curves are smooth and straight runs stay straight. */
export function smoothCentrelines(graph: RoadGraph) {
  for (const e of graph.edges) {
    const simplified = roundCorners(simplifyPolyline(e.points, 0.9), e.width * 2);
    e.points = e.bridge
      ? simplified
      : widenBends(catmullRom(simplified, 4), e.width / 2 + SIDEWALK + 1);
  }
}

/* ------------------------------------------------------------- junctions */

interface Arm {
  e: RoadEdge;
  atStart: boolean;
  /** Where the corners are laid out: the chord towards the mouth. */
  dir: Point;
  /** The road's own heading as it leaves the node, which decides whether it bends. */
  heading: Point;
  hw: number;
  ang: number;
  cutL: number;
  cutR: number;
  /** Longest cut this end may take so the band keeps room for its other end. */
  limit: number;
}
interface Corner {
  /** From arm k's left edge line to arm k+1's right edge line, in ring order. */
  points: Point[];
  /** Fillet circle for sidewalk construction, if any. */
  arc?: { centre: Point; radius: number; from: number; to: number };
}
/** A walkway end at mid-sidewalk where a band meets a junction or dead end. */
interface WalkEnd {
  edge: number;
  atStart: boolean;
  /** The band's left side (positive perpendicular of the edge direction). */
  left: boolean;
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
 * Band length that holds a crosswalk and stop line at each end with lane markings
 * between them; shorter links between close junctions get no crosswalks.
 */
const CROSSING_BAND = 16;
/** Lane markings stop this far from a crossed band end, just past the stop line. */
const MARKED_END = 5;
/** Arms closer than this angle (radians) are one road splitting, not a crossing. */
const SPLIT = 0.7;
/** Crosswalk centre measured from the band end; the zebra spans 1.0–3.6 m. */
const CROSSING_AT = 2.3;
/** Walkways run just outside the middle of the sidewalk, clear of kerbside lamps. */
const WALK = SIDEWALK / 2 + 0.35;
/** Straight continuations with equal widths need no junction. */
const continuation = (arms: Arm[]) =>
  arms.length === 2 &&
  arms[0].e.width === arms[1].e.width &&
  Math.abs(signedAngle(arms[0].heading, mul(arms[1].heading, -1))) < 1e-4;
const culDeSacRadius = (arm: Arm) =>
  arm.hw + (arm.e.kind === "street" || arm.e.kind === "lane" ? 4.5 : 2);

/**
 * Explicit junction polygons with curb fillets. Incident arms are sorted by
 * departing angle; for each adjacent pair the left edge line of one meets the
 * right edge line of the next at a corner, which is rounded with a fillet. Arms are
 * trimmed back to their farthest tangent point so bands and rings share edges.
 * Fillets shrink when a short band would otherwise be eaten by both of its ends.
 * Walkways along the middle of every sidewalk, linked around corners and across
 * crosswalks, form the pedestrian network.
 */
export function buildRoadGeometry(graph: RoadGraph): RoadGeometry {
  // The first layout learns how far back each junction cuts its arms; the second
  // takes every arm's direction towards where its mouth ended up, so the corners'
  // straight lines meet a curving road at its mouth instead of missing it sideways.
  let geometry = layoutRoadGeometry(graph);
  for (let pass = 0; pass < PASSES; pass++) {
    const trims = geometry.trims;
    geometry = layoutRoadGeometry(
      graph,
      graph.edges.flatMap((e) => trims[e.id]),
    );
  }
  return geometry;
}
/** Layouts after the first; each moves the cuts less (78 mouths missing by 0.4 m, then 29, 15, 7). */
const PASSES = 3;
function layoutRoadGeometry(graph: RoadGraph, cuts?: number[]): RoadGeometry {
  const junctions: RoadGeometry["junctions"] = [],
    sidewalks: RoadGeometry["sidewalks"] = [],
    markings: RoadGeometry["markings"] = [];
  const trim = graph.edges.map(() => [0, 0] as [number, number]);
  /** Where each junction ring meets an edge end: its corners and the mouth's normal. */
  const mouthEnds = new Map<string, { endL: Point; endR: Point; l: Point }>();
  const junctionNodes = new Set<number>();
  const turns: { from: WalkEnd; to: WalkEnd; via: Point[] }[] = [];
  const departing = (edgeId: number, atStart: boolean): Arm => {
    const e = graph.edges[edgeId];
    const pts = atStart ? e.points : [...e.points].reverse();
    // The corners are laid out along straight lines from the node, so the direction
    // is the chord to about where the mouth will sit: a road that is still curving
    // then crosses those lines at its mouth instead of missing them sideways.
    const reach = Math.min(
      0.45 * polylineLength(pts),
      cuts?.[edgeId * 2 + (atStart ? 0 : 1)] ?? 8,
    );
    const dir = norm(sub(pointAt(pts, Math.max(reach, 4)), pts[0]));
    return {
      e,
      atStart,
      dir,
      heading: norm(sub(pts[Math.min(2, pts.length - 1)], pts[0])),
      hw: e.width / 2,
      ang: Math.atan2(dir.z, dir.x),
      cutL: 0,
      cutR: 0,
      limit: Infinity,
    };
  };
  // A ring road lists its node twice: once leaving from its start, once from its end.
  const armsAt = graph.nodes.map((n) =>
    n.edges
      .map((id, i) => {
        const e = graph.edges[id];
        return departing(id, e.a !== e.b ? e.a === n.id : n.edges.indexOf(id) === i);
      })
      .sort((p, q) => p.ang - q.ang),
  );
  const phases = graph.edges.map(
    () => [undefined, undefined] as [Phase | undefined, Phase | undefined],
  );
  for (const arms of armsAt) {
    if (arms.length < 3) continue;
    let pair = [arms[0], arms[1]],
      straightest = Infinity;
    for (const a of arms)
      for (const b of arms)
        if (a !== b && dot(a.dir, b.dir) < straightest) {
          straightest = dot(a.dir, b.dir);
          pair = [a, b];
        }
    for (const a of arms)
      phases[a.e.id][a.atStart ? 0 : 1] = pair.includes(a) ? "z" : "x";
  }
  // Share each band between its two ends in proportion to what they would cut.
  const need = (arms: Arm[], arm: Arm) => {
    if (arms.length === 1) {
      const r = culDeSacRadius(arm);
      return Math.sqrt(Math.max(0, r * r - arm.hw * arm.hw));
    }
    if (continuation(arms)) return 0;
    const widest = Math.max(...arms.filter((o) => o !== arm).map((o) => o.hw));
    return widest + CURB_RADIUS[arm.e.kind] + 0.3;
  };
  const ends = graph.edges.map(() => [] as Arm[]);
  for (const arms of armsAt) for (const arm of arms) ends[arm.e.id].push(arm);
  for (const e of graph.edges) {
    const arms = ends[e.id].map((arm) => ({
        arm,
        need: need(armsAt[arm.atStart ? e.a : e.b], arm),
      })),
      length = polylineLength(e.points),
      room = length - Math.min(CROSSING_BAND, length * 0.3),
      total = arms.reduce((s, a) => s + a.need, 0);
    if (total > room)
      for (const { arm, need } of arms) arm.limit = (room * need) / total;
  }
  /**
   * Whether another arm leaves the node within SPLIT of this band's end. A zebra
   * crossing there would cut through the neighbouring band's own crossing.
   */
  const splits = (e: RoadEdge, node: number) => {
    const arm = armsAt[node].find((a) => a.e === e && a.atStart === (e.a === node));
    return (
      !!arm &&
      armsAt[node].some((o) => o !== arm && dot(o.dir, arm.dir) > Math.cos(SPLIT))
    );
  };
  const bandSide = (arm: Arm, armLeft: boolean): WalkEnd => ({
    edge: arm.e.id,
    atStart: arm.atStart,
    left: arm.atStart === armLeft,
  });
  for (const n of graph.nodes) {
    const arms = armsAt[n.id];
    if (arms.length === 0) continue;
    if (arms.length === 1) {
      const arm = arms[0],
        radius = culDeSacRadius(arm);
      trim[arm.e.id][arm.atStart ? 0 : 1] = Math.min(
        arm.limit,
        Math.sqrt(Math.max(0, radius * radius - arm.hw * arm.hw)),
      );
      continue;
    }
    if (continuation(arms)) {
      turns.push(
        { from: bandSide(arms[0], true), to: bandSide(arms[1], false), via: [] },
        { from: bandSide(arms[1], true), to: bandSide(arms[0], false), via: [] },
      );
      continue;
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
      const half = turn / 2;
      const tangent = Math.min(
        Math.min(CURB_RADIUS[a.e.kind], CURB_RADIUS[b.e.kind]) / Math.tan(half),
        14,
        a.limit - 0.3 - tA,
        b.limit - 0.3 - tB,
      );
      a.cutL = Math.max(a.cutL, tA + Math.max(0, tangent));
      b.cutR = Math.max(b.cutR, tB + Math.max(0, tangent));
      if (tangent < 0.75) {
        // No room for a fillet between close junctions: keep the sharp corner.
        corners.push({ points: [hit] });
        continue;
      }
      const r = tangent * Math.tan(half);
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
    }
    // Every arm needs enough room for the widest neighbour even without a corner.
    for (const a of arms) {
      const widest = Math.min(
        a.limit,
        0.6 * Math.max(...arms.filter((o) => o !== a).map((o) => o.hw)),
      );
      a.cutL = Math.max(a.cutL, widest);
      a.cutR = Math.max(a.cutR, widest);
    }
    // Mouths sit on the curved centreline, so each ring shares its band's ends.
    // Corners are laid out along the arm's straight start direction; where the road
    // curves, the mouth moves out until it clears both of its corners so the ring
    // never folds back on itself.
    const mouths = arms.map((a, k) => {
      const pts = a.atStart ? a.e.points : [...a.e.points].reverse(),
        length = polylineLength(pts),
        near = [...corners[k].points, ...corners[(k + count - 1) % count].points];
      const mouth = (cut: number) => {
        const remaining = trimPolyline(pts, cut, 0),
          end = remaining[0],
          t = norm(sub(remaining[1], end));
        return { cut, end, t, l: perp(t) };
      };
      let m = mouth(Math.max(a.cutL, a.cutR) + 0.3);
      while (m.cut < length * 0.5 && near.some((q) => dot(sub(q, m.end), m.t) > -0.2))
        m = mouth(m.cut + 0.25);
      return {
        cut: m.cut,
        l: m.l,
        endL: add(m.end, mul(m.l, a.hw)),
        endR: add(m.end, mul(m.l, -a.hw)),
      };
    });
    const ring: Point[] = [];
    for (let k = 0; k < count; k++) {
      const a = arms[k],
        { cut, l, endL, endR } = mouths[k];
      ring.push(endR, endL, ...corners[k].points);
      const index = a.e.id;
      mouthEnds.set(`${index}:${a.atStart ? 0 : 1}`, { endL, endR, l });
      if (a.atStart) trim[index][0] = cut;
      else trim[index][1] = cut;
      // Sidewalk pieces: strip from the band end back to the corner on the left side,
      // the corner itself, and the strip on the next arm's right side.
      const b = arms[(k + 1) % count],
        { endR: endRB, l: lB } = mouths[(k + 1) % count],
        nA = perp(a.dir),
        nB = mul(perp(b.dir), -1);
      const corner = corners[k];
      const first = corner.points[0] ?? endRB,
        last = corner.points[corner.points.length - 1] ?? endL;
      let via: Point[] = [];
      if (corner.points.length) {
        if (dist(endL, first) > 0.05)
          sidewalks.push({
            node: n.id,
            polygon: [
              first,
              endL,
              add(endL, mul(l, SIDEWALK)),
              add(first, mul(nA, SIDEWALK)),
            ],
          });
        if (dist(last, endRB) > 0.05)
          sidewalks.push({
            node: n.id,
            polygon: [
              last,
              add(last, mul(nB, SIDEWALK)),
              add(endRB, mul(lB, -SIDEWALK)),
              endRB,
            ],
          });
        if (corner.arc) {
          // The fillet centre lies in the block, so the sidewalk runs inside the
          // kerb arc. A fillet tighter than the sidewalk closes at the point where
          // the two strips' outer edges meet.
          const { centre, radius, from, to } = corner.arc,
            steps = corner.points.length - 1,
            inner = (offset: number, n: number) =>
              radius > offset + 0.05
                ? arcPoints(centre, radius - offset, from, to, n)
                : [
                    lineIntersection(
                      add(first, mul(nA, offset)),
                      a.dir,
                      add(last, mul(nB, offset)),
                      b.dir,
                    ) ?? centre,
                  ];
          sidewalks.push({
            node: n.id,
            polygon: [...corner.points, ...inner(SIDEWALK, steps).reverse()],
          });
          via = inner(
            WALK,
            Math.max(2, Math.ceil(Math.abs(to - from) / (Math.PI / 8))),
          );
        } else if (corner.points.length === 1) {
          // Sharp corner: fill the notch between the two strips.
          const [p] = corner.points,
            bisector = norm(add(nA, nB)),
            reach = 1 / Math.max(0.35, dot(bisector, nA));
          sidewalks.push({
            node: n.id,
            polygon: [
              p,
              add(p, mul(nB, SIDEWALK)),
              add(p, mul(bisector, SIDEWALK * reach)),
              add(p, mul(nA, SIDEWALK)),
            ],
          });
          via = [add(p, mul(bisector, WALK * reach))];
        } else {
          const [p1, p2] = corner.points;
          sidewalks.push({
            node: n.id,
            polygon: [p1, p2, add(p2, mul(nB, SIDEWALK)), add(p1, mul(nA, SIDEWALK))],
          });
          via = [add(p1, mul(nA, WALK)), add(p2, mul(nB, WALK))];
        }
      } else {
        // Continuous outer edge between the two arm ends.
        sidewalks.push({
          node: n.id,
          polygon: [
            endL,
            add(endL, mul(l, SIDEWALK)),
            add(endRB, mul(lB, -SIDEWALK)),
            endRB,
          ],
        });
      }
      turns.push({ from: bandSide(a, true), to: bandSide(b, false), via });
    }
    junctions.push({ node: n.id, polygon: removeLoops(ring) });
    if (count >= 3) junctionNodes.add(n.id);
  }
  for (const n of graph.nodes)
    if (armsAt[n.id].length === 1)
      culDeSac(n, armsAt[n.id][0], junctions, sidewalks, trim, turns, bandSide);
  const bands: RoadGeometry["bands"] = [];
  const walkways: RoadGeometry["walkways"] = { points: [], links: [] },
    walkEnds = new Map<string, number>();
  const endKey = (w: WalkEnd) => `${w.edge}:${+w.atStart}:${+w.left}`;
  const walkPoint = (p: Point) => walkways.points.push(p) - 1;
  for (const e of graph.edges) {
    const pts = trimPolyline(e.points, trim[e.id][0], trim[e.id][1]);
    if (pts.length < 2) continue;
    const { left, right } = offsetPolyline(pts, e.width / 2);
    const outer = offsetPolyline(pts, e.width / 2 + SIDEWALK);
    // A short band is offset from its own chord, not from the road's tangent at each
    // mouth, so its ends can miss the junction ring's mouth by a few centimetres and
    // leave a wedge of bare terrain. The band takes the mouth's corners exactly.
    const last = pts.length - 1;
    for (const [at, end, flip] of [
      [0, mouthEnds.get(`${e.id}:0`), false],
      [last, mouthEnds.get(`${e.id}:1`), true],
    ] as const) {
      if (!end || dist(left[at], flip ? end.endR : end.endL) > 1) continue;
      const toLeft = flip ? end.endR : end.endL,
        toRight = flip ? end.endL : end.endR,
        side = flip ? -1 : 1;
      left[at] = toLeft;
      right[at] = toRight;
      outer.left[at] = add(toLeft, mul(end.l, SIDEWALK * side));
      outer.right[at] = add(toRight, mul(end.l, -SIDEWALK * side));
    }
    bands.push({
      edge: e.id,
      polygon: [...left, ...[...right].reverse()],
      left,
      right,
      centre: pts,
    });
    sidewalks.push({ edge: e.id, polygon: [...left, ...[...outer.left].reverse()] });
    sidewalks.push({
      edge: e.id,
      polygon: [...outer.right, ...[...right].reverse()],
    });
    const length = polylineLength(pts),
      crossing = (node: number) =>
        junctionNodes.has(node) &&
        !e.bridge &&
        length >= CROSSING_BAND &&
        !splits(e, node);
    paintMarkings(e, pts, crossing, markings);
    // Walkways: stations along the band, with crosswalk stations near crossed ends.
    const stations = new Set<number>([0, length]);
    const steps = Math.max(1, Math.ceil(length / 12));
    for (let i = 1; i < steps; i++) stations.add((length * i) / steps);
    if (crossing(e.a)) stations.add(CROSSING_AT);
    if (crossing(e.b)) stations.add(length - CROSSING_AT);
    const sorted = [...stations].sort((p, q) => p - q),
      offset = e.width / 2 + WALK;
    const side = (left: boolean) => {
      const ids = sorted.map((s) => {
        const p = pointAt(pts, s),
          d = norm(
            sub(
              pointAt(pts, Math.min(length, s + 0.5)),
              pointAt(pts, Math.max(0, s - 0.5)),
            ),
          );
        return walkPoint(add(p, mul(perp(d), left ? offset : -offset)));
      });
      for (let i = 1; i < ids.length; i++)
        walkways.links.push({ a: ids[i - 1], b: ids[i] });
      walkEnds.set(endKey({ edge: e.id, atStart: true, left }), ids[0]);
      walkEnds.set(endKey({ edge: e.id, atStart: false, left }), ids[ids.length - 1]);
      return ids;
    };
    const lefts = side(true),
      rights = side(false);
    for (const [node, i] of [
      [e.a, 1],
      [e.b, sorted.length - 2],
    ] as const)
      if (crossing(node))
        // Pedestrians wait for the signal that stops traffic along this band.
        walkways.links.push({
          a: lefts[i],
          b: rights[i],
          crossing: phases[e.id][node === e.a && i === 1 ? 0 : 1],
        });
  }
  for (const { from, to, via } of turns) {
    const a = walkEnds.get(endKey(from)),
      b = walkEnds.get(endKey(to));
    if (a === undefined || b === undefined) continue;
    const ids = [a, ...via.map(walkPoint), b];
    for (let i = 1; i < ids.length; i++)
      walkways.links.push({ a: ids[i - 1], b: ids[i] });
  }
  // A short strip whose ends take different normals can twist into a bow-tie,
  // which renders as a flipped triangle; order its corners around the middle.
  for (const piece of sidewalks)
    if (piece.polygon.length === 4 && selfIntersects(piece.polygon)) {
      const c = mul(piece.polygon.reduce(add, { x: 0, z: 0 }), 0.25);
      piece.polygon = [...piece.polygon].sort(
        (p, q) => Math.atan2(p.z - c.z, p.x - c.x) - Math.atan2(q.z - c.z, q.x - c.x),
      );
    }
  return { junctions, bands, sidewalks, markings, walkways, trims: trim, phases };
}

/**
 * Cut folds out of a ring that crosses itself: at each crossing the smaller of the
 * two loops is replaced by the crossing point. Awkward junction geometry can fold a
 * corner past a mouth, and a folded ring would render a flipped triangle.
 */
function removeLoops(ring: Point[]) {
  let out = ring;
  for (let guard = 0; guard < ring.length; guard++) {
    const n = out.length;
    let found: { i: number; k: number; at: Point } | undefined;
    for (let i = 0; i < n && !found; i++)
      for (let k = i + 2; k < n; k++) {
        if (i === 0 && k === n - 1) continue;
        const a = out[i],
          b = out[(i + 1) % n],
          hit = segmentIntersection(a, b, out[k], out[(k + 1) % n]);
        if (hit) {
          found = { i, k, at: lerpPoint(a, b, hit.t) };
          break;
        }
      }
    if (!found) return out;
    const { i, k, at } = found;
    const inner = [at, ...out.slice(i + 1, k + 1)],
      outer = [...out.slice(0, i + 1), at, ...out.slice(k + 1)];
    out = Math.abs(signedArea(inner)) > Math.abs(signedArea(outer)) ? inner : outer;
    if (out.length < 3) return ring;
  }
  return out;
}

/** Turning circle at a dead end, sized by the road kind. */
function culDeSac(
  n: { id: number; x: number; z: number },
  arm: Arm,
  junctions: RoadGeometry["junctions"],
  sidewalks: RoadGeometry["sidewalks"],
  trim: [number, number][],
  turns: { from: WalkEnd; to: WalkEnd; via: Point[] }[],
  bandSide: (arm: Arm, armLeft: boolean) => WalkEnd,
) {
  const cuts = trim[arm.e.id];
  const points = trimPolyline(arm.e.points, cuts[0], cuts[1]);
  if (!arm.atStart) points.reverse();
  const cut = cuts[arm.atStart ? 0 : 1],
    end = points[0],
    dir = norm(sub(points[1], end)),
    l = perp(dir),
    centre = sub(end, mul(dir, cut)),
    radius = Math.hypot(cut, arm.hw);
  const endR = add(end, mul(l, -arm.hw)),
    endL = add(end, mul(l, arm.hw));
  // Ring runs from the left end around the far side to the right end.
  const from = Math.atan2(endL.z - centre.z, endL.x - centre.x);
  let to = Math.atan2(endR.z - centre.z, endR.x - centre.x);
  while (to <= from) to += Math.PI * 2;
  const steps = Math.max(8, Math.ceil(((to - from) * radius) / 1.5));
  const arc = arcPoints(centre, radius, from, to, steps);
  arc[0] = endL;
  arc[arc.length - 1] = endR;
  junctions.push({ node: n.id, polygon: [endR, endL, ...arc.slice(1, -1)] });
  // The ring starts square to the street sidewalks at the mouth, then widens to
  // the full circle.
  const outerL = add(endL, mul(l, SIDEWALK)),
    outerR = add(endR, mul(l, -SIDEWALK)),
    outerFrom = Math.atan2(outerL.z - centre.z, outerL.x - centre.x);
  let outerTo = Math.atan2(outerR.z - centre.z, outerR.x - centre.x);
  while (outerTo <= outerFrom) outerTo += Math.PI * 2;
  const outer = arcPoints(
    centre,
    Math.hypot(cut, arm.hw + SIDEWALK),
    outerTo,
    outerFrom,
    steps,
  );
  outer[0] = outerR;
  outer[outer.length - 1] = outerL;
  sidewalks.push({ node: n.id, polygon: [...arc, ...outer] });
  turns.push({
    from: bandSide(arm, true),
    to: bandSide(arm, false),
    via: arcPoints(centre, Math.hypot(cut, arm.hw + WALK), outerFrom, outerTo, 16),
  });
}

/** Lane lines, centre lines, stop lines and zebra crossings for one band. */
function paintMarkings(
  e: RoadEdge,
  centre: Point[],
  crossing: (node: number) => boolean,
  out: RoadGeometry["markings"],
) {
  if (e.kind === "lane") return;
  const length = centre.reduce((s, p, i) => (i ? s + dist(centre[i - 1], p) : 0), 0);
  if (length < 6) return;
  const hw = e.width / 2,
    lanes = LANES[e.kind],
    laneWidth = (e.width - 2) / lanes;
  // Lane lines stop short of the stop lines and crosswalks instead of running
  // through them.
  const startCut = crossing(e.a) ? MARKED_END : 0.5,
    endCut = crossing(e.b) ? MARKED_END : 0.5,
    lined = length - startCut - endCut > 2,
    lane = lined ? trimPolyline(centre, startCut, endCut) : centre,
    laneLength = lined ? length - startCut - endCut : 0;
  const strip = (offset: number, width: number, color: "white" | "yellow") => {
    if (!lined) return;
    const path = offsetLine(lane, offset),
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
    const path = offsetLine(lane, offset);
    let s = 1;
    while (s + on < laneLength - 1) {
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
  // Crossings and stop lines at junction ends; incoming traffic keeps right, so the
  // stop line covers the left half of the band seen from the node.
  for (const [node, fromStart] of [
    [e.a, true],
    [e.b, false],
  ] as const) {
    if (!crossing(node)) continue;
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

/** Left and right offset curves with mitre joins clamped to a bevel; never folding. */
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
  // On the inside of a bend tighter than the offset, the edge would run backwards
  // and fold the strip over itself; hold it at the last forward point instead.
  for (const side of [left, right])
    for (let i = 1; i < side.length; i++)
      if (dot(sub(side[i], side[i - 1]), sub(points[i], points[i - 1])) <= 0)
        side[i] = side[i - 1];
  return { left, right };
}
export function trimPolyline(points: Point[], startCut: number, endCut: number) {
  const total = points.reduce((s, p, i) => (i ? s + dist(points[i - 1], p) : 0), 0);
  // A band shorter than a metre still sits between its two mouths; only crossed
  // mouths collapse it, otherwise its square ends miss the junction rings' mouths.
  if (startCut + endCut >= total - 0.1) {
    // Crossed mouths: each junction ring reaches past the other's mouth, so the band
    // is only the overlap, with its ends on both mouth lines.
    const from = Math.max(0, total - endCut),
      to = Math.min(total, startCut);
    if (to - from >= 0.05) {
      const overlap: Point[] = [pointAt(points, from)];
      let along = 0;
      for (let i = 1; i < points.length - 1; i++) {
        along += dist(points[i - 1], points[i]);
        if (along > from + 0.5 && along < to - 0.5) overlap.push(points[i]);
      }
      overlap.push(pointAt(points, to));
      return overlap;
    }
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

/** Densify every centreline to at most 8 m between points for profile sampling. */
export function densifyCentrelines(graph: RoadGraph) {
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
  }
}

/**
 * Grade limit of each segment of a centreline: the road's own limit, cut to 40% of it
 * where the bend is tight (8 m radius or less) and eased back to the full limit at 40 m.
 * The two legs of a tight bend lie within one 8 m terrain cell, so they must stay level
 * with each other or the surface across that cell tilts.
 */
export function bendGrades(points: Point[], base: number) {
  const radius = bendRadii(points);
  return points.slice(1).map((_, i) => {
    const r = Math.min(radius[i], radius[i + 1]);
    return base * Math.min(1, Math.max(0.4, 0.4 + (0.6 * (r - 8)) / 32));
  });
}

/** Turning radius at each point of a centreline, from the chords 8 m before and after. */
export function bendRadii(points: Point[]) {
  const along = [0];
  for (let i = 1; i < points.length; i++)
    along.push(along[i - 1] + dist(points[i - 1], points[i]));
  return points.map((p, i) => {
    const a = pointAt(points, Math.max(0, along[i] - 8)),
      c = pointAt(points, Math.min(along[points.length - 1], along[i] + 8));
    if (dist(a, p) < 1e-6 || dist(p, c) < 1e-6) return Infinity;
    const turn = Math.abs(
      Math.atan2(c.z - p.z, c.x - p.x) - Math.atan2(p.z - a.z, p.x - a.x),
    );
    const angle = Math.min(turn, Math.PI * 2 - turn);
    return angle > 1e-3 ? 8 / angle : Infinity;
  });
}

/**
 * Relaxes the points around any bend tighter than `minRadius` until it opens up. A
 * bend tighter than the road's half-width folds the inner edge to a point, and its
 * two legs then lie within one terrain cell. The end points stay where they are.
 */
export function widenBends(points: Point[], minRadius: number) {
  const out = points.map((p) => ({ ...p }));
  for (let pass = 0; pass < 80; pass++) {
    const radius = bendRadii(out),
      tight = new Set<number>();
    radius.forEach((r, i) => {
      if (r < minRadius && i > 0 && i < out.length - 1)
        for (let k = Math.max(1, i - 2); k <= Math.min(out.length - 2, i + 2); k++)
          tight.add(k);
    });
    if (!tight.size) break;
    const next = out.map((p) => ({ ...p }));
    for (const i of tight) {
      next[i].x = (out[i - 1].x + 2 * out[i].x + out[i + 1].x) / 4;
      next[i].z = (out[i - 1].z + 2 * out[i].z + out[i + 1].z) / 4;
    }
    out.splice(0, out.length, ...next);
  }
  return out;
}

/** Unconnected nodes this close keep their heights within NEIGHBOUR_STEP of each other. */
const NEIGHBOUR = 50,
  NEIGHBOUR_STEP = 1;

/**
 * Longitudinal profiles: node heights pinned to smoothed terrain, edge profiles low-pass
 * filtered and grade-limited from both ends, bridges straight between abutments. The
 * stretch of each edge inside its junction (its trim) holds the node height, so flat
 * junction polygons meet their bands without a step.
 */
export function solveProfiles(
  graph: RoadGraph,
  f: HeightField,
  trims: [number, number][] = graph.edges.map(() => [0, 0]),
) {
  const terrainAt = (p: Point) => Math.max(0.6, sample(f, p.x, p.z));
  const maxGrade = (kind: string) => (kind === "highway" ? 0.07 : 0.1);
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
  // Junction plateaus hold their node height, so a road between two nodes can only
  // climb over the stretch between its plateaus. Pull node heights together until
  // every road can meet its grade limit there; otherwise its profile would step.
  const free = graph.edges.map((e) => {
    const length = polylineLength(e.points),
      [t0, t1] = trims[e.id];
    // Steps under half a metre are ignored by the grade checks, so that is the floor.
    return Math.max(0.5, length - Math.min(length, t0 + t1));
  });
  // What each road can climb between its plateaus: its grade limit over the free
  // stretch, less where its bends are tight.
  const climb = graph.edges.map((e) => {
    const grades = bendGrades(e.points, maxGrade(e.kind)),
      length = polylineLength(e.points),
      [t0, t1] = trims[e.id];
    let capacity = 0,
      covered = 0,
      start = 0;
    for (let i = 1; i < e.points.length; i++) {
      const run = dist(e.points[i - 1], e.points[i]),
        overlap = Math.max(0, Math.min(start + run, length - t1) - Math.max(start, t0));
      capacity += grades[i - 1] * overlap;
      covered += overlap;
      start += run;
    }
    // A road whose plateaus leave less than the floor still gets the floor at its limit.
    return capacity + maxGrade(e.kind) * Math.max(0, free[e.id] - covered);
  });
  // Plateaus of nodes that no road joins can still sit a few metres apart, such as
  // two dead ends facing each other: the one 8 m terrain cell between them would have
  // to climb the whole difference and tilt the streets on it.
  const joined = new Set(graph.edges.map((e) => e.a * graph.nodes.length + e.b));
  const close: [number, number][] = [];
  for (const a of graph.nodes)
    for (const b of graph.nodes)
      if (
        a.id < b.id &&
        dist(a, b) < NEIGHBOUR &&
        !joined.has(a.id * graph.nodes.length + b.id) &&
        !joined.has(b.id * graph.nodes.length + a.id)
      )
        close.push([a.id, b.id]);
  for (let pass = 0; pass < 200; pass++) {
    let worst = 0;
    for (const [i, j] of close) {
      const a = graph.nodes[i],
        b = graph.nodes[j],
        excess = Math.abs(a.y - b.y) - NEIGHBOUR_STEP;
      if (excess <= 0) continue;
      worst = Math.max(worst, excess);
      const step = (Math.sign(a.y - b.y) * excess) / 2;
      a.y -= step;
      b.y += step;
    }
    for (const e of graph.edges) {
      if (e.bridge || e.a === e.b) continue;
      const a = graph.nodes[e.a],
        b = graph.nodes[e.b],
        excess = Math.abs(a.y - b.y) - 0.95 * climb[e.id];
      if (excess <= 0) continue;
      worst = Math.max(worst, excess);
      const step = (Math.sign(a.y - b.y) * excess) / 2;
      a.y -= step;
      b.y += step;
    }
    if (worst < 0.01) break;
  }
  for (const e of graph.edges) {
    const length = polylineLength(e.points);
    let [t0, t1] = trims[e.id];
    if (t0 + t1 > length) {
      t0 = (length * t0) / (t0 + t1);
      t1 = length - t0;
    }
    // Put a point exactly on each junction mouth so the plateau ends there.
    for (const s of [t0, length - t1]) {
      if (s <= 0.05 || s >= length - 0.05) continue;
      let run = 0;
      for (let i = 1; i < e.points.length; i++) {
        const d = dist(e.points[i - 1], e.points[i]);
        if (run + d > s) {
          if (s - run > 0.05 && run + d - s > 0.05)
            e.points.splice(
              i,
              0,
              lerpPoint(e.points[i - 1], e.points[i], (s - run) / d),
            );
          break;
        }
        run += d;
      }
    }
    const pts = e.points,
      n = pts.length,
      along = [0];
    for (let i = 1; i < n; i++) along.push(along[i - 1] + dist(pts[i - 1], pts[i]));
    const ya = graph.nodes[e.a].y,
      yb = graph.nodes[e.b].y;
    const pin = (h: number[]) => {
      for (let i = 0; i < n; i++)
        if (along[i] <= t0 + 0.05) h[i] = ya;
        else if (along[i] >= length - t1 - 0.05) h[i] = yb;
    };
    if (e.bridge) {
      const span = Math.max(1e-6, length - t0 - t1);
      e.heights = along.map(
        (s) => ya + (yb - ya) * Math.min(1, Math.max(0, (s - t0) / span)),
      );
      continue;
    }
    const heights = pts.map(terrainAt);
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
    pin(smooth);
    const grades = bendGrades(pts, maxGrade(e.kind));
    // Sweep both ways until no step exceeds the limit: re-pinning the plateaus after
    // each sweep can otherwise leave a steeper step beside them.
    for (let pass = 0; pass < 60; pass++) {
      let clamped = false;
      for (let i = 1; i < n; i++) {
        const d = along[i] - along[i - 1] || 1,
          delta = smooth[i] - smooth[i - 1],
          limit = grades[i - 1];
        if (Math.abs(delta) > limit * d) {
          smooth[i] = smooth[i - 1] + Math.sign(delta) * limit * d;
          clamped = true;
        }
      }
      pin(smooth);
      for (let i = n - 2; i >= 0; i--) {
        const d = along[i + 1] - along[i] || 1,
          delta = smooth[i] - smooth[i + 1],
          limit = grades[i];
        if (Math.abs(delta) > limit * d) {
          smooth[i] = smooth[i + 1] + Math.sign(delta) * limit * d;
          clamped = true;
        }
      }
      pin(smooth);
      if (!clamped) break;
    }
    e.heights = smooth;
  }
}

/** Stamp road corridors and junction plateaus into the heightfield (weighted blend). */
export function stampRoads(f: HeightField, graph: RoadGraph, geometry: RoadGeometry) {
  const { w, h } = f,
    original = Float32Array.from(f.data),
    acc = new Float32Array(w * h),
    weight = new Float32Array(w * h),
    best = new Float32Array(w * h),
    edge = new Float32Array(w * h).fill(Infinity);
  // The flat corridor reaches well past the sidewalk: the terrain grid is 8 m, so a
  // bank that starts at the kerb puts the nearest grid point outside the sidewalk
  // already on the slope, and the sidewalk tilts with it.
  const shoulder = SIDEWALK + 4;
  // Where flat corridors overlap, the road whose kerb is nearest sets the height;
  // averaging neighbouring roads at different heights would suit neither.
  const contribute = (i: number, wgt: number, y: number, kerb: number) => {
    const flat = wgt >= 1 - 1e-6;
    if (
      wgt > best[i] + 1e-6 ||
      (flat && best[i] >= 1 - 1e-6 && kerb < edge[i] - 0.25)
    ) {
      best[i] = wgt;
      edge[i] = kerb;
      acc[i] = wgt * y;
      weight[i] = wgt;
    } else if (wgt >= best[i] - 1e-6 && (!flat || kerb < edge[i] + 0.25)) {
      edge[i] = Math.min(edge[i], kerb);
      acc[i] += wgt * y;
      weight[i] += wgt;
    }
  };
  const stampSegment = (
    a: Point,
    b: Point,
    ya: number,
    yb: number,
    hw: number,
    kerb = hw,
  ) => {
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
    // A grid cell the paved strip reaches into puts all four corners on the street's
    // level: one corner left on the bank would tilt the sidewalk across that cell.
    const paved = hw + SIDEWALK,
      samples = Math.ceil(Math.sqrt(l2)) + 1;
    const touched = (gx: number, gz: number) => {
      for (const cz of [gz - 1, gz])
        for (const cx of [gx - 1, gx]) {
          const lx = cx * f.cell - f.size / 2,
            lz = cz * f.cell - f.size / 2;
          for (let s = 0; s <= samples; s++) {
            const qx = a.x + (ab.x * s) / samples,
              qz = a.z + (ab.z * s) / samples;
            if (
              Math.hypot(
                Math.max(lx - qx, 0, qx - lx - f.cell),
                Math.max(lz - qz, 0, qz - lz - f.cell),
              ) <= paved
            )
              return true;
          }
        }
      return false;
    };
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
        const flat = hw + shoulder,
          level = d <= flat || (d <= paved + 2 * f.cell && touched(x, z));
        if (!level && d > flat + bank) continue;
        const wgt = level ? 1 : 1 - smoothstep(0, 1, (d - flat) / bank);
        contribute(i, wgt, y, d - kerb);
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
    // Profiles hold the node height across the whole ring, so the plateau covers
    // it, corner sidewalks included. Beyond the nearest mouth the bands take over.
    let r = 0,
      mouth = Infinity;
    for (const p of j.polygon) r = Math.max(r, dist(n, p));
    for (const id of n.edges) {
      const e = graph.edges[id];
      if (e.a === n.id) mouth = Math.min(mouth, geometry.trims[id][0]);
      if (e.b === n.id) mouth = Math.min(mouth, geometry.trims[id][1]);
    }
    stampSegment(n, { x: n.x + 0.01, z: n.z }, n.y, n.y, r, Math.min(r, mouth));
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
