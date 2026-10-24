/** Small, committed TS oracle cases for every geometry and surface helper. */
import { writeFile } from "node:fs/promises";
import * as road from "../mapgen/roadgeometry.ts";
import * as street from "../mapgen/streetfit.ts";
import type { Point, RoadGraph, RoadKind } from "../mapgen/types.ts";
import { sample } from "../mapgen/field.ts";

const lines: Point[][] = [
  [{ x: 0, z: 0 }],
  [
    { x: -25, z: -5 },
    { x: 0, z: 0 },
    { x: 20, z: 4 },
  ],
  [
    { x: -30, z: 0 },
    { x: -8, z: 0 },
    { x: 0, z: 10 },
    { x: 5, z: -2 },
    { x: 30, z: 0 },
  ],
  [
    { x: 0, z: 0 },
    { x: 25, z: 0 },
    { x: 25, z: 25 },
    { x: 0, z: 25 },
    { x: 0, z: 0 },
  ],
  [
    { x: 1, z: 2 },
    { x: 1, z: 2 },
    { x: 3, z: 4 },
    { x: 3, z: 4 },
  ],
];
// Seed 713 edge 125 exposes the one-ULP powf(0.5) versus sqrt difference.
lines.push([
  { x: 201.5119395960481, z: -1061.3367137001162 },
  { x: 160.819265383628, z: -1078.0730892169909 },
  { x: 132.49814329259394, z: -1103.6948895460378 },
]);
const helpers = lines.map((points) => ({
  points,
  simplified: road.simplifyPolyline(points, 0.9),
  catmull: road.catmullRom(points, 4),
  rounded: road.roundCorners(points, 12),
  offset: road.offsetPolyline(points, 6),
  trimmed: [
    [0, 0],
    [3, 5],
    [40, 50],
  ].map(([a, b]) => road.trimPolyline(points, a, b)),
  at: [-2, 0, 3, 17, 200].map((d) => road.pointAt(points, d)),
  radii: road.bendRadii(points),
  grades: road.bendGrades(points, 0.1),
  widened: road.widenBends(points, 14),
}));
const points = [
  { x: 0, z: 0 },
  { x: -60, z: 0 },
  { x: 60, z: 0 },
  { x: 0, z: 55 },
  { x: 22, z: 8 },
  { x: 25, z: 20 },
  { x: -55, z: 20 },
];
const graph: RoadGraph = {
  nodes: points.map((p, id) => ({ id, ...p, y: 0, edges: [] })),
  edges: [],
};
const edge = (
  a: number,
  b: number,
  kind: RoadKind,
  width: number,
  via: Point[] = [],
  bridge = false,
) => {
  const id = graph.edges.length;
  graph.edges.push({
    id,
    a,
    b,
    kind,
    width,
    bridge,
    points: [points[a], ...via, points[b]],
    heights: [],
  });
  graph.nodes[a].edges.push(id);
  graph.nodes[b].edges.push(id);
};
edge(0, 1, "avenue", 18);
edge(0, 2, "avenue", 18);
edge(0, 3, "street", 9);
edge(0, 4, "lane", 6);
edge(4, 5, "street", 9);
edge(5, 6, "highway", 24, [], true);
edge(3, 3, "lane", 6, [
  { x: -12, z: 67 },
  { x: 12, z: 70 },
]);
const field = {
  w: 21,
  h: 21,
  size: 160,
  cell: 8,
  data: Float32Array.from(
    { length: 441 },
    (_, i) => Math.sin(i * 0.13) * 4 + 8 + Math.floor(i / 21) * 0.1,
  ),
};
const inputGraph = structuredClone(graph);
road.smoothCentrelines(graph);
const smooth = structuredClone(graph);
road.densifyCentrelines(graph);
const dense = structuredClone(graph);
const geometry = road.buildRoadGeometry(graph);
road.solveProfiles(graph, field, geometry.trims);
const shaped = { ...field, data: new Float32Array(field.data) };
const cells = road.stampRoads(shaped, graph, geometry);
const streets = street.streetPolygons(graph, geometry);
const layers = [
  { polygons: streets.asphalt, top: 0.1 },
  { polygons: streets.sidewalks, top: 0.25 },
];
const grid = {
  heights: shaped.data,
  side: shaped.w,
  step: shaped.cell,
  half: shaped.size / 2,
};
const pads = [
  { x: -40, z: 8, w: 12, d: 9, y: 10, angle: 0.37 },
  { x: 30, z: -20, w: 10, d: 10 },
];
const sinkInput = structuredClone({ grid, layers, pads });
street.sinkUnderStreets(grid, layers, pads);
const queries = points.flatMap((p) =>
  [-1, 0, 1].map((x) => ({ x: p.x + x, z: p.z + x })),
);
for (const b of geometry.bands) queries.push(...b.polygon);
const fit = {
  inputGraph,
  field,
  smooth,
  dense,
  geometry,
  profile: graph,
  cells,
  stamped: { ...field, data: sinkInput.grid.heights },
  bridges: road.bridgeDecks(graph),
  streets,
  sinkInput,
  sunk: shaped,
  tests: [0, 0.25, 2].map((margin) => ({
    margin,
    queries,
    results: queries.map(street.streetTest(geometry, margin)),
  })),
};
const flat = (p: Point[]) => p.flatMap((q) => [q.x, 0, q.z]);
const polygons = [
  flat([
    { x: -20, z: -15 },
    { x: 20, z: -15 },
    { x: 20, z: 15 },
    { x: 0, z: 2 },
    { x: -20, z: 15 },
  ]),
  flat([
    { x: -8, z: -16 },
    { x: 12, z: -16 },
    { x: 12, z: 16 },
    { x: -8, z: 16 },
  ]),
];
const avoid = [
  flat([
    { x: -4, z: -10 },
    { x: 4, z: -10 },
    { x: 4, z: 10 },
    { x: -4, z: 10 },
  ]),
];
const draped = street.drapeOnTerrain(polygons, grid);
const avoided = street.drapeOnTerrain(polygons, grid, avoid);
const weldInput = [
  [0, 1, 0, 4, 1, 0, 4, 1, 4, 0, 1, 4],
  [4.03, 2, 0.02, 8, 2, 0, 8, 2, 4, 4.02, 2, 3.99],
  [2, 3, 0, 3, 3, -1, 1, 3, -1],
];
const surface = {
  grid,
  polygons,
  avoid,
  draped,
  avoided,
  weldInput,
  welded: street.weldCorners(weldInput),
  closed: street.closeTJunctions(weldInput),
  tagged: street.closeTJunctions(weldInput, [1, 0, 2]),
  sealed: street.sealSurfaces([draped, avoided]),
  snaps: [-1.005, -0.005, 0, 0.004999999999, 0.005, 12.345].map((v) => [
    v,
    street.snapCm(v),
  ]),
};
const samplePoints = [
  { x: -12.3, z: 0.7 },
  { x: -100, z: 20.3 },
  { x: 79.2, z: 76.1 },
];
const sampling = samplePoints.map((p) => ({ p, y: sample(field, p.x, p.z) }));
await writeFile(
  process.argv[2] ?? "crates/mapgen/tests/fixtures/geometry-helpers.json",
  JSON.stringify({ helpers, fit, surface, sampling }, (_key, value) =>
    value instanceof Float32Array ? Array.from(value) : value,
  ),
);
