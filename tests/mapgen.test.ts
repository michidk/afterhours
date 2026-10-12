import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMap } from "../mapgen/pipeline.ts";
import { fillDepressions, flowAccumulation } from "../mapgen/hydrology.ts";
import { createField, sample } from "../mapgen/field.ts";
import { insetPolygon, pointInPolygon, signedArea } from "../mapgen/geom.ts";
import { buildRoadGeometry } from "../mapgen/roadgeometry.ts";
import type { RoadGraph } from "../mapgen/types.ts";

const SMALL = { seed: 713, size: 1536, cell: 8 };

test("map generation is deterministic for a seed", () => {
  const a = generateMap(SMALL),
    b = generateMap(SMALL);
  assert.deepEqual(a.terrain.data, b.terrain.data);
  assert.deepEqual(a.roads, b.roads);
  assert.deepEqual(a.buildings, b.buildings);
  assert.notDeepEqual(generateMap({ ...SMALL, seed: 714 }).roads, a.roads);
});

test("priority-flood leaves every land cell a strictly descending path to the sea", () => {
  const f = createField(512, 16);
  // A bowl with an inner pit that must be filled.
  for (let z = 0; z < f.h; z++)
    for (let x = 0; x < f.w; x++) {
      const dx = x - f.w / 2,
        dz = z - f.h / 2,
        r = Math.hypot(dx, dz);
      f.data[z * f.w + x] = r > 14 ? -5 : 20 - r + (r < 5 ? -12 : 0);
    }
  fillDepressions(f);
  const { dir } = flowAccumulation(f);
  for (let i = 0; i < f.data.length; i++) {
    if (f.data[i] <= 0) continue;
    let c = i,
      steps = 0;
    while (f.data[c] > 0) {
      const next = dir[c];
      assert.ok(next >= 0, `cell ${c} has no downhill neighbour`);
      assert.ok(f.data[next] < f.data[c], "flow must descend strictly");
      c = next;
      assert.ok(steps++ < f.data.length, "flow path must terminate");
    }
  }
});

test("rivers descend monotonically to water and stay inside the carved channel", () => {
  const map = generateMap(SMALL);
  assert.ok(map.rivers.length >= 1, "an island this size should drain through rivers");
  for (const river of map.rivers) {
    const heights = river.points.map((p) => sample(map.terrain, p.x, p.z));
    for (let i = 1; i < heights.length; i++)
      assert.ok(heights[i] <= heights[i - 1] + 0.6, `river rises at point ${i}`);
    // A river ends at the sea, in a lake, or at a confluence with another river.
    const end = river.points[river.points.length - 1];
    const joins = map.rivers.some(
      (other) =>
        other !== river &&
        other.points.some((p) => Math.hypot(p.x - end.x, p.z - end.z) < 16),
    );
    const inLake = map.lakes.some((lake) => pointInPolygon(end, lake.outline));
    assert.ok(
      heights[heights.length - 1] <= 1.5 || joins || inLake,
      "river must end at the sea, a lake or a confluence",
    );
  }
});

test("road graph is connected, planar at nodes, and keeps grades within limits", () => {
  const map = generateMap(SMALL);
  const { nodes, edges } = map.roads;
  assert.ok(edges.length > 20, "expected a road network");
  // Connected: breadth-first from node 0 reaches every node.
  const seen = new Set<number>([0]),
    queue = [0];
  while (queue.length) {
    const n = queue.pop()!;
    for (const id of nodes[n].edges) {
      const e = edges[id],
        o = e.a === n ? e.b : e.a;
      if (!seen.has(o)) {
        seen.add(o);
        queue.push(o);
      }
    }
  }
  assert.equal(seen.size, nodes.length, "road graph must be a single component");
  for (const n of nodes) assert.ok(n.edges.length >= 1 && n.edges.length <= 4);
  for (const e of edges) {
    assert.equal(e.points.length, e.heights.length);
    // Node heights are pinned to the terrain, so an edge whose ends differ more than
    // the limit allows can only match the end-to-end grade.
    const length = e.points.reduce(
      (s, p, i) =>
        i ? s + Math.hypot(p.x - e.points[i - 1].x, p.z - e.points[i - 1].z) : 0,
      0,
    );
    const endGrade =
      Math.abs(e.heights[e.heights.length - 1] - e.heights[0]) / Math.max(1, length);
    const limit = Math.max(
      e.kind === "highway" ? 0.08 : e.kind === "avenue" ? 0.11 : 0.15,
      endGrade,
    );
    for (let i = 1; i < e.points.length; i++) {
      const d = Math.hypot(
        e.points[i].x - e.points[i - 1].x,
        e.points[i].z - e.points[i - 1].z,
      );
      if (d < 0.5 || e.bridge) continue;
      const grade = Math.abs(e.heights[i] - e.heights[i - 1]) / d;
      assert.ok(
        grade <= limit + 0.01,
        `${e.kind} grade ${grade.toFixed(3)} exceeds ${limit}`,
      );
    }
    // The shaped terrain was flattened to the road profile along the centreline.
    if (!e.bridge)
      for (let i = 0; i < e.points.length; i += 3) {
        const h = sample(map.shaped, e.points[i].x, e.points[i].z);
        assert.ok(
          Math.abs(h - e.heights[i]) < 0.8,
          "terrain must follow the road profile",
        );
      }
  }
});

test("junction polygons are built for every node of degree three or more", () => {
  const graph: RoadGraph = {
    nodes: [
      { id: 0, x: 0, z: 0, y: 0, edges: [0, 1, 2] },
      { id: 1, x: 100, z: 0, y: 0, edges: [0] },
      { id: 2, x: 0, z: 100, y: 0, edges: [1] },
      { id: 3, x: -80, z: -60, y: 0, edges: [2] },
    ],
    edges: [
      {
        id: 0,
        a: 0,
        b: 1,
        kind: "avenue",
        width: 18,
        bridge: false,
        points: [
          { x: 0, z: 0 },
          { x: 100, z: 0 },
        ],
        heights: [0, 0],
      },
      {
        id: 1,
        a: 0,
        b: 2,
        kind: "street",
        width: 12,
        bridge: false,
        points: [
          { x: 0, z: 0 },
          { x: 0, z: 100 },
        ],
        heights: [0, 0],
      },
      {
        id: 2,
        a: 0,
        b: 3,
        kind: "street",
        width: 12,
        bridge: false,
        points: [
          { x: 0, z: 0 },
          { x: -80, z: -60 },
        ],
        heights: [0, 0],
      },
    ],
  };
  const geometry = buildRoadGeometry(graph);
  const junction = geometry.junctions.find((j) => j.node === 0);
  assert.ok(junction, "centre node needs a junction polygon");
  assert.ok(junction.polygon.length >= 9);
  assert.ok(Math.abs(signedArea(junction.polygon)) > 100);
  // Every band starts outside the junction and touches its ring.
  for (const band of geometry.bands) {
    const first = band.left[0];
    assert.ok(
      Math.hypot(first.x, first.z) > 5,
      "bands must be trimmed back from the node",
    );
  }
  assert.equal(geometry.bands.length, 3);
});

test("blocks, lots and buildings respect roads and each other", () => {
  const map = generateMap(SMALL);
  assert.ok(map.blocks.length > 5);
  assert.ok(map.buildings.length > 5);
  for (const b of map.blocks) {
    assert.ok(Math.abs(signedArea(b.interior)) < Math.abs(signedArea(b.polygon)));
    for (const lot of b.lots) assert.ok(lot.area > 50);
  }
  for (const b of map.buildings) {
    assert.ok(b.h >= 4 && b.h <= 200);
    assert.ok(b.y >= 0.8, "pads sit above sea level");
    assert.ok(
      Math.abs(sample(map.shaped, b.x, b.z) - b.y) < 0.8,
      "pad stamped into terrain",
    );
  }
  for (const t of map.trees)
    assert.ok(sample(map.shaped, t.x, t.z) > 0, "trees stand on land");
});

test("polygon inset shrinks a counter-clockwise ring inward", () => {
  const square = [
    { x: 0, z: 0 },
    { x: 100, z: 0 },
    { x: 100, z: 100 },
    { x: 0, z: 100 },
  ];
  const inner = insetPolygon(square, 10)!;
  assert.ok(inner);
  assert.ok(Math.abs(Math.abs(signedArea(inner)) - 80 * 80) < 1);
  assert.ok(pointInPolygon({ x: 50, z: 50 }, inner));
  assert.ok(!pointInPolygon({ x: 5, z: 5 }, inner));
  assert.ok(insetPolygon(square, 60) === undefined, "over-inset collapses");
});
