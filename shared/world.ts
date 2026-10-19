import type { PackedSurfaceChunks } from "./city-pack.ts";
import type { Character } from "./character.ts";
import type { Drive } from "./physics/vehicle.ts";
import type { BuildingAssetId } from "./assets/buildings/index.ts";
export const BLOCK = 64;
import type { VehicleModel, WeaponItem, WeaponKind } from "./catalog.ts";
export const LIMIT = 1536;
export const POSITION_SCALE = 1000;
export interface Road {
  /** Segment centre (also the streaming index position). Endpoints form the street graph. */
  x: number;
  z: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  width: number;
  kind: "avenue" | "street" | "coast" | "service";
  signalA?: boolean;
  signalB?: boolean;
  /** Distance from end A/B to the junction's stop line, where its signal stands. */
  stopA?: number;
  stopB?: number;
  /**
   * Signal phase for traffic on this segment at the junction toward end A/B, set by
   * the generator; otherwise the segment's dominant axis is used.
   */
  phaseA?: "x" | "z";
  phaseB?: "x" | "z";
  /** On a segment touching a junction at end A/B: that junction's stop-line distance. */
  approachA?: number;
  approachB?: number;
  /** Set by the generator where this segment's weapon crate spot is unusable. */
  noCrate?: boolean;
}
export type Kind =
  | "player"
  | "pedestrian"
  | "car"
  | "helicopter"
  | "plane"
  | "boat"
  | "jetski"
  | "speedboat";
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
  character?: Character;
  driver?: string;
  lightsOn?: boolean;
  /** A car swamped by water: seconds left before it explodes. Its engine is dead. */
  flooded?: number;
  /** Vehicle occupant IDs; slot zero is the driver/pilot. Null means vacant. */
  seats?: (string | null)[];
  vehicle?: string;
  /** Assigned vehicle slot, including zero for the driver/pilot. */
  seat?: number;
  parachute?: boolean;
  weapon?: string;
  ai?: boolean;
  cooldown?: number;
  down?: number;
  angularVelocity?: number;
  /** Helicopter attitude in radians: nose down and right side down are positive. */
  pitch?: number;
  roll?: number;
  steering?: number;
  /** Last driving forces applied by authority, held during remote prediction. */
  drive?: Drive;
  /** Last authoritative plane controls, held while predicting nearby aircraft. */
  planeInput?: Pick<Input, "moveX" | "moveY" | "ascend" | "descend">;
  rearGripLoss?: number;
  skidding?: boolean;
  wheelSkids?: boolean[];
  burning?: number;
  wreck?: number;
  flight?: "grounded" | "takingOff" | "cruising" | "landing" | "falling";
  takeoffDelay?: number;
  targetAltitude?: number;
  landingX?: number;
  landingZ?: number;
  model?: VehicleModel;
  maxHealth?: number;
  inventory?: WeaponItem[];
  equipped?: number;
  reloadUntil?: number;
  aim?: number;
  jetpack?: { fuel: number; active: boolean };
}
export interface WorldEvent {
  kind: string;
  x: number;
  y: number;
  z: number;
  angle?: number;
  length?: number;
  /** Entity struck by a hit, so clients can play its flinch. */
  target?: string;
  /** Attacker behind a swing or shot, so clients can animate the strike. */
  source?: string;
  sound?:
    | "pistol"
    | "smg"
    | "punch"
    | "bat"
    | "impact"
    | "impactWood"
    | "impactBody"
    | "swing"
    | "dryFire"
    | "horn";
}
export interface Input {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  moveX?: number;
  moveY?: number;
  brake: boolean;
  sprint?: boolean;
  ascend: boolean;
  descend: boolean;
  attack: boolean;
  aim?: number;
  shotTime?: number;
}
export const idle = (): Input => ({
  up: false,
  down: false,
  left: false,
  right: false,
  brake: false,
  sprint: false,
  ascend: false,
  descend: false,
  attack: false,
});
export const inputX = (input: Input) =>
  input.moveX ?? Number(input.right) - Number(input.left);
export const inputY = (input: Input) =>
  input.moveY ?? Number(input.up) - Number(input.down);
export interface Building {
  /** Replaceable visual recipe; dimensions remain authoritative collision bounds. */
  asset?: BuildingAssetId;
  facing?: number;
  x: number;
  z: number;
  w: number;
  d: number;
  /** Roof altitude. Generated cities set `y` (pad altitude) so walls span y..h. */
  h: number;
  y?: number;
  /** Footprint rotation in radians for street-aligned lots; collision honours it. */
  angle?: number;
  color: string;
  style: number;
}
/** Asphalt is drawn this far above its profile height; sidewalk slabs stand higher. */
export const STREET_LIFT = 0.1;
export const KERB_HEIGHT = 0.15;
/** Flat [x, y, z, ...] polygons with road-profile heights, shared by map and 3D. */
export interface RoadSurface {
  asphalt: number[][];
  sidewalks: number[][];
  markings: { color: "white" | "yellow"; polygon: number[] }[];
}
export interface City {
  terrain?: { heights: number[] };
  /** Downtown reference point for spawns; generated cities are not centred on 0,0. */
  centre?: { x: number; z: number };
  /** Where players appear: the town hall plaza in generated cities. */
  spawn?: { x: number; z: number };
  /** Street polygons packed per 128 m chunk; see shared/city-pack.ts. */
  surface?: PackedSurfaceChunks;
  roads: Road[];
  seed: number;
  props: { x: number; z: number; h: number; kind: "palm" | "lamp" | "tree" }[];
  buildings: Building[];
  parks: {
    x: number;
    z: number;
    w?: number;
    d?: number;
    kind?: "garden" | "civic" | "woodland";
  }[];
  surfaces?: {
    x: number;
    z: number;
    w: number;
    d: number;
    kind: "plaza" | "parking" | "service" | "court" | "quay";
  }[];
  ramps: { x: number; z: number }[];
  /**
   * Inland water of a generated city. Lakes are flat x, z outline pairs at a
   * surface `level`; rivers are flat x, z, surface y, width quadruples and are
   * drawn only. The sea is everywhere else below WATER_LEVEL.
   */
  water?: {
    lakes: { level: number; outline: number[] }[];
    rivers: { points: number[] }[];
  };
  /**
   * Pedestrian network of a generated city: flat x, z pairs along the middle of the
   * sidewalks, and flat link triples `a, b, crossing` where crossing is 0 along a
   * sidewalk, or 1/2 across a crosswalk whose traffic runs along x/z. Server only.
   */
  walkways?: { points: number[]; links: number[] };
  pickups: { x: number; z: number; weapon: string }[];
  airport: Airfield;
  /** Every airport of a generated city, `airport` first; authored cities have one. */
  airports?: Airfield[];
  /** Where players spawn, with a car park in front of it. */
  townHall?: {
    x: number;
    z: number;
    angle: number;
    spawn: { x: number; z: number };
    parking: Spot[];
  };
  /** A closed circuit: flat x, z centreline pairs, its width and starting grid. */
  racetrack?: { path: number[]; width: number; grid: Spot[] };
  /** Quays on the sea coast; `x, z` is the quay, berths lie in its basin. */
  harbours?: { x: number; z: number; angle: number; berths: Spot[] }[];
  landmarks: {
    x: number;
    z: number;
    name: string;
    kind: LandmarkKind;
  }[];
}
export type Airfield = { x: number; z: number; w: number; d: number };
/** A parking place: position and the yaw a vehicle stands at. */
export type Spot = { x: number; z: number; angle: number };
export type LandmarkKind =
  "tower" | "plaza" | "airport" | "townhall" | "racetrack" | "harbour";
/** Every airport of a city; authored cities and old artifacts only have `airport`. */
export const airportsOf = (city: Pick<City, "airport" | "airports">) =>
  city.airports?.length ? city.airports : [city.airport];
export function random(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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
  if (x > 512 && z < -512) return "PALOMA INTERNATIONAL";
  if (z < -384 && x > 192) return "PORT PALOMA";
  if (x > 256 && z < 128) return "IRONWORKS";
  if (x < -384) return "SUNSET BEACH";
  if (z > 384) return "NORTHWOOD";
  if (z > 256 && x > 192) return "UNIVERSITY";
  if (z > 128) return "PALM GARDENS";
  if (x < -64 && z > -256) return "DOWNTOWN";
  if (x > 128) return "EAST MARKET";
  return "LITTLE HAVANA";
}

export function spawnOrigin(city: Pick<City, "centre" | "spawn">) {
  if (city.spawn) return { ...city.spawn };
  return { x: (city.centre?.x ?? 0) + 11, z: (city.centre?.z ?? 0) + 25 };
}
