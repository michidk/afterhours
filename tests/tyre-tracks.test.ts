import { test } from "node:test";
import assert from "node:assert/strict";
import { TyreTracks } from "../client/effects/tyre-tracks.ts";
import type { Entity, WorldEvent } from "../shared/world.ts";
const car = (): Entity => ({
  id: "car",
  kind: "car",
  x: 0,
  z: 0,
  y: 0,
  vx: 8,
  vz: 12,
  vy: 0,
  angle: 0,
  color: "#fff",
  health: 100,
  wheelSkids: [false, false, true, true],
});

test("predicted tyre slip emits two marks in the first frame without a server event", () => {
  const tracks = new TyreTracks(),
    marks: WorldEvent[] = [],
    e = car();
  tracks.sample([e], (mark) => marks.push(mark));
  assert.equal(marks.length, 2);
  assert.deepEqual(
    marks.map((m) => [m.x, m.z]),
    [
      [-1, -1.25],
      [1, -1.25],
    ],
  );
  e.x += 0.3;
  e.z += 0.4;
  tracks.sample([e], (mark) => marks.push(mark));
  assert.equal(marks.length, 4);
  assert.ok(Math.abs(marks[2].length! - 0.56) < 1e-8);
  assert.ok(Math.abs(marks[2].x + 0.85) < 1e-8);
  assert.ok(Math.abs(marks[2].z + 1.05) < 1e-8);
});
test("tracks reset across airborne movement, missing entities and teleports", () => {
  const tracks = new TyreTracks(),
    e = car(),
    marks: WorldEvent[] = [];
  const sample = () => tracks.sample([e], (mark) => marks.push(mark));
  sample();
  e.y = 2;
  sample();
  assert.equal(marks.length, 2);
  e.y = 0;
  e.z = 5;
  sample();
  assert.equal(marks.length, 4);
  e.z = 100;
  sample();
  assert.equal(marks.length, 6);
  assert.ok(marks.every((m) => m.length! < 1));
  tracks.sample([], () => {});
  sample();
  assert.equal(marks.length, 8);
  e.wheelSkids!.fill(false);
  sample();
  assert.equal(marks.length, 8);
});
test("distance sampling has a bounded cost independent of refresh rate", () => {
  const count = (fps: number) => {
    const tracks = new TyreTracks(),
      e = car();
    let count = 0;
    for (let i = 0; i <= fps; i++) {
      e.z = (i / fps) * 8;
      tracks.sample([e], () => count++);
    }
    return count;
  };
  assert.ok(count(165) < 140);
  assert.ok(Math.abs(count(165) - count(60)) < 30);
});
test("rubber follows the scaled, rotated tyres of each car model", () => {
  for (const model of ["sport", "van"] as const) {
    const e = { ...car(), model, angle: Math.PI / 2, x: 20, z: 30 },
      marks: WorldEvent[] = [];
    new TyreTracks().sample([e], (mark) => marks.push(mark));
    const width = model === "sport" ? 1.9 : 2.2,
      length = model === "sport" ? 4.1 : 5;
    assert.ok(Math.abs(marks[0].x - (20 - (1.25 * length) / 4.3)) < 1e-8);
    assert.ok(Math.abs(marks[0].z - (30 + width / 2)) < 1e-8);
    assert.ok(Math.abs(marks[1].z - (30 - width / 2)) < 1e-8);
  }
});
test("cars on raised ground leave marks; only height above the ground counts as airborne", () => {
  // The downtown plateau sits 26 m up, so an absolute altitude test hid every skid there.
  const hill = (x: number) => 26 + x * 0.1,
    marks: WorldEvent[] = [],
    tracks = new TyreTracks((x) => hill(x)),
    e = { ...car(), x: 10, y: hill(10) };
  tracks.sample([e], (mark) => marks.push(mark));
  assert.equal(marks.length, 2, "tyres on a plateau or slope draw rubber");
  assert.ok(
    marks.every((m) => m.y! > hill(m.x) && m.y! < hill(m.x) + 0.3),
    "marks sit just above the terrain under each tyre",
  );
  e.y = hill(10) + 2;
  tracks.sample([e], (mark) => marks.push(mark));
  assert.equal(marks.length, 2, "a car 2 m above the ground is airborne");
  e.y = hill(10);
  e.x = 40;
  e.z = 40;
  e.y = hill(40);
  tracks.sample([e], (mark) => marks.push(mark));
  assert.equal(marks.length, 4, "landing starts fresh marks rather than a bridge");
  assert.ok(marks.slice(2).every((m) => m.length! < 1));
});
