import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { generateCity } from "../scripts/city-generator.ts";
import { Simulation } from "../server/simulation.ts";
import { Sessions } from "../server/session.ts";
import { Runtime } from "../server/runtime.ts";
import { CityStore } from "../server/city-stream.ts";
import { GameNetwork } from "../client/network/index.ts";
import { Prediction } from "../client/network/prediction.ts";
import { SnapshotTimeline } from "../client/network/timeline.ts";
import {
  predictionWorld,
  predictStep,
  contact,
  entityBox,
} from "../shared/physics/index.ts";
import { idle, type Entity } from "../shared/world.ts";

function drivingWorld() {
  const city = generateCity();
  city.buildings = [];
  city.props = [];
  const sim = new Simulation(city);
  sim.entities.clear();
  const cars = [0, 4.5, 9].map((z, i) => {
    const car = sim.spawn("car", i * 0.15, z, undefined, "sport");
    car.driver = `driver-${i}`;
    car.vz = 40;
    car.health = car.maxHealth = 1000000;
    sim.inputs.set(
      car.driver,
      i === 0 ? { ...idle(), up: true } : { ...idle(), brake: true, right: i === 2 },
    );
    return car;
  });
  return { sim, cars };
}

test("last authoritative braking and steering predict a driven three-car collision", () => {
  const { sim, cars } = drivingWorld();
  try {
    sim.tick(1 / 30);
    assert.deepEqual(cars[1].drive, { throttle: 0, steer: 0, brake: true });
    assert.deepEqual(cars[2].drive, { throttle: 0, steer: 1, brake: true });
    const snapshots = structuredClone(cars),
      saved = structuredClone(snapshots);
    const predicted = structuredClone(cars[0]),
      shadows = predictionWorld(predicted, snapshots);
    for (let i = 0; i < 10; i++) {
      sim.tick(1 / 30);
      predictStep(
        predicted,
        { ...idle(), up: true },
        sim.city,
        snapshots,
        1 / 30,
        shadows,
      );
    }
    assert.ok(cars[0].vz < 40, "the scenario must produce a collision impulse");
    for (const actual of cars) {
      const replay =
        actual.id === predicted.id
          ? predicted
          : shadows.find((e) => e.id === actual.id);
      assert.ok(replay);
      for (const key of ["x", "z", "vx", "vz", "angle", "angularVelocity"] as const)
        assert.ok(
          Math.abs((actual[key] ?? 0) - (replay[key] ?? 0)) < 1e-8,
          `${actual.id} ${key}`,
        );
    }
    assert.deepEqual(snapshots, saved, "prediction leaves snapshots untouched");
  } finally {
    sim.destruction.dispose();
  }
});

test("last authoritative aircraft controls predict a turning midair collision", () => {
  const city = generateCity();
  city.buildings = [];
  city.props = [];
  const sim = new Simulation(city);
  sim.entities.clear();
  const planes = [0, 8].map((z, i) => {
    const plane = sim.spawn("plane", 0, z, undefined, "plane");
    plane.driver = `pilot-${i}`;
    plane.y = 40;
    plane.vz = i === 0 ? 40 : 20;
    plane.health = plane.maxHealth = 1000000;
    sim.inputs.set(plane.driver, {
      ...idle(),
      up: true,
      right: i === 1,
      ascend: i === 1,
    });
    return plane;
  });
  try {
    sim.tick(1 / 30);
    const snapshots = structuredClone(planes);
    const saved = structuredClone(snapshots);
    const predicted = structuredClone(planes[0]);
    const shadows = predictionWorld(predicted, snapshots);
    const contacts = new Set([predicted.id]);
    for (let i = 0; i < 10; i++) {
      sim.tick(1 / 30);
      predictStep(
        predicted,
        { ...idle(), up: true },
        city,
        snapshots,
        1 / 30,
        shadows,
        contacts,
      );
    }
    assert.ok(contacts.has(planes[1].id), "the scenario produces a midair contact");
    for (const actual of planes) {
      const replay =
        actual.id === predicted.id
          ? predicted
          : shadows.find((e) => e.id === actual.id);
      assert.ok(replay);
      for (const key of ["x", "y", "z", "vx", "vy", "vz", "angle"] as const)
        assert.ok(
          Math.abs(actual[key] - replay[key]) < 0.001,
          `${actual.id} ${key}: ${actual[key]} != ${replay[key]}`,
        );
    }
    assert.deepEqual(snapshots, saved, "prediction leaves authority untouched");
  } finally {
    sim.destruction.dispose();
  }
});

test("a 250 ms runtime stall catches up the entire collision world in fixed ticks", (t) => {
  const { sim, cars } = drivingWorld();
  const expected = drivingWorld();
  const sessions = new Sessions(
    createServer(),
    sim,
    true,
    new CityStore(sim.city).manifest,
  );
  const runtime = new Runtime(sim, sessions);
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.mock.method(sessions, "broadcast", () => {});
  try {
    runtime.start();
    clock = 250;
    t.mock.timers.tick(5);
    assert.equal(runtime.ticks, 4, "catch-up yields after four world ticks");
    clock = 255;
    t.mock.timers.tick(5);
    assert.equal(runtime.ticks, 7, "remaining stall debt survives the yield");
    assert.equal(runtime.catchUpTicks, 5);
    for (let i = 0; i < 7; i++) expected.sim.tick(1 / 30);
    for (let i = 0; i < cars.length; i++) {
      for (const key of ["x", "z", "vx", "vz", "angle", "angularVelocity"] as const)
        assert.equal(cars[i][key], expected.cars[i][key], `${i} ${key}`);
    }
  } finally {
    runtime.stop();
    expected.sim.destruction.dispose();
  }
});

function presentation(t: TestContext) {
  const { sim, cars } = drivingWorld();
  t.after(() => sim.destruction.dispose());
  const player = sim.join("Driver", "#ffffff");
  const car = cars[0],
    other = cars[1];
  car.driver = player.id;
  player.vehicle = car.id;
  car.x = other.x = 0;
  car.vz = other.vz = 52;
  const network = new GameNetwork(
    { welcome() {}, state() {}, chat() {}, status() {} },
    "Test",
    "#ffffff",
    sim.city,
  );
  network.playerId = player.id;
  const timeline: unknown = Reflect.get(network, "timeline");
  assert.ok(timeline instanceof SnapshotTimeline);
  const prediction = (network.prediction = new Prediction(sim.city));
  const contacts = new Set<string>();
  t.mock.method(prediction, "render", () => ({
    body: structuredClone(car),
    neighbours: [structuredClone(other)],
    contacts,
  }));
  const snapshot = (now: number) => {
    const entities = structuredClone([player, car, other]);
    for (const e of entities) network.entities.set(e.id, e);
    timeline.push(now / 1000, entities, now);
  };
  return { network, car, other, contacts, snapshot };
}

test("buffered overlap does not promote a physically separated fast car", (t) => {
  const { network, car, other, snapshot } = presentation(t);
  let previous: number | undefined;
  for (let now = 0; now <= 3200; now += 16) {
    car.z = (52 * now) / 1000;
    other.z = car.z + 8;
    if (now % 64 === 0) snapshot(now);
    assert.equal(contact(entityBox(car), entityBox(other)), undefined);
    const remote = network.renderEntities(now).find((e) => e.id === other.id)!;
    if (previous !== undefined)
      assert.ok(Math.abs(remote.z - previous) < 1.5, `jump at ${now}`);
    previous = remote.z;
  }
});

test("entering and leaving contact presentation stays continuous and stops extrapolating stale snapshots", (t) => {
  const { network, car, other, contacts, snapshot } = presentation(t);
  let previous: Entity | undefined;
  for (let now = 0; now <= 1600; now += 16) {
    car.z = (52 * now) / 1000;
    other.z = car.z + 8;
    if (now <= 960 && now % 64 === 0) snapshot(now);
    if (now === 512) contacts.add(other.id);
    if (now === 768) contacts.clear();
    const remote = network.renderEntities(now).find((e) => e.id === other.id)!;
    if (previous) assert.ok(Math.abs(remote.z - previous.z) < 1.7, `jump at ${now}`);
    previous = remote;
  }
  const stopped = network.renderEntities(2000).find((e) => e.id === other.id)!;
  const later = network.renderEntities(4000).find((e) => e.id === other.id)!;
  assert.ok(
    Math.abs(later.z - stopped.z) < 0.1,
    "stale playback cannot keep driving the car",
  );
});
