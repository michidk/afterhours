/** Raw road-stage oracle, before roadgeometry mutates centreline points/heights. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateHydrology } from "../mapgen/hydrology.ts";
import { derive } from "../mapgen/random.ts";
import { generateRoads } from "../mapgen/roads.ts";
import { chooseCentre, desirabilityField } from "../mapgen/site.ts";
import {
  dropletErosion,
  generateHeightmap,
  keepMainIsland,
  settle,
  shapeCoast,
  thermalErosion,
} from "../mapgen/terrain.ts";

export async function dumpRoadStages(
  seed: number,
  size: number,
  cell: number,
  out: string,
) {
  const { field } = generateHeightmap(seed, size, cell);
  thermalErosion(field, 10);
  dropletErosion(field, derive(seed, "droplets"), Math.round(field.w * field.h * 0.7));
  thermalErosion(field, 4);
  settle(field);
  keepMainIsland(field);
  shapeCoast(field);
  const hydro = generateHydrology(field, seed);
  const desirability = desirabilityField(field, hydro, seed);
  const centre = chooseCentre(field, desirability);
  const inputs = { field, hydro, desirability, centre, seed };
  const roads = generateRoads(inputs);
  const json = (value: unknown) =>
    JSON.stringify(value, (_key, nested) =>
      nested instanceof Float32Array || nested instanceof Uint8Array
        ? Array.from(nested)
        : nested,
    );
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, "road-inputs.json"), `${json(inputs)}\n`);
  await writeFile(resolve(out, "roads-generated.json"), `${json(roads)}\n`);
}
