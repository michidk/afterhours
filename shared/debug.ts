import { WORLD_LIMIT } from "./water.ts";
import { z } from "zod";
import type { Entity, Input } from "./world.ts";
import type { Destructible, DebrisState } from "./destruction.ts";

/** Teleport targets stay a few metres inside the shared world boundary. */
const coordinate = z
  .number()
  .finite()
  .min(-WORLD_LIMIT + 4)
  .max(WORLD_LIMIT - 4);
export const debugCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("state") }),
  z.object({ kind: z.literal("observe"), id: z.string().min(1).max(120).optional() }),
  z.object({ kind: z.literal("destroyProp"), id: z.string().min(1).max(120) }),
  z.object({
    kind: z.literal("time"),
    hour: z.number().finite().min(0).max(24),
    rate: z.number().finite().min(0).max(24).optional(),
  }),
  z.object({
    kind: z.literal("teleport"),
    x: coordinate,
    z: coordinate,
    /** Accept the nearest clear site within a short search when the point is occupied. */
    near: z.boolean().optional(),
  }),
  /** Admin: move yourself beside another connected player, wherever they are. */
  z.object({ kind: z.literal("gotoPlayer"), id: z.string().min(1).max(120) }),
  /** Admin: move another connected player beside yourself. */
  z.object({ kind: z.literal("bringPlayer"), id: z.string().min(1).max(120) }),
  z.object({
    kind: z.literal("spawn"),
    model: z.enum([
      "sedan",
      "sport",
      "van",
      "scout",
      "utility",
      "plane",
      "aerobatic",
      "boat",
      "launch",
      "jetski",
      "racer",
      "speedboat",
      "offshore",
    ]),
  }),
]);
export type DebugCommand = z.infer<typeof debugCommandSchema>;
export interface DebugState {
  server?: ServerDiagnostics;
  inspection?: { id: string; data: string } | null;
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
    honks: number;
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

export interface ServerDiagnostics {
  tickBudgetMs: number;
  tickCpuP95Ms: number;
  tickP95Ms: number;
  tickMaxMs: number;
  backlogMs: number;
  catchUpTicks: number;
  droppedMs: number;
  late: number;
  memoryMB: number;
  heapUsedMB: number;
  heapLimitMB: number;
  availableMemoryMB: number;
  players: number;
  entities: number;
}
