/** Write deterministic intermediate snapshots for the native Rust mapgen parity port. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cloneField } from "../mapgen/field.ts";
import {
  generateHeightmap,
  thermalErosion,
  dropletErosion,
  settle,
  keepMainIsland,
  shapeCoast,
} from "../mapgen/terrain.ts";
import {
  fillDepressions,
  flowAccumulation,
  generateHydrology,
} from "../mapgen/hydrology.ts";
import { derive } from "../mapgen/random.ts";
import { desirabilityField, chooseCentre } from "../mapgen/site.ts";
import { lakeShorelines } from "../mapgen/shoreline.ts";
import { dumpRoadStages } from "./mapgen-roads-dump.ts";
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
if (args.includes("--geometry-stages")) {
  const { dumpGeometry } = await import("./mapgen-geometry-dump.ts");
  await dumpGeometry(seed, out);
  console.log(`Wrote isolated geometry dumps for seed ${seed} to ${out}`);
  process.exit(0);
}
const json = (v: unknown) =>
  JSON.stringify(v, (_k, nested: unknown) =>
    nested instanceof Float32Array ||
    nested instanceof Float64Array ||
    nested instanceof Int32Array ||
    nested instanceof Uint8Array
      ? Array.from(nested)
      : nested,
  );
const write = (name: string, v: unknown) =>
  writeFile(resolve(out, `${name}.json`), `${json(v)}\n`);
const options = { seed, size: LIMIT * 2, cell: TERRAIN_STEP };
const { field, flatness } = generateHeightmap(seed, options.size, options.cell);
await write("terrain", { field, flatness });
const erosion = cloneField(field);
thermalErosion(erosion, 10);
await write("erosion-thermal-1", erosion);
dropletErosion(
  erosion,
  derive(seed, "droplets"),
  Math.round(erosion.w * erosion.h * 0.7),
);
await write("erosion-droplet", erosion);
thermalErosion(erosion, 4);
await write("erosion-thermal-2", erosion);
settle(erosion);
await write("erosion-settle", erosion);
keepMainIsland(erosion);
await write("erosion-island", erosion);
shapeCoast(erosion);
await write("erosion", erosion);
const filled = cloneField(erosion);
const depth = fillDepressions(filled);
const drainage = flowAccumulation(filled);
await write("hydrology-fill", {
  field: filled,
  depth,
  dir: drainage.dir,
  flux: drainage.flux,
});
const hydro = generateHydrology(erosion, seed);
await write("hydrology", {
  field: erosion,
  flow: hydro.flow,
  rivers: hydro.rivers,
  lakes: hydro.lakes,
  riverMask: hydro.riverMask,
  waterDistance: hydro.waterDistance,
  coastDistance: hydro.coastDistance,
});
const desirability = desirabilityField(erosion, hydro, seed);
await write("site", { desirability, centre: chooseCentre(erosion, desirability) });
// Exercise interpolation, disconnected basins, and seed-specific terrain.
const side = 5;
const bowl = Array.from(
  { length: 25 },
  (_, i) => Math.hypot((i % side) - 2, Math.floor(i / side) - 2) * 4 - 3,
);
const bowlSeeds = new Uint8Array(25);
bowlSeeds[12] = 1;
const separate = Array<number>(49).fill(4);
separate[16] = -2;
separate[32] = -2;
const separateSeeds = new Uint8Array(49);
separateSeeds[16] = 1;
const terrainSeeds = Uint8Array.from(erosion.data, (h, i) =>
  Math.abs((i % erosion.w) - erosion.w / 2) < erosion.w / 4 &&
  Math.abs(Math.floor(i / erosion.w) - erosion.h / 2) < erosion.h / 4 &&
  h < 12
    ? 1
    : 0,
);
const shorelineCases = [
  { name: "bowl", heights: bowl, side, step: 8, half: 16, seeds: bowlSeeds, level: 0 },
  {
    name: "disconnected",
    heights: separate,
    side: 7,
    step: 8,
    half: 24,
    seeds: separateSeeds,
    level: 0,
  },
  {
    name: "terrain",
    heights: Array.from(erosion.data),
    side: erosion.w,
    step: erosion.cell,
    half: erosion.size / 2,
    seeds: terrainSeeds,
    level: 12,
  },
];
await write(
  "shoreline",
  shorelineCases.map((c) => ({
    ...c,
    rings: lakeShorelines(c.heights, c.side, c.step, c.half, c.seeds, c.level),
  })),
);
// The complete snapshot remains useful to later stage ports.
await dumpRoadStages(seed, LIMIT * 2, TERRAIN_STEP, out);
if (!args.includes("--terrain-only")) {
  const snapshots = new Map<string, string>();
  const map = generateMap(options, undefined, (name, value) => {
    snapshots.set(name, json(value));
  });
  for (const [name, value] of snapshots)
    await writeFile(resolve(out, `${name}.json`), `${value}\n`);
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
  await write("map", map);
  const city = cityFromMap(map, (name, context, extra) => {
    const { map: _map, paved: _paved, ...fields } = context;
    snapshots.set(`feature-${name}`, json({ ...fields, ...(extra as object) }));
  });
  for (const [name, value] of snapshots)
    if (name.startsWith("feature-"))
      await writeFile(resolve(out, `${name}.json`), `${value}\n`);
  await write("city", city);
  await write("artifact", { format: "afterhours-city", version: 7, city: packCity(city) });
}
console.log(`Wrote mapgen stage dumps for seed ${seed} to ${out}`);
