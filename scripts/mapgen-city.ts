import type { Building, City, Road, RoadSurface } from "../shared/world.ts";
import { LIMIT } from "../shared/world.ts";
import { WATER_LEVEL } from "../shared/water.ts";
import { TERRAIN_SIDE, TERRAIN_STEP } from "../shared/terrain.ts";
import type { BuildingAssetId } from "../shared/assets/buildings/index.ts";
import type { GeneratedMap, Point, RoadEdge, RoadKind } from "../mapgen/types.ts";
import {
  closestOnSegment,
  dist,
  lerpPoint,
  orientedBox,
  rotatedRect,
} from "../mapgen/geom.ts";
import { simplifyPolyline } from "../mapgen/roadgeometry.ts";
import { sample } from "../mapgen/field.ts";
import { packSurfaceChunks } from "../shared/city-pack.ts";

// `+ 0` turns -0 into 0 so packed and parsed artifacts compare equal.
const round = (v: number) => Math.round(v * 100) / 100 + 0;
const KIND: Record<RoadKind, Road["kind"]> = {
  highway: "avenue",
  avenue: "avenue",
  street: "street",
  lane: "service",
};
const ASSET: Record<string, BuildingAssetId> = {
  tower: "glass-tower",
  office: "deco-tower",
  apartments: "apartments",
  shop: "shop-house",
  townhouse: "townhouse",
  house: "villa",
  warehouse: "warehouse",
  civic: "civic-hall",
};

/** Height of a road surface point from the nearest profile sample of its edge. */
function edgeHeightAt(e: RoadEdge, p: Point) {
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
 * Convert a generated map into the runtime city artifact. Heights shift so the
 * generator's sea level matches the game's water level; roads become dense straight
 * segments for navigation while the drawn streets travel as surface polygons.
 */
export function cityFromMap(map: GeneratedMap): City {
  const f = map.shaped,
    shift = WATER_LEVEL - map.seaLevel;
  if (f.w !== TERRAIN_SIDE || f.cell !== TERRAIN_STEP)
    throw Error(`map grid ${f.w}@${f.cell} m does not match the game terrain grid`);
  const heights = Array.from(f.data, (h) =>
    round(Math.max(-80, Math.min(240, h + shift))),
  );

  // Roads: polylines simplified and cut into segments short enough for lanes.
  const roads: Road[] = [];
  const junction = new Set(
    map.roads.nodes.filter((n) => n.edges.length >= 3).map((n) => n.id),
  );
  for (const e of map.roads.edges) {
    const pts = subdivide(simplifyPolyline(e.points, 0.6), 24);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1],
        b = pts[i];
      const ax = round(a.x),
        az = round(a.z),
        bx = round(b.x),
        bz = round(b.z);
      if (Math.hypot(bx - ax, bz - az) < 0.05) continue;
      roads.push({
        x: round((ax + bx) / 2),
        z: round((az + bz) / 2),
        ax,
        az,
        bx,
        bz,
        width: Math.max(6, Math.min(24, e.width)),
        kind: KIND[e.kind],
        signalA: i === 1 && junction.has(e.a) ? true : undefined,
        signalB: i === pts.length - 1 && junction.has(e.b) ? true : undefined,
      });
    }
  }

  // Street surfaces with their solved profile heights.
  const flat = (points: Point[], y: (p: Point) => number) => {
    const out: number[] = [];
    for (const p of points) out.push(round(p.x), round(y(p) + shift), round(p.z));
    return out;
  };
  const g = map.geometry;
  const asphalt: number[][] = [],
    sidewalks: number[][] = [],
    markings: RoadSurface["markings"] = [];
  const usable = (points: Point[]) => points.length >= 3 && points.length <= 1000;
  // Strips along an edge (bands, kerb-side sidewalks, solid lines) are cut into
  // pieces of at most STRIP metres so each polygon fits one streaming chunk.
  const STRIP = 16;
  const pieces = (left: Point[], right: Point[]) => {
    if (left.length !== right.length || left.length < 2)
      return [[...left, ...[...right].reverse()]];
    const out: Point[][] = [];
    let start = 0,
      run = 0;
    for (let i = 1; i < left.length; i++) {
      run += dist(left[i - 1], left[i]);
      if (run >= STRIP || i === left.length - 1) {
        out.push([...left.slice(start, i + 1), ...right.slice(start, i + 1).reverse()]);
        start = i;
        run = 0;
      }
    }
    return out;
  };
  /** Edge polygons are `[...left, ...right reversed]` with equal halves. */
  const halves = (polygon: Point[]) => {
    if (polygon.length <= 4 || polygon.length % 2) return [polygon];
    const n = polygon.length / 2;
    return pieces(polygon.slice(0, n), polygon.slice(n).reverse());
  };
  for (const band of g.bands) {
    const e = map.roads.edges[band.edge];
    for (const piece of pieces(band.left, band.right))
      if (usable(piece)) asphalt.push(flat(piece, (p) => edgeHeightAt(e, p)));
  }
  for (const j of g.junctions) {
    const y = map.roads.nodes[j.node].y;
    if (usable(j.polygon)) asphalt.push(flat(j.polygon, () => y));
  }
  for (const s of g.sidewalks) {
    if (s.node !== undefined) {
      const y = map.roads.nodes[s.node].y;
      if (usable(s.polygon)) sidewalks.push(flat(s.polygon, () => y));
      continue;
    }
    const e = map.roads.edges[s.edge!];
    for (const piece of halves(s.polygon))
      if (usable(piece)) sidewalks.push(flat(piece, (p) => edgeHeightAt(e, p)));
  }
  for (const m of g.markings) {
    const e = map.roads.edges[m.edge];
    for (const piece of halves(m.polygon))
      if (usable(piece))
        markings.push({
          color: m.color,
          polygon: flat(piece, (p) => edgeHeightAt(e, p)),
        });
  }

  // Buildings: oriented boxes with pad and roof altitudes.
  const buildings: Building[] = map.buildings.map((b, i) => {
    const ring = b.footprint ?? rotatedRect(b, b.w, b.d, b.angle);
    const box = orientedBox(ring);
    const y = round(b.y + shift);
    return {
      x: round(box.centre.x),
      z: round(box.centre.z),
      w: round(Math.min(256, Math.max(3, box.w))),
      d: round(Math.min(256, Math.max(3, box.d))),
      y,
      h: round(Math.min(256, y + b.h)),
      angle: round(Math.atan2(Math.sin(box.angle), Math.cos(box.angle))),
      asset: ASSET[b.kind] ?? "shop-house",
      facing: 0,
      color: b.color.toLowerCase(),
      style: i % 3,
    };
  });

  // Airport: the flattest free square away from downtown; the pad is stamped flat.
  const airport = placeAirport(map, roads, buildings, shift, heights);

  const props: City["props"] = [],
    seen = new Set<string>();
  const inside = (p: Point, pad: number) =>
    Math.abs(p.x - airport.x) < airport.w / 2 + pad &&
    Math.abs(p.z - airport.z) < airport.d / 2 + pad;
  for (const t of map.trees) {
    const x = round(t.x),
      z = round(t.z),
      key = `${x},${z}`;
    if (
      seen.has(key) ||
      inside(t, 6) ||
      Math.abs(x) > LIMIT - 2 ||
      Math.abs(z) > LIMIT - 2
    )
      continue;
    seen.add(key);
    props.push({
      x,
      z,
      h: round(Math.max(2, t.h)),
      kind: t.kind === "palm" ? "palm" : "tree",
    });
  }
  for (const l of map.lamps) {
    const x = round(l.x),
      z = round(l.z),
      key = `${x},${z}`;
    if (
      seen.has(key) ||
      inside(l, 6) ||
      Math.abs(x) > LIMIT - 2 ||
      Math.abs(z) > LIMIT - 2
    )
      continue;
    seen.add(key);
    props.push({ x, z, h: round(l.h), kind: "lamp" });
  }

  const parks: City["parks"] = map.parks.map((p) => {
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const q of p.polygon) {
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minZ = Math.min(minZ, q.z);
      maxZ = Math.max(maxZ, q.z);
    }
    return {
      x: round((minX + maxX) / 2),
      z: round((minZ + maxZ) / 2),
      w: round(Math.min(256, Math.max(6, (maxX - minX) * 0.8))),
      d: round(Math.min(256, Math.max(6, (maxZ - minZ) * 0.8))),
      kind: p.kind === "woodland" ? "woodland" : "garden",
    };
  });

  // Weapon pickups on sidewalks of the streets closest to downtown.
  const centre = { x: round(map.centre.x), z: round(map.centre.z) };
  const near = [...roads]
    .filter((r) => r.kind !== "service")
    .sort(
      (a, b) =>
        Math.hypot(a.x - centre.x, a.z - centre.z) -
        Math.hypot(b.x - centre.x, b.z - centre.z),
    );
  const pickups: City["pickups"] = [];
  for (const [i, weapon] of (["pistol", "bat", "pistol"] as const).entries()) {
    const r = near[i * 4];
    if (!r) break;
    const dx = r.bx - r.ax,
      dz = r.bz - r.az,
      l = Math.hypot(dx, dz) || 1,
      off = r.width / 2 + 3.5;
    pickups.push({
      x: round(r.x + (dz / l) * off),
      z: round(r.z - (dx / l) * off),
      weapon,
    });
  }
  const tallest = buildings.reduce(
    (t, b) => (b.h - (b.y ?? 0) > t.h - (t.y ?? 0) ? b : t),
    buildings[0],
  );
  const landmarks: City["landmarks"] = [
    { x: centre.x, z: centre.z, name: "CITY CENTRE", kind: "plaza" },
    { x: airport.x, z: airport.z, name: "AIRPORT", kind: "airport" },
  ];
  if (tallest)
    landmarks.push({ x: tallest.x, z: tallest.z, name: "THE SPIRE", kind: "tower" });
  return {
    seed: map.options.seed,
    terrain: { heights },
    centre,
    surface: packSurfaceChunks({ asphalt, sidewalks, markings }),
    roads,
    buildings,
    props,
    parks,
    surfaces: [],
    ramps: [],
    pickups,
    airport,
    landmarks,
  };
}

function subdivide(points: Point[], maxLength: number) {
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      n = Math.max(1, Math.ceil(dist(a, b) / maxLength));
    for (let s = 1; s <= n; s++) out.push(lerpPoint(a, b, s / n));
  }
  return out;
}

/** Flattest land square at least 700 m from downtown with no roads or buildings. */
function placeAirport(
  map: GeneratedMap,
  roads: Road[],
  buildings: Building[],
  shift: number,
  heights: number[],
) {
  const f = map.shaped,
    size = 220,
    half = size / 2;
  let best: { x: number; z: number; score: number } | undefined;
  for (let z = -LIMIT + half + 40; z <= LIMIT - half - 40; z += 32)
    for (let x = -LIMIT + half + 40; x <= LIMIT - half - 40; x += 32) {
      if (Math.hypot(x - map.centre.x, z - map.centre.z) < 700) continue;
      let min = Infinity,
        max = -Infinity,
        sum = 0,
        count = 0,
        wet = false;
      for (let dz = -half; dz <= half && !wet; dz += 16)
        for (let dx = -half; dx <= half; dx += 16) {
          const h = sample(f, x + dx, z + dz);
          if (h < 2.5) {
            wet = true;
            break;
          }
          min = Math.min(min, h);
          max = Math.max(max, h);
          sum += h;
          count++;
        }
      if (wet || max - min > 14) continue;
      const occupied =
        buildings.some(
          (b) => Math.abs(b.x - x) < half + 20 && Math.abs(b.z - z) < half + 20,
        ) ||
        roads.some(
          (r) => Math.abs(r.x - x) < half + 30 && Math.abs(r.z - z) < half + 30,
        );
      if (occupied) continue;
      const score = max - min + sum / count / 20;
      if (!best || score < best.score) best = { x, z, score };
    }
  const site = best ?? { x: map.centre.x + 900, z: map.centre.z, score: 0 };
  // Stamp the pad flat into the shipped terrain with a feathered margin.
  const level = sample(f, site.x, site.z) + shift,
    margin = 24;
  for (let z = 0; z < f.h; z++)
    for (let x = 0; x < f.w; x++) {
      const px = x * f.cell - f.size / 2,
        pz = z * f.cell - f.size / 2;
      const dx = Math.max(0, Math.abs(px - site.x) - half),
        dz = Math.max(0, Math.abs(pz - site.z) - half),
        d = Math.hypot(dx, dz);
      if (d > margin) continue;
      const i = z * f.w + x,
        t = 1 - d / margin;
      heights[i] = round(heights[i] + (level - heights[i]) * t);
    }
  return { x: round(site.x), z: round(site.z), w: size, d: size };
}
