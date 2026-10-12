import { cityPreview } from "./city-preview.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateMap } from "../mapgen/pipeline.ts";
import { cityFromMap } from "./mapgen-city.ts";
import { CITY_FORMAT_VERSION, cityFileSchema } from "../shared/city-schema.ts";
import { LIMIT } from "../shared/world.ts";
import { TERRAIN_STEP } from "../shared/terrain.ts";
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw Error(`${name} requires a value`);
  return value;
};
const seed = Number(option("--seed", "713")),
  path = resolve(option("--out", "data/city.json"));
const previewPath = args.includes("--preview")
  ? resolve(option("--preview", "data/city-preview.html"))
  : undefined;
if (previewPath === path) throw Error("--preview must differ from --out");
if (!Number.isInteger(seed)) throw Error("--seed must be an integer");
const map = generateMap({ seed, size: LIMIT * 2, cell: TERRAIN_STEP }, (stage) =>
  console.error(`  ${stage}`),
);
const artifact = cityFileSchema.parse({
  format: "afterhours-city",
  version: CITY_FORMAT_VERSION,
  city: cityFromMap(map),
});
await mkdir(dirname(path), { recursive: true });
await writeFile(path, JSON.stringify(artifact) + "\n");
console.log(
  `Generated city ${seed}: ${artifact.city.roads.length} road segments, ${artifact.city.buildings.length} buildings -> ${path}`,
);

if (previewPath) {
  await mkdir(dirname(previewPath), { recursive: true });
  await writeFile(previewPath, cityPreview(artifact.city));
  console.log(`Wrote offline atlas -> ${previewPath}`);
}
