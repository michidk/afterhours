import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCity } from "../scripts/city-generator.ts";
import { Simulation } from "../server/simulation.ts";
import { idle } from "../shared/world.ts";
import { navigationFor } from "../shared/navigation.ts";
import { RAMP, predictStep, rampHeight } from "../shared/physics/index.ts";

function empty() {
  const s = new Simulation(generateCity());
  s.entities.clear();
  s.city.buildings = [];
  s.city.props = [];
  s.ai.props = [];
  return s;
}
test("AI drives up the physical ramp below the old launch threshold and lands", () => {
  const s = empty(),
    car = s.spawn("car", 3.5, 83);
  const ROAD_GRAPH = navigationFor(s.city).roads;
  const from = ROAD_GRAPH.findIndex((n) => n.x === 0 && n.z === 64),
    to = ROAD_GRAPH.findIndex((n) => n.x === 0 && n.z === 128);
  s.ai.assignCar(car, from, to, (83 - 64) / 64, 0);
  car.vz = 8;
  let highest = 0,
    fastest = 0,
    lifted = false;
  for (let i = 0; i < 135; i++) {
    s.tick(1 / 30);
    highest = Math.max(highest, car.y);
    fastest = Math.max(fastest, Math.hypot(car.vx, car.vz));
    if (car.z > 94.5 && car.y > RAMP.height) lifted = true;
  }
  assert.ok(fastest < 12);
  assert.ok(highest > RAMP.height);
  assert.ok(lifted, "the lip launches even normal AI traffic");
  assert.equal(car.y, 0);
  assert.ok(car.z > 100);
});
test("ramp sides and high face block cars and pedestrians below the surface", () => {
  for (const kind of ["car", "pedestrian"] as const)
    for (const side of [false, true]) {
      const s = empty(),
        e = s.spawn(kind, side ? 8 : 3.5, side ? 93 : 99);
      e.angle = side ? -Math.PI / 2 : Math.PI;
      e.vx = side ? -10 : 0;
      e.vz = side ? 0 : -10;
      s.inputs.set(e.id, { ...idle(), ...(side ? { left: true } : { down: true }) });
      for (let i = 0; i < 30; i++) s.tick(1 / 30);
      assert.equal(e.y, 0, "a wall contact must not teleport the body onto the wedge");
      assert.ok(
        side ? e.x > 6 : e.z > 94.5,
        `${kind} must remain outside the solid face`,
      );
    }
});
test("shared prediction and authority agree throughout ramp ascent, jump and landing", () => {
  const s = empty(),
    car = s.spawn("car", 3.5, 83),
    predicted = structuredClone(car),
    input = { ...idle(), up: true };
  car.vz = predicted.vz = 20;
  s.inputs.set(car.id, input);
  let flight = false;
  for (let i = 0; i < 100; i++) {
    s.tick(1 / 30);
    predictStep(predicted, input, s.city, [], 1 / 30);
    assert.ok(
      Math.hypot(car.x - predicted.x, car.z - predicted.z, car.y - predicted.y) < 1e-8,
    );
    assert.ok(Math.abs(car.vy - predicted.vy) < 1e-8);
    flight ||= car.y > RAMP.height;
  }
  assert.ok(flight);
  assert.equal(car.y, 0);
  assert.equal(rampHeight(3.5, 91, s.city), 0.8);
});
