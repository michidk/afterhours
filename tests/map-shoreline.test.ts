import { test } from "node:test";
import assert from "node:assert/strict";
import { lakeShorelines } from "../mapgen/shoreline.ts";
import { pointInPolygon, selfIntersects } from "../mapgen/geom.ts";

test("lake shoreline intersects sloping terrain between grid vertices", () => {
  const side = 5,
    heights = Array.from(
      { length: 25 },
      (_, i) => Math.hypot((i % side) - 2, Math.floor(i / side) - 2) * 4 - 3,
    );
  const seeds = new Uint8Array(25);
  seeds[12] = 1;
  const rings = lakeShorelines(heights, side, 8, 16, seeds, 0);
  assert.equal(rings.length, 1);
  assert.equal(selfIntersects(rings[0]), false);
  assert.ok(pointInPolygon({ x: 0, z: 0 }, rings[0]));
  assert.ok(
    rings[0].some((p) => Math.abs(p.x) === 6 || Math.abs(p.z) === 6),
    "shore crosses an edge at the interpolated 6 m waterline",
  );
  assert.ok(!pointInPolygon({ x: 7, z: 0 }, rings[0]));
});

test("lake shoreline does not include a disconnected depression", () => {
  const heights = Array(49).fill(4);
  heights[16] = -2;
  heights[32] = -2;
  const seeds = new Uint8Array(49);
  seeds[16] = 1;
  const rings = lakeShorelines(heights, 7, 8, 24, seeds, 0);
  assert.equal(rings.length, 1);
  assert.ok(pointInPolygon({ x: -8, z: -8 }, rings[0]));
  assert.ok(!pointInPolygon({ x: 8, z: 8 }, rings[0]));
});
