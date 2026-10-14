import { LIMIT } from "./world.ts";
import { TERRAIN_SIDE } from "./terrain.ts";
import { BUILDING_ASSET_IDS } from "./assets/buildings/index.ts";
import { z } from "zod";
import { packedSurfaceChunksSchema, packedTerrainSchema } from "./city-pack.ts";
const coordinate = z.number().finite().min(-LIMIT).max(LIMIT),
  size = z.number().finite().positive().max(256);
const point = { x: coordinate, z: coordinate };
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
  /** Street polygons packed per 128 m chunk; see shared/city-pack.ts. */
  surface: packedSurfaceChunksSchema.optional(),
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
          stopA: z.number().min(0).max(80).optional(),
          stopB: z.number().min(0).max(80).optional(),
          noCrate: z.boolean().optional(),
          phaseA: z.enum(["x", "z"]).optional(),
          phaseB: z.enum(["x", "z"]).optional(),
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
  walkways: z
    .object({
      points: z.array(coordinate).max(200000),
      links: z.array(z.number().int().min(0)).max(300000),
    })
    .refine(
      (w) =>
        w.points.length % 2 === 0 &&
        w.links.length % 3 === 0 &&
        w.links.every((v, i) => (i % 3 === 2 ? v <= 2 : v < w.points.length / 2)),
      "walkway links must join existing points",
    )
    .optional(),
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
export const CITY_FORMAT_VERSION = 6;
/** On disk the terrain is base64 int16 centimetres; see shared/city-pack.ts. */
const TERRAIN_BYTES = TERRAIN_SIDE * TERRAIN_SIDE * 2;
export const cityFileSchema = z.object({
  format: z.literal("afterhours-city"),
  version: z.literal(CITY_FORMAT_VERSION),
  city: citySchema.omit({ terrain: true }).extend({
    terrain: packedTerrainSchema.refine(
      (t) =>
        (t.cm.length * 3) / 4 -
          (t.cm.endsWith("==") ? 2 : t.cm.endsWith("=") ? 1 : 0) ===
        TERRAIN_BYTES,
      "terrain must hold one 16-bit height per grid cell",
    ),
  }),
});
