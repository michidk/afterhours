import { characterSchema } from "./character.ts";
import { WORLD_LIMIT } from "./water.ts";
import { z } from "zod";
import type { Entity, WorldEvent, Input } from "./world.ts";
import type { MapManifest } from "./city-stream.ts";
import type { WeaponItem, AmmoKind } from "./catalog.ts";
import type { GrenadeState } from "./grenades.ts";
import type { DebrisState } from "./destruction.ts";
import { VERSION } from "./version.ts";
import { debugCommandSchema } from "./debug.ts";
export { VERSION } from "./version.ts";
const controls = {
  up: z.boolean().default(false),
  down: z.boolean().default(false),
  left: z.boolean().default(false),
  right: z.boolean().default(false),
  brake: z.boolean().default(false),
  sprint: z.boolean().default(false),
  ascend: z.boolean().default(false),
  descend: z.boolean().default(false),
  attack: z.boolean().default(false),
  aim: z.number().finite().min(-Math.PI).max(Math.PI).optional(),
  shotTime: z.number().finite().nonnegative().optional(),
};
const incomingMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("join"),
    version: z.literal(VERSION),
    name: z.string().trim().min(1).max(18),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    character: characterSchema.optional(),
    token: z.string().max(100).optional(),
  }),
  z.object({
    type: z.literal("input"),
    seq: z
      .number()
      .int()
      .nonnegative()
      .max(2 ** 31 - 1),
    timestamp: z.number().finite().nonnegative(),
    ...controls,
  }),
  z.object({ type: z.literal("resync") }),
  z.object({ type: z.literal("interact") }),
  z.object({ type: z.literal("drop") }),
  z.object({ type: z.literal("reload") }),
  z.object({ type: z.literal("jetpack") }),
  z.object({ type: z.literal("lights") }),
  z.object({ type: z.literal("equip"), slot: z.number().int().min(0).max(3) }),
  z.object({
    type: z.literal("debugCommand"),
    requestId: z
      .number()
      .int()
      .nonnegative()
      .max(2 ** 31 - 1),
    command: debugCommandSchema,
  }),
  z.object({
    type: z.literal("debugView"),
    center: z
      .object({
        x: z.number().finite().min(-WORLD_LIMIT).max(WORLD_LIMIT),
        z: z.number().finite().min(-WORLD_LIMIT).max(WORLD_LIMIT),
      })
      .nullable(),
  }),
  z.object({
    type: z.literal("chat"),
    text: z.string().trim().min(1).max(160),
  }),
  z.object({
    type: z.literal("debug"),
    kind: z.enum([
      "car",
      "sport",
      "van",
      "helicopter",
      "utility",
      "plane",
      "pistol",
      "smg",
      "bat",
      "knife",
      "machinegun",
      "flamethrower",
      "grenade",
      "jetpack",
      "heal",
      "damage",
      "day",
      "night",
    ]),
  }),
  z.object({
    type: z.literal("ping"),
    timestamp: z.number().finite().nonnegative(),
  }),
]);
export const messageSchema = incomingMessageSchema.and(
  z.object({ timestamp: z.number().finite().nonnegative().optional() }),
);
export type ClientMessage = z.infer<typeof messageSchema>;
export interface PlayerSummary {
  id: string;
  name: string;
  color: string;
}
export interface PlayerRoster {
  type: "roster";
  players: PlayerSummary[];
}
export interface InputFrame {
  seq: number;
  timestamp: number;
  input: Input;
}
export type PickupPayload =
  | { kind: "weapon"; item: WeaponItem }
  | { kind: "ammo"; ammoKind: AmmoKind; amount: number }
  | { kind: "jetpack"; fuel: number };
export type Pickup = PickupPayload & {
  id: string;
  x: number;
  z: number;
  y: number;
  expires: number;
};
import type { EntityPatch } from "./codec.ts";
export interface Snapshot {
  type: "state";
  version: number;
  frame: number;
  base: number;
  full: boolean;
  time: number;
  day: number;
  dayRate?: number;
  ack: number;
  ackTimestamp?: number;
  entities: EntityPatch[];
  removed: string[];
  events: WorldEvent[];
  pickups: Pickup[];
  players: number;
  debris?: DebrisState[];
  grenades?: GrenadeState[];
}
export interface Welcome {
  type: "welcome";
  version: number;
  id: string;
  token: string;
  map: MapManifest;
  debug: boolean;
}
