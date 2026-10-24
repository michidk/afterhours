import { readFile } from "node:fs/promises";
import { decode } from "@msgpack/msgpack";
import { z } from "zod";
import type { CityStore } from "./city-store.ts";

const bytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array);
const artifact = z.object({
  format: z.literal("afterhours-meshes"),
  version: z.literal(1),
  mapId: z.string(),
  base: bytes,
  chunks: z.record(z.string(), bytes),
});
export async function loadCityMeshes(
  store: CityStore,
  path = process.env.CITY_MESH_PATH || "data/city-meshes.msgpack",
) {
  let source: Buffer;
  try {
    source = await readFile(path);
  } catch {
    throw Error(
      `Static mesh file missing: ${path}. Run bun run city:meshes before starting the server.`,
    );
  }
  const saved = artifact.parse(decode(source));
  if (saved.mapId !== store.manifest.mapId)
    throw Error(
      "Static meshes do not match the city. Run bun run city:meshes after generating a city.",
    );
  if (
    Object.keys(saved.chunks).length !== store.chunks.size ||
    [...store.chunks.keys()].some((key) => !saved.chunks[key])
  )
    throw Error("Static mesh artifact has incomplete chunk coverage");
  store.installGeometry(saved.base, saved.chunks);
}
