import type { Building, City, Road, RoadSurface, Spot } from "../shared/world.ts";
import { LIMIT } from "../shared/world.ts";
import { WATER_LEVEL } from "../shared/water.ts";
import { TERRAIN_SIDE, TERRAIN_STEP, terrainHeight } from "../shared/terrain.ts";
import type { GeneratedMap, Point } from "../mapgen/types.ts";
import {
  closestOnSegment,
  convexOverlap,
  dist,
  pointInPolygon,
  rotatedRect,
  selfIntersects,
} from "../mapgen/geom.ts";
import { SIDEWALK } from "../mapgen/roadgeometry.ts";
import { derive, type Rng } from "../mapgen/random.ts";

// `+ 0` turns -0 into 0 so packed and parsed artifacts compare equal.
const round = (v: number) => Math.round(v * 100) / 100 + 0;
/** Polygons are cut into pieces no longer than this so each fits a streaming chunk. */
const TILE = 16;

/** What the feature stages share and extend while the converter builds a city. */
export interface FeatureContext {
  map: GeneratedMap;
  /** Shipped terrain heights (game water level), edited in place. */
  heights: number[];
  roads: Road[];
  buildings: Building[];
  asphalt: number[][];
  sidewalks: number[][];
  markings: RoadSurface["markings"];
  /** Footprints of placed features; later features, trees and parks keep out. */
  taken: Point[][];
  /** True on drawn street asphalt or sidewalks. */
  paved: (p: Point) => boolean;
  /** Lakes, river channels and their banks. */
  wet: Uint8Array;
}

export const groundAt = (ctx: Pick<FeatureContext, "heights">, p: Point) =>
  terrainHeight(p.x, p.z, { terrain: { heights: ctx.heights } });
const gridIndex = (p: Point) =>
  Math.round((p.z + LIMIT) / TERRAIN_STEP) * TERRAIN_SIDE +
  Math.round((p.x + LIMIT) / TERRAIN_STEP);
const insideWorld = (p: Point, margin: number) =>
  Math.abs(p.x) < LIMIT - margin && Math.abs(p.z) < LIMIT - margin;

/** Lakes (with a 24 m shore) and river channels on the terrain grid. */
export function wetMask(map: GeneratedMap) {
  const f = map.shaped,
    wet = new Uint8Array(f.w * f.h);
  const mark = (cx: number, cz: number, reach: number) => {
    for (let dz = -reach; dz <= reach; dz++)
      for (let dx = -reach; dx <= reach; dx++) {
        const x = cx + dx,
          z = cz + dz;
        if (x >= 0 && z >= 0 && x < f.w && z < f.h) wet[z * f.w + x] = 1;
      }
  };
  for (let z = 0; z < f.h; z++)
    for (let x = 0; x < f.w; x++) {
      const q = { x: x * f.cell - f.size / 2, z: z * f.cell - f.size / 2 };
      if (map.lakes.some((lake) => pointInPolygon(q, lake.outline))) mark(x, z, 3);
    }
  for (const river of map.rivers)
    river.points.forEach((r, i) =>
      mark(
        Math.round((r.x + f.size / 2) / f.cell),
        Math.round((r.z + f.size / 2) / f.cell),
        Math.ceil((river.widths[i] / 2 + 4) / f.cell),
      ),
    );
  return wet;
}

/** Local frame of a rotated rectangle: u along `angle`, v across it. */
function frame(centre: Point, angle: number) {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return {
    at: (u: number, v: number): Point => ({
      x: centre.x + u * c - v * s,
      z: centre.z + u * s + v * c,
    }),
    local: (p: Point) => ({
      u: (p.x - centre.x) * c + (p.z - centre.z) * s,
      v: -(p.x - centre.x) * s + (p.z - centre.z) * c,
    }),
    /** Entity yaw facing local +v (or -v). */
    facing: (sign: number) => Math.atan2(-s * sign, c * sign),
  };
}
const flat = (points: Point[], y: number) =>
  points.flatMap((p) => [round(p.x), round(y), round(p.z)]);
/** A rectangle in a frame, cut into tiles at most TILE metres along u. */
function tiles(
  f: ReturnType<typeof frame>,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
) {
  const out: Point[][] = [],
    n = Math.max(1, Math.ceil((u1 - u0) / TILE)),
    m = Math.max(1, Math.ceil((v1 - v0) / TILE));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      const a = u0 + ((u1 - u0) * i) / n,
        b = u0 + ((u1 - u0) * (i + 1)) / n,
        c = v0 + ((v1 - v0) * j) / m,
        d = v0 + ((v1 - v0) * (j + 1)) / m;
      out.push([f.at(a, c), f.at(b, c), f.at(b, d), f.at(a, d)]);
    }
  return out;
}

/** True when a road segment passes within `pad` of the polygon. */
function nearRoad(roads: Road[], ring: Point[], pad: number) {
  const c = ring.reduce(
    (s, p) => ({ x: s.x + p.x / ring.length, z: s.z + p.z / ring.length }),
    {
      x: 0,
      z: 0,
    },
  );
  const reach = Math.max(...ring.map((p) => dist(p, c))) + pad;
  return roads.some((r) => {
    const a = { x: r.ax, z: r.az },
      b = { x: r.bx, z: r.bz };
    if (dist(closestOnSegment(c, a, b).point, c) > reach + r.width / 2) return false;
    const steps = Math.ceil(dist(a, b) / 4);
    for (let i = 0; i <= steps; i++) {
      const p = {
        x: a.x + ((b.x - a.x) * i) / steps,
        z: a.z + ((b.z - a.z) * i) / steps,
      };
      if (pointInPolygon(p, ring)) return true;
      for (let k = 0; k < ring.length; k++)
        if (
          dist(closestOnSegment(p, ring[k], ring[(k + 1) % ring.length]).point, p) <
          pad + r.width / 2
        )
          return true;
    }
    return false;
  });
}
const overlapsTaken = (ctx: FeatureContext, ring: Point[]) =>
  ctx.taken.some((t) => convexOverlap(t, ring));
const overlapsBuilding = (ctx: FeatureContext, ring: Point[]) =>
  ctx.buildings.some(
    (b) =>
      Math.hypot(b.x - ring[0].x, b.z - ring[0].z) < 400 &&
      convexOverlap(rotatedRect(b, b.w, b.d, b.angle ?? 0), ring),
  );

/**
 * Pull every grid point inside the rectangle to `level`, feathering back to the
 * original ground over `margin` metres outside it. Points next to streets beyond
 * the first grid ring are left alone so the street profiles keep their ground.
 */
function stampRect(
  ctx: FeatureContext,
  centre: Point,
  w: number,
  d: number,
  angle: number,
  level: number,
  margin: number,
  only?: (p: Point, current: number) => boolean,
) {
  const f = frame(centre, angle),
    reach = Math.hypot(w, d) / 2 + margin + TERRAIN_STEP;
  for (
    let gz = Math.max(0, Math.floor((centre.z - reach + LIMIT) / TERRAIN_STEP));
    gz <=
    Math.min(TERRAIN_SIDE - 1, Math.ceil((centre.z + reach + LIMIT) / TERRAIN_STEP));
    gz++
  )
    for (
      let gx = Math.max(0, Math.floor((centre.x - reach + LIMIT) / TERRAIN_STEP));
      gx <=
      Math.min(TERRAIN_SIDE - 1, Math.ceil((centre.x + reach + LIMIT) / TERRAIN_STEP));
      gx++
    ) {
      const p = { x: gx * TERRAIN_STEP - LIMIT, z: gz * TERRAIN_STEP - LIMIT },
        { u, v } = f.local(p),
        du = Math.max(0, Math.abs(u) - w / 2),
        dv = Math.max(0, Math.abs(v) - d / 2),
        out = Math.hypot(du, dv);
      if (out > TERRAIN_STEP + margin) continue;
      const i = gz * TERRAIN_SIDE + gx;
      if (only && !only(p, ctx.heights[i])) continue;
      if (out > TERRAIN_STEP && ctx.paved(p)) continue;
      const t =
        out <= TERRAIN_STEP ? 1 : Math.max(0, 1 - (out - TERRAIN_STEP) / margin);
      ctx.heights[i] = round(ctx.heights[i] + (level - ctx.heights[i]) * t);
    }
}

/** Ground samples of a polygon's interior on a 4 m lattice. */
function interior(ring: Point[], step = 4) {
  let x0 = Infinity,
    x1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (const p of ring) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.z);
    z1 = Math.max(z1, p.z);
  }
  const out: Point[] = [];
  for (let x = x0; x <= x1; x += step)
    for (let z = z0; z <= z1; z += step)
      if (pointInPolygon({ x, z }, ring)) out.push({ x, z });
  return out;
}

export type TownHall = NonNullable<City["townHall"]>;
/**
 * The town hall faces a street near downtown with a striped car park in front of
 * it. Players spawn on the plaza between the two. Buildings standing on the chosen
 * lot are cleared.
 */
export function placeTownHall(ctx: FeatureContext): TownHall {
  const LOT = 64,
    DEPTH = 58,
    centre = ctx.map.centre;
  const candidates = ctx.roads
    .filter((r) => r.kind !== "service" && Math.hypot(r.bx - r.ax, r.bz - r.az) > 8)
    .sort((a, b) => dist(a, centre) - dist(b, centre))
    .slice(0, 600);
  // The lot is levelled afterwards, so ground that is a little uneven will do when no
  // level lot is left near downtown.
  for (const slack of [5, 8, 12])
    for (const road of candidates)
      for (const side of [1, -1]) {
        const length = Math.hypot(road.bx - road.ax, road.bz - road.az),
          t = { x: (road.bx - road.ax) / length, z: (road.bz - road.az) / length },
          // Local +v points away from the street.
          angle = Math.atan2(t.z, t.x) + (side < 0 ? Math.PI : 0),
          n = { x: -Math.sin(angle), z: Math.cos(angle) },
          setback = road.width / 2 + SIDEWALK + 1.5 + DEPTH / 2,
          middle = { x: road.x + n.x * setback, z: road.z + n.z * setback },
          ring = rotatedRect(middle, LOT, DEPTH, angle);
        if (!insideWorld(middle, 80) || overlapsTaken(ctx, ring)) continue;
        // Only the street it faces (its collinear segments) may come near the lot.
        const sameStreet = (r: Road) => {
          const l = Math.hypot(r.bx - r.ax, r.bz - r.az) || 1,
            turn = Math.abs(t.x * (r.bz - r.az) - t.z * (r.bx - r.ax)) / l,
            offLine = Math.abs(t.x * (r.z - road.z) - t.z * (r.x - road.x));
          return turn < 0.35 && offLine < 4;
        };
        if (
          nearRoad(
            ctx.roads.filter((r) => !sameStreet(r)),
            ring,
            2,
          )
        )
          continue;
        const samples = interior(ring);
        let lo = Infinity,
          hi = -Infinity,
          fail = false;
        for (const p of samples) {
          const h = groundAt(ctx, p);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
          if (ctx.paved(p) || ctx.wet[gridIndex(p)] || h < WATER_LEVEL + 1.5) {
            fail = true;
            break;
          }
        }
        if (fail || hi - lo > slack) continue;
        const f = frame(middle, angle),
          // Level with the street it faces, so cars roll straight off the kerb.
          level = round(groundAt(ctx, f.at(0, -DEPTH / 2 - 2)));
        stampRect(ctx, middle, LOT, DEPTH, angle, level, 16);
        for (let i = ctx.buildings.length - 1; i >= 0; i--) {
          const b = ctx.buildings[i];
          if (
            dist(b, middle) < 120 &&
            convexOverlap(rotatedRect(b, b.w + 4, b.d + 4, b.angle ?? 0), ring)
          )
            ctx.buildings.splice(i, 1);
        }
        // Local layout, v from the street (-29) to the back (+29):
        // car park -29..-9 (two rows of bays either side of a 7 m aisle), plaza -9..-3,
        // hall -3..25.
        const PARK = { from: -DEPTH / 2, to: -9 },
          BAY = 2.8,
          DEEP = 5.5,
          gap = 4.5;
        for (const tile of tiles(f, -LOT / 2, LOT / 2, PARK.from, PARK.to))
          ctx.asphalt.push(flat(tile, level));
        for (const tile of tiles(f, -LOT / 2, LOT / 2, PARK.to, -3))
          ctx.sidewalks.push(flat(tile, level));
        const parking: Spot[] = [],
          line = (u: number, v0: number, v1: number) =>
            ctx.markings.push({
              color: "white",
              polygon: flat(
                [
                  f.at(u - 0.07, v0),
                  f.at(u + 0.07, v0),
                  f.at(u + 0.07, v1),
                  f.at(u - 0.07, v1),
                ],
                level,
              ),
            });
        const rows = [
          // Street-side row nose-in toward the street, leaving an entrance in the middle.
          { v0: PARK.from + 1, v1: PARK.from + 1 + DEEP, heading: -1, entrance: true },
          { v0: PARK.to - DEEP, v1: PARK.to, heading: 1, entrance: false },
        ];
        for (const row of rows) {
          const count = Math.floor((LOT - 2) / BAY);
          const start = -(count * BAY) / 2;
          for (let k = 0; k <= count; k++) {
            const u = start + k * BAY;
            if (row.entrance && Math.abs(u) < gap + BAY / 2) continue;
            line(u, row.v0, row.v1);
            if (k === count || (row.entrance && Math.abs(u + BAY / 2) < gap + BAY / 2))
              continue;
            const spot = f.at(u + BAY / 2, (row.v0 + row.v1) / 2);
            parking.push({
              x: round(spot.x),
              z: round(spot.z),
              angle: round(f.facing(row.heading)),
            });
          }
        }
        const hall = f.at(0, 11);
        ctx.buildings.push({
          x: round(hall.x),
          z: round(hall.z),
          w: 40,
          d: 28,
          y: level,
          h: round(level + 15),
          angle: round(Math.atan2(Math.sin(angle), Math.cos(angle))),
          asset: "civic-hall",
          facing: 0,
          color: "#d9cfb8",
          style: 0,
        });
        ctx.taken.push(rotatedRect(middle, LOT + 4, DEPTH + 4, angle));
        const spawn = f.at(0, -6);
        return {
          x: round(middle.x),
          z: round(middle.z),
          angle: round(angle),
          spawn: { x: round(spawn.x), z: round(spawn.z) },
          parking,
        };
      }
  throw Error("No street-facing lot near downtown for the town hall");
}

/** Catmull-Rom closed spline through control points, sampled about `step` apart. */
function closedSpline(controls: Point[], step: number) {
  const out: Point[] = [],
    n = controls.length;
  for (let i = 0; i < n; i++) {
    const p0 = controls[(i - 1 + n) % n],
      p1 = controls[i],
      p2 = controls[(i + 1) % n],
      p3 = controls[(i + 2) % n],
      count = Math.max(2, Math.ceil(dist(p1, p2) / step));
    for (let k = 0; k < count; k++) {
      const t = k / count,
        t2 = t * t,
        t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b +
          (-a + c) * t +
          (2 * a - 5 * b + 4 * c - d) * t2 +
          (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  return out;
}
/** Resample a closed polyline at a fixed spacing. */
function resample(loop: Point[], step: number) {
  const lengths = [0];
  for (let i = 1; i <= loop.length; i++)
    lengths.push(lengths[i - 1] + dist(loop[i - 1], loop[i % loop.length]));
  const total = lengths[loop.length],
    count = Math.round(total / step),
    out: Point[] = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const s = (k * total) / count;
    while (lengths[j + 1] < s) j++;
    const a = loop[j],
      b = loop[(j + 1) % loop.length],
      t = (s - lengths[j]) / (lengths[j + 1] - lengths[j] || 1);
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }
  return out;
}
/** Tightest turning radius of a closed polyline. */
function minRadius(loop: Point[], span = 4) {
  let r = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[(i - span + loop.length) % loop.length],
      b = loop[i],
      c = loop[(i + span) % loop.length];
    const ab = dist(a, b),
      bc = dist(b, c),
      ca = dist(c, a),
      twice = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    if (twice > 1e-6) r = Math.min(r, (ab * bc * ca) / (2 * twice));
  }
  return r;
}
/** Closest approach of two parts of the loop that are far apart along it. */
function minSeparation(loop: Point[], step: number, along: number) {
  const skip = Math.ceil(along / step);
  let best = Infinity;
  for (let i = 0; i < loop.length; i += 2)
    for (let j = i + skip; j < loop.length - skip + i; j += 2)
      best = Math.min(best, dist(loop[i], loop[j % loop.length]));
  return best;
}

export type Racetrack = NonNullable<City["racetrack"]>;
const TRACK_WIDTH = 12;
/**
 * A seeded closed circuit on open land away from the city: a perturbed oval of
 * Catmull-Rom curves with a hairpin or two, smoothed to a minimum radius. The
 * asphalt follows a smoothed ground profile, so it climbs and falls with the land.
 */
export function placeRacetrack(
  ctx: FeatureContext,
  rng: Rng = derive(ctx.map.options.seed, "racetrack"),
): Racetrack {
  const STEP = 2;
  /** Track ground stays this far above the sea. Beaches shelve gently, so the old 1.5 m margin was a band tens of metres wide. */
  const DRY = WATER_LEVEL + 0.8;
  /** One closed candidate loop inside an RX by RZ oval around `site`. */
  const layout = (site: Point, RX: number, RZ: number) => {
    const count = 9 + Math.floor(rng() * 5),
      rotation = rng() * Math.PI * 2,
      controls: Point[] = [];
    for (let i = 0; i < count; i++) {
      const theta = rotation + ((i + (rng() - 0.5) * 0.5) / count) * Math.PI * 2,
        // A few control points pulled well inside make hairpins and chicanes.
        r = rng() < 0.25 ? 0.4 + rng() * 0.2 : 0.7 + rng() * 0.3;
      controls.push({
        x: site.x + Math.cos(theta) * RX * r,
        z: site.z + Math.sin(theta) * RZ * r,
      });
    }
    // Relax kinks on a coarse 6 m polyline, where smoothing reaches corner scale.
    let candidate = resample(closedSpline(controls, 1), 6);
    for (let pass = 0; pass < 60 && minRadius(candidate, 2) < 24; pass++)
      candidate = candidate.map((p, i) => {
        const a = candidate[(i - 1 + candidate.length) % candidate.length],
          b = candidate[(i + 1) % candidate.length];
        return { x: p.x * 0.5 + (a.x + b.x) * 0.25, z: p.z * 0.5 + (a.z + b.z) * 0.25 };
      });
    return resample(candidate, STEP);
  };
  // The track's corridor must miss every street, building, lake, river and the sea.
  const clear = (loop: Point[], roads: Road[]) =>
    loop.every((p, i) => {
      if (i % 2) return true;
      const h = groundAt(ctx, p);
      if (
        !insideWorld(p, 40) ||
        h < DRY ||
        ctx.wet[gridIndex(p)] ||
        ctx.paved(p) ||
        ctx.taken.some((ring) => pointInPolygon(p, ring))
      )
        return false;
      return roads.every(
        (r) =>
          dist(
            closestOnSegment(p, { x: r.ax, z: r.az }, { x: r.bx, z: r.bz }).point,
            p,
          ) >
          TRACK_WIDTH / 2 + r.width / 2 + 8,
      );
    }) &&
    !ctx.buildings.some(
      (b) =>
        Math.hypot(b.x - loop[0].x, b.z - loop[0].z) < 600 &&
        loop.some(
          (p, i) =>
            i % 4 === 0 &&
            pointInPolygon(
              p,
              rotatedRect(
                b,
                b.w + TRACK_WIDTH + 8,
                b.d + TRACK_WIDTH + 8,
                b.angle ?? 0,
              ),
            ),
        ),
    );
  let loop: Point[] | undefined;
  for (const [RX, RZ] of [
    [170, 115],
    [140, 95],
    [115, 80],
  ]) {
    // Open, dry, gently rolling sites first, the fewest streets inside them first.
    const sites: { c: Point; streets: number; rough: number }[] = [];
    for (let z = -LIMIT + RZ + 60; z <= LIMIT - RZ - 60; z += 48)
      for (let x = -LIMIT + RX + 60; x <= LIMIT - RX - 60; x += 48) {
        const c = { x, z };
        if (dist(c, ctx.map.centre) < 300) continue;
        let lo = Infinity,
          hi = -Infinity,
          dry = 0,
          total = 0;
        for (let dz = -RZ; dz <= RZ; dz += 20)
          for (let dx = -RX; dx <= RX; dx += 20) {
            const p = { x: x + dx, z: z + dz },
              h = groundAt(ctx, p);
            total++;
            if (h < DRY || ctx.wet[gridIndex(p)]) continue;
            dry++;
            lo = Math.min(lo, h);
            hi = Math.max(hi, h);
          }
        if (dry < total * 0.9 || hi - lo > 40) continue;
        const streets = ctx.roads.filter(
          (r) => Math.abs(r.x - x) < RX + 20 && Math.abs(r.z - z) < RZ + 20,
        ).length;
        sites.push({ c, streets, rough: hi - lo });
      }
    sites.sort((a, b) => a.streets - b.streets || a.rough - b.rough);
    for (const site of sites.slice(0, 30)) {
      const near = ctx.roads.filter(
        (r) => Math.abs(r.x - site.c.x) < RX + 60 && Math.abs(r.z - site.c.z) < RZ + 60,
      );
      for (let attempt = 0; attempt < 25 && !loop; attempt++) {
        const candidate = layout(site.c, RX, RZ);
        if (
          candidate.length * STEP >= 2.2 * (RX + RZ) &&
          minRadius(candidate) >= 20 &&
          !selfIntersects(candidate) &&
          minSeparation(candidate, STEP, 80) >= TRACK_WIDTH + 30 &&
          clear(candidate, near)
        )
          loop = candidate;
      }
      if (loop) break;
    }
    if (loop) break;
  }
  if (!loop) throw Error("Could not lay out a racetrack");
  // Ground profile along the loop, smoothed over about 80 m so crests stay drivable.
  let profile = loop.map((p) => groundAt(ctx, p));
  for (let pass = 0; pass < 3; pass++)
    profile = profile.map((_, i) => {
      let sum = 0;
      for (let k = -20; k <= 20; k++)
        sum += profile[(i + k + loop!.length) % loop!.length];
      return sum / 41;
    });
  // Fit the terrain to the profile along the corridor, feathered into the land.
  const CORE = TRACK_WIDTH / 2 + 5,
    FEATHER = 22;
  let x0 = Infinity,
    x1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (const p of loop) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.z);
    z1 = Math.max(z1, p.z);
  }
  const reach = CORE + FEATHER + TERRAIN_STEP;
  for (
    let gz = Math.max(0, Math.floor((z0 - reach + LIMIT) / TERRAIN_STEP));
    gz <= Math.min(TERRAIN_SIDE - 1, Math.ceil((z1 + reach + LIMIT) / TERRAIN_STEP));
    gz++
  )
    for (
      let gx = Math.max(0, Math.floor((x0 - reach + LIMIT) / TERRAIN_STEP));
      gx <= Math.min(TERRAIN_SIDE - 1, Math.ceil((x1 + reach + LIMIT) / TERRAIN_STEP));
      gx++
    ) {
      const p = { x: gx * TERRAIN_STEP - LIMIT, z: gz * TERRAIN_STEP - LIMIT };
      let nearest = 0,
        best = Infinity;
      for (let i = 0; i < loop.length; i++) {
        const d = dist(p, loop[i]);
        if (d < best) {
          best = d;
          nearest = i;
        }
      }
      if (best > CORE + FEATHER) continue;
      const i = gz * TERRAIN_SIDE + gx,
        t = best <= CORE ? 1 : 1 - (best - CORE) / FEATHER;
      ctx.heights[i] = round(ctx.heights[i] + (profile[nearest] - ctx.heights[i]) * t);
    }
  // Asphalt pieces, edge lines and a chequered start line.
  const n = loop.length,
    normal = (i: number) => {
      const a = loop![(i - 1 + n) % n],
        b = loop![(i + 1) % n],
        l = dist(a, b) || 1;
      return { x: -(b.z - a.z) / l, z: (b.x - a.x) / l };
    };
  const offset = (i: number, d: number) => {
    const m = normal(i);
    return { x: loop![i].x + m.x * d, z: loop![i].z + m.z * d };
  };
  const strip = (from: number, to: number, a: number, b: number) => {
    const out: number[] = [];
    for (let i = from; i <= to; i++) {
      const k = i % n,
        p = offset(k, a);
      out.push(round(p.x), round(profile[k]), round(p.z));
    }
    for (let i = to; i >= from; i--) {
      const k = i % n,
        q = offset(k, b);
      out.push(round(q.x), round(profile[k]), round(q.z));
    }
    return out;
  };
  const PIECE = TILE / STEP;
  for (let i = 0; i < n; i += PIECE) {
    const to = Math.min(i + PIECE, n);
    // One quad per sample: a longer sloped strip would be ear-clipped into chords
    // that cut across the profile and crack against its neighbours.
    for (let k = i; k < to; k++) {
      ctx.asphalt.push(strip(k, k + 1, -TRACK_WIDTH / 2, TRACK_WIDTH / 2));
      for (const side of [-1, 1])
        ctx.markings.push({
          color: "white",
          polygon: strip(
            k,
            k + 1,
            side * (TRACK_WIDTH / 2 - 0.5),
            side * (TRACK_WIDTH / 2 - 0.8),
          ),
        });
    }
    ctx.taken.push([
      offset(i % n, -CORE - 6),
      offset(to % n, -CORE - 6),
      offset(to % n, CORE + 6),
      offset(i % n, CORE + 6),
    ]);
  }
  // Chequered start line two squares deep across the track at sample 0.
  const tangent = { x: loop[1].x - loop[0].x, z: loop[1].z - loop[0].z },
    tl = Math.hypot(tangent.x, tangent.z),
    along = { x: tangent.x / tl, z: tangent.z / tl },
    across = normal(0),
    SQUARE = 1;
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < TRACK_WIDTH / SQUARE; col++) {
      if ((row + col) % 2) continue;
      const a = -TRACK_WIDTH / 2 + col * SQUARE,
        b = row * SQUARE - SQUARE;
      const corner = (da: number, db: number) => ({
        x: loop![0].x + across.x * (a + da) + along.x * (b + db),
        z: loop![0].z + across.z * (a + da) + along.z * (b + db),
      });
      ctx.markings.push({
        color: "white",
        polygon: flat(
          [corner(0, 0), corner(SQUARE, 0), corner(SQUARE, SQUARE), corner(0, SQUARE)],
          profile[0],
        ),
      });
    }
  // Two grid slots behind the line, staggered either side of the racing line.
  const grid: Spot[] = [6, 12].map((back, slot) => {
    const k = (n - back / STEP) % n,
      p = offset(k, slot ? 2.6 : -2.6),
      heading = Math.atan2(along.x, along.z);
    return { x: round(p.x), z: round(p.z), angle: round(heading) };
  });
  return {
    path: loop.flatMap((p) => [round(p.x), round(p.z)]),
    width: TRACK_WIDTH,
    grid,
  };
}

export type Harbour = NonNullable<City["harbours"]>[number];
/**
 * Harbours on the sea coast: a concrete quay level a metre above the water, a
 * dredged basin in front of it and three moorings for boats, plus a harbour office.
 * Sites are deep-water stretches of coast, kept far apart and preferably near a street.
 */
export function placeHarbours(ctx: FeatureContext, count = 3): Harbour[] {
  const QUAY = 52,
    APRON = 30,
    BASIN = 30,
    level = round(WATER_LEVEL + 1.1);
  type Candidate = { at: Point; angle: number; score: number };
  const found: Candidate[] = [];
  for (let gz = 4; gz < TERRAIN_SIDE - 4; gz += 2)
    for (let gx = 4; gx < TERRAIN_SIDE - 4; gx += 2) {
      const p = { x: gx * TERRAIN_STEP - LIMIT, z: gz * TERRAIN_STEP - LIMIT },
        h = ctx.heights[gz * TERRAIN_SIDE + gx];
      if (h < WATER_LEVEL + 0.3 || h > WATER_LEVEL + 6 || !insideWorld(p, 120))
        continue;
      // Seaward direction: down the smoothed slope.
      const g = {
        x:
          groundAt(ctx, { x: p.x + 24, z: p.z }) -
          groundAt(ctx, { x: p.x - 24, z: p.z }),
        z:
          groundAt(ctx, { x: p.x, z: p.z + 24 }) -
          groundAt(ctx, { x: p.x, z: p.z - 24 }),
      };
      const gl = Math.hypot(g.x, g.z);
      if (gl < 1e-3) continue;
      const sea = { x: -g.x / gl, z: -g.z / gl },
        // The quay line runs across the seaward direction; local +v points out to sea.
        // Quays run along the terrain grid: a vertical wall on a diagonal line would
        // step with every cell, and a straight face is what a quay looks like anyway.
        angle = Math.round(Math.atan2(-sea.x, sea.z) / (Math.PI / 2)) * (Math.PI / 2),
        f = frame(p, angle);
      let ok = true,
        depth = 0;
      for (const u of [-QUAY / 2, 0, QUAY / 2]) {
        for (const v of [18, 26, 36]) {
          const q = f.at(u, v),
            d = WATER_LEVEL - groundAt(ctx, q);
          // Open sea only: lakes stand above the sea level and are masked as wet.
          // The basin is dredged to four metres, so a gently shelving coast will do.
          if (d < 0.5 || ctx.wet[gridIndex(q)]) ok = false;
          depth += d;
        }
        for (const v of [-4, -14, -APRON + 2]) {
          const q = f.at(u, v),
            land = groundAt(ctx, q);
          if (
            land < WATER_LEVEL + 0.2 ||
            land > WATER_LEVEL + 7 ||
            ctx.wet[gridIndex(q)] ||
            ctx.paved(q)
          )
            ok = false;
        }
      }
      if (!ok) continue;
      const footprint = rotatedRect(
        f.at(0, (BASIN - APRON) / 2),
        QUAY + 8,
        APRON + BASIN,
        angle,
      );
      if (overlapsTaken(ctx, footprint) || overlapsBuilding(ctx, footprint)) continue;
      // The apron's terrain eases out over 24 m, so a street any closer would be left
      // on a steep cut beside the quay.
      if (nearRoad(ctx.roads, rotatedRect(f.at(0, -APRON / 2), QUAY, APRON, angle), 26))
        continue;
      // Near a street is better (people can drive there); deeper water is better.
      let road = Infinity;
      for (const r of ctx.roads)
        road = Math.min(
          road,
          dist(
            closestOnSegment(p, { x: r.ax, z: r.az }, { x: r.bx, z: r.bz }).point,
            p,
          ),
        );
      found.push({ at: p, angle, score: depth / 9 - Math.min(road, 300) / 40 });
    }
  found.sort((a, b) => b.score - a.score);
  const chosen: Candidate[] = [];
  for (const spacing of [700, 500, 350])
    for (const c of found) {
      if (chosen.length >= count) break;
      if (chosen.every((o) => dist(o.at, c.at) > spacing)) chosen.push(c);
    }
  if (chosen.length < count)
    throw Error(`Only ${chosen.length} harbour sites on the coast`);
  return chosen.map((c, index) => {
    const f = frame(c.at, c.angle);
    // Apron flat at quay level; basin dredged to at least four metres.
    stampRect(ctx, f.at(0, -APRON / 2), QUAY, APRON, c.angle, level, 24);
    // The dig leaves the quay's own grid ring alone and never raises the seabed. Only
    // the corridor in front of the quay cuts into land; beside it, ground stays a
    // beach and only water is deepened, so the basin does not carve a staircase
    // of vertical walls into the shore.
    stampRect(
      ctx,
      f.at(0, BASIN / 2 + 8),
      QUAY + 8,
      BASIN,
      c.angle,
      WATER_LEVEL - 4,
      12,
      (p, current) => {
        const { u, v } = f.local(p);
        return (
          current > WATER_LEVEL - 4 &&
          v > 6 &&
          (Math.abs(u) <= QUAY / 2 || current <= WATER_LEVEL)
        );
      },
    );
    for (const tile of tiles(f, -QUAY / 2, QUAY / 2, -16, 5))
      ctx.sidewalks.push(flat(tile, level));
    // Mooring stripes along the quay edge.
    for (let u = -QUAY / 2 + 4; u <= QUAY / 2 - 4; u += 6)
      ctx.markings.push({
        color: "yellow",
        polygon: flat(
          [
            f.at(u - 0.6, 4.1),
            f.at(u + 0.6, 4.1),
            f.at(u + 0.6, 4.5),
            f.at(u - 0.6, 4.5),
          ],
          level + 0.15,
        ),
      });
    const office = f.at(-QUAY / 2 + 9, -APRON + 7);
    ctx.buildings.push({
      x: round(office.x),
      z: round(office.z),
      w: 14,
      d: 9,
      y: level,
      h: round(level + 6),
      angle: round(Math.atan2(Math.sin(c.angle), Math.cos(c.angle))),
      asset: "warehouse",
      facing: 0,
      color: "#b9b3a2",
      style: index % 3,
    });
    ctx.taken.push(
      rotatedRect(f.at(0, (BASIN - APRON) / 2), QUAY + 12, APRON + BASIN + 4, c.angle),
    );
    const berths: Spot[] = [-17, 0, 17].map((u) => {
      const p = f.at(u, 18);
      // Moored alongside: bow along the quay.
      return {
        x: round(p.x),
        z: round(p.z),
        angle: round(Math.atan2(Math.cos(c.angle), Math.sin(c.angle))),
      };
    });
    const sign = f.at(0, -8);
    return { x: round(sign.x), z: round(sign.z), angle: round(c.angle), berths };
  });
}

/** Compass name of a point relative to the island's middle, for landmark labels. */
export function compass(p: Point, middle: Point) {
  const a = Math.atan2(p.x - middle.x, p.z - middle.z);
  return [
    "NORTH",
    "NORTHEAST",
    "EAST",
    "SOUTHEAST",
    "SOUTH",
    "SOUTHWEST",
    "WEST",
    "NORTHWEST",
  ][((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}

/** Keep the runway and approaches clear, with services on either side. */
export function dressAirport(ctx: FeatureContext, a: City["airport"]) {
  const f = frame(a, 0),
    level = groundAt(ctx, a);
  for (const [u0, u1, v0, v1] of [
    [30, 40, -90, 90],
    [35, 95, -85, 85],
    [11, 35, -75, -65],
    [11, 35, 65, 75],
    [-95, -28, -70, -30],
  ])
    for (const tile of tiles(f, u0, u1, v0, v1)) ctx.asphalt.push(flat(tile, level));
  for (const [u, v, w, d, h, asset, color] of [
    [72, -55, 36, 32, 14, "warehouse", "#93a9b6"],
    [72, 55, 36, 32, 14, "warehouse", "#a6b7bd"],
    [-62, 5, 56, 26, 10, "campus", "#d6d0b8"],
    [-87, 48, 12, 12, 25, "deco-tower", "#bdd2d3"],
  ] satisfies [number, number, number, number, number, Building["asset"], string][]) {
    const p = f.at(u, v);
    ctx.buildings.push({
      ...p,
      w,
      d,
      y: level,
      h: level + h,
      asset,
      color,
      style: 0,
      angle: 0,
      facing: 0,
    });
  }
  for (const tile of tiles(f, -95, -28, -28, -18))
    ctx.sidewalks.push(flat(tile, level));
  const line = (
    u0: number,
    u1: number,
    v0: number,
    v1: number,
    color: "yellow" | "white",
  ) =>
    ctx.markings.push({
      color,
      polygon: flat(
        [f.at(u0, v0), f.at(u1, v0), f.at(u1, v1), f.at(u0, v1)],
        level + 0.02,
      ),
    });
  line(34.85, 35.15, -85, 85, "yellow");
  for (const v of [-70, 70]) line(11, 35, v - 0.15, v + 0.15, "yellow");
  for (let u = -92; u < -30; u += 5) line(u, u + 0.15, -68, -57, "white");
  line(-92, -32, -57.15, -57, "white");
}
