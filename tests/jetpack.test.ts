import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import { loadCity } from "../server/city-loader.ts";
import { idle } from "../shared/world.ts";
import {
  predictStep,
  characterForces,
  characterAltitude,
} from "../shared/physics/movement.ts";
import { Prediction } from "../client/network/prediction.ts";
import { applyPatch } from "../shared/codec.ts";

test("jetpack thrust spends finite fuel identically in authority and prediction, then parachutes", async () => {
  const city = await loadCity();
  // Pure flight checks: the generated island is not flat at the origin.
  (city as { terrain?: unknown }).terrain = undefined;
  city.buildings = [];
  city.props = [];
  city.ramps = [];
  const sim = new Simulation(city);
  sim.entities.clear();
  const p = sim.join("Flyer", "#ffffff");
  p.x = p.z = 0;
  p.jetpack = { fuel: 2, active: true };
  const predicted = structuredClone(p);
  const input = { ...idle(), ascend: true, right: true };
  sim.inputs.set(p.id, input);
  for (let i = 0; i < 60; i++) {
    sim.tick(1 / 30);
    predictStep(predicted, input, city, [], 1 / 30);
    assert.ok(Math.abs(predicted.y - p.y) < 1e-8);
    assert.ok(Math.abs(predicted.jetpack!.fuel - p.jetpack.fuel) < 1e-8);
  }
  assert.ok(p.y > 15);
  assert.ok(p.jetpack.fuel < 1e-8);
  sim.tick(1 / 30);
  assert.equal(p.parachute, true);
  sim.inputs.set(p.id, idle());
  for (let i = 0; i < 180; i++) sim.tick(1 / 30);
  assert.equal(p.y, 0);
  assert.equal(p.parachute, undefined);
  assert.equal(p.jetpack.fuel, 0);
});

test("disabled packs and render extrapolation cannot spend replay fuel", async () => {
  const city = await loadCity();
  // Pure flight checks: the generated island is not flat at the origin.
  (city as { terrain?: unknown }).terrain = undefined;
  city.buildings = [];
  city.props = [];
  city.ramps = [];
  const sim = new Simulation(city);
  sim.entities.clear();
  const p = sim.join("Flyer", "#ffffff");
  p.jetpack = { fuel: 10, active: false };
  sim.inputs.set(p.id, { ...idle(), ascend: true });
  sim.tick(1);
  assert.equal(p.jetpack.fuel, 10);
  assert.equal(p.y, 0);
  p.jetpack.active = true;
  const prediction = new Prediction(city);
  prediction.reconcile(p, [p], 0);
  prediction.input({ seq: 1, timestamp: 100, input: { ...idle(), ascend: true } }, [p]);
  const fuel = prediction.body!.jetpack!.fuel;
  for (let i = 0; i < 10; i++) prediction.render(115);
  assert.equal(prediction.body!.jetpack!.fuel, fuel);
  assert.equal(p.jetpack.fuel, 10);
  prediction.reconcile(
    { ...p, jetpack: { fuel: 4, active: false } },
    [{ ...p, jetpack: { fuel: 4, active: false } }],
    1,
  );
  assert.equal(prediction.body!.jetpack!.fuel, 4);
  const states = new Map([[p.id, structuredClone(p)]]);
  applyPatch(states, { id: p.id, jetpack: null });
  assert.equal(states.get(p.id)!.jetpack, undefined);
});

test("empty packs cannot retain powered horizontal speed and parachutes take precedence", async () => {
  const city = await loadCity();
  // Pure flight checks: the generated island is not flat at the origin.
  (city as { terrain?: unknown }).terrain = undefined;
  const sim = new Simulation(city);
  sim.entities.clear();
  const p = sim.join("Flyer", "#ffffff");
  p.y = 10;
  p.jetpack = { fuel: 0, active: true };
  characterForces(p, { ...idle(), right: true }, 1);
  assert.equal(p.vx, 4.5);
  p.jetpack.fuel = 10;
  p.parachute = true;
  p.vx = 0;
  characterForces(p, { ...idle(), right: true }, 1);
  assert.equal(p.vx, 6);
  p.parachute = undefined;
  characterForces(p, { ...idle(), right: true }, 1);
  assert.equal(p.vx, 10);
});

test("Q descends under power identically in authority and prediction and lands safely on roofs", async () => {
  const city = await loadCity();
  // Pure flight checks: the generated island is not flat at the origin.
  (city as { terrain?: unknown }).terrain = undefined;
  city.buildings = [{ x: 0, z: 0, w: 20, d: 20, h: 8, color: "#ffffff", style: 0 }];
  city.props = [];
  city.parks = [];
  city.ramps = [];
  const sim = new Simulation(city);
  city.roads = [];
  sim.entities.clear();
  const p = sim.join("Flyer", "#ffffff");
  p.x = p.z = 0;
  p.y = 16;
  p.jetpack = { fuel: 10, active: true };
  const predicted = structuredClone(p);
  const input = { ...idle(), descend: true };
  sim.inputs.set(p.id, input);
  for (let i = 0; i < 60; i++) {
    sim.tick(1 / 30);
    predictStep(predicted, input, city, [], 1 / 30);
    assert.ok(Math.abs(p.y - predicted.y) < 1e-8);
    assert.ok(Math.abs(p.jetpack.fuel - predicted.jetpack!.fuel) < 1e-8);
    assert.equal(p.parachute, undefined);
  }
  assert.equal(p.y, 9.8);
  assert.equal(p.vy, 0);
  assert.ok(p.jetpack.fuel < 10);
  const fuel = p.jetpack.fuel;
  characterAltitude(p, city, 1, input);
  assert.equal(p.jetpack.fuel, fuel);
  assert.equal(p.y, 9.8);
  p.y = 15;
  p.jetpack.fuel = 0;
  characterAltitude(p, city, 1 / 30, input);
  assert.equal(p.parachute, true);
});
