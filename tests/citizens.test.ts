import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import type { Personality } from "../server/citizens.ts";
import { emptyCity } from "../shared/city-stream.ts";
import type { Entity } from "../shared/world.ts";
import { destructibles } from "../shared/destruction.ts";

function setup() {
  const city = emptyCity({ seed: 713, airport: { x: 600, z: 600, w: 100, d: 100 } });
  city.roads = [
    { ax: 0, az: -100, bx: 0, bz: 100, x: 0, z: 0, width: 14, kind: "street" },
    { ax: 0, az: 100, bx: 100, bz: 100, x: 50, z: 100, width: 14, kind: "street" },
  ];
  city.buildings = [{ x: 25, z: 90, w: 8, d: 8, h: 8, color: "#fff", style: 0 }];
  city.parks = [{ x: 100, z: 90 }];
  const sim = new Simulation(city);
  sim.entities.clear();
  sim.ai.routes.clear();
  sim.inventory.sources = [];
  sim.inventory.pickups.clear();
  function person(x: number, z: number, personality: Personality) {
    const p = sim.spawn("pedestrian", x, z);
    sim.ai.assign(p, 0, false);
    sim.ai.citizens.state(p).personality = personality;
    return p;
  }
  function car(personality: Personality) {
    const c = sim.spawn("car", 0, 0);
    sim.ai.assignCar(c, 0, 1, 0.5, 0);
    sim.ai.citizens.state(c).personality = personality;
    return c;
  }
  function walk(p: Entity) {
    return sim.ai.pedestrian(
      p,
      [...sim.entities.values()],
      1 / 30,
      sim.time,
      sim.entities,
    );
  }
  function advance(seconds: number) {
    for (let i = 0; i < seconds * 30; i++) sim.tick(1 / 30);
  }
  return { sim, person, car, walk, advance };
}

test("pedestrians dodge a predicted collision sideways, including while waiting at a destination", () => {
  const { sim, person, car, walk } = setup();
  const p = person(3.5, 10, "calm"),
    v = car("calm");
  v.vz = 12;
  const dodge = walk(p);
  assert.equal(dodge.sprint, true);
  assert.ok(dodge.x > 0.9);
  assert.equal(Math.abs(dodge.z), 0);
  v.vz = -12;
  assert.equal(walk(p).sprint, false);
  v.vz = 0;
  assert.equal(walk(p).sprint, false);
  sim.time = 0;
});

test("witnesses flee or pursue the actual driver; distant and occluded pedestrians stay calm", () => {
  const { sim, person, car, walk } = setup();
  const driver = sim.join("Driver", "#fff"),
    v = car("calm");
  driver.vehicle = v.id;
  v.driver = driver.id;
  const victim = person(3.5, 2, "calm");
  const timid = person(8, 2, "timid");
  const angry = person(-5, 2, "aggressive");
  const distant = person(60, 2, "calm");
  const hidden = person(8, 12, "calm");
  sim.city.buildings.push({ x: 8, z: 7, w: 6, d: 2, h: 8, color: "#fff", style: 0 });
  sim.damage(victim, 10, v);
  assert.equal(walk(timid).sprint, true);
  assert.ok(walk(timid).x > 0);
  const fight = sim.ai.citizens.reaction(angry, sim.time);
  assert.equal(fight.kind, "fight");
  if (fight.kind === "fight") assert.equal(fight.target.id, driver.id);
  assert.equal(walk(distant).sprint, false);
  assert.equal(walk(hidden).sprint, false);
});

test("aggressive victims retaliate through normal melee damage and stop when the target dies", () => {
  const { sim, person, advance } = setup();
  const angry = person(0, 0, "aggressive");
  const player = sim.join("Attacker", "#fff");
  player.x = 0;
  player.z = 1.6;
  player.angle = Math.PI;
  sim.attack(player);
  assert.equal(angry.health, 80);
  advance(0.1);
  assert.equal(player.health, 80);
  assert.ok(sim.drainEvents().some((event) => event.kind === "swing"));
  sim.damage(player, 999);
  advance(0.1);
  assert.equal(sim.ai.citizens.reaction(angry, sim.time).kind, "routine");
});

test("calm drivers continue and restless drivers flee faster while retaining lane control", () => {
  for (const personality of ["calm", "restless"] as const) {
    const { sim, car } = setup();
    const v = car(personality);
    v.vz = 8;
    sim.damage(v, 2);
    const drive = sim.ai.car(v, [v], sim.time, 1 / 30);
    assert.equal(v.ai, true);
    assert.equal(drive.steer, 0);
    if (personality === "calm") assert.ok((drive.serviceBrake ?? 0) > 0);
    else assert.ok(drive.throttle > 0);
    assert.equal(
      [...sim.entities.values()].filter((e) => e.kind === "pedestrian").length,
      0,
    );
  }
});

test("timid drivers stop, exit once, and flee; aggressive drivers exit and attack the culprit", () => {
  for (const personality of ["timid", "aggressive"] as const) {
    const { sim, car, advance } = setup();
    const v = car(personality);
    const culprit = sim.join("Culprit", "#fff");
    culprit.x = 8;
    culprit.z = 0;
    v.vz = 4;
    sim.damage(v, 2, culprit);
    sim.tick(1 / 30);
    assert.equal(
      [...sim.entities.values()].filter((e) => e.kind === "pedestrian").length,
      0,
    );
    advance(2);
    const pedestrians = [...sim.entities.values()].filter(
      (e) => e.kind === "pedestrian",
    );
    assert.equal(pedestrians.length, 1);
    const driver = pedestrians[0];
    assert.equal(v.ai, false);
    assert.equal(v.driver, undefined);
    assert.equal(driver.vehicle, undefined);
    assert.equal(sim.ai.citizens.state(driver).personality, personality);
    if (personality === "timid")
      assert.ok(Math.hypot(driver.x - v.x, driver.z - v.z) > 5);
    else {
      advance(2);
      assert.ok(culprit.health < 100);
    }
    assert.equal(
      [...sim.entities.values()].filter((e) => e.kind === "pedestrian").length,
      1,
    );
  }
});

test("blocked exits retry without leaving phantom people; burning and wrecked cars never spawn survivors", () => {
  const { sim, car, advance } = setup();
  const people = () =>
    [...sim.entities.values()].filter((e) => e.kind === "pedestrian").length;
  const v = car("timid");
  for (const x of [v.x - 3, v.x + 3])
    sim.city.buildings.push({ x, z: 0, w: 1, d: 8, h: 8, color: "#fff", style: 0 });
  sim.damage(v, 2);
  advance(1);
  assert.equal(people(), 0);
  assert.equal(v.ai, true);
  sim.city.buildings = [];
  advance(1);
  assert.equal(people(), 1);
  // Nobody can see the abandoned car, so traffic clears it and queues a replacement.
  advance(1);
  assert.equal(sim.entities.has(v.id), false);
  assert.equal(sim.traffic.diagnostics.pendingRespawns, 1);
  for (const wrecked of [false, true]) {
    const other = car("timid");
    sim.damage(other, 999);
    if (wrecked) other.wreck = 30;
    const count = people();
    advance(0.1);
    assert.equal(people(), count);
  }
});

test("a real rear-end collision blames the approaching car's driver, not the stationary victim", () => {
  const { sim, car } = setup();
  const victim = car("aggressive");
  victim.z = 4.2;
  const rear = sim.spawn("car", 3.5, 0);
  const player = sim.join("Rear driver", "#fff");
  rear.driver = player.id;
  player.vehicle = rear.id;
  rear.vz = 8;
  sim.tick(1 / 120);
  assert.ok(victim.health < victim.maxHealth!);
  const reaction = sim.ai.citizens.reaction(victim, sim.time);
  assert.equal(reaction.kind, "exit");
  if (reaction.kind === "exit") {
    assert.equal(reaction.next.kind, "fight");
    if (reaction.next.kind === "fight")
      assert.equal(reaction.next.target.id, player.id);
  }
});

test("citizens visit reachable home, work and leisure stops, pause there and resume after fleeing", () => {
  const { sim, person, walk } = setup();
  const p = person(9, -100, "calm");
  const home = { x: p.x, z: p.z };
  assert.equal(walk(p).x, 0);
  assert.equal(walk(p).z, 0);
  sim.time = 12;
  assert.equal(walk(p).sprint, false);
  let route = sim.ai.routes.get(p.id)!;
  assert.ok(route.points.length > 0);
  assert.notDeepEqual(route.points.at(-1), home);
  const destinations = [];
  for (let stop = 0; stop < 3; stop++) {
    for (let steps = 0; steps < 30 && !route.routine?.waiting; steps++) {
      const point = route.points[route.index];
      p.x = point.x;
      p.z = point.z;
      walk(p);
    }
    destinations.push({ x: p.x, z: p.z });
    assert.equal(route.routine?.waiting, true);
    sim.time += 12;
    walk(p);
  }
  assert.deepEqual(destinations[2], home);
  assert.notDeepEqual(destinations[0], destinations[1]);
  sim.damage(p, 1);
  assert.equal(walk(p).sprint, true);
  p.x = 12;
  p.z = 5;
  sim.time += 11;
  assert.equal(walk(p).sprint, false);
  route = sim.ai.routes.get(p.id)!;
  assert.equal(route.reacting, false);
  assert.ok(route.points.length > 0);
});

test("rare ambient impulses produce both short runs and NPC fights, with a cooldown", () => {
  const { sim, person, walk } = setup();
  const actor = person(0, 0, "aggressive");
  const target = person(0, 1.6, "calm");
  const state = sim.ai.citizens.state(actor);
  let runs = 0,
    fights = 0;
  for (let i = 0; i < 1000; i++) {
    sim.time = i * 200;
    state.reaction = { kind: "routine" };
    state.nextImpulse = sim.time;
    const intent = walk(actor);
    const kind = sim.ai.citizens.reaction(actor, sim.time).kind;
    if (kind === "run") runs++;
    if (kind === "fight") {
      fights++;
      assert.equal(intent.attack, 0);
      actor.angle = intent.attack!;
      actor.cooldown = 0;
      target.health = 100;
      target.down = 0;
      sim.attack(actor);
      assert.equal(target.health, 80);
    }
    assert.ok(state.nextImpulse >= sim.time + 60);
  }
  assert.ok(runs > 0 && runs < 60, `runs: ${runs}`);
  assert.ok(fights > 0 && fights < 40, `fights: ${fights}`);
});

test("a chase routes around buildings and stealing a stopped car puts its former driver on foot", () => {
  const { sim, person, car, walk, advance } = setup();
  const pursuer = person(-9, 0, "aggressive");
  const target = sim.join("Target", "#fff");
  target.x = 9;
  target.z = 0;
  sim.damage(pursuer, 1, target);
  sim.city.buildings.push({ x: 0, z: 0, w: 6, d: 12, h: 8, color: "#fff", style: 0 });
  // Only the building may deflect the chase, not the kerbside weapon crate.
  for (const p of destructibles(sim.city))
    if (p.kind === "crate")
      sim.destruction.hit(p.id, 1000, sim.time, { x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(walk(pursuer).z) > 0.9);
  advance(1);
  assert.ok(Math.abs(pursuer.z) > 1);
  assert.ok(pursuer.x < -3.4);

  sim.entities.clear();
  sim.city.buildings = [];
  const v = car("timid");
  const player = sim.join("New driver", "#fff");
  player.x = v.x + 3;
  player.z = v.z;
  sim.damage(v, 2);
  sim.interact(player.id);
  advance(1);
  assert.equal(v.driver, player.id);
  assert.equal(player.vehicle, v.id);
  assert.equal(v.ai, false);
  assert.equal(sim.entities.size, 3);
  const formerDriver = [...sim.entities.values()].find((e) => e.kind === "pedestrian");
  assert.ok(formerDriver);
  assert.equal(formerDriver.ai, true);
  assert.equal(formerDriver.vehicle, undefined);
});

test("taking an AI car puts its driver on foot only once", () => {
  const { sim, car } = setup();
  const v = car("calm");
  const player = sim.join("Driver", "#fff");
  player.x = v.x;
  player.z = v.z;
  sim.interact(player.id);
  assert.equal(v.driver, player.id);
  const pedestrians = () =>
    [...sim.entities.values()].filter((e) => e.kind === "pedestrian");
  assert.equal(pedestrians().length, 1);
  assert.equal(pedestrians()[0].vehicle, undefined);
  assert.ok(Math.hypot(pedestrians()[0].x - v.x, pedestrians()[0].z - v.z) >= 3);
  sim.interact(player.id);
  player.x = v.x;
  player.z = v.z;
  sim.interact(player.id);
  assert.equal(v.driver, player.id);
  assert.equal(pedestrians().length, 1);
});
