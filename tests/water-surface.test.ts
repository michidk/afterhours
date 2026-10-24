import test from "node:test";
import assert from "node:assert/strict";
import { surfaceLevel, WATER_LEVEL } from "../shared/water.ts";
import { setWaveTime } from "../shared/water.ts";
import { TERRAIN_SIDE } from "../shared/terrain.ts";

const terrain = { heights: Array(TERRAIN_SIDE * TERRAIN_SIDE).fill(-0.8) };
const city = { terrain, water: { lakes: [], rivers: [] } } as any;

test("dry ground near sea level does not move with sea swell", () => {
  setWaveTime(0);
  const first = surfaceLevel(0, 0, city);
  setWaveTime(10);
  const second = surfaceLevel(0, 0, city);
  assert.equal(first, -0.8);
  assert.equal(second, first);
  assert.ok(first > WATER_LEVEL);
});
