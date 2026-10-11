import { generateCity } from "../scripts/city-generator.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prediction, interpolate } from "../client/network/prediction.ts";
import { Simulation } from "../server/simulation.ts";
import { idle } from "../shared/world.ts";
import { SnapshotTimeline } from "../client/network/timeline.ts";
import {
  predictStep,
  predictionWorld,
  contact,
  entityBox,
} from "../shared/physics/index.ts";

test("delayed collision snapshots replay pending inputs once and replace provisional damage", () => {
  const s = new Simulation(generateCity());
  s.entities.clear();
  s.city.props = [];
  s.city.buildings = [];
  const p = s.join("Driver", "#fff");
  p.x = 0;
  p.z = 0;
  const car = s.spawn("car", 0, 0),
    obstacle = s.spawn("car", 0.4, 4.3);
  s.interact(p.id);
  car.vz = 16;
  const prediction = new Prediction(s.city),
    input = idle();
  prediction.reconcile(p, [p, car, obstacle], -1);
  let packet = structuredClone([p, car, obstacle]);
  for (let seq = 0; seq < 6; seq++) {
    prediction.input({ seq, timestamp: (seq * 1000) / 30, input }, [p, car, obstacle]);
    s.tick(1 / 30);
    if (seq === 2) packet = structuredClone([p, car, obstacle]);
  }
  assert.equal(prediction.body!.health, 100);
  prediction.reconcile(packet[0], packet, 2);
  assert.deepEqual(
    prediction.pending.map((frame) => frame.seq),
    [3, 4, 5],
  );
  for (const key of ["x", "z", "vx", "vz", "angle"] as const)
    assert.ok(Math.abs(prediction.body![key] - car[key]) < 1e-8, key);
  assert.equal(prediction.body!.health, packet[1].health);
  assert.ok(prediction.body!.health < 100);
});
test("correction smoothing cannot pull the displayed player through a parked car", () => {
  const s = new Simulation(generateCity());
  s.entities.clear();
  s.city.props = [];
  s.city.buildings = [];
  const p = s.join("Walker", "#fff");
  p.x = 0;
  p.z = 0;
  const obstacle = s.spawn("car", 0, 3);
  const prediction = new Prediction(s.city);
  prediction.reconcile(p, [p, obstacle], -1);
  prediction.offset.z = 2;
  const original = structuredClone(prediction.body),
    pose = prediction.render(16)!;
  const overlap = contact(entityBox(pose), entityBox(obstacle));
  assert.ok(!overlap || overlap.depth < 0.012);
  assert.deepEqual(prediction.body, original);
});

test("local dynamic contacts match server impulses without mutating snapshots or deciding damage", () => {
  const s = new Simulation(generateCity());
  s.entities.clear();
  s.city.buildings = [];
  s.city.props = [];
  const car = s.spawn("car", 0, 0),
    obstacle = s.spawn("car", 0.4, 4.25),
    predicted = structuredClone(car),
    snapshots = structuredClone([car, obstacle]);
  car.vz = predicted.vz = snapshots[0].vz = 20;
  const saved = structuredClone(snapshots),
    shadows = predictionWorld(predicted, snapshots);
  s.tick(1 / 30);
  predictStep(predicted, idle(), s.city, snapshots, 1 / 30, shadows);
  assert.ok(predicted.vz < 15, "collision response happens before another snapshot");
  for (const key of ["x", "z", "vx", "vz", "angle", "angularVelocity"] as const)
    assert.ok(Math.abs((car[key] || 0) - (predicted[key] || 0)) < 1e-8, key);
  assert.deepEqual(snapshots, saved);
  assert.equal(predicted.health, 100);
  assert.ok(car.health < 100, "only authority applies impact damage");
  assert.ok(shadows[0].vz > 0, "finite-mass neighbours receive provisional impulses");
});
test("walking prediction respects parked cars without predicting knockdown", () => {
  const s = new Simulation(generateCity());
  s.entities.clear();
  s.city.buildings = [];
  s.city.props = [];
  const p = s.join("Walker", "#fff");
  p.x = 0;
  p.z = 0;
  const car = s.spawn("car", 0, 3),
    predicted = structuredClone(p),
    input = { ...idle(), up: true },
    snapshots = structuredClone([p, car]),
    shadows = predictionWorld(predicted, snapshots);
  s.inputs.set(p.id, input);
  for (let i = 0; i < 20; i++) {
    s.tick(1 / 30);
    predictStep(predicted, input, s.city, snapshots, 1 / 30, shadows);
  }
  assert.ok(Math.abs(predicted.z - p.z) < 1e-8);
  assert.equal(predicted.health, 100);
  assert.ok(!predicted.down);
  assert.ok(predicted.z < 2);
});
test("authoritative corrections replace speculative contacts and smooth the shortest yaw arc", () => {
  const s = new Simulation(generateCity());
  s.entities.clear();
  s.city.props = [];
  s.city.buildings = [];
  const p = s.join("Driver", "#fff"),
    car = s.spawn("car", p.x, p.z);
  s.interact(p.id);
  car.angle = Math.PI - 0.1;
  const prediction = new Prediction(s.city);
  prediction.reconcile(p, [p, car], -1);
  prediction.lastRender = 1000;
  car.angle = -Math.PI + 0.1;
  prediction.reconcile(p, [p, car], -1);
  assert.ok(Math.abs(prediction.offset.angle + 0.2) < 1e-8);
  const pose = prediction.render(1016)!;
  assert.ok(Math.abs(pose.angle) > 3);
  car.x += 10;
  prediction.reconcile(p, [p, car], 99);
  assert.equal(prediction.body!.x, car.x);
  assert.equal(prediction.offset.angle, 0);
  assert.equal(prediction.offset.x, 0);
});
test("prediction replays unacknowledged inputs once and clears ownership history", () => {
  const s = new Simulation(generateCity());
  s.entities.clear();
  s.city.props = [];
  s.ai.props = [];
  s.city.buildings = [];
  const p = s.join("A", "#ffffff"),
    prediction = new Prediction(s.city);
  prediction.reconcile(p, [p], -1);
  const input = { ...idle(), up: true };
  for (let seq = 0; seq < 6; seq++)
    prediction.input({ seq, timestamp: seq * 33, input }, [p]);
  const expected = prediction.body!.z;
  s.inputs.set(p.id, input);
  for (let i = 0; i < 3; i++) s.tick(1 / 30);
  prediction.reconcile(p, [p], 2);
  assert.equal(prediction.pending.length, 3);
  assert.ok(Math.abs(prediction.body!.z - expected) < 1e-8);
  const car = s.spawn("car", p.x, p.z);
  s.interact(p.id);
  prediction.reconcile(p, [p, car], 5);
  assert.equal(prediction.ownership, car.id);
  assert.equal(prediction.pending.length, 0);
  assert.equal(prediction.body!.id, car.id);
  s.interact(p.id);
  prediction.reconcile(p, [p, car], 5);
  assert.equal(prediction.body!.id, p.id);
  assert.equal(prediction.pending.length, 0);
});
test("interpolation follows the short angular arc across pi", () => {
  const s = new Simulation(generateCity()),
    p = s.join("A", "#ffffff");
  const result = interpolate(
    { ...p, angle: Math.PI - 0.1 },
    { ...p, angle: -Math.PI + 0.1 },
    0.5,
  );
  assert.ok(Math.abs(result.angle - Math.PI) < 1e-8);
});
test("local driving renders between input ticks without advancing replay state", () => {
  const s = new Simulation(generateCity());
  s.entities.clear();
  s.city.buildings = [];
  s.city.props = [];
  const p = s.join("Driver", "#fff"),
    car = s.spawn("car", p.x, p.z);
  s.interact(p.id);
  car.vz = 12;
  const prediction = new Prediction(s.city);
  prediction.reconcile(p, [p, car], -1);
  prediction.input({ seq: 0, timestamp: 1000, input: { ...idle(), up: true } }, [
    p,
    car,
  ]);
  const authoritativePrediction = structuredClone(prediction.body);
  const positions = [0, 6, 12, 18, 24, 30].map((dt) => prediction.render(1000 + dt)!.z);
  assert.ok(positions.every((z, i) => i === 0 || z > positions[i - 1]));
  assert.deepEqual(prediction.body, authoritativePrediction);
  assert.equal(prediction.pending.length, 1);
  assert.equal(
    prediction.render(2000)!.z,
    prediction.render(3000)!.z,
    "extrapolation is bounded",
  );
});
test("remote traffic remains continuous under uneven snapshot delivery", () => {
  const s = new Simulation(generateCity()),
    car = s.spawn("car", 0, 0);
  const timeline = new SnapshotTimeline();
  car.vx = 10;
  const arrivals = Array.from({ length: 40 }, (_, i) => ({
    time: i / 15,
    received: (i * 1000) / 15 + [0, 28, -18, 14][i % 4],
  }));
  let next = 0,
    previous: number | undefined;
  for (let now = 0; now < 2400; now += 1000 / 165) {
    while (next < arrivals.length && arrivals[next].received <= now) {
      const packet = arrivals[next++];
      timeline.push(packet.time, [{ ...car, x: packet.time * 10 }], packet.received);
    }
    const x = timeline.sample(now)[0]?.x;
    if (now > 300 && x !== undefined && previous !== undefined) {
      assert.ok(x >= previous - 1e-8, "packet arrivals must not reverse a moving car");
      assert.ok(x - previous < 0.075, "packet arrivals must not jump a render frame");
    }
    previous = x;
  }
  const last = timeline.sample(5000)[0].x;
  assert.equal(
    timeline.sample(6000)[0].x,
    last,
    "a lost connection stops extrapolation",
  );
});
