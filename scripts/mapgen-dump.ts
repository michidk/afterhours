/** Write JSON stage snapshots for the native Rust mapgen parity port. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateMap } from "../mapgen/pipeline.ts";
import { LIMIT } from "../shared/world.ts";
import { TERRAIN_STEP } from "../shared/terrain.ts";

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1] ?? (() => { throw Error(`${name} requires a value`); })();
};
const seed = Number(value("--seed", "713"));
const out = resolve(value("--out", ".mapgen-dump"));
if (!Number.isInteger(seed)) throw Error("--seed must be an integer");
await mkdir(out, { recursive: true });
const map = generateMap({ seed, size: LIMIT * 2, cell: TERRAIN_STEP });
const json = (value: unknown) =>
  JSON.stringify(value, (_key, nested) =>
    nested instanceof Float32Array ? Array.from(nested) : nested,
  );
const write = (name: string, value: unknown) => writeFile(resolve(out, `${name}.json`), `${json(value)}\n`);
await write("terrain", map.terrain);
await write("erosion", map.terrain);
await write("hydrology", { flow: map.flow, rivers: map.rivers, lakes: map.lakes });
await write("site", { desirability: map.desirability, centre: map.centre });
await write("roads", map.roads);
await write("geometry", map.geometry);
await write("bridges", map.bridges);
await write("shaped", map.shaped);
const streets = (await import("../mapgen/streetfit.ts")).streetPolygons(map.roads, map.geometry);
await write("streets", streets);
await write("blocks", map.blocks);
await write("buildings", map.buildings);
await write("parks", map.parks);
await write("vegetation", { trees: map.trees, lamps: map.lamps });
console.log(`Wrote mapgen stage dumps for seed ${seed} to ${out}`);
