import { LIMIT } from "./world.ts";
import { TERRAIN_SIDE } from "./terrain.ts";
import { BUILDING_ASSET_IDS } from "./assets/buildings/index.ts";
import { z } from "zod";
const coordinate = z.number().finite().min(-LIMIT).max(LIMIT),
  size = z.number().finite().positive().max(256);
const point = { x: coordinate, z: coordinate };
/** Flat [x, y, z, ...] polygon with at least three vertices. */
const polygon = z
  .array(z.number().finite())
  .min(9)
  .max(3000)
  .refine((p) => p.length % 3 === 0, "polygon needs x, y, z triples");
export const citySchema = z.object({
  seed: z.number().int(),
  terrain: z
    .object({
      heights: z
        .array(z.number().finite().min(-80).max(240))
        .length(TERRAIN_SIDE * TERRAIN_SIDE),
    })
    .optional(),
  centre: z.object(point).optional(),
  surface: z
    .object({
      asphalt: z.array(polygon).max(20000),
      sidewalks: z.array(polygon).max(40000),
      markings: z
        .array(z.object({ color: z.enum(["white", "yellow"]), polygon }))
        .max(60000),
    })
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
          width: z.number().min(6).max(24),
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
    .max(30000),
  props: z
    .array(z.object({ ...point, h: size, kind: z.enum(["palm", "lamp", "tree"]) }))
    .max(30000),
  buildings: z
    .array(
      z.object({
        ...point,
        asset: z.enum(BUILDING_ASSET_IDS).optional(),
        facing: z.number().int().min(0).max(3).optional(),
        w: size,
        d: size,
        h: size,
        y: z.number().finite().min(-5).max(240).optional(),
        angle: z.number().finite().min(-Math.PI).max(Math.PI).optional(),
        color: z.string().regex(/^#[0-9a-f]{6}$/i),
        style: z.number().int().min(0).max(2),
      }),
    )
    .max(3000),
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
export const CITY_FORMAT_VERSION = 5;
export const cityFileSchema = z.object({
  format: z.literal("afterhours-city"),
  version: z.literal(CITY_FORMAT_VERSION),
  city: citySchema.extend({ terrain: citySchema.shape.terrain.unwrap() }),
});
