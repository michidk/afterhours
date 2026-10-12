import { generateMap } from "../mapgen/pipeline.ts";

/** Offline smoke run: prints stage timings and counts for a seed. */
const seed = Number(process.argv[2] ?? 713),
  cell = Number(process.argv[3] ?? 8);
const map = generateMap({ seed, size: 3072, cell, debug: true }, (s) =>
  console.error(`  ${s}`),
);
for (const t of map.timings)
  console.log(`${t.stage.padEnd(14)} ${t.ms.toFixed(0).padStart(6)} ms`);
const land = map.terrain.data.reduce((n, h) => n + (h > 0 ? 1 : 0), 0);
console.log({
  landKm2: +((land * cell * cell) / 1e6).toFixed(2),
  rivers: map.rivers.length,
  lakes: map.lakes.length,
  centre: map.centre,
  nodes: map.roads.nodes.length,
  edges: map.roads.edges.length,
  bridges: map.bridges.length,
  blocks: map.blocks.length,
  lots: map.blocks.reduce((n, b) => n + b.lots.length, 0),
  buildings: map.buildings.length,
  parks: map.parks.length,
  trees: map.trees.length,
  lamps: map.lamps.length,
  byKind: map.roads.edges.reduce<Record<string, number>>(
    (acc, e) => ((acc[e.kind] = (acc[e.kind] ?? 0) + 1), acc),
    {},
  ),
  zones: map.blocks.reduce<Record<string, number>>(
    (acc, b) => ((acc[b.zone] = (acc[b.zone] ?? 0) + 1), acc),
    {},
  ),
});
