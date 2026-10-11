import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cityFileSchema } from "../shared/city-schema.ts";
export async function loadCity(path = process.env.CITY_PATH || "data/city.json") {
  let source: string;
  try {
    source = await readFile(resolve(path), "utf8");
  } catch {
    throw new Error(
      `City file missing: ${path}. Run bun run city:generate before starting the server.`,
    );
  }
  let artifact: unknown;
  try {
    artifact = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Invalid city file ${path}: malformed JSON.`);
  }
  const result = cityFileSchema.safeParse(artifact);
  if (!result.success)
    throw new Error(`Invalid city file ${path}: ${result.error.message}`);
  return result.data.city;
}
