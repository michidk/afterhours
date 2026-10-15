import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { messageSchema } from "../shared/protocol.ts";
import { propulsionRunning } from "../shared/propulsion.ts";
import { encodeSnapshot, decodeSnapshot, applyPatch } from "../shared/codec.ts";
import { VERSION } from "../shared/version.ts";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CarLights, buildHeadlightCones } from "../client/models/car-lights.ts";

function setup() {
  const city = generateCity();
  city.buildings = [];
  city.props = [];
  city.pickups = [];
  const sim = new Simulation(city);
  sim.entities.clear();
  const car = sim.spawn("car", 0, 0);
  const driver = sim.join("Driver", "#ffffff");
  driver.x = driver.z = 0;
  sim.interact(driver.id);
  return { sim, car, driver };
}

const lit = (sim: Simulation, car: { lightsOn?: boolean }, hour: number) => {
  sim.day = hour;
  sim.dayRate = 0;
  sim.tick(1 / 30);
  return car.lightsOn;
};

test("headlights are automatic: on in the dark for a driven car, never for a parked one", () => {
  assert.equal(messageSchema.safeParse({ type: "lights" }).success, false);
  const { sim, car, driver } = setup();
  const passenger = sim.join("Passenger", "#ffffff");
  passenger.x = passenger.z = 0;
  sim.interact(passenger.id);
  assert.equal(passenger.vehicle, car.id);
  for (const [hour, expected] of [
    [12, false],
    [18, true],
    [0, true],
    [5.99, true],
    [6, false],
  ] as const)
    assert.equal(lit(sim, car, hour), expected, String(hour));
  // Leaving the car switches them off; the passenger alone does not light it.
  sim.interact(driver.id);
  assert.equal(lit(sim, car, 0), false);
  car.driver = driver.id;
  assert.equal(lit(sim, car, 0), true);
  car.wreck = 180;
  assert.equal(lit(sim, car, 0), false);
  sim.entities.delete(car.id);
  const boat = sim.spawn("boat", 0, 0);
  boat.driver = driver.id;
  driver.vehicle = boat.id;
  assert.equal(lit(sim, boat, 0), undefined);
});

test("AI cars light up at night, and a stolen or abandoned car follows the same rule", () => {
  const { sim, car, driver } = setup();
  sim.interact(driver.id);
  car.ai = true;
  for (const [hour, expected] of [
    [12, false],
    [21, true],
    [3, true],
  ] as const)
    assert.equal(lit(sim, car, hour), expected, String(hour));
  driver.x = car.x;
  driver.z = car.z;
  sim.interact(driver.id);
  assert.equal(car.ai, false);
  assert.equal(lit(sim, car, 0), true, "the thief is driving");
  sim.interact(driver.id);
  assert.equal(lit(sim, car, 0), false, "an empty car is dark");
});

test("taking the wheel starts the engine, and the lights follow the dark", () => {
  for (const [hour, expected] of [
    [12, false],
    [21, true],
    [3, true],
  ] as const) {
    const city = generateCity();
    city.buildings = [];
    city.props = [];
    city.pickups = [];
    const sim = new Simulation(city);
    sim.entities.clear();
    const car = sim.spawn("car", 0, 0);
    assert.equal(propulsionRunning(car), false, "a parked car is off");
    assert.equal(lit(sim, car, hour), false, "and dark");
    const driver = sim.join("Driver", "#ffffff");
    driver.x = driver.z = 0;
    sim.interact(driver.id);
    assert.equal(car.driver, driver.id);
    assert.equal(propulsionRunning(car), true, "the engine starts");
    assert.equal(lit(sim, car, hour), expected, String(hour));
  }
});

test("light on and off updates survive binary snapshot deltas", () => {
  const { car } = setup();
  const entities = new Map([[car.id, car]]);
  for (const lightsOn of [true, false]) {
    const snapshot = decodeSnapshot(
      encodeSnapshot({
        type: "state",
        version: VERSION,
        frame: 1,
        base: 0,
        full: false,
        time: 0,
        day: 0,
        ack: 0,
        entities: [{ id: car.id, lightsOn }],
        removed: [],
        events: [],
        pickups: [],
        players: 1,
      }),
    );
    applyPatch(entities, snapshot.entities[0]);
    assert.equal(entities.get(car.id)?.lightsOn, lightsOn);
  }
});

test("car beams follow scaled rotating cars, limit real lights, and emit no light on removal", (t) => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const { car } = setup();
    const root = new TransformNode(car.id, scene);
    root.position.set(10, 0.3, 20);
    root.rotation.y = Math.PI / 2;
    root.scaling.set(1.2, 1.35, 1.3);
    buildHeadlightCones(scene, root);
    assert.equal(root.getChildMeshes().length, 2);
    assert.ok(root.getChildMeshes().every((m) => !m.isEnabled() && !m.isPickable));
    const lights = new CarLights(scene);
    car.lightsOn = true;
    lights.update([car], new Map([[car.id, root]]), Vector3.Zero());
    assert.equal(scene.lights.length, 4);
    const enabled = scene.lights.filter((l) => l.intensity > 0);
    assert.equal(enabled.length, 2);
    const first = enabled[0];
    assert.ok("position" in first && first.position instanceof Vector3);
    assert.ok(Math.abs(first.position.x - 12.86) < 0.0001);
    assert.ok(Math.abs(first.position.y - 1.272) < 0.0001);
    const scans = t.mock.method(scene.meshes[0], "_resyncLightSource");
    lights.update([car], new Map([[car.id, root]]), Vector3.Zero());
    assert.equal(
      scans.mock.callCount(),
      0,
      "unchanged lights do not rescan scene meshes",
    );
    car.lightsOn = false;
    lights.update([car], new Map([[car.id, root]]), Vector3.Zero());
    assert.equal(scene.lights.filter((l) => l.intensity > 0).length, 0);
    car.lightsOn = true;
    lights.update([], new Map(), Vector3.Zero());
    assert.equal(scene.lights.filter((l) => l.intensity > 0).length, 0);
    assert.equal(
      scans.mock.callCount(),
      0,
      "light selection never rescans scene meshes",
    );
    root.dispose();
    assert.equal(scene.meshes.length, 0);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
