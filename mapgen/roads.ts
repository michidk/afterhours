import { blur, cellSlope, distanceTransform, sample, toWorld } from "./field.ts";
import { dist, lerpPoint, norm, sub } from "./geom.ts";
import { GraphBuilder, ROAD_WIDTH } from "./graph.ts";
import type { Hydrology } from "./hydrology.ts";
import { Noise, derive, type Rng } from "./random.ts";
import type { HeightField, Point, RoadGraph, RoadKind } from "./types.ts";

export interface RoadInputs {
  field: HeightField;
  hydro: Hydrology;
  desirability: Float32Array;
  centre: Point;
  seed: number;
  debug?: boolean;
}

/* ---------------------------------------------------------------- arterials */

const DIRECTIONS: [number, number][] = [];
for (const [dx, dz] of [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
  [2, 1],
  [1, 2],
  [2, -1],
  [1, -2],
  [3, 1],
  [1, 3],
  [3, -1],
  [1, -3],
  [3, 2],
  [2, 3],
  [3, -2],
  [2, -3],
])
  DIRECTIONS.push([dx, dz], [-dx, -dz]);

class CostGrid {
  w: number;
  cell: number;
  height: Float32Array;
  water: Uint8Array;
  sea: Uint8Array;
  blocked: Uint8Array;
  roadDistance: Float32Array;
  desire: Float32Array;
  constructor(
    readonly f: HeightField,
    hydro: Hydrology,
    desirability: Float32Array,
    cell: number,
  ) {
    this.cell = cell;
    this.w = Math.round(f.size / cell) + 1;
    const n = this.w * this.w;
    this.height = new Float32Array(n);
    this.water = new Uint8Array(n);
    this.sea = new Uint8Array(n);
    this.blocked = new Uint8Array(n);
    this.roadDistance = new Float32Array(n).fill(1e6);
    this.desire = new Float32Array(n);
    for (let z = 0; z < this.w; z++)
      for (let x = 0; x < this.w; x++) {
        const p = this.world(x, z),
          i = z * this.w + x;
        this.height[i] = sample(f, p.x, p.z);
        const fx = Math.round((p.x + f.size / 2) / f.cell),
          fz = Math.round((p.z + f.size / 2) / f.cell),
          fi = Math.min(f.w * f.h - 1, Math.max(0, fz * f.w + fx));
        const sea = this.height[i] <= 0;
        this.sea[i] = sea ? 1 : 0;
        this.water[i] =
          sea || hydro.riverMask[fi] || hydro.waterDistance[fi] < 10 ? 1 : 0;
        this.blocked[i] =
          sea || x < 2 || z < 2 || x >= this.w - 2 || z >= this.w - 2 ? 1 : 0;
        this.desire[i] = desirability[fi];
      }
  }
  world(x: number, z: number): Point {
    return { x: x * this.cell - this.f.size / 2, z: z * this.cell - this.f.size / 2 };
  }
  index(p: Point) {
    const x = Math.round((p.x + this.f.size / 2) / this.cell),
      z = Math.round((p.z + this.f.size / 2) / this.cell);
    return (
      Math.max(0, Math.min(this.w - 1, z)) * this.w +
      Math.max(0, Math.min(this.w - 1, x))
    );
  }
  /** Rebuild the distance to existing arterials after each route. */
  markRoads(polylines: Point[][]) {
    const mask = new Uint8Array(this.w * this.w);
    for (const line of polylines)
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1],
          b = line[i],
          steps = Math.ceil(dist(a, b) / (this.cell * 0.5));
        for (let s = 0; s <= steps; s++)
          mask[this.index(lerpPoint(a, b, s / steps))] = 1;
      }
    const d = distanceTransform(mask, this.w, this.w);
    for (let i = 0; i < d.length; i++) this.roadDistance[i] = d[i] * this.cell;
  }
}

function routeArterial(grid: CostGrid, from: Point, to: Point, kind: RoadKind) {
  const { w, cell } = grid,
    maxGrade = kind === "highway" ? 0.07 : 0.1,
    maxBridge = 7 * cell;
  const start = grid.index(from),
    goal = grid.index(to);
  const g = new Float64Array(w * w).fill(Infinity),
    parent = new Int32Array(w * w).fill(-1),
    closed = new Uint8Array(w * w);
  const heapKeys: number[] = [],
    heapVals: number[] = [];
  const push = (key: number, val: number) => {
    let i = heapKeys.length;
    heapKeys.push(key);
    heapVals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapKeys[p] <= heapKeys[i]) break;
      [heapKeys[p], heapKeys[i]] = [heapKeys[i], heapKeys[p]];
      [heapVals[p], heapVals[i]] = [heapVals[i], heapVals[p]];
      i = p;
    }
  };
  const pop = () => {
    const val = heapVals[0],
      lastKey = heapKeys.pop()!,
      lastVal = heapVals.pop()!;
    if (heapKeys.length) {
      heapKeys[0] = lastKey;
      heapVals[0] = lastVal;
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= heapKeys.length) break;
        if (c + 1 < heapKeys.length && heapKeys[c + 1] < heapKeys[c]) c++;
        if (heapKeys[i] <= heapKeys[c]) break;
        [heapKeys[c], heapKeys[i]] = [heapKeys[i], heapKeys[c]];
        [heapVals[c], heapVals[i]] = [heapVals[i], heapVals[c]];
        i = c;
      }
    }
    return val;
  };
  const gx = goal % w,
    gz = (goal - gx) / w;
  const heuristic = (i: number) => {
    const x = i % w,
      z = (i - x) / w;
    return Math.hypot(x - gx, z - gz) * 0.95;
  };
  g[start] = 0;
  push(heuristic(start), start);
  const moveCost = (i: number, j: number, length: number) => {
    // Sample along the move; water needs a bridge, steep grades are forbidden.
    const dh = grid.height[j] - grid.height[i],
      grade = Math.abs(dh) / (length * cell);
    if (grade > maxGrade) return Infinity;
    const steps = Math.ceil(length * 2);
    let water = 0,
      cost = 0;
    const ix = i % w,
      iz = (i - ix) / w,
      jx = j % w,
      jz = (j - jx) / w;
    for (let s = 1; s < steps; s++) {
      const t = s / steps,
        x = Math.round(ix + (jx - ix) * t),
        z = Math.round(iz + (jz - iz) * t),
        k = z * w + x;
      if (grid.blocked[k]) return Infinity;
      if (grid.water[k]) water++;
      else {
        const rd = grid.roadDistance[k];
        cost += 1 + 7 * (grade / maxGrade) ** 2 + 1.6 * (1 - grid.desire[k]);
        cost += rd < 70 ? 2.5 * (1 - rd / 70) : 0;
        if (rd < 1.5 * cell) cost -= 0.6;
      }
    }
    if (water) {
      if (water > steps - 2 || length * cell > maxBridge) return Infinity;
      cost += 26 * water;
    }
    return (cost / Math.max(1, steps - 1)) * length;
  };
  while (heapKeys.length) {
    const i = pop();
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === goal) break;
    const x = i % w,
      z = (i - x) / w;
    for (const [dx, dz] of DIRECTIONS) {
      const nx = x + dx,
        nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= w || nz >= w) continue;
      const j = nz * w + nx;
      if (closed[j] || grid.blocked[j]) continue;
      const c = moveCost(i, j, Math.hypot(dx, dz));
      if (c === Infinity) continue;
      const total = g[i] + c;
      if (total < g[j]) {
        g[j] = total;
        parent[j] = i;
        push(total + heuristic(j), j);
      }
    }
  }
  if (parent[goal] < 0 && goal !== start) return undefined;
  const cells: number[] = [];
  for (let i = goal; i >= 0; i = parent[i]) {
    cells.push(i);
    if (i === start) break;
  }
  cells.reverse();
  const points = cells.map((i) => grid.world(i % w, Math.floor(i / w)));
  const bridges = cells.map((i) => grid.water[i] === 1);
  return { points, bridges };
}

/** Chaikin corner cutting keeps the first and last point and softens zig-zags. */
function smoothPath(points: Point[], passes: number) {
  let out = points;
  for (let p = 0; p < passes; p++) {
    if (out.length < 3) break;
    const next: Point[] = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      next.push(
        lerpPoint(out[i], out[i + 1], 0.25),
        lerpPoint(out[i], out[i + 1], 0.75),
      );
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}
function resample(points: Point[], spacing: number) {
  const out: Point[] = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      d = dist(a, b);
    let t = spacing - carry;
    while (t <= d) {
      out.push(lerpPoint(a, b, t / d));
      t += spacing;
    }
    carry = d - (t - spacing);
  }
  if (dist(out[out.length - 1], points[points.length - 1]) > spacing * 0.3)
    out.push(points[points.length - 1]);
  else out[out.length - 1] = points[points.length - 1];
  return out;
}

/* ------------------------------------------------------------- tensor field */

export class TensorField {
  private boundary: Float32Array; // [tx, tz] pairs per cell of the summed boundary tensor
  private bw: number;
  private bcell = 16;
  private noise: Noise;
  constructor(
    private f: HeightField,
    private centre: Point,
    private gridAngle: number,
    private coreRadius: number,
    seed: number,
  ) {
    this.bw = Math.round(f.size / this.bcell) + 1;
    this.boundary = new Float32Array(this.bw * this.bw * 2);
    this.noise = new Noise(derive(seed, "field-noise"));
  }
  /** Splat a polyline's tangents into nearby cells with a linear falloff. */
  addBoundary(line: Point[], radius: number, weight: number) {
    const rc = Math.ceil(radius / this.bcell);
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1],
        b = line[i],
        d = dist(a, b);
      if (d < 0.1) continue;
      const angle = Math.atan2(b.z - a.z, b.x - a.x),
        tx = Math.cos(2 * angle),
        tz = Math.sin(2 * angle);
      const steps = Math.max(1, Math.ceil(d / this.bcell));
      for (let s = 0; s < steps; s++) {
        const p = lerpPoint(a, b, s / steps);
        const cx = Math.round((p.x + this.f.size / 2) / this.bcell),
          cz = Math.round((p.z + this.f.size / 2) / this.bcell);
        for (let dz = -rc; dz <= rc; dz++)
          for (let dx = -rc; dx <= rc; dx++) {
            const x = cx + dx,
              z = cz + dz;
            if (x < 0 || z < 0 || x >= this.bw || z >= this.bw) continue;
            const dd = Math.hypot(dx, dz) * this.bcell;
            if (dd > radius) continue;
            const wgt = weight * (1 - dd / radius) ** 2;
            const k = (z * this.bw + x) * 2;
            this.boundary[k] += tx * wgt;
            this.boundary[k + 1] += tz * wgt;
          }
      }
    }
  }
  /** Major eigenvector direction (unit) and field magnitude at a point. */
  at(p: Point) {
    let tx = 0,
      tz = 0;
    const dc = dist(p, this.centre);
    // Grid in the core, fading out; radial rings beyond it.
    const gridW = 1.2 * Math.max(0, 1 - dc / (this.coreRadius * 1.6)) ** 1.5;
    tx += gridW * Math.cos(2 * this.gridAngle);
    tz += gridW * Math.sin(2 * this.gridAngle);
    const rel = sub(p, this.centre),
      radialW = 0.45 * Math.min(1, dc / this.coreRadius);
    const rl = Math.hypot(rel.x, rel.z) || 1;
    const rr = { x: rel.x / rl, z: rel.z / rl };
    // Ring direction is perpendicular to the radius; tensor of angle θ+π/2 is (−cos2θ, −sin2θ).
    tx += -radialW * (rr.x * rr.x - rr.z * rr.z);
    tz += -radialW * (2 * rr.x * rr.z);
    const cx = Math.round((p.x + this.f.size / 2) / this.bcell),
      cz = Math.round((p.z + this.f.size / 2) / this.bcell);
    if (cx >= 0 && cz >= 0 && cx < this.bw && cz < this.bw) {
      const k = (cz * this.bw + cx) * 2;
      tx += this.boundary[k];
      tz += this.boundary[k + 1];
    }
    // Contours: terraces on slopes, weighted by steepness.
    const e = this.f.cell;
    const gx = (sample(this.f, p.x + e, p.z) - sample(this.f, p.x - e, p.z)) / (2 * e),
      gz = (sample(this.f, p.x, p.z + e) - sample(this.f, p.x, p.z - e)) / (2 * e);
    const s = Math.hypot(gx, gz);
    if (s > 0.02) {
      const cw = 1.6 * Math.min(1, (s - 0.02) / 0.1),
        ca = Math.atan2(gz, gx) + Math.PI / 2;
      tx += cw * Math.cos(2 * ca);
      tz += cw * Math.sin(2 * ca);
    }
    const magnitude = Math.hypot(tx, tz);
    let angle = Math.atan2(tz, tx) / 2;
    // Organic drift outside the core.
    const organic = Math.min(
      1,
      Math.max(0, (dc - this.coreRadius * 0.8) / this.coreRadius),
    );
    angle += organic * 0.45 * this.noise.fbm(p.x / 260 + 3, p.z / 260 - 8, 2);
    return { dir: { x: Math.cos(angle), z: Math.sin(angle) }, magnitude };
  }
}

/* --------------------------------------------------------------- streamlines */

interface Sample extends Point {
  tx: number;
  tz: number;
  cls: number;
}
class SampleIndex {
  private cells = new Map<string, Sample[]>();
  constructor(private cell: number) {}
  private key = (x: number, z: number) =>
    `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  add(s: Sample) {
    const k = this.key(s.x, s.z),
      list = this.cells.get(k);
    if (list) list.push(s);
    else this.cells.set(k, [s]);
  }
  /** Nearest sample within radius, optionally restricted to one class. */
  nearest(x: number, z: number, radius: number, cls?: number) {
    let best: Sample | undefined,
      bestD = radius;
    const r = Math.ceil(radius / this.cell),
      cx = Math.floor(x / this.cell),
      cz = Math.floor(z / this.cell);
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++) {
        const list = this.cells.get(`${cx + i},${cz + j}`);
        if (!list) continue;
        for (const s of list) {
          if (cls !== undefined && s.cls !== cls) continue;
          const d = Math.hypot(s.x - x, s.z - z);
          if (d < bestD) {
            bestD = d;
            best = s;
          }
        }
      }
    return best;
  }
}

interface TraceParams {
  dsep: number;
  dtest: number;
  maxLength: number;
  minDesire: number;
  maxSlope: number;
}

/**
 * Stage 2: arterials by least-cost routing between settlement anchors, then streets
 * as hyperstreamlines of a tensor field. Everything is inserted into one planar
 * graph with snapping, then cleaned.
 */
export function generateRoads(
  input: RoadInputs,
  progress?: (s: string) => void,
): RoadGraph {
  const { field: f, hydro, desirability, centre, seed } = input;
  const rng = derive(seed, "roads");
  const graph = new GraphBuilder();
  const grid = new CostGrid(f, hydro, desirability, 12);
  const anchors = pickAnchors(f, hydro, desirability, centre, rng);
  const arterials: Point[][] = [];
  const isLand = (p: Point) => sample(f, p.x, p.z) > 0.3;
  const slopeAt = (p: Point) => {
    // A two-cell baseline ignores single-cell roughness that a road would grade over.
    const e = f.cell * 2;
    return Math.hypot(
      (sample(f, p.x + e, p.z) - sample(f, p.x - e, p.z)) / (2 * e),
      (sample(f, p.x, p.z + e) - sample(f, p.x, p.z - e)) / (2 * e),
    );
  };
  const waterDistance = (p: Point) => {
    const x = Math.round((p.x + f.size / 2) / f.cell),
      z = Math.round((p.z + f.size / 2) / f.cell);
    if (x < 0 || z < 0 || x >= f.w || z >= f.h) return 0;
    return hydro.waterDistance[z * f.w + x];
  };
  const desireAt = (p: Point) => {
    const x = Math.round((p.x + f.size / 2) / f.cell),
      z = Math.round((p.z + f.size / 2) / f.cell);
    if (x < 0 || z < 0 || x >= f.w || z >= f.h) return 0;
    return desirability[z * f.w + x];
  };
  // Insert a polyline into the graph; snapping may sever it at existing roads.
  const insertPolyline = (
    points: Point[],
    kind: RoadKind,
    bridges?: boolean[],
    snap = 16,
  ) => {
    if (points.length < 2) return;
    let from = -1;
    const startNear = graph.nodesNear(points[0].x, points[0].z, snap);
    if (startNear.length)
      from = startNear.sort(
        (a, b) => dist(graph.nodes[a], points[0]) - dist(graph.nodes[b], points[0]),
      )[0];
    else from = graph.addNode(points[0].x, points[0].z);
    for (let i = 1; i < points.length; i++) {
      const target = points[i];
      if (dist(graph.nodes[from], target) < 6 && i < points.length - 1) continue;
      const result = graph.insert(from, target, kind, { snap }, bridges?.[i] ?? false);
      if (!result) {
        // Try to continue from the nearest existing node instead of stopping.
        const near = graph.nodesNear(target.x, target.z, snap);
        if (!near.length) return;
        from = near[0];
        continue;
      }
      from = result.node;
    }
  };

  progress?.("arterials");
  const connections = anchorConnections(anchors, grid);
  for (const [i, j, kind] of connections) {
    const route = routeArterial(grid, anchors[i], anchors[j], kind);
    if (!route) continue;
    // Keep bridge runs straight: smooth only land stretches.
    const smoothed = smoothPath(route.points, 2);
    const pts = resample(smoothed, 26);
    const bridges = pts.map((p) => {
      const d = waterDistance(p);
      return d < ROAD_WIDTH[kind] / 2 + 2;
    });
    // A segment is a bridge when either endpoint lies over water.
    const segBridge = pts.map((_, k) => k > 0 && (bridges[k] || bridges[k - 1]));
    insertPolyline(pts, kind, segBridge, 22);
    arterials.push(pts);
    grid.markRoads(arterials);
  }

  progress?.("streets");
  const coreRadius = 420;
  const tensor = new TensorField(f, centre, rng() * Math.PI, coreRadius, seed);
  for (const line of arterials) tensor.addBoundary(line, 220, 2.2);
  for (const river of hydro.rivers) tensor.addBoundary(river.points, 160, 1.4);
  for (const ring of coastlines(f)) tensor.addBoundary(ring, 200, 1.2);
  const samples = new SampleIndex(24);
  // Existing arterials are obstacles for both street directions.
  for (const line of arterials)
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1],
        b = line[i],
        t = norm(sub(b, a)),
        steps = Math.ceil(dist(a, b) / 8);
      for (let s = 0; s <= steps; s++) {
        const p = lerpPoint(a, b, s / steps);
        samples.add({ x: p.x, z: p.z, tx: t.x, tz: t.z, cls: -1 });
      }
    }
  // Street spacing grows as desirability falls: tight core blocks, loose suburbs.
  const levels: {
    params: TraceParams;
    spacing: (d: number) => number;
    kind: (p: Point) => RoadKind;
  }[] = [
    {
      params: {
        dsep: 240,
        dtest: 80,
        maxLength: 1600,
        minDesire: 0.12,
        maxSlope: 0.14,
      },
      spacing: (d) => 170 + 150 * (1 - d),
      kind: (p) => (dist(p, centre) < coreRadius ? "avenue" : "street"),
    },
    {
      params: {
        dsep: 110,
        dtest: 42,
        maxLength: 1000,
        minDesire: 0.18,
        maxSlope: 0.16,
      },
      spacing: (d) => 80 + 95 * (1 - d),
      kind: () => "street",
    },
  ];
  // Seed order: most desirable cells first, so the core fills before suburbs.
  const seedOrder: number[] = [],
    lattice = Math.max(1, Math.round(24 / f.cell));
  for (let z = 1; z < f.h - 1; z += lattice)
    for (let x = 1; x < f.w - 1; x += lattice) {
      const i = z * f.w + x;
      if (desirability[i] > 0.12) seedOrder.push(i);
    }
  seedOrder.sort((a, b) => desirability[b] - desirability[a] || a - b);
  let classId = 0;
  const stats = { seeds: 0, blocked: 0, traced: 0, short: 0 },
    reasons: Record<string, number> = {};
  for (const level of levels) {
    for (const major of [true, false]) {
      const cls = classId++;
      // Jobard–Lefer: every accepted line proposes new seeds one spacing away on
      // both sides, so lines pack at the intended separation instead of leaving
      // gaps of up to twice the spacing between random seeds.
      const queue: Point[] = [];
      const attempt = (seed: Point, desire: number) => {
        stats.seeds++;
        if (desire < level.params.minDesire) return false;
        const dsep = level.spacing(desire);
        // Separation applies within a class; crossing classes and arterials only
        // stop a trace when it runs parallel to them.
        if (samples.nearest(seed.x, seed.z, dsep * 0.92, cls)) {
          stats.blocked++;
          return false;
        }
        if (waterDistance(seed) < 20 || !isLand(seed)) return false;
        const line = traceStreamline(
          seed,
          major,
          { ...level.params, dsep, dtest: dsep * 0.45 },
          tensor,
          samples,
          cls,
          { isLand, slopeAt, waterDistance, desireAt, reasons },
        );
        if (!line || line.length < 3) {
          stats.short++;
          return false;
        }
        stats.traced++;
        const kind = level.kind(seed);
        const pts = resample(line, 22);
        for (let k = 0; k < pts.length; k++) {
          const p = pts[k],
            t = norm(
              sub(pts[Math.min(pts.length - 1, k + 1)], pts[Math.max(0, k - 1)]),
            );
          samples.add({ x: p.x, z: p.z, tx: t.x, tz: t.z, cls });
          if (k % 2 === 0)
            for (const side of [-1, 1]) {
              const spacing = level.spacing(desireAt(p));
              queue.push({
                x: p.x - t.z * spacing * side,
                z: p.z + t.x * spacing * side,
              });
            }
        }
        insertPolyline(pts, kind, undefined, 14);
        return true;
      };
      for (const i of seedOrder) {
        if (desirability[i] < level.params.minDesire) break;
        const x = i % f.w;
        if (!attempt(toWorld(f, x, (i - x) / f.w), desirability[i])) continue;
        while (queue.length) {
          const candidate = queue.shift()!;
          attempt(candidate, desireAt(candidate));
        }
      }
    }
  }
  if (input.debug)
    console.error(
      "streets",
      stats,
      reasons,
      "anchors",
      anchors.length,
      "edges",
      graph.edges.filter((e) => e.alive).length,
    );
  progress?.("cleanup");
  graph.cleanup({ minEdge: 12, minStub: 45, debug: input.debug });
  graph.bridgeRivers(hydro.rivers);
  if (input.debug)
    console.error("after cleanup", graph.edges.filter((e) => e.alive).length);
  const result = graph.toRoadGraph();
  return { nodes: result.nodes, edges: result.edges };
}

/** Settlement anchors: the centre plus secondary nuclei on distinct desirable patches. */
function pickAnchors(
  f: HeightField,
  hydro: Hydrology,
  desirability: Float32Array,
  centre: Point,
  rng: Rng,
) {
  const anchors: Point[] = [centre];
  const wide = blur(desirability, f.w, f.h, Math.round(160 / f.cell), 1);
  const order: number[] = [];
  for (let i = 0; i < wide.length; i++) if (wide[i] > 0.04) order.push(i);
  order.sort((a, b) => wide[b] - wide[a] || a - b);
  for (const i of order) {
    if (anchors.length >= 7) break;
    const x = i % f.w,
      p = toWorld(f, x, (i - x) / f.w);
    if (anchors.some((a) => dist(a, p) < 620)) continue;
    if (hydro.waterDistance[i] < 30 || cellSlope(f, x, (i - x) / f.w) > 0.08) continue;
    anchors.push({ x: p.x + (rng() - 0.5) * 20, z: p.z + (rng() - 0.5) * 20 });
  }
  return anchors;
}
/** Relative-neighbourhood graph on the anchors: radials plus a loose ring. */
function anchorConnections(
  anchors: Point[],
  grid: CostGrid,
): [number, number, RoadKind][] {
  const out: [number, number, RoadKind][] = [];
  for (let i = 0; i < anchors.length; i++)
    for (let j = i + 1; j < anchors.length; j++) {
      const d = dist(anchors[i], anchors[j]);
      let lune = false;
      for (let k = 0; k < anchors.length && !lune; k++)
        if (
          k !== i &&
          k !== j &&
          dist(anchors[k], anchors[i]) < d &&
          dist(anchors[k], anchors[j]) < d
        )
          lune = true;
      if (!lune) out.push([i, j, i === 0 && d > 700 ? "highway" : "avenue"]);
    }
  // Route centre connections first so secondary routes can merge into them.
  out.sort(
    (a, b) =>
      (a[0] === 0 ? -1 : 0) - (b[0] === 0 ? -1 : 0) || a[0] - b[0] || a[1] - b[1],
  );
  void grid;
  return out;
}
/** Shoreline rings so streets near the coast run parallel to it. */
function coastlines(f: HeightField): Point[][] {
  const rings: Point[][] = [],
    step = 4;
  // Coarse scan along rows: sample the zero crossing as a chain of short tangents.
  for (let z = step; z < f.h - step; z += step) {
    let line: Point[] = [];
    for (let x = 1; x < f.w; x++) {
      const a = f.data[z * f.w + x - 1],
        b = f.data[z * f.w + x];
      if (a <= 0 !== b <= 0) {
        const t = a / (a - b);
        line.push(toWorld(f, x - 1 + t, z));
      }
    }
    if (line.length > 1) rings.push(line);
    line = [];
  }
  // Vertical scan gives tangents for north/south-facing shores as well.
  const out: Point[][] = [];
  for (let x = step; x < f.w - step; x += step) {
    for (let z = 1; z < f.h; z++) {
      const a = f.data[(z - 1) * f.w + x],
        b = f.data[z * f.w + x];
      if (a <= 0 !== b <= 0) {
        const p = toWorld(f, x, z - 1 + a / (a - b));
        // Local tangent from the height gradient: perpendicular to it.
        const gx =
          f.data[z * f.w + Math.min(f.w - 1, x + 1)] -
          f.data[z * f.w + Math.max(0, x - 1)];
        const gz =
          f.data[Math.min(f.h - 1, z + 1) * f.w + x] -
          f.data[Math.max(0, z - 1) * f.w + x];
        const l = Math.hypot(gx, gz) || 1;
        out.push([
          { x: p.x - (gz / l) * 6, z: p.z + (gx / l) * 6 },
          { x: p.x + (gz / l) * 6, z: p.z - (gx / l) * 6 },
        ]);
      }
    }
  }
  for (const r of rings)
    for (let i = 1; i < r.length; i++)
      if (dist(r[i - 1], r[i]) < f.cell * 3) out.push([r[i - 1], r[i]]);
  return out;
}

function traceStreamline(
  seed: Point,
  major: boolean,
  params: TraceParams,
  tensor: TensorField,
  samples: SampleIndex,
  cls: number,
  env: {
    isLand: (p: Point) => boolean;
    slopeAt: (p: Point) => number;
    waterDistance: (p: Point) => number;
    desireAt: (p: Point) => number;
    reasons?: Record<string, number>;
  },
) {
  const step = 5;
  const stop = (why: string) => {
    if (env.reasons) env.reasons[why] = (env.reasons[why] ?? 0) + 1;
  };
  const direction = (p: Point, previous?: Point) => {
    const t = tensor.at(p);
    if (t.magnitude < 0.03) return undefined;
    let d = major ? t.dir : { x: -t.dir.z, z: t.dir.x };
    if (previous && d.x * previous.x + d.z * previous.z < 0) d = { x: -d.x, z: -d.z };
    return d;
  };
  const trace = (sign: number) => {
    const out: Point[] = [];
    let p = seed,
      prev: Point | undefined = undefined,
      length = 0,
      turned = 0;
    const first = direction(p);
    if (!first) return out;
    prev = { x: first.x * sign, z: first.z * sign };
    while (length < params.maxLength / 2) {
      // Midpoint integration keeps lines smooth without an RK4 budget.
      const d1 = direction(p, prev);
      if (!d1) {
        stop("degenerate");
        break;
      }
      const mid = { x: p.x + (d1.x * step) / 2, z: p.z + (d1.z * step) / 2 };
      const d2 = direction(mid, d1) ?? d1;
      const next = { x: p.x + d2.x * step, z: p.z + d2.z * step };
      if (!env.isLand(next) || env.waterDistance(next) < 12) {
        stop("water");
        break;
      }
      if (env.slopeAt(next) > params.maxSlope) {
        stop("slope");
        break;
      }
      if (env.desireAt(next) < params.minDesire * 0.6) {
        stop("desire");
        break;
      }
      turned += Math.abs(
        Math.atan2(d2.x * prev.z - d2.z * prev.x, d2.x * prev.x + d2.z * prev.z),
      );
      if (turned > Math.PI * 1.1) {
        stop("turned");
        break;
      }
      // Same-class lines keep their separation distance; any other road only stops
      // the trace when it runs nearly parallel (within ~26°) and close enough to
      // overlap, otherwise the trace crosses it and forms a junction.
      const same = samples.nearest(next.x, next.z, params.dtest, cls);
      if (same) {
        out.push(next);
        stop("same-class");
        break;
      }
      const near = samples.nearest(next.x, next.z, 26);
      if (near && Math.abs(near.tx * d2.x + near.tz * d2.z) > 0.9) {
        out.push(next);
        stop("parallel");
        break;
      }
      out.push(next);
      length += step;
      prev = d2;
      p = next;
    }
    return out;
  };
  const forward = trace(1),
    backward = trace(-1);
  // Dangling ends look ahead for a nearby road to join, as ProbableTrain does.
  for (const half of [forward, backward]) {
    if (!half.length) continue;
    const tip = half[half.length - 1];
    const near = samples.nearest(tip.x, tip.z, params.dtest * 1.6);
    if (near && dist(near, tip) > 1) half.push({ x: near.x, z: near.z });
  }
  const line = [...backward.reverse(), seed, ...forward];
  if ((forward.length + backward.length) * step < params.dsep * 0.9) return undefined;
  return line;
}
