import { sample, slope } from "./field.ts";
import {
  area,
  centroid,
  convexOverlap,
  dist,
  insetPolygon,
  orientedBox,
  pointInPolygon,
  rotatedRect,
  SpatialHash,
} from "./geom.ts";
import { derive, pick, range, type Rng } from "./random.ts";
import type {
  Block,
  BuildingKind,
  BuildingPlacement,
  HeightField,
  Lot,
  Point,
  Zone,
} from "./types.ts";

const PALETTE: Record<BuildingKind, string[]> = {
  tower: ["#9fb7c9", "#b9c6d0", "#d9d2c3", "#8fa3b4"],
  office: ["#c9c2b4", "#b7b1a6", "#d3cbbd", "#a8b2b9"],
  apartments: ["#d8c3a0", "#e2cdb0", "#c9b49a", "#e6d7bd"],
  shop: ["#e4b98a", "#d99f7b", "#efc9a0", "#c98f6c"],
  townhouse: ["#d1a98f", "#c59a7e", "#dcb59c", "#b98c70"],
  house: ["#e7d7b7", "#d8c7a2", "#f0e2c6", "#cdbf9f"],
  warehouse: ["#aab4bb", "#9ca7ae", "#b8c0c6", "#8f9aa2"],
  civic: ["#efe1b8", "#e8d8aa", "#f5e8c8"],
};
const SETBACK: Record<Zone, number> = {
  core: 0.5,
  commercial: 1.2,
  residential: 2.5,
  suburb: 4,
  industrial: 3,
  park: 0,
  rural: 0,
};

/**
 * Stage 5: one street-aligned rectangular footprint per lot, sized by zone coverage,
 * with heights falling off from the centre and flat pads on sloping ground.
 */
export function placeBuildings(
  blocks: Block[],
  f: HeightField,
  centre: Point,
  seed: number,
): BuildingPlacement[] {
  const rng = derive(seed, "buildings"),
    out: BuildingPlacement[] = [],
    hash = new SpatialHash<BuildingPlacement>(64);
  for (const block of blocks)
    for (const lot of block.lots) {
      const placement = fitLot(lot, block.zone, f, centre, rng);
      if (!placement) continue;
      const poly =
        placement.footprint ??
        rotatedRect(placement, placement.w, placement.d, placement.angle);
      const clash = hash
        .near(placement.x, placement.z, 60)
        .some((b) =>
          convexOverlap(poly, b.footprint ?? rotatedRect(b, b.w + 1, b.d + 1, b.angle)),
        );
      if (clash) continue;
      out.push(placement);
      hash.insert(placement);
    }
  return out;
}

/** Dense zones extrude the whole setback polygon, as real downtown blocks do. */
function fitPolygon(lot: Lot, zone: Zone, f: HeightField, centre: Point, rng: Rng) {
  const inset = insetPolygon(lot.polygon, SETBACK[zone] + 0.6);
  if (!inset || inset.length < 3 || area(inset) < 60) return undefined;
  const box = orientedBox(inset);
  if (Math.max(box.w, box.d) > 60 || Math.min(box.w, box.d) < 5) return undefined;
  const heights = inset.map((p) => sample(f, p.x, p.z));
  const centreH = sample(f, box.centre.x, box.centre.z);
  if (
    slope(f, box.centre.x, box.centre.z) > 0.42 ||
    Math.max(...heights) - Math.min(...heights) > 9
  )
    return undefined;
  const pad = Math.max(0.8, (Math.max(...heights) + centreH) / 2);
  const { kind, h } = typeAndHeight(zone, dist(box.centre, centre), area(inset), rng);
  return {
    x: Math.round(box.centre.x * 100) / 100,
    z: Math.round(box.centre.z * 100) / 100,
    w: Math.round(box.w * 10) / 10,
    d: Math.round(box.d * 10) / 10,
    angle: box.angle,
    h: Math.round(h * 10) / 10,
    y: Math.round(pad * 100) / 100,
    kind,
    color: pick(rng, PALETTE[kind]),
    footprint: inset.map((p) => ({
      x: Math.round(p.x * 100) / 100,
      z: Math.round(p.z * 100) / 100,
    })),
  } satisfies BuildingPlacement;
}

function fitLot(
  lot: Lot,
  zone: Zone,
  f: HeightField,
  centre: Point,
  rng: Rng,
): BuildingPlacement | undefined {
  if (lot.frontage < 0) return undefined;
  if (zone === "core" || zone === "commercial") {
    const dense = fitPolygon(lot, zone, f, centre, rng);
    if (dense) return dense;
  }
  const a = lot.polygon[lot.frontage],
    b = lot.polygon[(lot.frontage + 1) % lot.polygon.length];
  const angle = Math.atan2(b.z - a.z, b.x - a.x);
  // Local frame: u along the street, v into the lot.
  const c = Math.cos(-angle),
    s = Math.sin(-angle);
  const local = lot.polygon.map((p) => ({
    x: p.x * c - p.z * s,
    z: p.x * s + p.z * c,
  }));
  const front = { x: a.x * c - a.z * s, z: a.x * s + a.z * c };
  // Which side of the street edge is the lot? Centroid decides.
  const cl = centroid(local),
    inward = cl.z > front.z ? 1 : -1;
  let minU = Infinity,
    maxU = -Infinity,
    maxDepth = 0;
  for (const p of local) {
    minU = Math.min(minU, p.x);
    maxU = Math.max(maxU, p.x);
    maxDepth = Math.max(maxDepth, (p.z - front.z) * inward);
  }
  const setback = SETBACK[zone],
    side = zone === "core" ? 0.6 : zone === "commercial" ? 1.2 : 2.5;
  const frontLength = dist(a, b);
  const uCentre = (minU + maxU) / 2;
  // Shrink until the rectangle fits inside the lot polygon.
  const coverage = {
    core: 0.92,
    commercial: 0.8,
    residential: 0.62,
    suburb: 0.45,
    industrial: 0.7,
    park: 0,
    rural: 0,
  }[zone];
  let w =
    Math.min(frontLength - 2 * side, maxU - minU - 2 * side) *
    (zone === "suburb" ? 0.7 : 0.95);
  let d = Math.max(6, (maxDepth - setback - (zone === "core" ? 1 : 4)) * coverage);
  w = Math.min(
    w,
    zone === "suburb"
      ? 16
      : zone === "residential"
        ? 24
        : zone === "industrial"
          ? 60
          : 44,
  );
  d = Math.min(
    d,
    zone === "suburb"
      ? 14
      : zone === "residential"
        ? 20
        : zone === "industrial"
          ? 50
          : 36,
  );
  if (w < 6 || d < 6) return undefined;
  const place = (ww: number, dd: number) => {
    const lz = front.z + inward * (setback + dd / 2);
    const lx = uCentre;
    const wx = lx * Math.cos(angle) - lz * Math.sin(angle),
      wz = lx * Math.sin(angle) + lz * Math.cos(angle);
    return { x: wx, z: wz };
  };
  let pos = place(w, d);
  for (let i = 0; i < 8; i++) {
    const rect = rotatedRect(pos, w, d, angle);
    if (rect.every((p) => pointInPolygon(p, lot.polygon))) break;
    w *= 0.88;
    d *= 0.92;
    if (w < 6 || d < 6) return undefined;
    pos = place(w, d);
  }
  const rect = rotatedRect(pos, w, d, angle);
  if (!rect.every((p) => pointInPolygon(p, lot.polygon))) return undefined;
  // Slope gate and pad height.
  const heights = rect.map((p) => sample(f, p.x, p.z));
  const centreH = sample(f, pos.x, pos.z);
  const steep = slope(f, pos.x, pos.z);
  if (steep > 0.42 || Math.max(...heights) - Math.min(...heights) > 9) return undefined;
  const pad = Math.max(0.8, (Math.max(...heights) + centreH) / 2);
  const dc = dist(pos, centre);
  const { kind, h } = typeAndHeight(zone, dc, w * d, rng);
  return {
    x: Math.round(pos.x * 100) / 100,
    z: Math.round(pos.z * 100) / 100,
    w: Math.round(w * 10) / 10,
    d: Math.round(d * 10) / 10,
    angle,
    h: Math.round(h * 10) / 10,
    y: Math.round(pad * 100) / 100,
    kind,
    color: pick(rng, PALETTE[kind]),
  } satisfies BuildingPlacement;
}

function typeAndHeight(zone: Zone, dc: number, footprint: number, rng: Rng) {
  const falloff = Math.exp(-dc / 420);
  const lognormal = Math.exp(range(rng, -0.25, 0.3));
  let kind: BuildingKind, h: number;
  switch (zone) {
    case "core":
      if (footprint > 450 && rng() < 0.45 + falloff * 0.4) {
        kind = "tower";
        h = (40 + 110 * falloff) * lognormal;
        if (rng() < 0.08) h *= 1.5;
      } else {
        kind = rng() < 0.6 ? "office" : "shop";
        h = (16 + 24 * falloff) * lognormal;
      }
      break;
    case "commercial":
      kind = rng() < 0.5 ? "apartments" : rng() < 0.7 ? "shop" : "office";
      h = (12 + 20 * falloff) * lognormal;
      break;
    case "residential":
      kind = rng() < 0.6 ? "apartments" : "townhouse";
      h = kind === "apartments" ? (10 + 10 * falloff) * lognormal : 8 * lognormal;
      break;
    case "suburb":
      kind = rng() < 0.12 ? "townhouse" : "house";
      h = (kind === "house" ? 5.5 : 8) * lognormal;
      break;
    case "industrial":
      kind = rng() < 0.9 ? "warehouse" : "office";
      h = (8 + rng() * 6) * lognormal;
      break;
    default:
      kind = "civic";
      h = 10;
  }
  if (rng() < 0.03 && zone !== "industrial" && zone !== "suburb") {
    kind = "civic";
    h = Math.max(h, 14);
  }
  return { kind, h: Math.max(4, Math.min(200, h)) };
}

/** Flatten the terrain under every building pad with a short feathered margin. */
export function stampPads(
  f: HeightField,
  buildings: BuildingPlacement[],
  protectedCells?: Float32Array,
) {
  const { w, h } = f;
  for (const b of buildings) {
    const margin = 3,
      r = Math.hypot(b.w, b.d) / 2 + margin;
    const x0 = Math.max(0, Math.floor((b.x - r + f.size / 2) / f.cell)),
      x1 = Math.min(w - 1, Math.ceil((b.x + r + f.size / 2) / f.cell)),
      z0 = Math.max(0, Math.floor((b.z - r + f.size / 2) / f.cell)),
      z1 = Math.min(h - 1, Math.ceil((b.z + r + f.size / 2) / f.cell));
    const c = Math.cos(-b.angle),
      s = Math.sin(-b.angle);
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const px = x * f.cell - f.size / 2 - b.x,
          pz = z * f.cell - f.size / 2 - b.z;
        const lx = Math.abs(px * c - pz * s),
          lz = Math.abs(px * s + pz * c);
        const dx = Math.max(0, lx - b.w / 2),
          dz = Math.max(0, lz - b.d / 2),
          dd = Math.hypot(dx, dz);
        if (dd > margin) continue;
        const i = z * w + x,
          t = 1 - dd / margin;
        // Road corridors keep their profile; pads only feather up to the kerb.
        if (protectedCells && protectedCells[i] > 0.98) continue;
        f.data[i] += (b.y - f.data[i]) * t;
      }
  }
}
