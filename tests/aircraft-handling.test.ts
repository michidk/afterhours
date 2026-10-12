import { LIMIT } from "../shared/world.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCity } from "../server/city-loader.ts";
import { Simulation } from "../server/simulation.ts";
import { idle } from "../shared/world.ts";
import { predictStep } from "../shared/physics/index.ts";
import { VEHICLES } from "../shared/catalog.ts";

const saved = await loadCity();
function setup() {
  const s = new Simulation(structuredClone(saved));
  s.entities.clear();
  s.city.buildings = [];
  s.city.props = [];
  s.city.parks = [];
  s.city.surfaces = [];
  s.city.ramps = [];
  return s;
}
function run(s: Simulation, seconds: number) {
  for (let i = 0; i < Math.round(seconds * 30); i++) s.tick(1 / 30);
}
for (const model of ["plane", "aerobatic"] as const) {
  test(`${model} takes off, turns, climbs, descends, stalls and brakes with shared tuning`, () => {
    const s = setup(),
      e = s.spawn("plane", 0, 0, undefined, model);
    e.driver = "pilot";
    const prediction = structuredClone(e),
      input = { ...idle(), up: true, ascend: true };
    s.inputs.set("pilot", input);
    for (let i = 0; i < 120; i++) {
      s.tick(1 / 30);
      predictStep(prediction, input, s.city, [], 1 / 30);
      assert.ok(Math.abs(prediction.y - e.y) < 1e-8);
      assert.ok(Math.abs(prediction.z - e.z) < 1e-8);
    }
    assert.ok(e.y > 12);
    const y = e.y;
    s.inputs.set("pilot", { ...idle(), up: true, right: true, descend: true });
    run(s, 1.5);
    assert.ok(e.y < y - 1);
    assert.ok(e.angle > 0.4);
    e.y = 20;
    e.vy = 0;
    e.vx = e.vz = 1;
    s.inputs.set("pilot", { ...idle(), ascend: true });
    run(s, 1);
    assert.ok(e.y < 16, "insufficient airspeed stalls even with climb held");
    e.y = 0;
    e.vy = 0;
    e.vx = 0;
    e.vz = 20;
    s.inputs.set("pilot", { ...idle(), brake: true });
    run(s, 2);
    assert.ok(Math.hypot(e.vx, e.vz) < 0.1);
    assert.equal(e.y, 0);
  });
}
for (const model of ["scout", "utility"] as const) {
  test(`${model} honors altitude controls, turning and braking while matching prediction`, () => {
    const s = setup(),
      e = s.spawn("helicopter", 0, 0, undefined, model);
    e.driver = "pilot";
    e.flight = "takingOff";
    const prediction = structuredClone(e),
      input = { ...idle(), up: true, ascend: true };
    s.inputs.set("pilot", input);
    for (let i = 0; i < 120; i++) {
      s.tick(1 / 30);
      predictStep(prediction, input, s.city, [], 1 / 30);
      for (const key of ["x", "z", "y", "angle", "vy"] as const)
        assert.ok(Math.abs(prediction[key] - e[key]) < 1e-8, key);
    }
    const y = e.y;
    assert.ok(y > 15);
    s.inputs.set("pilot", { ...idle(), right: true, descend: true });
    run(s, 2);
    assert.ok(e.y < y - 3);
    assert.ok(e.x > 5);
    assert.ok(e.angle > 1);
    s.inputs.set("pilot", { ...idle(), up: true, brake: true });
    run(s, 3);
    assert.ok(Math.hypot(e.vx, e.vz) < 0.03);
    assert.ok(e.y >= 2, "descent remains clear of ground");
  });
}
test("aircraft variants have observable acceleration and climb differences", () => {
  for (const models of [
    ["plane", "aerobatic"],
    ["scout", "utility"],
  ] as const) {
    const results = models.map((model) => {
      const s = setup(),
        e = s.spawn(VEHICLES[model].kind, 0, 0, undefined, model);
      e.driver = "pilot";
      if (e.kind === "helicopter") e.flight = "takingOff";
      s.inputs.set("pilot", { ...idle(), up: true, ascend: true });
      run(s, 3);
      return { speed: Math.hypot(e.vx, e.vz), altitude: e.y };
    });
    assert.ok(Math.abs(results[0].speed - results[1].speed) > 2);
    assert.ok(Math.abs(results[0].altitude - results[1].altitude) > 2);
  }
});
test("abandoned aircraft ditch at the water surface and burn authoritatively", () => {
  for (const kind of ["plane", "helicopter"] as const) {
    const s = setup(),
      e = s.spawn(kind, -LIMIT - 134, 0);
    e.y = 20;
    e.flight = "falling";
    run(s, 3);
    assert.equal(e.y, -1.1);
    assert.equal(e.health, 0);
    assert.ok(e.burning !== undefined);
  }
});
