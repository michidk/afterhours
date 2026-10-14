import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCity } from "../scripts/city-generator.ts";
import {
  carAltitude,
  carForces,
  carGrounded,
  predictStep,
} from "../shared/physics/index.ts";
import { TERRAIN_SIDE, TERRAIN_STEP } from "../shared/terrain.ts";
import { LIMIT, idle, type Entity } from "../shared/world.ts";
import { Simulation } from "../server/simulation.ts";

function terrain(height: (z: number) => number) {
  const city = generateCity();
  city.buildings = [];
  city.props = [];
  city.ramps = [];
  city.terrain = {
    heights: Array.from({ length: TERRAIN_SIDE ** 2 }, (_, i) =>
      height(Math.floor(i / TERRAIN_SIDE) * TERRAIN_STEP - LIMIT),
    ),
  };
  return city;
}
function car(y = 20): Entity {
  return {
    id: "car",
    kind: "car",
    model: "sedan",
    x: 0,
    z: 0,
    y,
    vx: 0,
    vz: 20,
    vy: 0,
    angle: 0,
    health: 100,
    color: "#fff",
  };
}

test("a car leaves a steep drop with momentum, falls under gravity and lands", () => {
  const city = terrain((z) => (z <= 0 ? 20 : Math.max(0, 20 - z * 2)));
  const e = car();
  const dt = 1 / 120;
  const previous = { ...e };
  e.z += e.vz * dt;
  carAltitude(e, previous, city, dt);
  assert.ok(e.y > 19.99, "the terrain cannot pull the car down");
  assert.equal(e.vy, -18 * dt);
  assert.equal(carGrounded(e, city), false);
  const airborne = { ...e };
  carForces(e, { throttle: 1, steer: 1, brake: true }, dt, false);
  assert.equal(e.vz, airborne.vz, "airborne wheels provide no traction");
  for (let i = 0; i < 240; i++) {
    const before = { ...e };
    e.z += e.vz * dt;
    carAltitude(e, before, city, dt);
  }
  assert.equal(e.y, 0);
  assert.equal(e.vy, 0);
  assert.equal(carGrounded(e, city), true);
});

test("cars retain slope momentum at a crest and gravity accelerates them downhill", () => {
  const city = terrain((z) => 20 - Math.abs(z) * 0.25);
  const e = car();
  e.z = -1 / 6;
  e.y = 20 + e.z * 0.25;
  e.vy = 5;
  const previous = { ...e };
  e.z = 0;
  carAltitude(e, previous, city, 1 / 120);
  assert.equal(e.y, 20);
  assert.ok(e.vy > 4.9);
  const crest = { ...e };
  e.z += e.vz / 120;
  carAltitude(e, crest, city, 1 / 120);
  assert.ok(e.y > 20, "uphill momentum carries the car above the crest");

  const slope = terrain((z) => 20 - z * 0.25);
  const rolling = car();
  rolling.vz = 0;
  carAltitude(rolling, { ...rolling }, slope, 1 / 120);
  assert.ok(rolling.vz > 0, "gravity acts along the terrain even from rest");
});

test("two shared simulations agree through terrain launch and landing", () => {
  const city = terrain((z) => (z <= 0 ? 20 : Math.max(0, 20 - z * 2)));
  const sim = new Simulation(city);
  sim.entities.clear();
  const e = sim.spawn("car", 0, -1);
  e.vz = 20;
  const predicted = structuredClone(e);
  const input = idle();
  let airborne = false;
  for (let i = 0; i < 100; i++) {
    sim.tick(1 / 30);
    predictStep(predicted, input, city, [], 1 / 30);
    for (const key of ["x", "y", "z", "vx", "vy", "vz"] as const)
      assert.ok(Math.abs(e[key] - predicted[key]) < 1e-8, key);
    airborne ||= e.y > 0 && !carGrounded(e, city);
  }
  assert.ok(airborne);
  assert.equal(e.y, 0);
});
