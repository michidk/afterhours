import { sample, slope } from "./field.ts";
import {
  area,
  centroid,
  cleanRing,
  closestOnSegment,
  dist,
  insetPolygon,
  orientedBox,
  signedArea,
  splitPolygon,
} from "./geom.ts";
import { planarFaces } from "./graph.ts";
import type { Hydrology } from "./hydrology.ts";
import { derive, type Rng } from "./random.ts";
import { SIDEWALK, simplifyPolyline } from "./roadgeometry.ts";
import type { Block, HeightField, Lot, Point, RoadGraph, Zone } from "./types.ts";

export interface BlockInputs {
  graph: RoadGraph;
  field: HeightField;
  hydro: Hydrology;
  centre: Point;
  seed: number;
}
const LOT_AREA: Record<Zone, [number, number]> = {
  core: [320, 900],
  commercial: [380, 1000],
  residential: [320, 850],
  suburb: [450, 1000],
  industrial: [2000, 6000],
  park: [1e9, 1e9],
  rural: [1e9, 1e9],
};

/**
 * Stage 4: planar faces → inset block interiors → zoning → recursive OBB lot
 * subdivision with a street-frontage requirement.
 */
export function generateBlocks(input: BlockInputs): Block[] {
  const { graph, field: f, hydro, centre, seed } = input;
  const rng = derive(seed, "blocks");
  const faces = planarFaces(graph);
  const blocks: Block[] = [];
  const waterDistance = (p: Point) => {
    const x = Math.round((p.x + f.size / 2) / f.cell),
      z = Math.round((p.z + f.size / 2) / f.cell);
    if (x < 0 || z < 0 || x >= f.w || z >= f.h) return 0;
    return hydro.waterDistance[z * f.w + x];
  };
  for (const face of faces) {
    // Splined street edges carry hundreds of points; simplify before insetting.
    const ring = cleanRing(simplifyPolyline(face.ring, 0.35), 0.2);
    if (ring.length < 3) continue;
    const faceArea = area(ring);
    if (faceArea < 400 || faceArea > 350_000) continue;
    const box = orientedBox(ring);
    if (Math.max(box.w, box.d) > 900) continue;
    // Inset by the widest bounding road's half width plus the sidewalk.
    let widest = 0;
    for (const id of face.edges) widest = Math.max(widest, graph.edges[id].width);
    const interior = insetPolygon(ring, widest / 2 + SIDEWALK);
    if (!interior || area(interior) < 150) continue;
    const c = centroid(interior);
    const zone = zoneFor(c, interior, graph, face.edges, centre, f, waterDistance);
    const block: Block = { id: blocks.length, polygon: ring, interior, zone, lots: [] };
    if (zone !== "park" && zone !== "rural")
      block.lots = subdivide(interior, zone, rng);
    blocks.push(block);
  }
  return blocks;
}

function zoneFor(
  c: Point,
  interior: Point[],
  graph: RoadGraph,
  edges: number[],
  centre: Point,
  f: HeightField,
  waterDistance: (p: Point) => number,
): Zone {
  const d = dist(c, centre),
    a = area(interior);
  let maxSlope = 0,
    minWater = Infinity,
    lowest = Infinity;
  for (const p of [c, ...interior]) {
    maxSlope = Math.max(maxSlope, slope(f, p.x, p.z));
    minWater = Math.min(minWater, waterDistance(p));
    lowest = Math.min(lowest, sample(f, p.x, p.z));
  }
  if (maxSlope > 0.42 || lowest < 1.2 || minWater < 6) return "park";
  if (a < 500) return "park";
  const rank = Math.max(
    ...edges.map((id) =>
      graph.edges[id].kind === "highway"
        ? 3
        : graph.edges[id].kind === "avenue"
          ? 2
          : 1,
    ),
  );
  if (d < 260) return "core";
  if (d < 520) return rank >= 2 ? "commercial" : "residential";
  if (a > 14_000 && rank >= 2 && maxSlope < 0.1 && d > 700) return "industrial";
  if (d < 900) return "residential";
  return "suburb";
}

/** Recursive oriented-bounding-box subdivision with frontage and sliver checks. */
function subdivide(interior: Point[], zone: Zone, rng: Rng): Lot[] {
  const [minArea, maxArea] = LOT_AREA[zone],
    streetEdges = interior.map(
      (p, i) => [p, interior[(i + 1) % interior.length]] as [Point, Point],
    );
  const hasFrontage = (poly: Point[]) => frontageIndex(poly, streetEdges) >= 0;
  const lots: Lot[] = [];
  const recurse = (poly: Point[], depth: number) => {
    const a = area(poly);
    if (a < minArea * 0.35) return;
    if (a <= maxArea || depth > 10) {
      if (a >= minArea * 0.6 && !sliver(poly)) lots.push(makeLot(poly, streetEdges));
      return;
    }
    const box = orientedBox(poly);
    const long =
      box.w >= box.d
        ? { x: Math.cos(box.angle), z: Math.sin(box.angle) }
        : { x: -Math.sin(box.angle), z: Math.cos(box.angle) };
    const length = Math.max(box.w, box.d);
    const t = (rng() - 0.5) * 0.2;
    const at = {
      x: box.centre.x + long.x * t * length,
      z: box.centre.z + long.z * t * length,
    };
    const perp = { x: -long.z, z: long.x };
    let [p, q] = splitPolygon(poly, at, perp);
    if (p.length < 3 || q.length < 3 || !hasFrontage(p) || !hasFrontage(q)) {
      [p, q] = splitPolygon(poly, box.centre, long);
      if (p.length < 3 || q.length < 3 || !hasFrontage(p) || !hasFrontage(q)) {
        if (a >= minArea * 0.6 && !sliver(poly)) lots.push(makeLot(poly, streetEdges));
        return;
      }
    }
    recurse(p, depth + 1);
    recurse(q, depth + 1);
  };
  recurse(signedArea(interior) > 0 ? interior : [...interior].reverse(), 0);
  return lots;
}
function sliver(poly: Point[]) {
  let perimeter = 0;
  for (let i = 0; i < poly.length; i++)
    perimeter += dist(poly[i], poly[(i + 1) % poly.length]);
  return area(poly) / (perimeter * perimeter) < 0.035;
}
function frontageIndex(poly: Point[], streetEdges: [Point, Point][]) {
  let best = -1,
    bestLength = 5;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    for (const [sa, sb] of streetEdges) {
      const da = dist(closestOnSegment(a, sa, sb).point, a),
        db = dist(closestOnSegment(b, sa, sb).point, b);
      if (da < 0.3 && db < 0.3) {
        const l = dist(a, b);
        if (l > bestLength) {
          bestLength = l;
          best = i;
        }
      }
    }
  }
  return best;
}
function makeLot(poly: Point[], streetEdges: [Point, Point][]): Lot {
  return {
    polygon: poly,
    frontage: frontageIndex(poly, streetEdges),
    area: area(poly),
  };
}
