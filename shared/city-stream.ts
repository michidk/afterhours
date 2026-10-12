import { z } from "zod";
import { citySchema } from "./city-schema.ts";
import { LIMIT, type City } from "./world.ts";

export const CITY_CHUNK_SIZE = 128;
export const STATIC_FIELDS = [
  "roads",
  "buildings",
  "props",
  "parks",
  "surfaces",
  "ramps",
  "landmarks",
] as const;
export type StaticField = (typeof STATIC_FIELDS)[number];
export const mapManifestSchema = z.object({
  version: z.literal(1),
  mapId: z.string().regex(/^[0-9a-f]{64}$/),
  seed: citySchema.shape.seed,
  limit: z.literal(LIMIT),
  chunkSize: z.literal(CITY_CHUNK_SIZE),
  airport: citySchema.shape.airport,
});
export type MapManifest = z.infer<typeof mapManifestSchema>;
/** A navigation drawing, separate from streamed collision/render geometry. */
export const cityAtlasSchema = z.object({
  mapId: mapManifestSchema.shape.mapId,
  roads: z
    .array(
      z.object({
        ax: citySchema.shape.roads.element.shape.ax,
        az: citySchema.shape.roads.element.shape.az,
        bx: citySchema.shape.roads.element.shape.bx,
        bz: citySchema.shape.roads.element.shape.bz,
        width: citySchema.shape.roads.element.shape.width,
      }),
    )
    .max(10000),
  parks: z.array(citySchema.shape.parks.element).max(2000),
  landmarks: z.array(citySchema.shape.landmarks.element).max(1000),
  ramps: z.array(citySchema.shape.ramps.element).max(1000),
});
export type CityAtlas = z.infer<typeof cityAtlasSchema>;
const entry = <T extends z.ZodType>(value: T) =>
  z.object({ id: z.number().int().nonnegative(), value });
export const cityChunkSchema = z.object({
  mapId: mapManifestSchema.shape.mapId,
  key: z.string().regex(/^-?\d+,-?\d+$/),
  roads: z.array(entry(citySchema.shape.roads.element)).max(5000),
  buildings: z.array(entry(citySchema.shape.buildings.element)).max(1000),
  props: z.array(entry(citySchema.shape.props.element)).max(5000),
  parks: z.array(entry(citySchema.shape.parks.element)).max(300),
  surfaces: z.array(entry(citySchema.shape.surfaces.unwrap().element)).max(2000),
  ramps: z.array(entry(citySchema.shape.ramps.element)).max(100),
  landmarks: z.array(entry(citySchema.shape.landmarks.element)).max(100),
});
export type CityChunk = z.infer<typeof cityChunkSchema>;
export function emptyCity(map: Pick<MapManifest, "seed" | "airport">): City {
  return {
    seed: map.seed,
    airport: map.airport,
    roads: [],
    buildings: [],
    props: [],
    parks: [],
    surfaces: [],
    ramps: [],
    pickups: [],
    landmarks: [],
  };
}
export function chunkBounds(key: string) {
  const [x, z] = key.split(",").map(Number);
  return {
    minX: x * CITY_CHUNK_SIZE,
    maxX: (x + 1) * CITY_CHUNK_SIZE,
    minZ: z * CITY_CHUNK_SIZE,
    maxZ: (z + 1) * CITY_CHUNK_SIZE,
  };
}
export function chunksAround(x: number, z: number, radius: number) {
  const keys: string[] = [];
  const minX = Math.max(-LIMIT, x - radius),
    maxX = Math.min(LIMIT, x + radius),
    minZ = Math.max(-LIMIT, z - radius),
    maxZ = Math.min(LIMIT, z + radius);
  if (minX > maxX || minZ > maxZ) return keys;
  for (
    let cx = Math.floor(minX / CITY_CHUNK_SIZE);
    cx <= Math.floor(maxX / CITY_CHUNK_SIZE);
    cx++
  )
    for (
      let cz = Math.floor(minZ / CITY_CHUNK_SIZE);
      cz <= Math.floor(maxZ / CITY_CHUNK_SIZE);
      cz++
    )
      keys.push(`${cx},${cz}`);
  return keys;
}
