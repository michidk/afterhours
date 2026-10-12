import { LIMIT } from "./world.ts";
import { BUILDING_ASSET_IDS } from "./assets/buildings/index.ts";
import { z } from "zod";
const coordinate = z.number().finite().min(-LIMIT).max(LIMIT),
  size = z.number().finite().positive().max(256);
const point = { x: coordinate, z: coordinate };
export const citySchema = z.object({
  seed: z.number().int(),
  terrain: z
    .object({ heights: z.array(z.number().finite().min(-20).max(240)).length(97 * 97) })
    .optional(),
  roads: z
    .array(
      z
        .object({
          ...point,
          ax: coordinate,
          az: coordinate,
          bx: coordinate,
          bz: coordinate,
          width: z.number().min(10).max(24),
          kind: z.enum(["avenue", "street", "coast", "service"]),
          signalA: z.boolean().optional(),
          signalB: z.boolean().optional(),
        })
        .refine(
          (r) => Math.hypot(r.bx - r.ax, r.bz - r.az) >= 0.05,
          "road segment must have length",
        ),
    )
    .min(1)
    .max(5000),
  props: z
    .array(z.object({ ...point, h: size, kind: z.enum(["palm", "lamp", "tree"]) }))
    .max(5000),
  buildings: z
    .array(
      z.object({
        ...point,
        asset: z.enum(BUILDING_ASSET_IDS).optional(),
        facing: z.number().int().min(0).max(3).optional(),
        w: size,
        d: size,
        h: size,
        color: z.string().regex(/^#[0-9a-f]{6}$/i),
        style: z.number().int().min(0).max(2),
      }),
    )
    .max(1000),
  parks: z
    .array(
      z.object({
        ...point,
        w: size.optional(),
        d: size.optional(),
        kind: z.enum(["garden", "civic", "woodland"]).optional(),
      }),
    )
    .max(300),
  surfaces: z
    .array(
      z.object({
        ...point,
        w: size,
        d: size,
        kind: z.enum(["plaza", "parking", "service", "court", "quay"]),
      }),
    )
    .max(2000)
    .optional(),
  ramps: z.array(z.object(point)).max(100),
  pickups: z
    .array(z.object({ ...point, weapon: z.enum(["bat", "pistol", "smg"]) }))
    .max(100),
  airport: z.object({ ...point, w: size, d: size }),
  landmarks: z
    .array(
      z.object({
        ...point,
        name: z.string().max(60),
        kind: z.enum(["tower", "plaza", "airport"]),
      }),
    )
    .max(100),
});
export const cityFileSchema = z.object({
  format: z.literal("afterhours-city"),
  version: z.literal(4),
  city: citySchema.extend({ terrain: citySchema.shape.terrain.unwrap() }),
});
