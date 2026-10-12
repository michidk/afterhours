import { cellSlope, sample, toWorld } from "./field.ts";
import {
  dist,
  lerpPoint,
  norm,
  perp,
  pointInPolygon,
  rotatedRect,
  SpatialHash,
  sub,
} from "./geom.ts";
import type { Hydrology } from "./hydrology.ts";
import { Noise, derive } from "./random.ts";
import type {
  Block,
  BuildingPlacement,
  HeightField,
  Lamp,
  Park,
  Point,
  RoadGraph,
  Tree,
} from "./types.ts";

export interface VegetationInputs {
  field: HeightField;
  hydro: Hydrology;
  graph: RoadGraph;
  blocks: Block[];
  buildings: BuildingPlacement[];
  desirability: Float32Array;
  seed: number;
}

/** Parks are the blocks that zoning set aside: riverside when they touch water. */
export function makeParks(blocks: Block[], hydro: Hydrology, f: HeightField): Park[] {
  const parks: Park[] = [];
  for (const b of blocks) {
    if (b.zone !== "park") continue;
    let nearWater = false;
    for (const p of b.interior) {
      const x = Math.round((p.x + f.size / 2) / f.cell),
        z = Math.round((p.z + f.size / 2) / f.cell);
      if (
        x >= 0 &&
        z >= 0 &&
        x < f.w &&
        z < f.h &&
        hydro.waterDistance[z * f.w + x] < 30
      )
        nearWater = true;
    }
    const steep = b.interior.some((p) => {
      const x = Math.round((p.x + f.size / 2) / f.cell),
        z = Math.round((p.z + f.size / 2) / f.cell);
      return x > 0 && z > 0 && x < f.w - 1 && z < f.h - 1 && cellSlope(f, x, z) > 0.2;
    });
    parks.push({
      polygon: b.interior,
      kind: nearWater ? "riverside" : steep ? "woodland" : "garden",
    });
  }
  return parks;
}

/**
 * Stage 6: trees by variable-radius Poisson-disc sampling over a suitability raster
 * (slope, moisture, distance to roads and buildings, land use), species by elevation
 * and moisture; street trees and lamps along sidewalks.
 */
export function placeVegetation(input: VegetationInputs): {
  trees: Tree[];
  lamps: Lamp[];
} {
  const { field: f, hydro, graph, blocks, buildings, desirability, seed } = input;
  const rng = derive(seed, "trees"),
    noise = new Noise(derive(seed, "forest"));
  const trees: Tree[] = [],
    lamps: Lamp[] = [];
  // Occupancy: cells that roads or footprints claim, with clearance.
  const roadDistance = roadDistanceField(f, graph);
  const footprints = new SpatialHash<BuildingPlacement>(64);
  for (const b of buildings) footprints.insert(b);
  const blockIndex = new SpatialHash<{ x: number; z: number; block: Block }>(128);
  for (const b of blocks) {
    const c = b.interior.reduce(
      (s, p) => ({
        x: s.x + p.x / b.interior.length,
        z: s.z + p.z / b.interior.length,
      }),
      { x: 0, z: 0 },
    );
    blockIndex.insert({ ...c, block: b });
  }
  const zoneAt = (p: Point) => {
    for (const entry of blockIndex.near(p.x, p.z, 450))
      if (pointInPolygon(p, entry.block.interior)) return entry.block.zone;
    return undefined;
  };
  const suitability = (x: number, z: number) => {
    const i = z * f.w + x,
      h = f.data[i];
    if (h <= 0.5) return 0;
    const s = cellSlope(f, x, z);
    const slopeTerm =
      s < 0.05 ? 0.75 : s < 0.45 ? 1 : Math.max(0, 1 - (s - 0.45) / 0.3);
    const water = hydro.waterDistance[i];
    const moisture =
      water < 8 ? 0 : water < 120 ? 1 : Math.max(0.35, 1 - (water - 120) / 900);
    const road = roadDistance[i];
    const roadTerm = road < 9 ? 0 : Math.min(1, (road - 9) / 10);
    const n = 0.6 + 0.4 * noise.fbm(x * 0.05, z * 0.05, 2);
    return slopeTerm * moisture * roadTerm * n;
  };
  // Poisson disc on the cell grid: visit cells in a seeded random order with
  // radius scaled by (1 - suitability) and a land-use multiplier.
  const placed = new SpatialHash<Tree>(32);
  const cells: number[] = [];
  for (let z = 1; z < f.h - 1; z++)
    for (let x = 1; x < f.w - 1; x++) cells.push(z * f.w + x);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  for (const i of cells) {
    const x = i % f.w,
      z = (i - x) / f.w;
    const s = suitability(x, z);
    if (s < 0.08) continue;
    const p = toWorld(f, x + rng() - 0.5, z + rng() - 0.5);
    if (sample(f, p.x, p.z) <= 0.4) continue;
    const zone = zoneAt(p);
    let density = 1;
    if (zone === "core" || zone === "commercial" || zone === "industrial") continue;
    if (zone === "residential") density = 0.22;
    if (zone === "suburb") density = 0.5;
    if (zone === "park") density = 1.1;
    if (zone === undefined) density = 0.55 + 0.45 * (1 - desirability[i]);
    const radius = (4 + (1 - s) * 22) / density;
    if (placed.near(p.x, p.z, radius).some((t) => dist(t, p) < radius)) continue;
    if (footprints.near(p.x, p.z, 60).some((b) => insideRect(p, b, 3))) continue;
    const h = sample(f, p.x, p.z),
      water = hydro.waterDistance[i];
    const kind: Tree["kind"] =
      h < 3 && hydro.coastDistance[i] < 90
        ? "palm"
        : h > 70 || cellSlope(f, x, z) > 0.3
          ? rng() < 0.8
            ? "pine"
            : "shrub"
          : water < 60 || rng() < 0.7
            ? "oak"
            : "shrub";
    const tree: Tree = {
      x: Math.round(p.x * 10) / 10,
      z: Math.round(p.z * 10) / 10,
      h:
        kind === "shrub"
          ? 2 + rng() * 1.5
          : kind === "palm"
            ? 7 + rng() * 4
            : 6 + rng() * 6,
      kind,
    };
    trees.push(tree);
    placed.insert(tree);
  }
  // Street trees and lamps along sidewalks, skipping junction approaches.
  for (const e of graph.edges) {
    if (e.bridge || e.kind === "highway") continue;
    const spacing = e.kind === "avenue" ? 30 : 40,
      offset = e.width / 2 + 1.4;
    let s = 0,
      nextLamp = 14,
      nextTree = 24,
      side = 1;
    const total = e.points.reduce(
      (acc, p, i) => (i ? acc + dist(e.points[i - 1], p) : 0),
      0,
    );
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1],
        b = e.points[i],
        d = dist(a, b),
        t = norm(sub(b, a)),
        n = perp(t);
      while (nextLamp <= s + d && nextLamp < total - 12) {
        const p = lerpPoint(a, b, (nextLamp - s) / d);
        lamps.push({
          x: p.x + n.x * offset * side,
          z: p.z + n.z * offset * side,
          h: 6,
        });
        side = -side;
        nextLamp += spacing;
      }
      if (e.kind !== "lane")
        while (nextTree <= s + d && nextTree < total - 14) {
          const p = lerpPoint(a, b, (nextTree - s) / d);
          for (const sd of [-1, 1]) {
            const q = {
              x: p.x + n.x * (offset + 0.4) * sd,
              z: p.z + n.z * (offset + 0.4) * sd,
            };
            const zone = zoneAt(q);
            if (zone === "industrial") continue;
            if (sample(f, q.x, q.z) <= 0.4) continue;
            if (footprints.near(q.x, q.z, 60).some((bb) => insideRect(q, bb, 1.5)))
              continue;
            const kind: Tree["kind"] =
              hydro.coastDistance[cellOf(f, q)] < 120 ? "palm" : "oak";
            const tree: Tree = { x: q.x, z: q.z, h: kind === "palm" ? 8 : 7, kind };
            trees.push(tree);
            placed.insert(tree);
          }
          nextTree += spacing * 1.2;
        }
      s += d;
    }
  }
  return { trees, lamps };
}
const cellOf = (f: HeightField, p: Point) => {
  const x = Math.max(0, Math.min(f.w - 1, Math.round((p.x + f.size / 2) / f.cell))),
    z = Math.max(0, Math.min(f.h - 1, Math.round((p.z + f.size / 2) / f.cell)));
  return z * f.w + x;
};
function insideRect(p: Point, b: BuildingPlacement, pad: number) {
  const r = rotatedRect(b, b.w + pad * 2, b.d + pad * 2, b.angle);
  return pointInPolygon(p, r);
}
/** Distance in metres from every cell to the nearest road centreline. */
function roadDistanceField(f: HeightField, graph: RoadGraph) {
  const out = new Float32Array(f.w * f.h).fill(1e6);
  const half = f.size / 2;
  for (const e of graph.edges)
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1],
        b = e.points[i],
        reach = e.width / 2 + 24;
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach + half) / f.cell)),
        x1 = Math.min(f.w - 1, Math.ceil((Math.max(a.x, b.x) + reach + half) / f.cell)),
        z0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach + half) / f.cell)),
        z1 = Math.min(f.h - 1, Math.ceil((Math.max(a.z, b.z) + reach + half) / f.cell));
      const dx = b.x - a.x,
        dz = b.z - a.z,
        l2 = dx * dx + dz * dz || 1;
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const px = x * f.cell - half,
            pz = z * f.cell - half,
            t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / l2));
          const d = Math.hypot(px - a.x - dx * t, pz - a.z - dz * t) - e.width / 2;
          const i = z * f.w + x;
          if (d < out[i]) out[i] = d;
        }
    }
  return out;
}
