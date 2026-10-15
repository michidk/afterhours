import test from "node:test";
import assert from "node:assert/strict";
import { surfIntensity, SURF_RANGE } from "../client/audio/index.ts";
import { LIMIT, type Entity } from "../shared/world.ts";
import { surfaceLevel } from "../shared/water.ts";

// Without terrain the island is flat land inside LIMIT and sea outside it.
const at = (x: number, y = 0, vehicle?: string) =>
  ({ id: "p", kind: "player", x, z: 0, y, vx: 0, vz: 0, vy: 0, vehicle }) as Entity;

test("surf is silent inland, rises near the shore and is loudest while swimming", () => {
  assert.equal(surfIntensity(at(0)), 0, "inland");
  assert.equal(
    surfIntensity(at(-LIMIT + SURF_RANGE + 5)),
    0,
    "beyond earshot of the sea",
  );
  const shore = surfIntensity(at(-LIMIT + 4)),
    near = surfIntensity(at(-LIMIT + 20));
  assert.ok(shore > near && near > 0, "louder closer to the water");
  const swimmer = at(-LIMIT - 40);
  swimmer.y = surfaceLevel(swimmer.x, swimmer.z);
  assert.equal(surfIntensity(swimmer), 1, "in the water");
  assert.ok(shore <= 0.25, "the shore stays well below swimming");
  assert.ok(
    surfIntensity(at(-LIMIT - 40, 4, "boat")) < 1,
    "a boat is above the water, not in it",
  );
  assert.equal(surfIntensity(at(-LIMIT + 4, 60)), 0, "high above the water");
});
