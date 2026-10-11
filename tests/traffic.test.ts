import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import { TRAFFIC } from "../server/traffic.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { VEHICLES } from "../shared/catalog.ts";
import { LIMIT, signal } from "../shared/world.ts";
import { contact, entityBox } from "../shared/physics/collision.ts";

function fixture(count = 6) {
  const sim = new Simulation(generateCity());
  sim.entities.clear();
  sim.ai.routes.clear();
  const cars = Array.from({ length: count }, (_, i) => {
    const car = sim.spawn("car", 3.5, 20 + i * 6, undefined, i % 2 ? "van" : "sport");
    sim.ai.assignCar(car, 24, 25, 0.5, i);
    car.x = 3.5;
    car.z = 20 + i * 6;
    return car;
  });
  const sample = (time: number) => {
    sim.time = time;
    return sim.traffic.update(sim);
  };
  return { sim, cars, sample };
}

test("persistent connected jams lose one AI car per cooldown, not a whole queue", () => {
  const { sim, cars, sample } = fixture();
  sample(0);
  sample(TRAFFIC.jamSeconds - 1);
  assert.equal(sim.entities.size, cars.length);
  sample(TRAFFIC.jamSeconds);
  assert.equal(sim.entities.size, cars.length - 1);
  assert.equal(sim.traffic.diagnostics.jamCount, 1);
  assert.equal(sim.traffic.diagnostics.jammedCars, cars.length);
  assert.equal(sim.traffic.diagnostics.pendingRespawns, 1);
  sample(TRAFFIC.jamSeconds + TRAFFIC.despawnSeconds - 1);
  assert.equal(sim.entities.size, cars.length - 1);
  sample(TRAFFIC.jamSeconds + TRAFFIC.despawnSeconds);
  assert.equal(sim.entities.size, cars.length - 2);
  for (const car of cars)
    if (!sim.entities.has(car.id)) assert.equal(sim.ai.routes.has(car.id), false);
});

test("normal signal queues and moving traffic never accumulate persistent gridlock", () => {
  const { sim, cars, sample } = fixture();
  for (let time = 0; time <= 90; time++) {
    if (signal(time, "z") === "green") for (const car of cars) car.z += 4;
    sample(time);
  }
  assert.equal(sim.traffic.diagnostics.despawned, 0);
  assert.equal(sim.traffic.diagnostics.jamCount, 0);
  assert.equal(sim.entities.size, cars.length);
});

test("two-car gridlock is relieved and meaningful progress cancels further cleanup", () => {
  const pair = fixture(2);
  pair.sample(0);
  pair.sample(30);
  assert.equal(pair.sim.traffic.diagnostics.despawned, 1);
  pair.sample(35);
  assert.equal(
    pair.sim.traffic.diagnostics.despawned,
    1,
    "a lone stopped car is preserved",
  );
  const jam = fixture();
  jam.sample(0);
  jam.sample(30);
  for (const car of jam.cars) car.z += 4;
  jam.sample(31);
  jam.sample(35);
  assert.equal(jam.sim.traffic.diagnostics.despawned, 1);
  assert.equal(jam.sim.traffic.diagnostics.jamCount, 0);
});

test("nearby unrelated cars are not a jam, but small recovery wiggles cannot hide one", () => {
  const isolated = fixture(2);
  isolated.cars[1].x = 100;
  for (let time = 0; time <= 60; time++) isolated.sample(time);
  assert.equal(isolated.sim.traffic.diagnostics.despawned, 0);

  const jam = fixture();
  for (let time = 0; time <= 31; time++) {
    for (const car of jam.cars) {
      car.x = 3.5 + Math.sin(time) * 0.5;
      car.vx = 0.5 * Math.cos(time);
    }
    jam.sample(time);
  }
  assert.equal(jam.sim.traffic.diagnostics.despawned, 1);
});

test("jam cleanup preserves player cars, all passengers, burning cars and wrecks", () => {
  const { sim, cars, sample } = fixture(7);
  cars[0].ai = false;
  cars[1].driver = "driver";
  cars[2].seats![1] = "passenger";
  const rider = sim.spawn("player", cars[3].x, cars[3].z);
  rider.vehicle = cars[3].id;
  cars[4].burning = 3;
  cars[5].wreck = 15;
  sample(0);
  sample(30);
  assert.equal(sim.entities.has(cars[6].id), false);
  for (const car of cars.slice(0, 6)) assert.equal(sim.entities.has(car.id), true);
  sample(35);
  assert.equal(sim.traffic.diagnostics.despawned, 1);
  assert.equal(rider.vehicle, cars[3].id);
});

test("delayed replacements use clear lanes away from players and retain their model", () => {
  const { sim, cars, sample } = fixture();
  const player = sim.join("Observer", "#fff");
  player.x = -192;
  player.z = -170;
  sample(0);
  sample(30);
  const removed = cars.find((car) => !sim.entities.has(car.id))!;
  sample(39);
  assert.equal(sim.traffic.diagnostics.respawned, 0);
  const before = new Set(sim.entities.keys());
  sample(40);
  const replacement = [...sim.entities.values()].find((e) => !before.has(e.id))!;
  assert.ok(replacement && replacement.ai);
  assert.equal(replacement.model, removed.model);
  assert.equal(replacement.color, removed.color);
  assert.ok(sim.ai.routes.has(replacement.id));
  assert.ok(
    Math.hypot(player.x - replacement.x, player.z - replacement.z) >=
      TRAFFIC.spawnPlayerDistance,
  );
  assert.equal(
    sim.blocked(
      replacement.x,
      replacement.z,
      VEHICLES[replacement.model!].length / 2 + 1,
    ),
    false,
  );
  for (const e of sim.entities.values())
    if (e.id !== replacement.id && !e.vehicle && e.y < 2)
      assert.ok(
        Math.hypot(e.x - replacement.x, e.z - replacement.z) >=
          TRAFFIC.spawnCarDistance,
      );
  assert.equal(sim.traffic.diagnostics.respawned, 1);
  sample(41);
  assert.equal(sim.traffic.diagnostics.respawned, 1, "replacements are also paced");
});

test("blocked replacement sites are retried later without forced overlaps", () => {
  const { sim, sample } = fixture();
  sample(0);
  sample(30);
  sim.city.buildings = [
    { x: 0, z: 0, w: LIMIT * 2, d: LIMIT * 2, h: 12, color: "#fff", style: 0 },
  ];
  sample(40);
  assert.equal(sim.traffic.diagnostics.respawned, 0);
  assert.ok(sim.traffic.diagnostics.pendingRespawns > 0);
  sim.city.buildings = [];
  sample(41);
  assert.equal(sim.traffic.diagnostics.respawned, 1);
});

test("simulation cleanup and replacement immediately update snapshot spatial interest", () => {
  const { sim, cars } = fixture();
  sim.ai.car = () => ({ throttle: 0, steer: 0, brake: true });
  for (let i = 0; i < 32 * 30; i++) sim.tick(1 / 30);
  const removed = cars.find((car) => !sim.entities.has(car.id))!;
  assert.ok(removed);
  assert.equal(
    sim.spatial.query(removed.x, removed.z, 20).some((e) => e.id === removed.id),
    false,
  );
  for (let i = 0; i < 10 * 30; i++) sim.tick(1 / 30);
  const replacement = [...sim.entities.values()].find((e) => !cars.includes(e))!;
  assert.ok(replacement);
  assert.ok(sim.spatial.query(replacement.x, replacement.z, 1).includes(replacement));
  for (const other of sim.entities.values())
    if (
      other !== replacement &&
      !other.vehicle &&
      Math.abs(other.y - replacement.y) < 2
    )
      assert.equal(contact(entityBox(replacement), entityBox(other)), undefined);
});

test("an AI wreck joins the same delayed safe-replacement lifecycle", () => {
  const { sim, cars } = fixture(1);
  const wreck = cars[0];
  wreck.ai = false;
  wreck.wreck = 0.001;
  sim.tick(1 / 30);
  assert.equal(sim.entities.has(wreck.id), false);
  assert.equal(sim.traffic.diagnostics.pendingRespawns, 1);
  assert.equal(sim.entities.size, 0);
  for (let i = 0; i < 11 * 30; i++) sim.tick(1 / 30);
  const replacement = [...sim.entities.values()][0];
  assert.ok(replacement.ai);
  assert.equal(replacement.model, wreck.model);
  assert.equal(sim.traffic.diagnostics.pendingRespawns, 0);
});
