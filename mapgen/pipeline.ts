import { generateBlocks } from "./blocks.ts";
import { placeBuildings, stampPads } from "./buildings.ts";
import { cloneField } from "./field.ts";
import { generateHydrology } from "./hydrology.ts";
import { derive } from "./random.ts";
import { generateRoads } from "./roads.ts";
import {
  bridgeDecks,
  buildRoadGeometry,
  densifyCentrelines,
  smoothCentrelines,
  solveProfiles,
  stampRoads,
} from "./roadgeometry.ts";
import { chooseCentre, desirabilityField } from "./site.ts";
import { sinkUnderStreets, streetPolygons, streetTest } from "./streetfit.ts";
import { KERB_HEIGHT, STREET_LIFT } from "../shared/world.ts";
import {
  dropletErosion,
  generateHeightmap,
  keepMainIsland,
  settle,
  shapeCoast,
  thermalErosion,
} from "./terrain.ts";
import type { GeneratedMap, MapOptions, StageTiming } from "./types.ts";
import { makeParks, placeVegetation } from "./vegetation.ts";

/**
 * Multi-stage, deterministic map generation. Each stage consumes only the outputs of
 * earlier stages; `progress` receives the stage name before it starts.
 */
export function generateMap(
  options: MapOptions,
  progress?: (stage: string) => void,
): GeneratedMap {
  const timings: StageTiming[] = [];
  const now = () =>
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const stage = <T>(name: string, run: () => T): T => {
    progress?.(name);
    const start = now(),
      result = run();
    timings.push({ stage: name, ms: now() - start });
    return result;
  };
  const { seed, size, cell } = options;
  const { field } = stage("terrain", () => generateHeightmap(seed, size, cell));
  stage("erosion", () => {
    thermalErosion(field, 10);
    dropletErosion(
      field,
      derive(seed, "droplets"),
      Math.round(field.w * field.h * 0.7),
    );
    thermalErosion(field, 4);
    settle(field);
    keepMainIsland(field);
    shapeCoast(field);
  });
  const debug = options.debug
    ? (label: string, ms: number) => console.error(`    ${label} ${ms} ms`)
    : undefined;
  const hydro = stage("hydrology", () => generateHydrology(field, seed, 0, debug));
  const desirability = stage("site", () => desirabilityField(field, hydro, seed));
  const centre = chooseCentre(field, desirability);
  const roads = stage("roads", () =>
    generateRoads(
      { field, hydro, desirability, centre, seed, debug: options.debug },
      (s) => progress?.(`roads: ${s}`),
    ),
  );
  const shaped = cloneField(field);
  let roadCells: Float32Array | undefined;
  const geometry = stage("road geometry", () => {
    smoothCentrelines(roads);
    densifyCentrelines(roads);
    const geometry = buildRoadGeometry(roads);
    solveProfiles(roads, field, geometry.trims);
    roadCells = stampRoads(shaped, roads, geometry);
    return geometry;
  });
  const bridges = bridgeDecks(roads);
  const blocks = stage("blocks", () =>
    generateBlocks({ graph: roads, field: shaped, hydro, centre, seed }),
  );
  const buildings = stage("buildings", () => {
    const placed = placeBuildings(blocks, shaped, centre, seed);
    stampPads(shaped, placed, roadCells);
    return placed;
  });
  // The coarse terrain grid must stay below every drawn street surface.
  stage("street fit", () => {
    const { asphalt, sidewalks } = streetPolygons(roads, geometry);
    sinkUnderStreets(
      {
        heights: shaped.data,
        side: shaped.w,
        step: shaped.cell,
        half: shaped.size / 2,
      },
      [
        { polygons: asphalt, top: STREET_LIFT },
        { polygons: sidewalks, top: STREET_LIFT + KERB_HEIGHT },
      ],
      buildings,
    );
  });
  const parks = makeParks(blocks, hydro, shaped);
  const { trees, lamps } = stage("vegetation", () =>
    placeVegetation({
      field: shaped,
      hydro,
      graph: roads,
      blocks,
      buildings,
      desirability,
      seed,
      onStreet: streetTest(geometry),
    }),
  );
  return {
    options,
    seaLevel: 0,
    terrain: field,
    shaped,
    flow: hydro.flow,
    rivers: hydro.rivers,
    lakes: hydro.lakes,
    desirability,
    centre,
    roads,
    geometry,
    bridges,
    blocks,
    buildings,
    parks,
    trees,
    lamps,
    timings,
  };
}
