import type { Building, City, Road, RoadSurface } from "../shared/world.ts";
import { KERB_HEIGHT, LIMIT, STREET_LIFT } from "../shared/world.ts";
import { WATER_LEVEL } from "../shared/water.ts";
import { TERRAIN_SIDE, TERRAIN_STEP, terrainHeight } from "../shared/terrain.ts";
import { earClip } from "../shared/polygon.ts";
import type { BuildingAssetId } from "../shared/assets/buildings/index.ts";
import type { GeneratedMap, Point, RoadEdge, RoadKind } from "../mapgen/types.ts";
import {
  add,
  area,
  closestOnSegment,
  convexOverlap,
  dist,
  lerpPoint,
  mul,
  orientedBox,
  pointInPolygon,
  rotatedRect,
  selfIntersects,
} from "../mapgen/geom.ts";
import { SIDEWALK, simplifyPolyline } from "../mapgen/roadgeometry.ts";
import { sample } from "../mapgen/field.ts";
import { packSurfaceChunks } from "../shared/city-pack.ts";
import { destructibles } from "../shared/destruction.ts";
import { edgeHeightAt, sinkUnderStreets } from "../mapgen/streetfit.ts";

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
  const trims = map.geometry.trims;
  for (const e of map.roads.edges) {
    const pts = subdivide(simplifyPolyline(e.points, 0.6), 24);
    // A junction's signal stands at its stop line, which can lie beyond the first
    // segment; it goes on whichever segment contains that distance.
    const along = [0];
    for (let i = 1; i < pts.length; i++)
      along.push(along[i - 1] + dist(pts[i - 1], pts[i]));
    const total = along[along.length - 1],
      stopA = Math.min(total / 2, trims[e.id][0] + 4.4),
      stopB = Math.max(total / 2, total - trims[e.id][1] - 4.4);
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
        ...(junction.has(e.a) &&
        along[i - 1] <= stopA &&
        (stopA < along[i] || i === pts.length - 1)
          ? { signalA: true, stopA: round(stopA - along[i - 1]) }
          : {}),
        ...(junction.has(e.b) && stopB <= along[i] && (along[i - 1] < stopB || i === 1)
          ? { signalB: true, stopB: round(along[i] - stopB) }
          : {}),
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
        const piece = [
          ...left.slice(start, i + 1),
          ...right.slice(start, i + 1).reverse(),
        ];
        if (!selfIntersects(piece)) out.push(piece);
        else
          // On the tightest bends the two edges can cross; fall back to one quad per
          // step, each ordered around its middle so none renders folded.
          for (let k = start + 1; k <= i; k++) {
            const quad = [left[k - 1], left[k], right[k], right[k - 1]],
              c = mul(quad.reduce(add, { x: 0, z: 0 }), 0.25);
            quad.sort(
              (a, b) =>
                Math.atan2(a.z - c.z, a.x - c.x) - Math.atan2(b.z - c.z, b.x - c.x),
            );
            if (area(quad) > 0.01) out.push(quad);
          }
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

  // Pieces from different profiles (a junction's flat plateau, a street's slope,
  // the two legs of a hairpin) meet at shared vertices with slightly different
  // heights; weld street and sidewalk vertices within half a metre to their mean so the
  // surfaces meet without steps.
  const welded = new Map<string, { sum: number; n: number }>();
  const weldKey = (flat: number[], i: number) =>
    `${Math.round(flat[i] * 2)},${Math.round(flat[i + 2] * 2)}`;
  for (const flat of [...asphalt, ...sidewalks])
    for (let i = 0; i < flat.length; i += 3) {
      const entry = welded.get(weldKey(flat, i));
      if (entry) {
        entry.sum += flat[i + 1];
        entry.n++;
      } else welded.set(weldKey(flat, i), { sum: flat[i + 1], n: 1 });
    }
  for (const flat of [...asphalt, ...sidewalks])
    for (let i = 0; i < flat.length; i += 3) {
      const { sum, n } = welded.get(weldKey(flat, i))!;
      if (n > 1) flat[i + 1] = round(sum / n);
    }

  // Buildings: oriented boxes with pad and roof altitudes. A box fitted around an
  // irregular lot can reach past the sidewalk; such boxes are fitted back.
  const buildings: Building[] = [];
  map.buildings.forEach((b, i) => {
    const ring = b.footprint ?? rotatedRect(b, b.w, b.d, b.angle);
    const box = clearOfStreets(orientedBox(ring), roads);
    if (!box) return;
    const y = round(b.y + shift);
    buildings.push({
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
    });
  });

  // Boxes fitted around irregular lots can still meet a curved sidewalk or a
  // neighbour's box; such buildings are dropped, larger ones kept first.
  const walkRings = sidewalks.map((flat) => {
    const ring: Point[] = [];
    for (let i = 0; i < flat.length; i += 3) ring.push({ x: flat[i], z: flat[i + 2] });
    return ring;
  });
  const kept: { b: Building; ring: Point[] }[] = [];
  for (const b of [...buildings].sort((p, q) => q.w * q.d - p.w * p.d)) {
    const ring = rotatedRect(b, b.w, b.d, b.angle ?? 0),
      probes = [
        ...ring,
        ...ring.map((c, i) => lerpPoint(c, ring[(i + 1) % 4], 0.5)),
        b,
      ];
    const reach = Math.hypot(b.w, b.d) / 2;
    if (
      walkRings.some(
        (w) =>
          dist(w[0], b) < reach + 40 &&
          (probes.some((q) => pointInPolygon(q, w)) ||
            w.some((q) => pointInPolygon(q, ring))),
      ) ||
      kept.some(
        (k) =>
          dist(k.b, b) < reach + Math.hypot(k.b.w, k.b.d) / 2 &&
          convexOverlap(k.ring, ring),
      )
    )
      continue;
    kept.push({ b, ring });
  }
  const keep = new Set(kept.map((k) => k.b));
  for (let i = buildings.length - 1; i >= 0; i--)
    if (!keep.has(buildings[i])) buildings.splice(i, 1);

  // Airport: the flattest free square away from downtown; the pad is stamped flat.
  const airport = placeAirport(map, roads, buildings, shift, heights);
  sinkUnderStreets(
    { heights, side: TERRAIN_SIDE, step: TERRAIN_STEP, half: LIMIT },
    [
      { polygons: asphalt, top: STREET_LIFT },
      { polygons: sidewalks, top: STREET_LIFT + KERB_HEIGHT },
    ],
    [
      ...buildings,
      {
        ...airport,
        y: terrainHeight(airport.x, airport.z, { terrain: { heights } }),
      },
    ],
  );
  // Shipped heights are whole centimetres; round down so no surface sample rises.
  for (let i = 0; i < heights.length; i++)
    heights[i] = Math.floor(heights[i] * 100 + 1e-6) / 100 + 0;
  // A pad the coarse grid could not keep beside a lower street is re-seated.
  for (const b of buildings) {
    const ground = round(terrainHeight(b.x, b.z, { terrain: { heights } }));
    if (Math.abs(ground - b.y!) <= 0.8) continue;
    b.h = round(b.h - b.y! + ground);
    b.y = ground;
  }

  // Pedestrian walkways along the sidewalks and across the crosswalks.
  const walkways: NonNullable<City["walkways"]> = { points: [], links: [] };
  for (const p of g.walkways.points) walkways.points.push(round(p.x), round(p.z));
  for (const l of g.walkways.links)
    walkways.links.push(l.a, l.b, l.crossing === "x" ? 1 : l.crossing === "z" ? 2 : 0);

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

  // Street surface lookups for placing parks, crates, signals and spawns.
  const asphaltRings = asphalt.map((flat) => {
    const ring: Point[] = [];
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (let i = 0; i < flat.length; i += 3) {
      ring.push({ x: flat[i], z: flat[i + 2] });
      x0 = Math.min(x0, flat[i]);
      x1 = Math.max(x1, flat[i]);
      z0 = Math.min(z0, flat[i + 2]);
      z1 = Math.max(z1, flat[i + 2]);
    }
    return { ring, x0, x1, z0, z1 };
  });
  const onAsphalt = (p: Point) =>
    asphaltRings.some(
      (a) =>
        p.x >= a.x0 &&
        p.x <= a.x1 &&
        p.z >= a.z0 &&
        p.z <= a.z1 &&
        pointInPolygon(p, a.ring),
    );
  const groundAt = (p: Point) => terrainHeight(p.x, p.z, { terrain: { heights } });

  // Parks are drawn as one flat axis-aligned slab with paths, so each gets the
  // largest box that fits inside its block, stays off the street and sits on
  // ground within a metre of its centre. Gardens too small for their benches
  // become woodland; parks with no such spot are dropped.
  const parks: City["parks"] = [];
  for (const park of map.parks) {
    let best: { c: Point; clear: number } | undefined;
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const q of park.polygon) {
      x0 = Math.min(x0, q.x);
      x1 = Math.max(x1, q.x);
      z0 = Math.min(z0, q.z);
      z1 = Math.max(z1, q.z);
    }
    for (let x = x0; x <= x1; x += 4)
      for (let z = z0; z <= z1; z += 4) {
        const c = { x, z };
        if (!pointInPolygon(c, park.polygon)) continue;
        let clear = Infinity;
        for (let i = 0; i < park.polygon.length; i++)
          clear = Math.min(
            clear,
            dist(
              c,
              closestOnSegment(
                c,
                park.polygon[i],
                park.polygon[(i + 1) % park.polygon.length],
              ).point,
            ),
          );
        if (!best || clear > best.clear) best = { c, clear };
      }
    if (!best) continue;
    const c = best.c,
      level = groundAt(c);
    const fits = (hw: number, hd: number) => {
      for (let dx = -hw; dx <= hw + 1e-6; dx += Math.max(1, hw / 6))
        for (let dz = -hd; dz <= hd + 1e-6; dz += Math.max(1, hd / 6)) {
          const q = { x: c.x + dx, z: c.z + dz };
          if (
            !pointInPolygon(q, park.polygon) ||
            onAsphalt(q) ||
            groundAt(q) < WATER_LEVEL + 0.3 ||
            Math.abs(groundAt(q) - level) > 1
          )
            return false;
        }
      return true;
    };
    let hw = 3,
      hd = 3;
    for (let grown = true; grown && hw < 128 && hd < 128;) {
      grown = false;
      if (fits(hw + 1, hd)) ((hw += 1), (grown = true));
      if (fits(hw, hd + 1)) ((hd += 1), (grown = true));
    }
    if (!fits(hw, hd) || hw < 4 || hd < 4) continue;
    const garden = park.kind !== "woodland" && hw >= 5.5 && hd >= 10.5;
    parks.push({
      x: round(c.x),
      z: round(c.z),
      w: round(hw * 2),
      d: round(hd * 2),
      kind: garden ? "garden" : "woodland",
    });
  }

  // Players spawn around the centre, so it is moved onto the nearest sidewalk
  // walkway rather than into the downtown junction's traffic.
  const spawn = g.walkways.points
    .filter((p) => !onAsphalt(p))
    .reduce((best, p) => (dist(p, map.centre) < dist(best, map.centre) ? p : best));
  const centre = { x: round(spawn.x), z: round(spawn.z) };
  // Weapon pickups on the sidewalk walkways nearest downtown, spread apart.
  const pickups: City["pickups"] = [];
  const spots = [...g.walkways.points]
    .filter((p) => !onAsphalt(p))
    .sort((a, b) => dist(a, centre) - dist(b, centre));
  for (const weapon of ["pistol", "bat", "pistol"] as const) {
    const spot = spots.find((p) => pickups.every((q) => dist(p, q) > 15));
    if (!spot) break;
    pickups.push({ x: round(spot.x), z: round(spot.z), weapon });
  }
  // Weapon crates and signal poles are derived from segments at runtime; veto
  // spots that land on asphalt (junction mouths, neighbouring streets) or, for
  // crates, inside a building.
  // A pole can stand nearer the far end when its stop line lies far from the
  // junction, so each end is tested on its own.
  for (const road of roads)
    for (const end of ["A", "B"] as const) {
      if (!road[`signal${end}`]) continue;
      const alone: Road = { ...road, signalA: undefined, signalB: undefined };
      alone[`signal${end}`] = true;
      const pole = destructibles({ props: [], parks: [], roads: [alone] }).find(
        (p) => p.kind === "signal",
      );
      if (pole && onAsphalt(pole)) {
        delete road[`signal${end}`];
        delete road[`stop${end}`];
      }
    }
  for (const road of roads)
    for (const crate of destructibles({ props: [], parks: [], roads: [road] }))
      if (
        crate.kind === "crate" &&
        ([-0.5, 0.5].some((dx) =>
          [-0.5, 0.5].some((dz) => onAsphalt({ x: crate.x + dx, z: crate.z + dz })),
        ) ||
          buildings.some(
            (b) =>
              Math.abs(
                (crate.x - b.x) * Math.cos(b.angle ?? 0) +
                  (crate.z - b.z) * Math.sin(b.angle ?? 0),
              ) <
                b.w / 2 + 0.6 &&
              Math.abs(
                -(crate.x - b.x) * Math.sin(b.angle ?? 0) +
                  (crate.z - b.z) * Math.cos(b.angle ?? 0),
              ) <
                b.d / 2 + 0.6,
          ))
      )
        road.noCrate = true;
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
    walkways,
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

/**
 * Push a building box out of the street and sidewalk corridors and shrink it by
 * whatever still intrudes; undefined when too little is left to build on.
 */
function clearOfStreets(
  box: { centre: Point; w: number; d: number; angle: number },
  roads: Road[],
) {
  let { centre, w, d } = box;
  const near = roads.filter(
    (r) =>
      Math.hypot(r.x - centre.x, r.z - centre.z) <
      Math.hypot(r.bx - r.ax, r.bz - r.az) / 2 + r.width / 2 + Math.hypot(w, d) / 2 + 4,
  );
  for (let round = 0; round < 8; round++) {
    let worst = 0,
      push = { x: 0, z: 0 };
    const corners = rotatedRect(centre, w, d, box.angle);
    for (let k = 0; k < 4; k++) {
      const a = corners[k],
        b = corners[(k + 1) % 4],
        steps = Math.ceil(dist(a, b) / 1.5);
      for (let s = 0; s <= steps; s++) {
        const p = lerpPoint(a, b, s / steps);
        for (const r of near) {
          const { point } = closestOnSegment(
              p,
              { x: r.ax, z: r.az },
              { x: r.bx, z: r.bz },
            ),
            gap = dist(p, point),
            depth = r.width / 2 + SIDEWALK + 0.3 - gap;
          if (depth <= worst) continue;
          worst = depth;
          const away = Math.hypot(centre.x - point.x, centre.z - point.z) || 1;
          push = {
            x: (centre.x - point.x) / away,
            z: (centre.z - point.z) / away,
          };
        }
      }
    }
    if (worst <= 0.01) return { centre, w, d, angle: box.angle };
    // Half the depth moves the box away; the box loses the other half on that side.
    centre = { x: centre.x + push.x * worst * 0.5, z: centre.z + push.z * worst * 0.5 };
    const c = Math.cos(box.angle),
      s = Math.sin(box.angle);
    w -= Math.abs(push.x * c + push.z * s) * worst;
    d -= Math.abs(-push.x * s + push.z * c) * worst;
    if (w < 4 || d < 4) return undefined;
  }
  return undefined;
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
  // Relax distance and flatness until some site is free of roads and buildings.
  for (const [far, rough] of [
    [700, 14],
    [450, 24],
    [250, 40],
  ]) {
    for (let z = -LIMIT + half + 40; z <= LIMIT - half - 40; z += 32)
      for (let x = -LIMIT + half + 40; x <= LIMIT - half - 40; x += 32) {
        if (Math.hypot(x - map.centre.x, z - map.centre.z) < far) continue;
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
        if (wet || max - min > rough) continue;
        // The pad itself must stay clear of every road segment.
        const clear = half + 8;
        const occupied =
          buildings.some(
            (b) => Math.abs(b.x - x) < half + 20 && Math.abs(b.z - z) < half + 20,
          ) ||
          roads.some((r) => {
            const steps = Math.ceil(Math.hypot(r.bx - r.ax, r.bz - r.az) / 8);
            for (let i = 0; i <= steps; i++) {
              const t = i / steps;
              if (
                Math.abs(r.ax + (r.bx - r.ax) * t - x) < clear + r.width / 2 &&
                Math.abs(r.az + (r.bz - r.az) * t - z) < clear + r.width / 2
              )
                return true;
            }
            return false;
          });
        if (occupied) continue;
        const score = max - min + sum / count / 20;
        if (!best || score < best.score) best = { x, z, score };
      }
    if (best) break;
  }
  const site = best ?? { x: map.centre.x + 900, z: map.centre.z, score: 0 };
  // Stamp the pad flat into the shipped terrain with a feathered margin that leaves
  // the road corridors alone beyond the first grid ring, which carries the pad edge.
  const level = sample(f, site.x, site.z) + shift,
    margin = 24;
  const nearRoad = (px: number, pz: number) =>
    roads.some((r) => {
      const dx = r.bx - r.ax,
        dz = r.bz - r.az,
        t = Math.max(
          0,
          Math.min(1, ((px - r.ax) * dx + (pz - r.az) * dz) / (dx * dx + dz * dz)),
        );
      return Math.hypot(r.ax + dx * t - px, r.az + dz * t - pz) < r.width / 2 + 2.5 + 8;
    });
  for (let z = 0; z < f.h; z++)
    for (let x = 0; x < f.w; x++) {
      const px = x * f.cell - f.size / 2,
        pz = z * f.cell - f.size / 2;
      const dx = Math.max(0, Math.abs(px - site.x) - half),
        dz = Math.max(0, Math.abs(pz - site.z) - half),
        d = Math.hypot(dx, dz);
      if (d > TERRAIN_STEP + margin || (d > TERRAIN_STEP && nearRoad(px, pz))) continue;
      const i = z * f.w + x,
        t = Math.min(1, 1 - (d - TERRAIN_STEP) / margin);
      heights[i] = round(heights[i] + (level - heights[i]) * t);
    }
  return { x: round(site.x), z: round(site.z), w: size, d: size };
}
