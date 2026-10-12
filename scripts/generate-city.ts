import { cityPreview } from "./city-preview.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateCity } from "./city-generator.ts";
import { cityFileSchema } from "../shared/city-schema.ts";
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
const artifact = cityFileSchema.parse({
  format: "afterhours-city",
  version: 4,
  city: generateCity(seed),
});
await mkdir(dirname(path), { recursive: true });
await writeFile(path, JSON.stringify(artifact, null, 2) + "\n");
console.log(
  `Generated city ${seed}: ${artifact.city.buildings.length} buildings -> ${path}`,
);

if (previewPath) {
  await mkdir(dirname(previewPath), { recursive: true });
  await writeFile(previewPath, cityPreview(artifact.city));
  console.log(`Wrote offline atlas -> ${previewPath}`);
}
