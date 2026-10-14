import { test } from "node:test";
import assert from "node:assert/strict";
import { collisionPairs, resolveMovementContacts } from "../shared/physics/index.ts";
import { emptyCity } from "../shared/city-stream.ts";
import type { Entity } from "../shared/world.ts";

const car = (id: string, x: number): Entity => ({
  id,
  kind: "car",
  model: "sedan",
  x,
  y: 0,
  z: 0,
  angle: 0,
  vx: 5,
  vy: 0,
  vz: 0,
  health: 100,
  color: "#ffffff",
});

test("sweep includes correction margins, excludes distant bodies, and orders pairs independently of input order", () => {
  const bodies = [car("c", 16), car("a", -16), car("b", 0), car("far", 100)];
  bodies.push({ ...car("passenger", 0), kind: "player", vehicle: "a" });
  bodies.push({ ...car("dead", 0), kind: "player", health: 0 });
  bodies.push({ ...car("above", 0), y: 2 });
  const ids = (list: Entity[]) => collisionPairs(list).map(([a, b]) => [a.id, b.id]);
  assert.deepEqual(ids(bodies), [
    ["a", "b"],
    ["b", "c"],
  ]);
  assert.deepEqual(ids(bodies.slice().reverse()), [
    ["a", "b"],
    ["b", "c"],
  ]);
});

test("a contacting pileup resolves identically regardless of snapshot entity order", () => {
  const city = emptyCity({ seed: 42, airport: { x: 640, z: -640, w: 128, d: 200 } });
  city.buildings = [{ x: 3, z: 0, w: 2, d: 8, h: 10, color: "#fff", style: 0 }];
  const original = [car("c", 1), car("a", 0), car("b", -1)];
  const solve = (order: Entity[]) => {
    const bodies = structuredClone(order);
    for (let pass = 0; pass < 10; pass++) resolveMovementContacts(bodies, city);
    return bodies.sort((a, b) => a.id.localeCompare(b.id));
  };
  const expected = solve(original);
  assert.deepEqual(solve(original.slice().reverse()), expected);
  assert.deepEqual(solve([original[1], original[2], original[0]]), expected);
  assert.ok(
    expected.every((body) => body.x + 1 < 2.02),
    "cars remain outside the wall",
  );
});

test("dense sweep groups retain every eligible pair in ID order", () => {
  const bodies = [car("d", 16), car("c", 0), car("b", -16), car("a", 0)];
  bodies[0].z = 16;
  bodies[1].y = 1.8;
  const expected = [
    ["a", "b"],
    ["a", "c"],
    ["a", "d"],
    ["b", "c"],
    ["c", "d"],
  ];
  for (let rotation = 0; rotation < bodies.length; rotation++) {
    assert.deepEqual(
      collisionPairs(bodies).map(([a, b]) => [a.id, b.id]),
      expected,
    );
    bodies.push(bodies.shift()!);
  }
});
