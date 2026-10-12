import test from "node:test";
import assert from "node:assert/strict";
import { segmentHitsBox } from "../client/world/occluders.ts";

const min = { x: 0, y: 0, z: 0 },
  max = { x: 10, y: 10, z: 10 };
test("segment/box slab test with padding", () => {
  assert.equal(
    segmentHitsBox({ x: -5, y: 5, z: 5 }, { x: 15, y: 5, z: 5 }, min, max),
    true,
  );
  assert.equal(
    segmentHitsBox({ x: -5, y: 20, z: 5 }, { x: 15, y: 20, z: 5 }, min, max),
    false,
  );
  assert.equal(
    segmentHitsBox({ x: -5, y: 13, z: 5 }, { x: 15, y: 13, z: 5 }, min, max, 4),
    true,
  );
  assert.equal(
    segmentHitsBox({ x: -5, y: 5, z: 5 }, { x: -2, y: 5, z: 5 }, min, max),
    false,
  );
  assert.equal(
    segmentHitsBox({ x: 5, y: 5, z: 20 }, { x: 5, y: 5, z: 15 }, min, max),
    false,
  );
  assert.equal(
    segmentHitsBox({ x: 5, y: 5, z: 5 }, { x: 5, y: 5, z: 5 }, min, max),
    true,
  );
});
