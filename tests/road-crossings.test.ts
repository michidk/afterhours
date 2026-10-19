import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoadGeometry, trimPolyline } from "../mapgen/roadgeometry.ts";
import type { Point, RoadGraph } from "../mapgen/types.ts";

/** A street junction at the origin whose arms leave at the given headings (degrees). */
function junction(headings: number[]): RoadGraph {
  const tips = headings.map((h) => ({
    x: Math.cos((h * Math.PI) / 180) * 80,
    z: Math.sin((h * Math.PI) / 180) * 80,
  }));
  return {
    nodes: [
      { id: 0, x: 0, z: 0, y: 0, edges: headings.map((_, i) => i) },
      ...tips.map((p, i) => ({ id: i + 1, x: p.x, z: p.z, y: 0, edges: [i] })),
    ],
    edges: tips.map((p, i) => ({
      id: i,
      a: 0,
      b: i + 1,
      kind: "street" as const,
      width: 10,
      bridge: false,
      points: [{ x: 0, z: 0 }, p],
      heights: [0, 0],
    })),
  };
}
/** Zebra stripes and stop lines are at least 0.4 m wide; lane lines are 0.12 m. */
const painted = (polygon: Point[]) =>
  polygon.every(
    (p, i) =>
      Math.hypot(
        p.x - polygon[(i + 1) % polygon.length].x,
        p.z - polygon[(i + 1) % polygon.length].z,
      ) > 0.39,
  );
const crossings = (graph: RoadGraph) => {
  const g = buildRoadGeometry(graph);
  return graph.edges.map(
    (e) => g.markings.filter((m) => m.edge === e.id && painted(m.polygon)).length,
  );
};

test("arms leaving a junction at a right angle each get a crosswalk", () => {
  const [a, b, c] = crossings(junction([0, 90, 180]));
  assert.ok(a > 0 && b > 0 && c > 0, `crosswalks per arm: ${a} ${b} ${c}`);
});

test("two arms that nearly coincide get no crosswalk, so none cuts through the other", () => {
  const [a, b, c] = crossings(junction([0, 20, 180]));
  assert.equal(a, 0, "the first of the pair has no crosswalk");
  assert.equal(b, 0, "the second of the pair has no crosswalk");
  assert.ok(c > 0, "the arm on its own keeps its crosswalk");
});

test("a band under a metre long stays between its two mouths", () => {
  const line = [
    { x: 0, z: 0 },
    { x: 30, z: 0 },
    { x: 47.4, z: 0 },
  ];
  // 34.08 + 12.37 leaves 0.95 m of a 47.4 m street.
  const [a, b] = trimPolyline(line, 34.08, 12.37);
  assert.ok(
    Math.abs(a.x - 34.08) < 1e-6 && Math.abs(b.x - 35.03) < 1e-6,
    `${a.x} ${b.x}`,
  );
});
