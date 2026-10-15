import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCity } from "../server/city-loader.ts";
import { Simulation } from "../server/simulation.ts";
import { VEHICLES } from "../shared/catalog.ts";
import { LIMIT, idle, type Entity } from "../shared/world.ts";
import {
  WATER_LEVEL,
  WORLD_LIMIT,
  groundLevel,
  isWater,
  resolveWorldBounds,
  surfaceLevel,
} from "../shared/water.ts";
import {
  contact,
  entityBox,
  predictStep,
  resolveMovementContacts,
} from "../shared/physics/index.ts";
import { debugCommandSchema } from "../shared/debug.ts";
import { CityStream, COLLISION_RADIUS } from "../client/world/stream.ts";
import { CityStore } from "../server/city-stream.ts";
import { chunksAround } from "../shared/city-stream.ts";

const saved = await loadCity();
const waterModels = [
  "boat",
  "launch",
  "jetski",
  "racer",
  "speedboat",
  "offshore",
] as const;
const island = { x: 0, z: 0, angle: 0, w: LIMIT, d: LIMIT };
function setup() {
  const sim = new Simulation(structuredClone(saved));
  sim.entities.clear();
  sim.city.terrain = undefined;
  sim.city.buildings = [];
  sim.city.props = [];
  sim.city.parks = [];
  sim.city.surfaces = [];
  sim.city.ramps = [];
  return sim;
}
function run(s: Simulation, seconds: number) {
  for (let i = 0; i < Math.round(seconds * 30); i++) s.tick(1 / 30);
}
function afloat(e: Entity) {
  // Bodies the server integrates once per tick can trail the wave clock by a few substeps.
  assert.ok(Math.abs(e.y - surfaceLevel(e.x, e.z)) < 0.03, "rides the swell");
  assert.equal(
    contact(entityBox(e), island),
    undefined,
    "the full rotated hull stays off land",
  );
  const box = entityBox(e),
    c = Math.abs(Math.cos(e.angle)),
    n = Math.abs(Math.sin(e.angle));
  assert.ok(Math.abs(e.x) + c * box.w + n * box.d <= WORLD_LIMIT + 0.00001);
  assert.ok(Math.abs(e.z) + n * box.w + c * box.d <= WORLD_LIMIT + 0.00001);
}

test("the immutable saved map supplies every model safely without enlarging land chunks", () => {
  const source = JSON.stringify(saved),
    sim = new Simulation(saved);
  for (const [id, spec] of Object.entries(VEHICLES)) {
    const placed = [...sim.entities.values()].find((e) => e.model === id && !e.ai);
    assert.ok(placed, id);
    assert.equal(placed.kind, spec.kind);
    for (const building of saved.buildings)
      assert.equal(
        contact(entityBox(placed), {
          x: building.x,
          z: building.z,
          angle: 0,
          w: building.w / 2,
          d: building.d / 2,
        }),
        undefined,
        id,
      );
    // Boats lie moored in the harbours of the saved city.
    if ("water" in spec) {
      assert.ok(isWater(placed.x, placed.z, saved), `${id} floats`);
      assert.ok(
        Math.abs(placed.y - surfaceLevel(placed.x, placed.z, saved)) < 0.03,
        "rides the swell",
      );
    }
  }
  assert.equal(JSON.stringify(saved), source);
  assert.throws(
    () => sim.spawn("boat", -LIMIT - 84, 0, undefined, "plane"),
    /does not match/,
  );
  assert.equal(sim.spawn("jetski", -LIMIT - 84, 0).model, "jetski");
  assert.equal(LIMIT, 1536);
  assert.equal(WORLD_LIMIT, 1792);
  assert.equal(groundLevel(-LIMIT - 4, 0), -1.1);
  assert.equal(isWater(0, 0), false);
  assert.equal(
    debugCommandSchema.safeParse({ kind: "teleport", x: -LIMIT - 134, z: 0 }).success,
    true,
  );
  assert.equal(
    debugCommandSchema.safeParse({ kind: "teleport", x: -LIMIT - 284, z: 0 }).success,
    false,
  );
  assert.deepEqual(chunksAround(-LIMIT - 214, 0, 48), []);
  const stream = new CityStream(new CityStore(saved).manifest, () => {});
  assert.equal(stream.ready({ x: -LIMIT - COLLISION_RADIUS - 1, z: 0 }), true);
  assert.equal(
    stream.ready({ x: -LIMIT - 4, z: 0 }),
    false,
    "shore still needs land collision geometry",
  );
});

for (const model of waterModels) {
  test(`${model} shares authoritative throttle, steering and braking with prediction`, () => {
    const s = setup(),
      e = s.spawn(VEHICLES[model].kind, -LIMIT - 154, 0, undefined, model);
    e.driver = "driver";
    const prediction = structuredClone(e);
    const input = { ...idle(), up: true, right: true };
    s.inputs.set("driver", input);
    let turned = false;
    for (let i = 0; i < 120; i++) {
      s.tick(1 / 30);
      predictStep(prediction, input, s.city, [], 1 / 30);
      for (const key of [
        "x",
        "z",
        "y",
        "vx",
        "vz",
        "angle",
        "angularVelocity",
      ] as const)
        assert.ok(Math.abs((prediction[key] || 0) - (e[key] || 0)) < 1e-8, key);
      afloat(e);
      turned ||= Math.abs(e.angle) > 0.3;
    }
    assert.ok(Math.hypot(e.vx, e.vz) > 1);
    assert.ok(turned);
    s.inputs.set("driver", { ...idle(), brake: true });
    run(s, 4);
    assert.ok(Math.hypot(e.vx, e.vz) < 0.1, "braking settles the hull");
    s.inputs.set("driver", { ...idle(), down: true });
    run(s, 2);
    assert.ok(
      e.vx * Math.sin(e.angle) + e.vz * Math.cos(e.angle) < -1,
      "reverse works",
    );
    e.driver = undefined;
    const speed = Math.hypot(e.vx, e.vz);
    s.inputs.set(e.id, { ...idle(), up: true });
    run(s, 1);
    assert.ok(
      Math.hypot(e.vx, e.vz) < speed,
      "empty craft cannot run their propulsion",
    );
  });
}

test("rotated shore and outer hull corners stay constrained after dynamic contacts", () => {
  const s = setup();
  for (const angle of [0, Math.PI / 4, Math.PI / 2, -Math.PI / 3]) {
    const boat = s.spawn("speedboat", -LIMIT - 0.5, 0, undefined, "offshore");
    boat.angle = angle;
    boat.vx = 10;
    resolveWorldBounds(boat);
    afloat(boat);
    boat.x = -LIMIT - 0.2;
    boat.z = LIMIT + 0.2;
    resolveWorldBounds(boat);
    afloat(boat);
    boat.x = -WORLD_LIMIT + 0.1;
    boat.z = WORLD_LIMIT - 0.1;
    boat.vx = -12;
    boat.vz = 12;
    resolveWorldBounds(boat);
    afloat(boat);
    assert.ok(boat.vx > 0 && boat.vz < 0);
    s.entities.delete(boat.id);
  }
  const a = s.spawn("boat", -LIMIT - 1.26, 0),
    b = s.spawn("boat", -LIMIT - 2, 0);
  const predicted = structuredClone([a, b]);
  s.tick(1 / 30);
  resolveMovementContacts(predicted, s.city);
  afloat(a);
  afloat(b);
  for (const body of predicted) afloat(body);
});

test("water variants accelerate differently and have distinct seats and cruising speeds", () => {
  for (const models of [
    ["boat", "launch"],
    ["jetski", "racer"],
    ["speedboat", "offshore"],
  ] as const) {
    const speeds = models.map((model) => {
      const s = setup(),
        e = s.spawn(VEHICLES[model].kind, -LIMIT - 134, 0, undefined, model);
      e.driver = "driver";
      s.inputs.set("driver", { ...idle(), up: true });
      run(s, 1);
      assert.equal(e.seats?.length, VEHICLES[model].seatCount);
      return e.vz;
    });
    assert.ok(Math.abs(speeds[0] - speeds[1]) > 0.7);
    assert.notEqual(VEHICLES[models[0]].water.cruise, VEHICLES[models[1]].water.cruise);
  }
});

test("swimmers can board together, exit to water, and step onto the shoreline", () => {
  const s = setup(),
    craft = s.spawn("boat", -LIMIT - 7, 0);
  const driver = s.join("Driver", "#ffffff"),
    passenger = s.join("Passenger", "#ffffff");
  for (const [i, person] of [driver, passenger].entries()) {
    person.x = craft.x + 4;
    person.z = i;
    person.y = WATER_LEVEL;
    s.interact(person.id);
    assert.equal(person.vehicle, craft.id);
    assert.equal(person.seat, i);
  }
  assert.equal(craft.driver, driver.id);
  s.inputs.set(passenger.id, { ...idle(), up: true });
  run(s, 1);
  assert.ok(
    Math.abs(craft.z) < 0.2,
    "passengers do not control propulsion; only the swell rocks it",
  );
  s.interact(passenger.id);
  assert.equal(passenger.vehicle, undefined);
  assert.equal(passenger.y, surfaceLevel(passenger.x, passenger.z, s.city));
  assert.equal(passenger.parachute, undefined);
  assert.equal(craft.driver, driver.id);
  s.inputs.set(passenger.id, { ...idle(), right: true });
  const predicted = structuredClone(passenger);
  for (let i = 0; i < 90; i++) {
    s.tick(1 / 30);
    predictStep(predicted, { ...idle(), right: true }, s.city, [craft], 1 / 30);
  }
  assert.ok(passenger.x > -LIMIT);
  assert.equal(passenger.y, 0);
  assert.ok(Math.abs(predicted.x - passenger.x) < 1e-8);
  s.interact(driver.id);
  assert.equal(craft.driver, undefined);
});

test("swimming slows locomotion, then a parachute lands at water height", () => {
  const s = setup(),
    p = s.join("Swimmer", "#ffffff");
  p.x = -LIMIT - 134;
  p.z = 0;
  p.y = WATER_LEVEL;
  s.inputs.set(p.id, { ...idle(), up: true, sprint: true });
  run(s, 2);
  assert.ok(p.z > 5 && p.z < 5.7);
  assert.ok(Math.abs(p.vz - 2.8) < 1e-8);
  p.y = 10;
  p.parachute = true;
  s.inputs.set(p.id, idle());
  run(s, 4);
  assert.equal(p.y, surfaceLevel(p.x, p.z, s.city), "lands on the swell");
  assert.equal(p.parachute, undefined);
});

test("all water AI models cruise bounded routes for six minutes and stop when stolen", () => {
  const s = setup();
  const craft = waterModels.map((model, index) => {
    const e = s.spawn(VEHICLES[model].kind, 0, 0, undefined, model);
    s.ai.assignWatercraft(e, index);
    return e;
  });
  const start = craft.map((e) => ({ x: e.x, z: e.z }));
  const targets = craft.map((e) => s.ai.waterRoutes.get(e.id)?.index);
  const advanced = new Set<string>();
  for (let i = 0; i < 10800; i++) {
    s.tick(1 / 30);
    for (const [index, e] of craft.entries()) {
      afloat(e);
      assert.equal(e.health, e.maxHealth);
      if (s.ai.waterRoutes.get(e.id)?.index !== targets[index]) advanced.add(e.id);
    }
  }
  assert.equal(advanced.size, 6);
  for (const [index, e] of craft.entries())
    assert.ok(Math.hypot(e.x - start[index].x, e.z - start[index].z) > 150);
  const e = craft[0],
    player = s.join("Captain", "#ffffff");
  player.x = e.x + Math.cos(e.angle) * 4;
  player.z = e.z - Math.sin(e.angle) * 4;
  player.y = WATER_LEVEL;
  s.interact(player.id);
  assert.equal(e.driver, player.id);
  assert.equal(e.ai, false);
  assert.equal(s.ai.waterRoutes.has(e.id), false);
});
