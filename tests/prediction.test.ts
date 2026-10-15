import { TERRAIN_SIDE } from "../shared/terrain.ts";
import { destructionOverlay } from "../shared/destruction.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prediction, interpolate } from "../client/network/prediction.ts";
import { Simulation } from "../server/simulation.ts";
import { idle, type Entity } from "../shared/world.ts";
import { SnapshotTimeline } from "../client/network/timeline.ts";
import { GameNetwork } from "../client/network/index.ts";
import { CityStore } from "../server/city-stream.ts";
import { CityStream } from "../client/world/stream.ts";
import { emptyCity } from "../shared/city-stream.ts";
import {
  predictStep,
  predictionWorld,
  contact,
  entityBox,
} from "../shared/physics/index.ts";

test("rendered neighbours respond to predicted impacts before the next snapshot", () => {
  const s = new Simulation(generateCity());
  s.entities.clear();
  s.city.buildings = [];
  s.city.props = [];
  const p = s.join("Driver", "#ffffff");
  p.x = p.z = 0;
  const car = s.spawn("car", 0, 0),
    obstacle = s.spawn("car", 0.4, 4.3);
  s.interact(p.id);
  car.vz = 16;
  const passenger: Entity = {
    ...p,
    id: "passenger",
    vehicle: obstacle.id,
    seat: 1,
    x: obstacle.x,
    z: obstacle.z,
  };
  const snapshots = structuredClone([p, car, obstacle, passenger]);
  const network = new GameNetwork(
    { welcome() {}, state() {}, chat() {}, status() {} },
    "Test",
    "#ffffff",
    s.city,
  );
  network.playerId = p.id;
  for (const e of snapshots) network.entities.set(e.id, e);
  const timeline: unknown = Reflect.get(network, "timeline");
  assert.ok(timeline instanceof SnapshotTimeline);
  timeline.push(0, snapshots, 0);
  const prediction = (network.prediction = new Prediction(s.city));
  prediction.reconcile(p, snapshots, -1);
  for (let seq = 0; seq < 6; seq++) {
    prediction.input({ seq, timestamp: (seq * 1000) / 30, input: idle() }, snapshots);
    s.tick(1 / 30);
  }
  const state = structuredClone(prediction.body);
  const rendered = network.renderEntities((6 * 1000) / 30 - 1);
  const hit = rendered.find((e) => e.id === obstacle.id);
  assert.ok(hit, "the predicted contact body must be rendered");
  assert.ok(hit.vz > 0, "show the provisional impulse without a server round trip");
  const local = rendered.find((e) => e.id === car.id)!;
  const overlap = contact(entityBox(local), entityBox(hit));
  assert.ok(!overlap || overlap.depth < 0.015, "visible collision hulls agree");
  assert.deepEqual(prediction.body, state, "rendering cannot advance replay state");
  assert.deepEqual(
    [...network.entities.values()],
    snapshots,
    "snapshots stay authoritative",
  );
  assert.equal(hit.health, 100, "no speculative damage");
  const rider = rendered.find((e) => e.id === passenger.id)!;
  assert.deepEqual(
    [rider.x, rider.z, rider.y, rider.angle],
    [hit.x, hit.z, hit.y, hit.angle],
  );
});

for (const delay of [0, 50, 100, 200, 360]) {
  test(`collision replay and display stay aligned with ${delay} ms delayed, jittered snapshots`, () => {
    const s = new Simulation(generateCity());
    s.entities.clear();
    s.city.props = [];
    s.city.buildings = [];
    const p = s.join("Driver", "#ffffff");
    p.x = p.z = 0;
    const car = s.spawn("car", 0, 0),
      obstacle = s.spawn("car", 0.4, 4.3);
    s.interact(p.id);
    car.vz = 12;
    const prediction = new Prediction(s.city);
    prediction.reconcile(p, [p, car, obstacle], -1);
    const packets: { due: number; ack: number; entities: Entity[] }[] = [];
    let visibleContacts = 0,
      capped = 0;
    for (let seq = 0; seq < 90; seq++) {
      const now = (seq * 1000) / 30;
      prediction.input({ seq, timestamp: now, input: idle() }, [p, car, obstacle]);
      s.tick(1 / 30);
      if (seq % 2 === 0)
        packets.push({
          due: now + delay + [0, 12, -8][seq % 3],
          ack: seq,
          entities: structuredClone([p, car, obstacle]),
        });
      while (packets[0]?.due <= now) {
        const packet = packets.shift()!;
        prediction.reconcile(packet.entities[0], packet.entities, packet.ack);
      }
      if (prediction.status === "predicting")
        assert.ok(
          Math.hypot(prediction.body!.x - car.x, prediction.body!.z - car.z) < 0.02,
          `replay drift at step ${seq}`,
        );
      const replay = structuredClone(prediction.body);
      for (const fraction of [0, 0.5, 0.95]) {
        const rendered = prediction.render(now + (fraction * 1000) / 30);
        assert.ok(rendered, "a capped prediction must not switch to old authority");
        if (prediction.status === "waiting for acknowledgements") capped++;
        const other = rendered.neighbours.find((e) => e.id === obstacle.id)!;
        const overlap = contact(entityBox(rendered.body), entityBox(other));
        assert.ok(!overlap || overlap.depth < 0.02, `render penetrated at step ${seq}`);
        if (other.vz > 0.1) visibleContacts++;
      }
      assert.deepEqual(prediction.body, replay);
      assert.ok(prediction.pending.every((frame) => frame.seq <= seq));
    }
    assert.ok(visibleContacts > 0, "the scenario must actually collide");
    assert.equal(capped, 0, "ordinary latency must not suspend local controls");
    prediction.reconcile(p, [p, car, obstacle], 89);
    assert.equal(prediction.pending.length, 0);
    assert.deepEqual(prediction.body, car, "final authority replaces all speculation");
  });
}

for (const distance of [27, 100])
  test(`approaching bodies at ${distance} m are included before they can reach the player`, () => {
    const city = emptyCity({ seed: 42, airport: { x: 640, z: -640, w: 128, d: 200 } });
    const a: Entity = {
      id: "a",
      kind: "car",
      model: "sport",
      x: 0,
      z: 0,
      y: 0,
      vx: 0,
      vz: 52,
      vy: 0,
      angle: 0,
      health: 100,
      color: "#fff",
    };
    const b: Entity = {
      ...a,
      id: "b",
      z: distance,
      vz: -52,
      angle: Math.PI,
      driver: "remote",
    };
    const shadows = predictionWorld(a, [a, b]);
    for (let step = 0; step < 30; step++)
      predictStep(a, { ...idle(), up: true }, city, [a, b], 1 / 30, shadows);
    const hit = shadows.find((e) => e.id === b.id);
    assert.ok(hit, "closing traffic cannot be omitted from prediction");
    assert.ok(
      a.vz < 20 && hit.vz > -20,
      "the collision is resolved within the prediction horizon",
    );
  });

test("prediction bounds follow closing speed, including existing impulses", () => {
  const player: Entity = {
    id: "local",
    kind: "player",
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    angle: 0,
    health: 100,
    color: "#fff",
  };
  const pedestrian: Entity = { ...player, id: "remote", z: 60 };
  assert.deepEqual(
    predictionWorld(player, [pedestrian]),
    [],
    "walking cannot close sixty metres in one second",
  );
  pedestrian.vz = -80;
  assert.equal(
    predictionWorld(player, [pedestrian])[0]?.id,
    "remote",
    "an existing impulse can reach the player",
  );
});

test("capped prediction keeps the local player and nearby cars on the same timeline", () => {
  const city = emptyCity({ seed: 42, airport: { x: 640, z: -640, w: 128, d: 200 } });
  const old: Entity = {
    id: "p",
    kind: "player",
    x: 0,
    z: 0,
    y: 0,
    vx: 0,
    vz: 0,
    vy: 0,
    angle: 0,
    health: 100,
    color: "#fff",
  };
  const car: Entity = { ...old, id: "car", kind: "car", model: "sedan", z: 3 };
  const p = { ...old, z: 2 },
    moved = { ...car, z: 5 };
  const network = new GameNetwork(
    { welcome() {}, state() {}, chat() {}, status() {} },
    "Test",
    "#ffffff",
    city,
  );
  network.playerId = p.id;
  network.entities = new Map([
    [p.id, p],
    [car.id, moved],
  ]);
  const timeline: unknown = Reflect.get(network, "timeline");
  assert.ok(timeline instanceof SnapshotTimeline);
  timeline.push(0, [old, car], 0);
  timeline.push(1, [p, moved], 1000);
  network.prediction = new Prediction(city);
  network.prediction.reconcile(p, [p, moved], -1);
  for (let seq = 0; seq < 32; seq++)
    network.prediction.input({ seq, timestamp: seq * 33, input: idle() }, [p, moved]);
  assert.equal(network.prediction.status, "waiting for acknowledgements");
  assert.ok(network.prediction.render(1100));
  const result = network.renderEntities(1100),
    local = result.find((e) => e.id === p.id)!,
    neighbour = result.find((e) => e.id === car.id)!;
  assert.equal(local.z, 2);
  assert.equal(
    neighbour.z,
    5,
    "capped prediction cannot retain a neighbour from an older clock",
  );
  assert.equal(contact(entityBox(local), entityBox(neighbour)), undefined);
});

test("stalled acknowledgements stop prediction before neighbours leave collision coverage", () => {
  const city = emptyCity({ seed: 42, airport: { x: 640, z: -640, w: 128, d: 200 } });
  const p: Entity = {
    id: "p",
    kind: "player",
    x: 0,
    z: 0,
    y: 0,
    vx: 0,
    vz: 0,
    vy: 0,
    angle: 0,
    health: 100,
    color: "#fff",
  };
  const prediction = new Prediction(city);
  prediction.reconcile(p, [p], -1);
  for (let seq = 0; seq < 32; seq++)
    prediction.input(
      { seq, timestamp: (seq * 1000) / 30, input: { ...idle(), up: true } },
      [p],
    );
  const held = prediction.render(1100)!.body.z;
  assert.ok(held > 0 && held < 5, "prediction stops within its lead budget");
  assert.equal(prediction.status, "waiting for acknowledgements");
  for (let seq = 32; seq < 100; seq++)
    prediction.input(
      { seq, timestamp: (seq * 1000) / 30, input: { ...idle(), up: true } },
      [p],
    );
  assert.equal(
    prediction.render(3400)!.body.z,
    held,
    "a stalled link holds the bounded pose instead of rewinding",
  );
  assert.ok(prediction.pending.length <= 60, "history stays bounded");
  prediction.reconcile(p, [p], 20, 3400);
  assert.deepEqual(prediction.body, p, "never replay an incomplete history suffix");
  assert.equal(prediction.status, "waiting for acknowledgements");
  prediction.reconcile({ ...p, z: 1 }, [{ ...p, z: 1 }], 99, 3433);
  assert.ok(prediction.render(3450), "resume from fresh authority");
  assert.equal(prediction.pending.length, 0);
});

test("missing collision chunks disable input, replay and extrapolation until loaded", async () => {
  const city = emptyCity({ seed: 42, airport: { x: 640, z: -640, w: 128, d: 200 } });
  city.buildings = [{ x: 128, z: 64, w: 8, d: 10, h: 20, color: "#ffffff", style: 0 }];
  const p: Entity = {
    id: "walker",
    kind: "player",
    x: 120,
    z: 64,
    y: 0,
    vx: 0,
    vz: 0,
    vy: 0,
    angle: 0,
    health: 100,
    color: "#ffffff",
  };
  const store = new CityStore(city);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stream = new CityStream(
    store.manifest,
    () => {},
    async (url) => {
      const parts = String(url).split("/"),
        key = `${parts.at(-2)},${parts.at(-1)}`;
      if (key === "2,0") await gate;
      return new Response(JSON.stringify(store.chunks.get(key)));
    },
  );
  for (let i = 0; i < 20; i++) {
    stream.setView(p, p);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(stream.ready(p), false);
  const prediction = new Prediction(stream.city, (point) => stream.ready(point)),
    frame = { seq: 0, timestamp: 1000, input: { ...idle(), right: true } };
  prediction.reconcile(p, [p], -1);
  prediction.input(frame, [p]);
  assert.deepEqual(prediction.body, p);
  assert.equal(prediction.pending.length, 0);
  assert.deepEqual(
    prediction.render(1016)!.body,
    p,
    "render authority without predicting through missing data",
  );
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stream.ready(p), true);
  const full = new Prediction(city);
  full.reconcile(p, [p], -1);
  for (let seq = 0; seq < 30; seq++) {
    const input = { ...frame, seq, timestamp: 1000 + seq * 33 };
    prediction.input(input, [p]);
    full.input(input, [p]);
    if (seq % 3 === 2) {
      const authoritative = structuredClone(full.body!);
      prediction.reconcile(authoritative, [authoritative], seq);
      full.reconcile(authoritative, [authoritative], seq);
    }
  }
  assert.deepEqual(prediction.body, full.body);
  assert.ok(prediction.body!.x < 124, "same wall blocks full and streamed prediction");
  assert.ok(prediction.body!.x > 123.5, "the scenario reaches the wall");
  stream.setView(undefined, { x: 650, z: 650 }, 48);
  prediction.reconcile(p, [p], -1);
  assert.deepEqual(prediction.body, p);
  assert.equal(prediction.pending.length, 0, "do not replay through an unloaded wall");
  assert.ok(
    prediction.render(2016),
    "retain presentation while physics waits for data",
  );
});

test("prediction checks the replayed and displayed positions, not only the snapshot", () => {
  const city = emptyCity({ seed: 42, airport: { x: 640, z: -640, w: 128, d: 200 } });
  const car: Entity = {
    id: "car",
    kind: "car",
    model: "sedan",
    driver: "p",
    x: 0,
    z: 0,
    y: 0,
    vx: 42,
    vz: 0,
    vy: 0,
    angle: 0,
    health: 100,
    color: "#fff",
  };
  const p: Entity = {
    ...car,
    id: "p",
    kind: "player",
    model: undefined,
    driver: undefined,
    vehicle: car.id,
  };
  const prediction = new Prediction(city, (point) => point.x < 1.8);
  prediction.reconcile(p, [p, car], -1);
  prediction.input({ seq: 0, timestamp: 1000, input: idle() }, [p, car]);
  assert.ok(prediction.body!.x > 1);
  assert.equal(
    prediction.render(1016)!.body.x,
    0,
    "display extrapolation cannot advance beyond collision data",
  );
  prediction.input({ seq: 1, timestamp: 1033, input: idle() }, [p, car]);
  prediction.reconcile(p, [p, car], -1);
  assert.deepEqual(prediction.body, car, "incomplete replay falls back to authority");
  assert.equal(prediction.pending.length, 0);
  const pose = prediction.render(1050)!.body;
  assert.equal(pose.x, 0, "discard the extrapolation input after an incomplete replay");
});

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
    pose = prediction.render(16)!.body;
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
  const pose = prediction.render(1016)!.body;
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
  const positions = [0, 6, 12, 18, 24, 30].map(
    (dt) => prediction.render(1000 + dt)!.body.z,
  );
  assert.ok(positions.every((z, i) => i === 0 || z > positions[i - 1]));
  assert.deepEqual(prediction.body, authoritativePrediction);
  assert.equal(prediction.pending.length, 1);
  assert.equal(
    prediction.render(2000)!.body.z,
    prediction.render(3000)!.body.z,
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

test("a delayed snapshot after a render stall cannot rewind remote movement", () => {
  const s = new Simulation(generateCity()),
    car = s.spawn("car", 0, 0);
  car.vx = 10;
  const timeline = new SnapshotTimeline();
  timeline.push(1, [{ ...car, x: 10 }], 0);
  timeline.sample(0);
  const before = timeline.sample(200)[0].x;
  assert.ok(Math.abs(before - 11) < 1e-8, "reach the bounded extrapolated pose");

  timeline.push(1 + 1 / 15, [{ ...car, x: (1 + 1 / 15) * 10 }], 600);
  const after = timeline.sample(600)[0].x;
  assert.ok(Math.abs(after - 11) < 1e-8, "resume from the last displayed pose");
});

test("remote movement stays continuous when server time runs slower than wall time", () => {
  const s = new Simulation(generateCity()),
    car = s.spawn("car", 0, 0);
  const timeline = new SnapshotTimeline();
  car.vx = 10;
  let next = 0,
    previous = 0;
  for (let now = 0; now < 10000; now += 1000 / 60) {
    while (next * 100 <= now) {
      const time = next / 15;
      timeline.push(time, [{ ...car, x: time * 10 }], next++ * 100);
    }
    const x = timeline.sample(now)[0].x;
    if (now > 3000) {
      assert.ok(x - previous > 0.05, "a slow simulation must not pause every packet");
      assert.ok(x - previous < 0.15, "a slow simulation must not jump every packet");
    }
    previous = x;
  }
});

test("corrections restore physics immediately and ease position and wrapped yaw only in render", () => {
  const s = new Simulation(generateCity());
  s.entities.clear();
  s.city.buildings = [];
  s.city.props = [];
  const p = s.join("Correction", "#ffffff");
  p.x = p.z = 0;
  p.angle = Math.PI - 0.05;
  const prediction = new Prediction(s.city);
  prediction.reconcile(p, [p], -1);
  prediction.render(1000);
  const corrected = { ...p, x: 0.1, angle: -Math.PI + 0.05 };
  prediction.reconcile(corrected, [corrected], -1);
  assert.equal(prediction.body!.x, 0.1);
  assert.equal(prediction.body!.angle, corrected.angle);
  const initial = prediction.render(1000)!.body;
  assert.ok(Math.abs(initial.x) < 1e-8, "retain the old displayed position at arrival");
  assert.ok(
    Math.abs(prediction.offset.angle + 0.1) < 1e-8,
    "turn along shortest arc across pi",
  );
  const state = structuredClone(prediction.body);
  const smallBefore = Math.abs(prediction.offset.x);
  prediction.render(1050);
  const smallFraction = Math.abs(prediction.offset.x) / smallBefore;
  assert.ok(smallFraction > 0.5 && smallFraction < 1);
  assert.deepEqual(prediction.body, state, "visual easing never changes physics");
  const larger = { ...corrected, x: 1.1 };
  prediction.reconcile(larger, [larger], -1);
  const largeBefore = Math.abs(prediction.offset.x);
  prediction.render(1100);
  assert.ok(
    Math.abs(prediction.offset.x) / largeBefore < smallFraction,
    "large errors settle faster",
  );
  prediction.render(10000);
  assert.equal(
    prediction.offset.x,
    0,
    "background pause must not retain stale correction",
  );
  const teleport = { ...larger, x: 20 };
  prediction.reconcile(teleport, [teleport], -1);
  assert.equal(prediction.render(10000)!.body.x, 20, "teleports snap immediately");
  s.destruction.dispose();
});

test("remote aim crosses pi smoothly while walking yaw stays separate", () => {
  const p: Entity = {
    id: "p",
    kind: "player",
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    angle: 0,
    aim: Math.PI - 0.1,
    health: 100,
    color: "#fff",
  };
  const pose = interpolate(p, { ...p, aim: -Math.PI + 0.1 }, 0.5);
  assert.ok(Math.abs(pose.aim! - Math.PI) < 1e-8);
  assert.equal(pose.angle, 0);
  assert.equal(interpolate(p, { ...p, aim: undefined }, 1).aim, undefined);
});

test("collision-map loss and recovery preserve the displayed car without predicting unknown collisions", () => {
  const city = emptyCity({ seed: 42, airport: { x: 640, z: -640, w: 128, d: 200 } });
  const car: Entity = {
    id: "car",
    kind: "car",
    model: "sedan",
    driver: "p",
    x: 0,
    z: 0,
    y: 0,
    vx: 0,
    vz: 10,
    vy: 0,
    angle: 0,
    health: 100,
    color: "#fff",
  };
  const player: Entity = {
    ...car,
    id: "p",
    kind: "player",
    model: undefined,
    driver: undefined,
    vehicle: car.id,
  };
  const network = new GameNetwork(
    { welcome() {}, state() {}, chat() {}, status() {} },
    "Test",
    "#fff",
    city,
  );
  network.playerId = player.id;
  network.entities = new Map([
    [player.id, player],
    [car.id, car],
  ]);
  let ready = true;
  const prediction = (network.prediction = new Prediction(city, () => ready));
  prediction.reconcile(player, [player, car], -1, 0);
  for (let seq = 0; seq < 6; seq++)
    prediction.input(
      { seq, timestamp: (seq * 1000) / 30, input: { ...idle(), up: true } },
      [player, car],
    );
  const display = (now: number) =>
    network.renderEntities(now).find((e) => e.id === car.id)!;
  const before = display(200);
  assert.ok(before.z > 2, "the car has a visible prediction lead");
  ready = false;
  assert.equal(
    display(216).z,
    before.z,
    "coverage loss must not snap back to authority",
  );
  let previous = before.z;
  for (let tick = 1; tick <= 30; tick++) {
    const now = 216 + (tick * 1000) / 30;
    car.z = tick / 3;
    prediction.reconcile(player, [player, car], 5, now);
    prediction.input(
      { seq: 5 + tick, timestamp: now, input: { ...idle(), up: true } },
      [player, car],
    );
    assert.deepEqual(
      prediction.body,
      car,
      "no physics steps while collision data is absent",
    );
    assert.equal(prediction.pending.length, 0);
    const pose = display(now);
    assert.ok(pose.z >= previous - 0.001, "fallback cannot rewind a moving car");
    previous = pose.z;
  }
  car.vz = 0;
  prediction.reconcile(player, [player, car], 35, 1250);
  for (let now = 1250; now <= 3000; now += 16) display(now);
  assert.ok(
    Math.abs(display(3000).z - car.z) < 0.001,
    "stopped presentation converges",
  );
  ready = true;
  prediction.reconcile(player, [player, car], 35, 3010);
  prediction.input({ seq: 36, timestamp: 3010, input: { ...idle(), up: true } }, [
    player,
    car,
  ]);
  assert.ok(
    Math.abs(display(3010).z - car.z) < 0.001,
    "resuming prediction preserves presentation",
  );
  assert.ok(prediction.body!.z > car.z, "physics resumes only with complete coverage");
  ready = false;
  car.z = 1000;
  prediction.reconcile(player, [player, car], 36, 3100);
  assert.equal(
    display(3100).z,
    1000,
    "an authoritative teleport still resets presentation",
  );
});

for (const [speed, elevation] of [
  [3, 0],
  [30, 0],
  [52, 0],
  [52, 25],
]) {
  test(`tree impact at ${speed} m/s on ${elevation} m ground predicts motion privately and reconciles`, () => {
    const city = generateCity();
    city.terrain = { heights: Array(TERRAIN_SIDE ** 2).fill(elevation) };
    city.props = [{ kind: "tree", x: 0, z: 5, h: 8 }];
    city.buildings = [];
    city.parks = [];
    const sim = new Simulation(city);
    sim.entities.clear();
    try {
      const player = sim.join("Driver", "#ffffff");
      player.x = player.z = 0;
      const car = sim.spawn("car", 0, 2, undefined, "sport");
      sim.interact(player.id);
      car.vz = speed;
      const clientCity = structuredClone(city);
      const snapshots = structuredClone([player, car]);
      const prediction = new Prediction(clientCity);
      prediction.reconcile(snapshots[0], snapshots, -1, 0);
      let provisional = false;
      for (let seq = 0; seq < 24; seq++) {
        const now = (seq * 1000) / 30;
        prediction.input({ seq, timestamp: now, input: idle() }, snapshots);
        sim.tick(1 / 30);
        const rendered = prediction.render(now)!;
        provisional ||= rendered.impacts.size > 0;
        assert.ok(
          Math.hypot(prediction.body!.x - car.x, prediction.body!.z - car.z) < 0.001,
          `tree collision disagrees at step ${seq}`,
        );
      }
      assert.equal(provisional, speed > 3);
      assert.equal(
        destructionOverlay(clientCity).ids.size,
        0,
        "no authoritative overlay mutation",
      );
      const debris = sim.destruction.snapshot(car, 100)[0];
      if (debris)
        assert.ok(debris.position.y > elevation, "debris starts above its terrain");
      assert.equal(sim.destruction.broken.size, speed > 3 ? 1 : 0);
      assert.equal(
        prediction.body!.health,
        snapshots[1].health,
        "damage waits for authority",
      );
      assert.deepEqual(clientCity, city, "prediction never changes the saved map");
      prediction.reconcile(player, [player, car], 23, 800);
      assert.equal(
        prediction.render(800)!.impacts.size,
        0,
        "acknowledged speculation expires",
      );
      assert.deepEqual(prediction.body, car);
    } finally {
      sim.destruction.dispose();
    }
  });
}

test("live steering responds between commands without changing replay or authority", () => {
  const sim = new Simulation(generateCity());
  sim.entities.clear();
  sim.city.props = [];
  sim.city.buildings = [];
  try {
    const player = sim.join("Driver", "#ffffff");
    player.x = player.z = 0;
    const car = sim.spawn("car", 0, 0, undefined, "sport");
    sim.interact(player.id);
    car.vz = 52;
    const prediction = new Prediction(sim.city);
    prediction.reconcile(player, [player, car], -1, 0);
    prediction.input({ seq: 0, timestamp: 0, input: idle() }, [player, car]);
    const before = structuredClone(prediction.body);
    const straight = prediction.render(16)!.body;
    const turning = prediction.render(16, { ...idle(), right: true })!.body;
    assert.ok(turning.steering! > 0);
    assert.ok(
      turning.angle > straight.angle,
      "heading responds before the next 33 ms command",
    );
    assert.ok(turning.vx > straight.vx);
    assert.deepEqual(prediction.body, before);
    assert.equal(prediction.pending[0].input.right, false);
    assert.equal(car.angle, 0);
  } finally {
    sim.destruction.dispose();
  }
});
