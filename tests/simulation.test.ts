import { roadIntersectsBox } from "../shared/roads.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import { idle, signal } from "../shared/world.ts";
import { generateCity } from "../scripts/city-generator.ts";
function empty() {
  const s = new Simulation(generateCity());
  s.entities.clear();
  s.city.props = [];
  s.ai.props = [];
  s.city.buildings = [];
  return s;
}
test("city generation is deterministic and keeps buildings off roads", () => {
  assert.deepEqual(generateCity(42), generateCity(42));
  assert.notDeepEqual(generateCity(42), generateCity(43));
  const city = generateCity();
  for (const b of city.buildings)
    for (const road of city.roads) assert.ok(!roadIntersectsBox(road, b));
});
test("traffic phases never give both directions green", () => {
  for (let t = 0; t < 36; t += 0.1)
    assert.ok(!(signal(t, "x") === "green" && signal(t, "z") === "green"));
});
test("starting player can leave spawn without being trapped by a building", () => {
  const s = new Simulation(generateCity());
  const p = s.join("Spawn check", "#ffffff");
  assert.equal(s.blocked(p.x, p.z), false);
  s.inputs.set(p.id, { ...idle(), left: true });
  for (let i = 0; i < 30; i++) s.tick(1 / 30);
  assert.ok(p.x < 8);
});
test("walking is normalized and building collisions prevent penetration", () => {
  const s = empty(),
    p = s.join("A", "#ffffff");
  p.x = 0;
  p.z = 0;
  s.inputs.set(p.id, { ...idle(), right: true, down: true });
  s.tick(1 / 30);
  assert.ok(Math.hypot(p.vx, p.vz) > 0 && Math.hypot(p.vx, p.vz) < 4.5);
  for (let i = 0; i < 10; i++) s.tick(1 / 30);
  assert.ok(Math.abs(Math.hypot(p.vx, p.vz) - 4.5) < 0.001);
  s.city.buildings = [{ x: 2, z: 0, w: 2, d: 4, h: 10, color: "#fff", style: 0 }];
  p.x = 0;
  p.z = 0;
  s.inputs.set(p.id, { ...idle(), right: true });
  for (let i = 0; i < 60; i++) s.tick(1 / 30);
  // The controller has a 0.42 m half-width. Check the body against the wall face.
  assert.ok(p.x + 0.42 <= 1.004);
});
test("driver ownership is exclusive while passengers share the vehicle", () => {
  const s = empty(),
    a = s.join("A", "#ffffff"),
    b = s.join("B", "#ffffff");
  const car = s.spawn("car", a.x + 1, a.z);
  b.x = a.x;
  b.z = a.z;
  s.interact(a.id);
  s.interact(b.id);
  assert.equal(a.vehicle, car.id);
  assert.equal(b.vehicle, car.id);
  assert.equal(car.driver, a.id);
  assert.equal(a.seat, 0);
  assert.equal(b.seat, 1);
  s.leave(a.id);
  assert.equal(car.driver, undefined);
  assert.equal(car.seats?.[0], null);
  assert.equal(car.seats?.[1], b.id);
  assert.equal(b.vehicle, car.id);
});
test("handbrake preserves more sideways slide than normal tyres", () => {
  const run = (brake: boolean) => {
    const s = empty(),
      p = s.join("A", "#ffffff"),
      v = s.spawn("car", 0, 0);
    p.vehicle = v.id;
    v.driver = p.id;
    v.vx = 10;
    v.vz = 10;
    s.inputs.set(p.id, { ...idle(), brake });
    s.tick(1 / 30);
    return Math.abs(v.vx);
  };
  assert.ok(run(true) > run(false));
});
test("aircraft altitude and automatic parachute exit are authoritative", () => {
  const s = empty(),
    p = s.join("A", "#fff"),
    v = s.spawn("helicopter", p.x, p.z);
  s.interact(p.id);
  s.inputs.set(p.id, { ...idle(), ascend: true });
  for (let i = 0; i < 90; i++) s.tick(1 / 30);
  assert.ok(v.y > 8);
  s.interact(p.id);
  assert.equal(p.vehicle, undefined);
  assert.equal(p.parachute, true);
  assert.equal(p.y, v.y);
  assert.equal(v.driver, undefined);
  assert.equal(v.flight, "falling");
});
test("combat uses range, cooldown, health and recovery", () => {
  const s = empty(),
    a = s.join("A", "#fff"),
    b = s.join("B", "#fff");
  a.x = 0;
  a.z = 0;
  b.x = 0;
  b.z = 1.5;
  s.attack(a);
  assert.equal(b.health, 80);
  s.attack(a);
  assert.equal(b.health, 80);
  a.cooldown = 0;
  b.z = 20;
  s.attack(a);
  assert.equal(b.health, 80);
  a.cooldown = 0;
  s.inventory.give(a, "pistol");
  s.attack(a);
  assert.equal(b.health, 55);
});
test("jump ramps launch fast cars and gravity lands them", () => {
  const s = empty(),
    v = s.spawn("car", 3.5, 86);
  v.vz = 20;
  for (let i = 0; i < 25; i++) s.tick(1 / 30);
  assert.ok(v.y > 1.6);
  for (let i = 0; i < 100; i++) s.tick(1 / 30);
  assert.equal(v.y, 0);
});
