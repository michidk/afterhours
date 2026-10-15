import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCity } from "../server/city-loader.ts";
import { Simulation } from "../server/simulation.ts";
import { idle } from "../shared/world.ts";
import { propulsionRunning } from "../shared/propulsion.ts";
import { FLOOD, waterDepth } from "../shared/physics/flooding.ts";
import { groundLevel, isWater, surfaceLevel, waterLevel } from "../shared/water.ts";

const saved = await loadCity();

/** A dry spot on a shore whose ground falls into deep water straight ahead (+x). */
function shoreline(sim: Simulation) {
  for (let z = -600; z <= 600; z += 40) {
    let land: number | undefined;
    for (let x = 0; x < 1700; x += 2) {
      const depth = waterDepth(x, z, sim.city);
      if (depth < -0.5) land = x;
      else if (land !== undefined && depth > 2 && x - land < 40)
        return { x: land - 6, z };
    }
  }
  throw Error("no shoreline found");
}

test("a car driven into deep water floods, sinks, lets its driver swim out and then explodes", () => {
  const sim = new Simulation(structuredClone(saved));
  sim.entities.clear();
  sim.city.buildings = [];
  sim.city.props = [];
  const start = shoreline(sim);
  const car = sim.spawn("car", start.x, start.z);
  car.angle = Math.PI / 2;
  car.y = groundLevel(car.x, car.z, sim.city);
  const driver = sim.join("Diver", "#ffffff");
  driver.x = start.x;
  driver.z = start.z;
  driver.y = car.y;
  sim.interact(driver.id);
  assert.equal(car.driver, driver.id);
  assert.ok(propulsionRunning(car));
  sim.inputs.set(driver.id, { ...idle(), up: true });
  for (let i = 0; i < 30 * 6 && car.flooded === undefined; i++) sim.tick(1 / 30);
  assert.notEqual(car.flooded, undefined, "the shore no longer pushes the car back");
  assert.ok(isWater(car.x, car.z, sim.city));
  assert.equal(propulsionRunning(car), false, "the engine is dead");
  const speed = Math.hypot(car.vx, car.vz);
  for (let i = 0; i < 60; i++) sim.tick(1 / 30);
  assert.ok(Math.hypot(car.vx, car.vz) < speed, "the water slows it");
  assert.ok(car.y < waterLevel(car.x, car.z, sim.city) - 0.5, "it sinks");
  sim.interact(driver.id);
  assert.equal(driver.vehicle, undefined, "the driver gets out");
  for (let i = 0; i < 30; i++) sim.tick(1 / 30);
  assert.ok(
    Math.abs(driver.y - surfaceLevel(driver.x, driver.z, sim.city)) < 0.05,
    "and swims on the swell",
  );
  for (let i = 0; i < FLOOD.seconds * 30; i++) sim.tick(1 / 30);
  assert.notEqual(car.wreck, undefined, "the flooded car explodes");
  assert.ok(sim.drainEvents().some((e) => e.kind === "explosion"));
});
