import type { Character } from "./character.ts";
import type { BuildingAssetId } from "./assets/buildings/index.ts";
export const BLOCK = 64;
import type { VehicleModel, WeaponItem, WeaponKind } from "./catalog.ts";
export const LIMIT = 1536;
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
  steering?: number;
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
  h: number;
  color: string;
  style: number;
}
export interface City {
  terrain?: { heights: number[] };
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
  pickups: { x: number; z: number; weapon: string }[];
  airport: { x: number; z: number; w: number; d: number };
  landmarks: {
    x: number;
    z: number;
    name: string;
    kind: "tower" | "plaza" | "airport";
  }[];
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
