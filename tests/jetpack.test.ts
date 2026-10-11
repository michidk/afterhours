import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import { loadCity } from "../server/city-loader.ts";
import { idle } from "../shared/world.ts";
import { predictStep } from "../shared/physics/movement.ts";
import { Prediction } from "../client/network/prediction.ts";
import { applyPatch } from "../shared/codec.ts";

test("jetpack thrust spends finite fuel identically in authority and prediction, then parachutes", async () => {
  const city = await loadCity();
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
