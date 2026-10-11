import { LIMIT, district, random, type City, type Building } from "../shared/world.ts";
import {
  BUILDING_ASSETS,
  type BuildingAssetId,
} from "../shared/assets/buildings/index.ts";
import { roadIntersectsBox, roadDistance } from "../shared/roads.ts";
import { generateRoads } from "./road-generator.ts";

export const CITY_TUNING = {
  airport: { x: 640, z: -640, w: 220, d: 220 },
  boardingAreas: [
    { x: 0, z: 36 },
    { x: -64, z: 30 },
  ],
};
type Lot = Pick<Building, "x" | "z" | "w" | "d">;
const overlaps = (a: Lot, b: Lot, gap = 0) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap &&
  Math.abs(a.z - b.z) < (a.d + b.d) / 2 + gap;

/** Offline road-first composition. There is deliberately no island-wide parcel grid. */
export function generateCity(seed = 713): City {
  const r = random(seed),
    roads = generateRoads(seed),
    buildings: Building[] = [],
    props: City["props"] = [],
    parks: City["parks"] = [],
    surfaces: NonNullable<City["surfaces"]> = [];
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const round = (v: number) => Math.round(v * 100) / 100;
  const airport = { ...CITY_TUNING.airport };
  const pads = [
    { x: 11, z: 25, w: 8, d: 14 },
    ...CITY_TUNING.boardingAreas.map((p) => ({ ...p, w: 14, d: 18 })),
  ];
  const pickups: City["pickups"] = [
    { x: 12, z: 17, weapon: "pistol" },
    { x: -12, z: -15, weapon: "bat" },
    { x: 76, z: 12, weapon: "pistol" },
  ];
  const clear = (lot: Lot) =>
    Math.abs(lot.x) + lot.w / 2 < LIMIT - 22 &&
    Math.abs(lot.z) + lot.d / 2 < LIMIT - 22 &&
    !roads.some((road) => roadIntersectsBox(road, lot)) &&
    !buildings.some((b) => overlaps(b, lot, 2)) &&
    !parks.some((p) => overlaps({ ...p, w: p.w ?? 38, d: p.d ?? 38 }, lot, 2)) &&
    !pads.some((p) => overlaps(p, lot, 2)) &&
    !pickups.some((p) => overlaps({ ...p, w: 2, d: 2 }, lot, 1));
  const add = (
    asset: BuildingAssetId,
    lot: Lot,
    height?: number,
    facing = 0,
    airfield = false,
  ) => {
    if (!clear(lot) || (!airfield && overlaps(lot, airport, 8))) return false;
    const recipe = BUILDING_ASSETS[asset];
    buildings.push({
      ...lot,
      x: round(lot.x),
      z: round(lot.z),
      w: round(lot.w),
      d: round(lot.d),
      asset,
      facing,
      h: round(
        height ?? recipe.height[0] + r() * (recipe.height[1] - recipe.height[0]),
      ),
      color: pick(recipe.colors),
      style: Math.floor(r() * 3),
    });
    return true;
  };
  // Anchor buildings and civic spaces make the city legible before local infill.
  add("deco-tower", { x: -166, z: -32, w: 22, d: 28 }, 108);
  add("glass-tower", { x: -160, z: 96, w: 25, d: 28 }, 82);
  add("campus", { x: 717, z: -640, w: 36, d: 94 }, 15, 3, true);
  add("warehouse", { x: 563, z: -693, w: 40, d: 42 }, 12, 1, true);
  add("warehouse", { x: 563, z: -587, w: 40, d: 42 }, 12, 1, true);
  add("deco-tower", { x: 714, z: -562, w: 12, d: 12 }, 32, 3, true);
  const addPark = (lot: Lot, kind: NonNullable<City["parks"][number]["kind"]>) => {
    if (!clear(lot) || overlaps(lot, airport, 15)) return false;
    parks.push({ ...lot, kind });
    return true;
  };
  addPark({ x: -96, z: -32, w: 34, d: 34 }, "civic");
  // Irregular green pockets, not whole repeated square city blocks.
  for (const p of [
    { x: 115, z: 110, w: 52, d: 58 },
    { x: -340, z: 105, w: 56, d: 45 },
    { x: 365, z: 355, w: 70, d: 65 },
    { x: -145, z: 365, w: 110, d: 80 },
    { x: 170, z: 490, w: 105, d: 120 },
    { x: -440, z: -430, w: 80, d: 105 },
    { x: -440, z: 560, w: 76, d: 88 },
    { x: 240, z: 600, w: 105, d: 82 },
    { x: -150, z: 650, w: 80, d: 66 },
  ])
    addPark(p, p.z > 380 ? "woodland" : "garden");
  for (let i = 0; i < 100; i++) {
    const x = round((r() - 0.5) * 1350),
      z = round((r() - 0.5) * 1300),
      w = round(28 + r() * 35),
      d = round(28 + r() * 45);
    if (parks.length >= 30) break;
    addPark({ x, z, w, d }, z > 360 ? "woodland" : "garden");
  }
  // Frontage rows follow the actual local tangent, with extra depth in commercial plots.
  // AABB footprints are retained so all server collision/roof contracts remain exact.
  const order = roads
    .map((road, i) => ({ road, i, key: r() }))
    .sort((a, b) => a.key - b.key);
  for (const { road } of order) {
    const dx = road.bx - road.ax,
      dz = road.bz - road.az,
      length = Math.hypot(dx, dz),
      nx = dz / length,
      nz = -dx / length;
    const spacing = road.kind === "service" ? 35 : 24;
    for (let t = spacing / 2; t < length - 3; t += spacing)
      for (const side of [-1, 1]) {
        const px = road.ax + (dx * t) / length,
          pz = road.az + (dz * t) / length,
          zone = district(px, pz);
        const industrial = zone === "IRONWORKS" || zone === "PORT PALOMA",
          suburb = zone === "NORTHWOOD";
        const asset: BuildingAssetId = industrial
          ? "warehouse"
          : zone === "UNIVERSITY"
            ? pick(["campus", "civic-hall"])
            : suburb
              ? "townhouse"
              : zone === "SUNSET BEACH"
                ? pick(["villa", "hotel", "apartments"])
                : zone === "DOWNTOWN"
                  ? pick(["glass-tower", "deco-tower", "hotel"])
                  : zone === "PALM GARDENS"
                    ? pick(["villa", "apartments"])
                    : zone === "EAST MARKET"
                      ? pick(["market-hall", "shop-house"])
                      : pick(["shop-house", "apartments"]);
        const w = round(
            industrial ? 26 + r() * 12 : suburb ? 13 + r() * 7 : 13 + r() * 8,
          ),
          d = round(industrial ? 25 + r() * 13 : 14 + r() * 8);
        const support = (Math.abs(nx) * w) / 2 + (Math.abs(nz) * d) / 2;
        const offset =
          (road.width / 2 + 5) * (Math.abs(nx) + Math.abs(nz)) + support + 1;
        const facing =
          Math.abs(nx) > Math.abs(nz) ? (side * nx > 0 ? 3 : 1) : side * nz > 0 ? 0 : 2;
        const x = round(px + nx * offset * side),
          z = round(pz + nz * offset * side);
        if (add(asset, { x, z, w, d }, undefined, facing) && industrial) {
          // A little cargo behind warehouses adds cover without blocking the street.
          add(
            "container",
            {
              x: round(x + side * nx * (support + 10)),
              z: round(z + side * nz * (support + 10)),
              w: 12,
              d: 5,
            },
            3,
            facing,
          );
        }
      }
  }
  // Back-lot infill near existing frontages; never start a second global grid.
  const frontage = [...buildings];
  for (const b of frontage) {
    if (b.asset === "container" || b.h > 40 || r() < 0.35) continue;
    const w = round(12 + r() * 6),
      d = round(12 + r() * 6);
    const angle = r() * Math.PI * 2,
      distance = 30 + r() * 12;
    add(
      b.asset ?? "shop-house",
      {
        x: round(b.x + Math.cos(angle) * distance),
        z: round(b.z + Math.sin(angle) * distance),
        w,
        d,
      },
      undefined,
      b.facing,
    );
  }
  const propKeys = new Set<string>();
  const addProp = (
    x: number,
    z: number,
    h: number,
    kind: City["props"][number]["kind"],
  ) => {
    x = round(x);
    z = round(z);
    const p = { x, z },
      key = `${x},${z}`;
    if (
      propKeys.has(key) ||
      Math.abs(x) > LIMIT - 15 ||
      Math.abs(z) > LIMIT - 15 ||
      overlaps({ ...p, w: 2, d: 2 }, airport, 3) ||
      buildings.some((b) => overlaps({ ...p, w: 1, d: 1 }, b, 1)) ||
      roads.some((road) => roadDistance(p, road) < road.width / 2 + 0.7) ||
      CITY_TUNING.boardingAreas.some((a) => Math.hypot(x - a.x, z - a.z) < 14)
    )
      return;
    propKeys.add(key);
    props.push({ x, z, h, kind });
  };
  for (const road of roads) {
    const dx = road.bx - road.ax,
      dz = road.bz - road.az,
      length = Math.hypot(dx, dz);
    if (length < 22) continue;
    for (let t = 18; t < length - 10; t += 42)
      for (const side of [-1, 1]) {
        const offset = road.width / 2 + 3;
        const x = road.ax + (dx * t) / length + ((side * dz) / length) * offset,
          z = road.az + (dz * t) / length - ((side * dx) / length) * offset;
        addProp(x, z, side < 0 ? 6 : 7, side < 0 ? "lamp" : z > 350 ? "tree" : "palm");
      }
  }
  for (const p of parks) {
    for (let x = p.x - (p.w ?? 38) / 2 + 6; x < p.x + (p.w ?? 38) / 2 - 3; x += 13)
      for (let z = p.z - (p.d ?? 38) / 2 + 6; z < p.z + (p.d ?? 38) / 2 - 3; z += 15) {
        if (Math.abs(x - p.x) < 5 || Math.abs(z - p.z) < 5) continue;
        addProp(x, z, round(6 + r() * 4), p.kind === "woodland" ? "tree" : "palm");
      }
  }
  return {
    seed,
    roads,
    buildings,
    props,
    parks,
    surfaces,
    airport,
    pickups,
    ramps: [
      { x: 3.5, z: 91 },
      { x: -124.5, z: -37 },
    ],
    landmarks: [
      { x: 640, z: -640, name: "PALOMA INTERNATIONAL", kind: "airport" },
      { x: -96, z: -32, name: "CIVIC SQUARE", kind: "plaza" },
      { x: -166, z: -32, name: "PALOMA TOWER", kind: "tower" },
      { x: -610, z: 70, name: "SUNSET DRIVE", kind: "plaza" },
      { x: 365, z: -605, name: "PORT PALOMA", kind: "plaza" },
      { x: 365, z: 355, name: "UNIVERSITY CRESCENT", kind: "plaza" },
      { x: -145, z: 365, name: "NORTHWOOD TRAILS", kind: "plaza" },
    ],
  };
}
