/** Isolated TS inputs and outputs for the native road-geometry port. */
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
import { generateHydrology } from "../mapgen/hydrology.ts";
import { chooseCentre, desirabilityField } from "../mapgen/site.ts";
import { generateRoads } from "../mapgen/roads.ts";
import { generateBlocks } from "../mapgen/blocks.ts";
import { placeBuildings, stampPads } from "../mapgen/buildings.ts";
import { derive } from "../mapgen/random.ts";
import * as road from "../mapgen/roadgeometry.ts";
import type { Point } from "../mapgen/types.ts";
import * as street from "../mapgen/streetfit.ts";
import { LIMIT, STREET_LIFT, KERB_HEIGHT } from "../shared/world.ts";
import { TERRAIN_STEP } from "../shared/terrain.ts";

export async function dumpGeometry(seed: number, out: string) {
  await mkdir(out, { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFile(
      resolve(out, `${name}.json`),
      JSON.stringify(value, (_key, nested) =>
        nested instanceof Float32Array ? Array.from(nested) : nested,
      ),
    );
  const { field } = generateHeightmap(seed, LIMIT * 2, TERRAIN_STEP);
  thermalErosion(field, 10);
  dropletErosion(field, derive(seed, "droplets"), Math.round(field.w * field.h * 0.7));
  thermalErosion(field, 4);
  settle(field);
  keepMainIsland(field);
  shapeCoast(field);
  const hydro = generateHydrology(field, seed, 0);
  const desirability = desirabilityField(field, hydro, seed);
  const centre = chooseCentre(field, desirability);
  const graph = generateRoads({ field, hydro, desirability, centre, seed });
  await write("input-field", field);
  await write("input-graph", graph);
  road.smoothCentrelines(graph);
  await write("smooth-graph", graph);
  road.densifyCentrelines(graph);
  await write("dense-graph", graph);
  const geometry = road.buildRoadGeometry(graph);
  await write("geometry", geometry);
  road.solveProfiles(graph, field, geometry.trims);
  await write("profile-graph", graph);
  const shaped = cloneField(field);
  const cells = road.stampRoads(shaped, graph, geometry);
  await write("stamped-field", shaped);
  await write("road-cells", cells);
  await write("bridges", road.bridgeDecks(graph));
  const streets = street.streetPolygons(graph, geometry);
  await write("streets", streets);
  const layers = [
    { polygons: streets.asphalt, top: STREET_LIFT },
    { polygons: streets.sidewalks, top: STREET_LIFT + KERB_HEIGHT },
  ];
  const grid = {
    heights: shaped.data,
    side: shaped.w,
    step: shaped.cell,
    half: shaped.size / 2,
  };
  const blocks = generateBlocks({ graph, field: shaped, hydro, centre, seed });
  const pads = placeBuildings(blocks, shaped, centre, seed);
  stampPads(shaped, pads, cells);
  await write("sink-input", { grid, layers, pads });
  street.sinkUnderStreets(grid, layers, pads);
  await write("sunk-field", shaped);
  const queries: Point[] = [];
  for (let z = -LIMIT; z <= LIMIT; z += 11.7)
    for (let x = -LIMIT; x <= LIMIT; x += 13.3) queries.push({ x, z });
  for (const b of geometry.bands) queries.push(...b.polygon);
  await write(
    "street-test",
    [0, 0.25, 2].map((margin) => ({
      margin,
      queries,
      results: queries.map(street.streetTest(geometry, margin)),
    })),
  );
}
