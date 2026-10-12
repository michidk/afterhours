import { z } from "zod";
import type { City, RoadSurface } from "./world.ts";

/**
 * Compact encodings for the bulky parts of a city. Terrain heights travel as
 * 16-bit centimetres; street polygons are bucketed into 128 m chunks by centroid
 * and stored as 16-bit centimetres relative to the chunk origin (height is
 * absolute). The artifact on disk, the server index and the streamed chunks all
 * share this layout, so the server never re-encodes geometry; only the client
 * unpacks the chunks it draws.
 */
export const PACK_CHUNK_SIZE = 128;
const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
export const packedLayerSchema = z.object({
  /** Vertex count per polygon, in order. */
  counts: z.array(z.number().int().min(3).max(1000)).max(20000),
  /** Base64 int16 little-endian x, y, z centimetre triples for every vertex. */
  xyz: base64,
});
export type PackedLayer = z.infer<typeof packedLayerSchema>;
export const packedSurfaceSchema = z.object({
  asphalt: packedLayerSchema,
  sidewalks: packedLayerSchema,
  white: packedLayerSchema,
  yellow: packedLayerSchema,
});
export type PackedSurface = z.infer<typeof packedSurfaceSchema>;
/** Chunk key `x,z` → packed polygons whose centroid lies in that chunk. */
export const packedSurfaceChunksSchema = z.record(
  z.string().regex(/^-?\d+,-?\d+$/),
  packedSurfaceSchema,
);
export type PackedSurfaceChunks = z.infer<typeof packedSurfaceChunksSchema>;
export const packedTerrainSchema = z.object({ cm: base64 });

type NodeBuffer = {
  from(
    data: Uint8Array | string,
    encoding?: string,
  ): Uint8Array & {
    toString(encoding: string): string;
  };
};
const nodeBuffer = (globalThis as { Buffer?: NodeBuffer }).Buffer;
export function toBase64(bytes: Uint8Array) {
  if (nodeBuffer) return nodeBuffer.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function fromBase64(text: string): Uint8Array {
  if (nodeBuffer) {
    const b = nodeBuffer.from(text, "base64");
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  const binary = atob(text),
    bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function int16(bytes: Uint8Array) {
  return new Int16Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}
const clampCm = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 100)));

/** Heights in metres → little-endian centimetre integers. */
export function packHeights(heights: ArrayLike<number>) {
  const array = new Int16Array(heights.length);
  for (let i = 0; i < heights.length; i++) array[i] = clampCm(heights[i]);
  return new Uint8Array(array.buffer);
}
export function unpackHeights(bytes: Uint8Array): number[] {
  return Array.from(int16(bytes), (cm) => cm / 100);
}
export function chunkOrigin(key: string) {
  const [x, z] = key.split(",").map(Number);
  return { x: x * PACK_CHUNK_SIZE, z: z * PACK_CHUNK_SIZE };
}
export function packLayer(polygons: number[][], origin: { x: number; z: number }) {
  const counts: number[] = [];
  let total = 0;
  for (const polygon of polygons) {
    counts.push(polygon.length / 3);
    total += polygon.length;
  }
  const array = new Int16Array(total);
  let i = 0;
  for (const polygon of polygons)
    for (let v = 0; v < polygon.length; v += 3) {
      array[i++] = clampCm(polygon[v] - origin.x);
      array[i++] = clampCm(polygon[v + 1]);
      array[i++] = clampCm(polygon[v + 2] - origin.z);
    }
  return { counts, xyz: toBase64(new Uint8Array(array.buffer)) };
}
export function unpackLayer(layer: PackedLayer, origin: { x: number; z: number }) {
  const values = int16(fromBase64(layer.xyz)),
    out: number[][] = [];
  let offset = 0;
  for (const count of layer.counts) {
    const polygon = new Array<number>(count * 3);
    for (let v = 0; v < count * 3; v += 3) {
      polygon[v] = values[offset + v] / 100 + origin.x;
      polygon[v + 1] = values[offset + v + 1] / 100;
      polygon[v + 2] = values[offset + v + 2] / 100 + origin.z;
    }
    out.push(polygon);
    offset += count * 3;
  }
  return out;
}
export function packSurface(surface: RoadSurface, origin: { x: number; z: number }) {
  const of = (color: string) =>
    surface.markings.filter((m) => m.color === color).map((m) => m.polygon);
  return {
    asphalt: packLayer(surface.asphalt, origin),
    sidewalks: packLayer(surface.sidewalks, origin),
    white: packLayer(of("white"), origin),
    yellow: packLayer(of("yellow"), origin),
  };
}
export function unpackSurface(packed: PackedSurface, origin: { x: number; z: number }) {
  return {
    asphalt: unpackLayer(packed.asphalt, origin),
    sidewalks: unpackLayer(packed.sidewalks, origin),
    markings: [
      ...unpackLayer(packed.white, origin).map((polygon) => ({
        color: "white" as const,
        polygon,
      })),
      ...unpackLayer(packed.yellow, origin).map((polygon) => ({
        color: "yellow" as const,
        polygon,
      })),
    ],
  };
}
function centroidKey(polygon: number[]) {
  let x = 0,
    z = 0;
  const n = polygon.length / 3;
  for (let v = 0; v < polygon.length; v += 3) {
    x += polygon[v];
    z += polygon[v + 2];
  }
  return `${Math.floor(x / n / PACK_CHUNK_SIZE)},${Math.floor(z / n / PACK_CHUNK_SIZE)}`;
}
/** Split one street surface into per-chunk packed layers (generator side). */
export function packSurfaceChunks(surface: RoadSurface): PackedSurfaceChunks {
  const buckets = new Map<string, RoadSurface>();
  const bucket = (key: string) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { asphalt: [], sidewalks: [], markings: [] }));
    return b;
  };
  for (const p of surface.asphalt) bucket(centroidKey(p)).asphalt.push(p);
  for (const p of surface.sidewalks) bucket(centroidKey(p)).sidewalks.push(p);
  for (const m of surface.markings) bucket(centroidKey(m.polygon)).markings.push(m);
  const out: PackedSurfaceChunks = {};
  for (const key of [...buckets.keys()].sort())
    out[key] = packSurface(buckets.get(key)!, chunkOrigin(key));
  return out;
}
/** Rejoin every chunk into one surface, for tools and tests. */
export function unpackSurfaceChunks(chunks: PackedSurfaceChunks): RoadSurface {
  const out: RoadSurface = { asphalt: [], sidewalks: [], markings: [] };
  for (const [key, packed] of Object.entries(chunks)) {
    const s = unpackSurface(packed, chunkOrigin(key));
    out.asphalt.push(...s.asphalt);
    out.sidewalks.push(...s.sidewalks);
    out.markings.push(...s.markings);
  }
  return out;
}
export type PackedCity = Omit<City, "terrain"> & { terrain: { cm: string } };
export function packCity(city: City): PackedCity {
  if (!city.terrain) throw Error("An artifact needs terrain");
  const { terrain, ...rest } = city;
  return { ...rest, terrain: { cm: toBase64(packHeights(terrain.heights)) } };
}
export function unpackCity(packed: PackedCity): City {
  const { terrain, ...rest } = packed;
  return { ...rest, terrain: { heights: unpackHeights(fromBase64(terrain.cm)) } };
}
