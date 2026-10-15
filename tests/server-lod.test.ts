import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { contactRange, speedLimit } from "../shared/physics/index.ts";
import { TUNING } from "../shared/catalog.ts";
import type { Entity } from "../shared/world.ts";

const world = () => {
  const s = new Simulation(generateCity());
  s.entities.clear();
  s.city.props = [];
  s.city.buildings = [];
  s.inventory.pickups.clear();
  return s;
};
const distant = (s: Simulation) =>
  (s as unknown as { distantAi(): Set<Entity> }).distantAi();
const run = (s: Simulation, ticks: number) => {
  for (let i = 0; i < ticks; i++) s.tick(TUNING.tick);
};

test("AI bodies are distant only beyond the contact range of every human", () => {
  const s = world();
  const human = s.join("Walker", "#ffffff");
  human.x = human.z = 0;
  const walker = speedLimit(human);
  const ped = s.spawn("pedestrian", 0, 0),
    sedan = s.spawn("car", 0, 0);
  ped.ai = sedan.ai = true;
  const pedRange = Math.max(s.lodFloor, contactRange(walker, speedLimit(ped))),
    carRange = Math.max(s.lodFloor, contactRange(walker, speedLimit(sedan)));
  assert.ok(carRange > pedRange, "a fast car can reach a walker from further away");
  const place = (e: Entity, metres: number) => {
    e.x = metres;
    e.z = 0;
  };
  place(ped, pedRange * 0.9);
  place(sedan, carRange * 0.9);
  assert.equal(distant(s).size, 0, "within reach, both keep full-rate physics");
  place(ped, pedRange * 1.1);
  assert.deepEqual(
    [...distant(s)],
    [ped],
    "the pedestrian is out of reach, the car is not",
  );
  place(sedan, carRange * 1.1);
  assert.equal(distant(s).size, 2);

  // Driving fast stretches the zone: the same distances now reach both.
  const car = s.spawn("car", 0, 0, undefined, "sport");
  car.driver = human.id;
  human.vehicle = car.id;
  car.vx = 0;
  car.vz = 50;
  const driving = Math.max(
    s.lodFloor,
    contactRange(speedLimit(car), speedLimit(sedan)),
  );
  assert.ok(driving > carRange * 1.5, "a fast driver reaches much further");
  place(sedan, driving * 0.9);
  car.x = car.z = 0;
  assert.ok(!distant(s).has(sedan), "traffic in the path of a fast car is not distant");
  place(sedan, driving * 1.1);
  assert.ok(distant(s).has(sedan));
});

test("only AI bodies can be distant, and nobody is distant without the switch or near a human", () => {
  const s = world();
  const human = s.join("A", "#ffffff");
  human.x = human.z = 0;
  const pushed = s.spawn("car", 1000, 0),
    driven = s.spawn("car", 1000, 100),
    npc = s.spawn("pedestrian", 1000, 200),
    wreck = s.spawn("car", 1000, 300);
  npc.ai = wreck.ai = driven.ai = true;
  driven.driver = "someone";
  wreck.wreck = 100;
  assert.deepEqual(
    [...distant(s)],
    [npc],
    "pushed, driven and wrecked bodies keep full rate",
  );
  assert.ok(!distant(s).has(pushed));
  s.lod = false;
  assert.equal(distant(s).size, 0, "the switch turns the whole mechanism off");
  s.lod = true;
  human.x = 1000;
  human.z = 200;
  assert.equal(distant(s).size, 0, "a human arriving makes it full rate again");
  s.entities.delete(human.id);
  assert.deepEqual(
    [...distant(s)],
    [npc],
    "with nobody connected only AI bodies are distant",
  );
});

test("a body within a human's reach is simulated exactly as before", () => {
  // Nothing a player can touch or see changes: the distant path must never apply here.
  const trajectory = (lod: boolean) => {
    const s = world();
    s.lod = lod;
    const human = s.join("A", "#ffffff");
    human.x = human.z = 0;
    const ped = s.spawn("pedestrian", 20, 0),
      car = s.spawn("car", -30, 10);
    ped.ai = car.ai = true;
    s.ai.pedestrian = () => ({ x: 1, z: 0.3, sprint: false });
    s.ai.car = () => ({ throttle: 1, steer: 0.2, brake: false });
    const out: number[] = [];
    for (let i = 0; i < 90; i++) {
      s.tick(TUNING.tick);
      out.push(ped.x, ped.z, ped.vx, car.x, car.z, car.angle, car.vx, car.vz);
    }
    return out;
  };
  assert.deepEqual(trajectory(true), trajectory(false));
});

test("a distant body integrates every other tick and lands where the full-rate path does", () => {
  const trajectory = (lod: boolean) => {
    const s = world();
    s.lod = lod;
    const ped = s.spawn("pedestrian", 900, 900),
      car = s.spawn("car", 900, 800);
    ped.ai = car.ai = true;
    s.ai.pedestrian = () => ({ x: 1, z: 0.4, sprint: false });
    s.ai.car = () => ({ throttle: 1, steer: 0.15, brake: false });
    // Over two ticks a distant body takes exactly one step covering both.
    run(s, 2);
    const first = { ped: ped.x, car: car.z };
    run(s, 28 * 5);
    return { first, ped, car, tick: distant(s).size };
  };
  const full = trajectory(false),
    coarse = trajectory(true);
  assert.equal(full.tick, 0);
  assert.equal(coarse.tick, 2, "both are distant: nobody is connected");
  // One 1/15 s Euler step toward (1, 0.4): speed gains acceleration * dt, then position moves.
  // Its speed gains acceleration * dt, capped at the AI walking speed, then the
  // position moves once at that speed.
  const dt = 2 * TUNING.tick,
    walk = Math.hypot(coarse.ped.vx, coarse.ped.vz),
    single = (Math.min(TUNING.acceleration * dt, walk) * dt) / Math.hypot(1, 0.4);
  assert.ok(
    Math.abs(coarse.first.ped - 900 - single) < 1e-9,
    `a single step moved ${coarse.first.ped - 900}, expected ${single}`,
  );
  assert.ok(
    Math.abs(full.first.ped - 900 - single) > 0.005,
    "the full-rate path takes four smaller substeps instead",
  );
  // Over five seconds the difference is a few centimetres: invisible and far from anyone.
  assert.ok(
    Math.hypot(coarse.ped.x - full.ped.x, coarse.ped.z - full.ped.z) < 0.1,
    `pedestrian drift ${Math.hypot(coarse.ped.x - full.ped.x, coarse.ped.z - full.ped.z)}`,
  );
  const driven = Math.hypot(full.car.x - 900, full.car.z - 800);
  assert.ok(driven > 20, `the car really drove: ${driven}`);
  assert.ok(
    Math.hypot(coarse.car.x - full.car.x, coarse.car.z - full.car.z) < driven * 0.03,
    `car drift ${Math.hypot(coarse.car.x - full.car.x, coarse.car.z - full.car.z)} of ${driven}`,
  );
  assert.ok(Math.abs(coarse.car.angle - full.car.angle) < 0.1, "heading agrees");
});

test("distant pedestrians re-plan every fourth tick with the real elapsed time", () => {
  const plans = (distantWorld: boolean) => {
    const s = world();
    const peds = Array.from({ length: 8 }, (_, i) => {
      const p = s.spawn("pedestrian", 800 + i * 3, 800);
      p.ai = true;
      return p;
    });
    if (!distantWorld) {
      const human = s.join("A", "#ffffff");
      human.x = 800;
      human.z = 800;
    }
    const log = new Map<string, number[]>();
    s.ai.pedestrian = (e: Entity, _n: Entity[], dt: number) => {
      log.set(e.id, [...(log.get(e.id) ?? []), dt]);
      return { x: 1, z: 0, sprint: false };
    };
    run(s, 120);
    return { peds, log };
  };
  const near = plans(false),
    far = plans(true);
  for (const p of near.peds)
    assert.equal(near.log.get(p.id)!.length, 120, "near pedestrians decide every tick");
  const counts = far.peds.map((p) => far.log.get(p.id)!.length);
  for (const [i, p] of far.peds.entries()) {
    assert.ok(counts[i] >= 29 && counts[i] <= 31, `${counts[i]} plans in 120 ticks`);
    const elapsed = far.log.get(p.id)!.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(elapsed - 4) < 0.15, `plans cover real time: ${elapsed}`);
  }
  // Staggered by id, so the work spreads over the four ticks rather than bunching.
  const perTick = new Map<number, number>();
  const s = world();
  const phases = new Set<number>();
  for (let i = 0; i < 40; i++) {
    const p = s.spawn("pedestrian", 800 + i, 800);
    p.ai = true;
    let h = 0;
    for (let c = 0; c < p.id.length; c++) h = (h * 31 + p.id.charCodeAt(c)) % 4;
    phases.add(h);
    perTick.set(h, (perTick.get(h) ?? 0) + 1);
  }
  assert.equal(phases.size, 4, "all four phases are used");
  assert.ok(Math.max(...perTick.values()) <= 16, "no phase carries most of the work");
});

test("a distant pedestrian never repeats an attack from a cached plan", () => {
  const s = world();
  const ped = s.spawn("pedestrian", 900, 900);
  ped.ai = true;
  let attacks = 0;
  s.attack = () => {
    attacks++;
  };
  s.ai.pedestrian = () => ({ x: 1, z: 0, sprint: false, attack: 1 });
  run(s, 40);
  assert.ok(
    attacks <= 10 + 1,
    `an attack is only issued when the plan is renewed: ${attacks}`,
  );
});

test("distant bodies keep real-time timers: fires burn out and cooldowns expire", () => {
  const s = world();
  const car = s.spawn("car", 900, 900),
    ped = s.spawn("pedestrian", 900, 800);
  car.ai = ped.ai = true;
  s.ai.car = () => ({ throttle: 0, steer: 0, brake: true });
  s.ai.pedestrian = () => ({ x: 0, z: 0, sprint: false });
  car.burning = 0.5;
  ped.cooldown = 1;
  run(s, 13);
  assert.equal(car.wreck, undefined, "still burning before half a second");
  assert.ok(ped.cooldown > 0.5);
  run(s, 4);
  assert.ok(car.wreck !== undefined, "burned out and exploded on schedule");
  run(s, 20);
  assert.equal(ped.cooldown, 0, "a second of cooldown elapsed in a second of ticks");
  assert.ok(
    s.drainEvents().some((e) => e.kind === "explosion"),
    "the explosion was reported",
  );
});
