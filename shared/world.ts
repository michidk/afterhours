export const BLOCK = 64;
export const LIMIT = 224;
export const ROADS = [-192, -128, -64, 0, 64, 128, 192];
export type Kind = "player" | "pedestrian" | "car" | "helicopter" | "plane";
export interface Entity {
  id: string;
  kind: Kind;
  x: number;
  z: number;
  y: number;
  angle: number;
  vx: number;
  vz: number;
  vy: number;
  color: string;
  health: number;
  name?: string;
  driver?: string;
  vehicle?: string;
  weapon?: string;
  ai?: boolean;
  cooldown?: number;
  down?: number;
}
export interface Input {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  brake: boolean;
  ascend: boolean;
  descend: boolean;
  attack: boolean;
}
export const idle = (): Input => ({
  up: false,
  down: false,
  left: false,
  right: false,
  brake: false,
  ascend: false,
  descend: false,
  attack: false,
});
export interface Building {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  color: string;
  style: number;
}
export interface City {
  seed: number;
  buildings: Building[];
  parks: { x: number; z: number }[];
  ramps: { x: number; z: number }[];
  pickups: { x: number; z: number; weapon: string }[];
}
export function random(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function generateCity(seed = 713): City {
  const r = random(seed),
    buildings: Building[] = [],
    parks: { x: number; z: number }[] = [];
  const colors = [
    "#d8b88d",
    "#d2c8b3",
    "#ca8b72",
    "#91b5ac",
    "#d0a074",
    "#a8afbc",
  ];
  for (let ix = 0; ix < 6; ix++)
    for (let iz = 0; iz < 6; iz++) {
      const x = ROADS[ix] + 32,
        z = ROADS[iz] + 32;
      if (
        (ix === 4 && iz === 4) ||
        (r() < 0.14 && (ix < 2 || ix > 3 || iz < 2 || iz > 3))
      ) {
        parks.push({ x, z });
        continue;
      }
      for (const dx of [-11, 11])
        for (const dz of [-11, 11])
          buildings.push({
            x: x + dx,
            z: z + dz,
            w: 15 + r() * 2,
            d: 15 + r() * 2,
            h: ix < 2 ? 12 + r() * 24 : 6 + r() * 12,
            color: colors[Math.floor(r() * colors.length)],
            style: Math.floor(r() * 3),
          });
    }
  return {
    seed,
    buildings,
    parks,
    ramps: [
      { x: 3.5, z: 91 },
      { x: -124.5, z: -37 },
    ],
    pickups: [
      { x: 12, z: 17, weapon: "pistol" },
      { x: -12, z: -15, weapon: "bat" },
      { x: 76, z: 12, weapon: "pistol" },
    ],
  };
}
export function signal(time: number, axis: "x" | "z") {
  const phase = time % 18;
  return axis === "z"
    ? phase < 7
      ? "green"
      : phase < 9
        ? "amber"
        : "red"
    : phase >= 9 && phase < 16
      ? "green"
      : phase >= 16
        ? "amber"
        : "red";
}
export function district(x: number, z: number) {
  return x < -64
    ? "DOWNTOWN"
    : z > 64
      ? "PALM GARDENS"
      : x > 64
        ? "EAST MARKET"
        : "LITTLE HAVANA";
}
