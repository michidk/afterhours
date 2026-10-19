import { test } from "node:test";
import assert from "node:assert/strict";
import { terrainColours } from "../client/world/terrain-colour.ts";
import { WATER_LEVEL } from "../shared/water.ts";

const SIDE = 65,
  STEP = 8;
/** A square grid whose height is `at(x, z)` in metres from the grid centre. */
const grid = (at: (x: number, z: number) => number) =>
  Array.from({ length: SIDE * SIDE }, (_, i) =>
    at(((i % SIDE) - 32) * STEP, (Math.floor(i / SIDE) - 32) * STEP),
  );
const colourAt = (c: Float32Array, gx: number, gz: number) =>
  Array.from(c.slice((gz * SIDE + gx) * 4, (gz * SIDE + gx) * 4 + 3));

test("terrain colours are deterministic and stay in range", () => {
  const heights = grid(
    (x, z) => WATER_LEVEL + 6 + Math.sin(x / 90) * 3 + Math.cos(z / 70) * 2,
  );
  const a = terrainColours(heights, SIDE, STEP),
    b = terrainColours(heights, SIDE, STEP);
  assert.deepEqual(a, b);
  for (let i = 0; i < a.length; i++)
    assert.ok(a[i] >= 0 && a[i] <= 1, "channels are valid colours");
});

test("level grass varies in soft patches instead of one flat colour", () => {
  const c = terrainColours(
    grid(() => WATER_LEVEL + 8),
    SIDE,
    STEP,
  );
  const greens = new Set<string>();
  for (let gz = 2; gz < SIDE - 2; gz++)
    for (let gx = 2; gx < SIDE - 2; gx++)
      greens.add(
        colourAt(c, gx, gz)
          .map((v) => v.toFixed(2))
          .join(),
      );
  assert.ok(greens.size > 40, `${greens.size} distinct colours`);
  // Neighbouring vertices stay close, so the patches blend instead of speckling.
  let worst = 0;
  for (let gz = 2; gz < SIDE - 2; gz++)
    for (let gx = 2; gx < SIDE - 3; gx++) {
      const p = colourAt(c, gx, gz),
        q = colourAt(c, gx + 1, gz);
      worst = Math.max(worst, ...p.map((v, i) => Math.abs(v - q[i])));
    }
  assert.ok(worst < 0.12, `neighbouring colours differ by at most ${worst.toFixed(2)}`);
});

test("beaches are sand, steep ground is rock and level inland ground is not", () => {
  // Level ground with a shelf at the waterline in the west and a steep ridge in the east.
  const c = terrainColours(
    grid((x) =>
      x < -160
        ? WATER_LEVEL + 0.1
        : x > 160
          ? WATER_LEVEL + 60 + (x - 160) * 1.5
          : WATER_LEVEL + 8,
    ),
    SIDE,
    STEP,
  );
  const sand = colourAt(c, 10, 32),
    grass = colourAt(c, 32, 32),
    ridge = colourAt(c, 58, 32);
  // Sand is red-heavy and blue-poor, grass green-heavy, rock grey (channels close together).
  assert.ok(sand[0] > sand[2] + 0.2, "the beach is sand-coloured");
  assert.ok(grass[1] > grass[0] && grass[1] > grass[2], "level ground is green");
  assert.ok(
    Math.max(...ridge) - Math.min(...ridge) < 0.15,
    "a steep ridge is grey rock",
  );
});
