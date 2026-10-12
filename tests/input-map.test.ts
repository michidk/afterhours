import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Controls } from "../client/input/index.ts";
import { MapViewport } from "../client/ui/city-map.ts";
import { messageSchema } from "../shared/protocol.ts";
import { cityAtlasSchema, emptyCity } from "../shared/city-stream.ts";
import { CityStore } from "../server/city-stream.ts";
import { Simulation } from "../server/simulation.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { predictStep } from "../shared/physics/movement.ts";
import { idle } from "../shared/world.ts";
import { TUNING } from "../shared/catalog.ts";

test("both Shift keys sprint through server and prediction without handbraking vehicles", () => {
  for (const key of ["ShiftLeft", "ShiftRight"]) {
    const controls = new Controls();
    controls.keys.add("KeyW");
    controls.keys.add(key);
    const message = messageSchema.parse({
      type: "input",
      seq: 0,
      timestamp: 0,
      ...controls.read(),
    });
    assert.equal(message.type, "input");
    if (message.type !== "input") throw Error("Expected input");
    assert.equal(message.sprint, true);
    assert.equal(message.brake, false);
    const sim = new Simulation(generateCity());
    sim.entities.clear();
    sim.city.buildings = [];
    sim.city.props = [];
    sim.city.ramps = [];
    const player = sim.join("Runner", "#ffffff");
    player.x = 0;
    player.z = 0;
    const predicted = structuredClone(player);
    sim.inputs.set(player.id, message);
    for (let i = 0; i < 30; i++) {
      sim.tick(1 / 30);
      predictStep(predicted, message, sim.city, [], 1 / 30);
    }
    assert.ok(Math.abs(player.vz - TUNING.sprint) < 1e-8);
    assert.ok(Math.abs(player.z - predicted.z) < 1e-8);
    controls.keys.delete(key);
    assert.equal(controls.read().sprint, false);
    sim.inputs.set(player.id, controls.read());
    for (let i = 0; i < 30; i++) sim.tick(1 / 30);
    assert.ok(Math.abs(player.vz - TUNING.walk) < 1e-8);
    const car = sim.spawn("car", 0, 0, "#ffffff", "sport"),
      plain = structuredClone(car),
      shift = structuredClone(car),
      braking = structuredClone(car);
    for (const e of [plain, shift, braking]) {
      e.driver = player.id;
      e.vz = 15;
    }
    for (let i = 0; i < 30; i++) {
      predictStep(plain, { ...idle(), up: true }, sim.city, [], 1 / 30);
      predictStep(shift, { ...idle(), up: true, sprint: true }, sim.city, [], 1 / 30);
      predictStep(braking, { ...idle(), up: true, brake: true }, sim.city, [], 1 / 30);
    }
    assert.deepEqual(shift, plain);
    assert.ok((braking.rearGripLoss ?? 0) > (shift.rearGripLoss ?? 0));
    controls.keys.add("Space");
    assert.equal(controls.read().brake, true);
    controls.clear();
    assert.deepEqual(controls.read(), { ...idle(), aim: undefined });
  }
  assert.equal(
    messageSchema.safeParse({ type: "input", seq: 0, timestamp: 0, sprint: "yes" })
      .success,
    false,
  );
  assert.equal(
    messageSchema.safeParse({ type: "input", seq: 0, timestamp: 0, moveX: 1.1 })
      .success,
    false,
  );
  const analog = messageSchema.parse({
    type: "input",
    seq: 0,
    timestamp: 0,
    moveX: 0.5,
  });
  assert.equal(analog.type, "input");
  if (analog.type !== "input") throw Error("Expected input");
  assert.equal(analog.moveX, 0.5);
});

test("map zoom keeps the world under the cursor fixed and panning follows the pointer", () => {
  const v = new MapViewport();
  v.resize(1000, 700, 816);
  const original = v.world(250, 180);
  v.zoom(3, 250, 180);
  const zoomed = v.world(250, 180);
  assert.ok(Math.hypot(original.x - zoomed.x, original.z - zoomed.z) < 1e-8);
  const before = v.screen(500, -600);
  v.pan(70, -45);
  const after = v.screen(500, -600);
  assert.ok(Math.abs(after.x - before.x - 70) < 1e-8);
  assert.ok(Math.abs(after.y - before.y + 45) < 1e-8);
  const ratio = v.scale / v.fit;
  v.resize(800, 600, 816);
  assert.equal(v.scale / v.fit, ratio);
  v.zoom(1e9);
  assert.equal(v.scale, v.fit * 24);
  v.zoom(1e-9);
  assert.equal(v.scale, v.fit / 2);
});

test("server provides an identity-checked navigation atlas without city geometry or dynamic state", async () => {
  const city = emptyCity({ seed: 42, airport: { x: 640, z: -640, w: 220, d: 220 } });
  city.roads = [
    { x: 0, z: 0, ax: -100, az: 0, bx: 100, bz: 0, width: 18, kind: "avenue" },
  ];
  city.buildings = [{ x: 10, z: 20, w: 20, d: 20, h: 100, color: "#aabbcc", style: 0 }];
  city.landmarks = [{ x: 10, z: 20, name: "City tower", kind: "tower" }];
  const store = new CityStore(city),
    server = http.createServer((req, res) => store.serve(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing server address");
    const base = `http://127.0.0.1:${address.port}/city/atlas/`;
    const response = await fetch(base + store.manifest.mapId),
      raw = await response.json(),
      atlas = cityAtlasSchema.parse(raw);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(atlas.mapId, store.manifest.mapId);
    assert.deepEqual(atlas.roads, [{ ax: -100, az: 0, bx: 100, bz: 0, width: 18 }]);
    assert.deepEqual(atlas.landmarks, city.landmarks);
    assert.equal("buildings" in raw, false);
    assert.equal("entities" in raw, false);
    assert.equal((await fetch(base + "0".repeat(64))).status, 409);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
