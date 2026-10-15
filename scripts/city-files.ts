import { existsSync } from "node:fs";

/**
 * Environment for tools and tests that boot the real server: reuse the city on
 * disk when both artifacts exist, so each launch does not spend ~20 s
 * regenerating it, and generate it when they are missing (a fresh checkout or CI).
 */
export function reuseCityEnv() {
  const city = process.env.CITY_PATH || "data/city.json",
    meshes = process.env.CITY_MESH_PATH || "data/city-meshes.msgpack";
  return { CITY_REGENERATE: existsSync(city) && existsSync(meshes) ? "0" : "1" };
}
