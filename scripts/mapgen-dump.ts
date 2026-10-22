/** Write JSON stage snapshots for the native Rust mapgen parity port. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateMap } from "../mapgen/pipeline.ts";
import { LIMIT } from "../shared/world.ts";
import { TERRAIN_STEP } from "../shared/terrain.ts";
import { cityFromMap } from "./mapgen-city.ts";
import { packCity } from "../shared/city-pack.ts";

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0
    ? fallback
    : (args[i + 1] ??
        (() => {
          throw Error(`${name} requires a value`);
        })());
};
const seed = Number(value("--seed", "713"));
const out = resolve(value("--out", ".mapgen-dump"));
if (!Number.isInteger(seed)) throw Error("--seed must be an integer");
await mkdir(out, { recursive: true });
const json = (value: unknown) =>
  JSON.stringify(value, (_key, nested) =>
    nested instanceof Float32Array || nested instanceof Uint8Array
      ? Array.from(nested)
      : nested,
  );
const snapshots = new Map<string, string>();
const map = generateMap(
  { seed, size: LIMIT * 2, cell: TERRAIN_STEP },
  undefined,
  (name, value) => {
    snapshots.set(name, json(value));
  },
);
for (const [name, value] of snapshots)
  await writeFile(resolve(out, `${name}.json`), `${value}\n`);
const write = (name: string, value: unknown) =>
  writeFile(resolve(out, `${name}.json`), `${json(value)}\n`);
await write("terrain", map.terrain);
await write("erosion", map.terrain);
await write("hydrology", { flow: map.flow, rivers: map.rivers, lakes: map.lakes });
await write("site", { desirability: map.desirability, centre: map.centre });
await write("roads", map.roads);
await write("shaped", map.shaped);
await write("blocks", map.blocks);
await write("buildings", map.buildings);
await write("parks", map.parks);
await write("vegetation", { trees: map.trees, lamps: map.lamps });
await write("map", map);
const city = cityFromMap(map, (name, context, extra) => {
  const { map: _map, paved: _paved, ...fields } = context;
  snapshots.set(`feature-${name}`, json({ ...fields, ...(extra as object) }));
});
for (const [name, value] of snapshots)
  if (name.startsWith("feature-"))
    await writeFile(resolve(out, `${name}.json`), `${value}\n`);
await write("city", city);
await write("artifact", {
  format: "afterhours-city",
  version: 7,
  city: packCity(city),
});
console.log(`Wrote mapgen stage dumps for seed ${seed} to ${out}`);
