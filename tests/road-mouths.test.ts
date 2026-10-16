import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoadGeometry, SIDEWALK, offsetPolyline } from "../mapgen/roadgeometry.ts";
import { dist, selfIntersects } from "../mapgen/geom.ts";
import type { Point, RoadGraph } from "../mapgen/types.ts";

for (const points of [
  [
    { x: 0, z: 0 },
    { x: 50, z: 0 },
  ],
  [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 8, z: 3 },
    { x: 20, z: 15 },
    { x: 50, z: 25 },
  ],
  [
    { x: 0, z: 0 },
    { x: 8, z: 0 },
  ],
]) {
  test(`turning circle shares street and sidewalk mouth vertices: ${JSON.stringify(points)}`, () => {
    const graph: RoadGraph = {
      nodes: [
        { ...points[0], id: 0, y: 0, edges: [0] },
        { ...points[points.length - 1], id: 1, y: 0, edges: [0] },
      ],
      edges: [
        {
          id: 0,
          a: 0,
          b: 1,
          kind: "street",
          width: 10,
          bridge: false,
          points,
          heights: points.map(() => 0),
        },
      ],
    };
    const geometry = buildRoadGeometry(graph),
      band = geometry.bands[0];
    const outer = offsetPolyline(band.centre, 5 + SIDEWALK);
    const contains = (polygon: Point[], p: Point) =>
      polygon.some((q) => dist(p, q) < 1e-8);
    for (const [node, index] of [
      [0, 0],
      [1, band.left.length - 1],
    ]) {
      const junction = geometry.junctions.find((j) => j.node === node)!;
      const sidewalk = geometry.sidewalks.find((s) => s.node === node)!;
      for (const p of [band.left[index], band.right[index]]) {
        assert.ok(
          contains(junction.polygon, p),
          "asphalt mouth must meet band exactly",
        );
        assert.ok(contains(sidewalk.polygon, p), "kerb mouth must meet band exactly");
      }
      for (const p of [outer.left[index], outer.right[index]])
        assert.ok(
          contains(sidewalk.polygon, p),
          "outer sidewalk must meet strip exactly",
        );
      assert.equal(selfIntersects(junction.polygon), false);
      assert.equal(selfIntersects(sidewalk.polygon), false);
    }
  });
}
