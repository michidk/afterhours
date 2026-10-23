import { test } from "node:test";
import assert from "node:assert/strict";
import { Piloted } from "../client/network/piloted.ts";
import { withPredicted } from "../client/network/prediction.ts";
import type { Entity } from "../shared/world.ts";

const plane = (over: Partial<Entity> = {}): Entity =>
  ({
    id: "plane-1",
    kind: "plane",
    model: "plane",
    x: 0,
    y: 50,
    z: 0,
    angle: 0,
    vx: 0,
    vy: 0,
    vz: 40,
    angularVelocity: 0,
    color: "#fff",
    health: 100,
    driver: "player-1",
    ...over,
  }) as Entity;

test("a piloted craft is drawn carried on from the newest snapshot, not interpolated behind it", () => {
  const p = new Piloted();
  const snapshot = plane();
  assert.equal(p.render(snapshot, 1000, 1000, 0).z, 0);
  // 100 ms after the snapshot arrived, 40 ms of it already spent on the way (one-way delay).
  const later = p.render(snapshot, 1000, 1100, 40);
  assert.ok(Math.abs(later.z - 40 * 0.14) < 1e-6, `z=${later.z}`);
  // A turning craft's heading is carried on by its turn rate.
  const turning = new Piloted().render(plane({ angularVelocity: 1 }), 0, 100, 0);
  assert.ok(Math.abs(turning.angle - 0.1) < 1e-6);
  // Never further than 0.3 s: past that it is stale, not late.
  assert.ok(Math.abs(new Piloted().render(plane(), 0, 5000, 0).z - 40 * 0.3) < 1e-6);
});

test("a new snapshot's jump eases out instead of snapping", () => {
  const p = new Piloted();
  const first = plane();
  p.render(first, 1000, 1000, 0);
  const before = p.render(first, 1000, 1066, 0).z;
  // The next snapshot puts the craft 3 m behind where it was drawn.
  const next = plane({ z: 40 * 0.066 - 3 });
  const jumped = p.render(next, 1066, 1066, 0).z;
  assert.ok(Math.abs(jumped - before) < 0.05, `snapped by ${jumped - before}`);
  let z = jumped,
    t = 1066;
  while (t < 1346) z = p.render(next, 1066, (t += 16), 0).z;
  const carried = next.z + 40 * ((t - 1066) / 1000);
  assert.ok(Math.abs(z - carried) < 0.25, `still ${z - carried} m off`);
});

test("a different craft starts clean", () => {
  const p = new Piloted();
  p.render(plane({ z: 500 }), 0, 0, 0);
  assert.equal(p.render(plane({ id: "plane-2", z: -200 }), 10, 10, 0).z, -200);
});

test("the car swaps to the predicted pose on the newest snapshot's driver, before the delayed copy shows one", () => {
  const car: Entity = {
    ...plane(),
    id: "car-1",
    kind: "car",
    model: "sedan",
    driver: undefined,
    z: 0,
  };
  const player: Entity = {
    ...plane(),
    id: "player-1",
    kind: "player",
    vehicle: "car-1",
    driver: undefined,
  };
  const me: Entity = { ...player, z: 12, pitch: 0, roll: 0, vz: 20, steering: 0 };
  const drawn = (driving?: string) =>
    withPredicted([player, car], me, "player-1", undefined, driving).find(
      (e) => e.id === "car-1",
    )!;
  assert.equal(drawn().z, 0, "swapped with nothing saying the player drives it");
  assert.equal(drawn("car-1").z, 12);
});
