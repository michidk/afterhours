import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import { TRAFFIC } from "../server/traffic.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { VEHICLES } from "../shared/catalog.ts";
import { LIMIT } from "../shared/world.ts";

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

test("blocked traffic honks after a delay, repeats at a bounded rate and never despawns", () => {
  const { sim, cars, sample } = fixture();
  sample(0);
  sample(7);
  assert.equal(sim.events.length, 0);
  sample(8);
  assert.equal(sim.events.length, 6);
  assert.ok(
    sim.events.every((event) => event.kind === "horn" && event.sound === "horn"),
  );
  sample(13);
  assert.equal(sim.events.length, 6);
  sample(14);
  assert.equal(sim.events.length, 12);
  for (let time = 15; time <= 600; time++) sample(time);
  assert.deepEqual(
    [...sim.entities.keys()],
    cars.map((car) => car.id),
  );
  assert.ok(cars.every((car) => sim.ai.routes.has(car.id)));
  assert.equal(sim.traffic.diagnostics.jamCount, 1);
  assert.equal(sim.traffic.diagnostics.jammedCars, 6);
  assert.equal(sim.traffic.diagnostics.pendingRespawns, 0);
  sim.destruction.dispose();
});

test("a lone blocked car honks, movement resets its delay, and red signals stay quiet", () => {
  const {
    sim,
    cars: [car],
    sample,
  } = fixture(1);
  sample(0);
  sample(8);
  assert.equal(sim.traffic.diagnostics.honks, 1);
  car.z += 4;
  sample(9);
  sample(16);
  assert.equal(sim.traffic.diagnostics.honks, 1);
  sample(17);
  assert.equal(sim.traffic.diagnostics.honks, 2);
  sim.ai.routes.get(car.id)!.waitingAtSignal = true;
  for (let time = 18; time <= 60; time++) sample(time);
  assert.equal(sim.traffic.diagnostics.honks, 2);
  assert.equal(sim.traffic.diagnostics.jamCount, 0);
  sim.destruction.dispose();
});

test("normal moving traffic and parked or player-controlled cars never honk", () => {
  const { sim, cars, sample } = fixture();
  cars[1].ai = false;
  cars[2].driver = "driver";
  cars[3].burning = 3;
  cars[4].wreck = 180;
  sim.ai.routes.delete(cars[5].id);
  for (let time = 0; time <= 60; time++) {
    cars[0].z += 4;
    sample(time);
  }
  assert.equal(sim.traffic.diagnostics.honks, 0);
  assert.equal(sim.entities.size, 6);
  sim.destruction.dispose();
});

test("small recovery wiggles do not silence a blocked car and taking control cancels honks", () => {
  const {
    sim,
    cars: [car],
    sample,
  } = fixture(1);
  for (let time = 0; time <= 31; time++) {
    car.x = 3.5 + Math.sin(time) * 0.5;
    car.vx = 0.5 * Math.cos(time);
    sample(time);
  }
  assert.ok(sim.traffic.diagnostics.honks > 0);
  const before = sim.traffic.diagnostics.honks;
  car.ai = false;
  sample(60);
  assert.equal(sim.traffic.diagnostics.honks, before);
  assert.equal(sim.entities.get(car.id), car);
  sim.destruction.dispose();
});

test("expired AI wreck replacements use clear lanes away from players and retain their model", () => {
  const {
    sim,
    cars: [wreck],
    sample,
  } = fixture(1);
  const player = sim.join("Observer", "#fff");
  player.x = -192;
  player.z = -170;
  wreck.ai = false;
  wreck.wreck = 0.001;
  sim.tick(1 / 30);
  assert.equal(sim.entities.has(wreck.id), false);
  assert.equal(sim.traffic.diagnostics.pendingRespawns, 1);
  sample(9);
  assert.equal(sim.traffic.diagnostics.respawned, 0);
  const before = new Set(sim.entities.keys());
  sample(11);
  const replacement = [...sim.entities.values()].find((e) => !before.has(e.id))!;
  assert.ok(replacement?.ai);
  assert.equal(replacement.model, wreck.model);
  assert.equal(replacement.color, wreck.color);
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
    if (e !== replacement && !e.vehicle && e.y < 2)
      assert.ok(
        Math.hypot(e.x - replacement.x, e.z - replacement.z) >=
          TRAFFIC.spawnCarDistance,
      );
  assert.equal(sim.traffic.diagnostics.pendingRespawns, 0);
  sim.destruction.dispose();
});

test("blocked wreck replacement sites retry later, and new cars enter spatial interest", () => {
  const {
    sim,
    cars: [wreck],
  } = fixture(1);
  wreck.wreck = 0.001;
  sim.city.buildings = [
    { x: 0, z: 0, w: LIMIT * 2, d: LIMIT * 2, h: 12, color: "#fff", style: 0 },
  ];
  sim.tick(1 / 30);
  sim.time = 11;
  sim.tick(1 / 30);
  assert.equal(sim.entities.size, 0);
  assert.equal(sim.traffic.diagnostics.pendingRespawns, 1);
  sim.city.buildings = [];
  sim.time = 13;
  sim.tick(1 / 30);
  const replacement = [...sim.entities.values()][0];
  assert.ok(replacement?.ai);
  assert.ok(sim.spatial.query(replacement.x, replacement.z, 1).includes(replacement));
  sim.destruction.dispose();
});

test("blocked cars honk on elevated terrain, while airborne cars stay quiet", () => {
  const { sim, cars, sample } = fixture(2);
  assert.ok(sim.city.terrain);
  sim.city.terrain.heights.fill(10);
  cars[0].y = 10;
  cars[1].y = 15;
  sample(0);
  sample(8);
  assert.equal(sim.traffic.diagnostics.honks, 1);
  assert.equal(sim.events[0].y, 11);
  assert.equal(sim.entities.size, 2);
  sim.destruction.dispose();
});

test("repeated driver exits replace citizens instead of growing the population", () => {
  const { sim, cars, sample } = fixture(1);
  let car = cars[0];
  for (let cycle = 0; cycle < 20; cycle++) {
    sim.ai.citizens.state(car).personality = "timid";
    sim.damage(car, 2);
    // Nobody is near, so the car is distant and moves on every other tick.
    sim.tick(1 / 30);
    sim.tick(1 / 30);
    const person = [...sim.entities.values()].find((e) => e.kind === "pedestrian");
    assert.ok(person, "a damaged timid driver exits");
    assert.ok(sim.ai.routes.has(person.id));
    sample(sim.time + 20);
    assert.equal(sim.entities.has(person.id), false);
    assert.equal(sim.ai.routes.has(person.id), false);
    assert.equal(sim.entities.size, 1);
    assert.equal(sim.ai.routes.size, 1);
    const replacement = [...sim.entities.values()][0];
    assert.equal(replacement.kind, "car");
    assert.equal(replacement.ai, true);
    car = replacement;
  }
  assert.equal(sim.traffic.diagnostics.respawned, 20);
  sim.destruction.dispose();
});

test("drivers stay while reacting or visible and do not block expired wreck replacements", () => {
  const { sim, cars, sample } = fixture(2);
  const [car, wreck] = cars;
  sim.ai.citizens.state(car).personality = "timid";
  sim.damage(car, 2);
  sim.tick(1 / 30);
  const person = [...sim.entities.values()].find((e) => e.kind === "pedestrian");
  assert.ok(person);
  sample(11);
  assert.equal(sim.entities.has(person.id), true, "still fleeing");
  assert.equal(sim.traffic.diagnostics.respawned, 0);
  const observer = sim.join("Observer", "#fff");
  observer.x = person.x;
  observer.z = person.z;
  sim.entities.delete(wreck.id);
  sim.ai.routes.delete(wreck.id);
  sim.traffic.scheduleReplacement(wreck, 11);
  sample(22);
  assert.equal(sim.entities.has(person.id), true, "visible after calming down");
  assert.equal(sim.traffic.diagnostics.respawned, 1, "wreck is not blocked");
  assert.equal(sim.traffic.diagnostics.pendingRespawns, 1);
  observer.x = 1000;
  observer.z = 1000;
  sample(28);
  assert.equal(sim.entities.has(person.id), false);
  assert.equal(sim.traffic.diagnostics.pendingRespawns, 0);
  assert.equal(sim.traffic.diagnostics.respawned, 2);
  sim.destruction.dispose();
});

test("a retired driver remains until a safe replacement site exists", () => {
  const { sim, cars, sample } = fixture(1);
  sim.ai.citizens.state(cars[0]).personality = "timid";
  sim.damage(cars[0], 2);
  sim.tick(1 / 30);
  const person = [...sim.entities.values()].find((e) => e.kind === "pedestrian");
  assert.ok(person);
  sim.city.buildings = [
    { x: 0, z: 0, w: LIMIT * 2, d: LIMIT * 2, h: 12, color: "#fff", style: 0 },
  ];
  sample(20);
  assert.equal(sim.entities.has(person.id), true);
  assert.equal(sim.traffic.diagnostics.respawned, 0);
  sim.city.buildings = [];
  sample(21);
  assert.equal(sim.entities.has(person.id), false);
  assert.equal(sim.traffic.diagnostics.respawned, 1);
  sim.destruction.dispose();
});
