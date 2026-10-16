import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoadGeometry } from "../mapgen/roadgeometry.ts";
import { dist, pointInPolygon } from "../mapgen/geom.ts";
import type { RoadGraph } from "../mapgen/types.ts";

for (const outgoing of [
  [
    { x: 0, z: 0 },
    { x: 45, z: 20 },
  ],
  [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 7, z: 2 },
    { x: 12, z: 7 },
    { x: 45, z: 20 },
  ],
])
  test(`street bend connects exact strip mouths with ${outgoing.length} stations`, () => {
    const graph: RoadGraph = {
      nodes: [
        { id: 0, x: -50, z: 0, y: 0, edges: [0] },
        { id: 1, x: 0, z: 0, y: 0, edges: [0, 1] },
        { id: 2, x: 45, z: 20, y: 0, edges: [1] },
      ],
      edges: [
        {
          id: 0,
          a: 0,
          b: 1,
          kind: "street",
          width: 10,
          bridge: false,
          points: [
            { x: -50, z: 0 },
            { x: 0, z: 0 },
          ],
          heights: [0, 0],
        },
        {
          id: 1,
          a: 1,
          b: 2,
          kind: "street",
          width: 10,
          bridge: false,
          points: outgoing,
          heights: outgoing.map(() => 0),
        },
      ],
    };
    const g = buildRoadGeometry(graph),
      j = g.junctions.find((j) => j.node === 1);
    assert.ok(j, "a bent continuation needs a connecting junction");
    assert.ok(pointInPolygon({ x: 0, z: 0 }, j.polygon));
    for (const [edge, atStart] of [
      [0, false],
      [1, true],
    ] as const) {
      const band = g.bands.find((b) => b.edge === edge)!;
      const index = atStart ? 0 : band.left.length - 1;
      for (const p of [band.left[index], band.right[index]])
        assert.ok(
          j.polygon.some((q) => dist(p, q) < 1e-8),
          "junction shares the exact road mouth",
        );
    }
  });
