import { LIMIT } from "./world.ts";
import { z } from "zod";
import type { Entity, Input } from "./world.ts";
import type { Destructible, DebrisState } from "./destruction.ts";

export const debugCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("state") }),
  z.object({ kind: z.literal("destroyProp"), id: z.string().min(1).max(120) }),
  z.object({
    kind: z.literal("time"),
    hour: z.number().finite().min(0).max(24),
    rate: z.number().finite().min(0).max(24).optional(),
  }),
  z.object({
    kind: z.literal("teleport"),
    x: z
      .number()
      .finite()
      .min(-LIMIT + 4)
      .max(LIMIT - 4),
    z: z
      .number()
      .finite()
      .min(-LIMIT + 4)
      .max(LIMIT - 4),
  }),
  z.object({
    kind: z.literal("spawn"),
    model: z.enum(["sedan", "sport", "van", "scout", "utility", "plane"]),
  }),
]);
export type DebugCommand = z.infer<typeof debugCommandSchema>;
export interface DebugState {
  playerId: string;
  time: number;
  day: number;
  dayRate: number;
  citySeed: number;
  entities: Entity[];
  input: Input;
  destruction: {
    brokenProps: string[];
    nearby: Destructible[];
    debris: DebrisState[];
    maxBodies: number;
  };
  traffic: {
    jamCount: number;
    jammedCars: number;
    despawned: number;
    respawned: number;
    pendingRespawns: number;
  };
}
export interface DebugResult {
  type: "debugResult";
  requestId: number;
  state?: DebugState;
  error?: string;
}
