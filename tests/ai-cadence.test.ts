import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import { generateCity } from "../scripts/city-generator.ts";
import type { Entity } from "../shared/world.ts";

test("AI decisions share a server tick without slowing physics or losing elapsed time", (t) => {
  const sim = new Simulation(generateCity());
  sim.entities.clear();
  sim.city.props = [];
  sim.city.buildings = [];
  const pedestrian = sim.spawn("pedestrian", 0, 0);
  const car = sim.spawn("car", 10, 0);
  const boat = sim.spawn("boat", 30, 0);
  pedestrian.ai = car.ai = boat.ai = true;
  const walking: number[] = [],
    driving: number[] = [];
  let boats = 0;
  t.mock.method(
    sim.ai,
    "pedestrian",
    (_entity: Entity, _nearby: Entity[], dt: number) => {
      walking.push(dt);
      return { x: 1, z: 0, sprint: false };
    },
  );
  t.mock.method(
    sim.ai,
    "car",
    (_entity: Entity, _nearby: Entity[], _time: number, dt: number) => {
      driving.push(dt);
      return { throttle: 1, steer: 0, brake: false };
    },
  );
  t.mock.method(sim.ai, "watercraft", () => {
    boats++;
    return { throttle: 1, steer: 0, brake: false };
  });
  try {
    sim.tick(1 / 30);
    assert.equal(walking.length, 1);
    assert.equal(driving.length, 1);
    assert.equal(boats, 1);
    assert.ok(
      Math.abs(pedestrian.x - 7 / 240) < 1e-12,
      "retain four 120 Hz acceleration substeps",
    );
    assert.ok(car.z > 0, "cars still advance during the decision interval");
    sim.tick(0.1);
    assert.equal(walking.length, 4, "a long tick still refreshes AI every 33 ms");
    assert.equal(driving.length, 4);
    assert.equal(boats, 4);
    sim.tick(1 / 120);
    assert.equal(walking.length, 5);
    for (const deltas of [walking, driving])
      assert.ok(Math.abs(deltas.reduce((a, b) => a + b, 0) - 17 / 120) < 1e-12);
  } finally {
    sim.destruction.dispose();
  }
});
