import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { idle } from "../shared/world.ts";
function setup() {
  const s = new Simulation(generateCity());
  s.entities.clear();
  s.city.buildings = [];
  s.city.props = [];
  const p = s.join("Shooter", "#ffffff");
  p.x = p.z = 0;
  p.angle = 0;
  s.inventory.give(p, "pistol");
  return { s, p };
}
test("hitscan uses footprints, stops at walls and consumes ammo even on a miss", () => {
  const { s, p } = setup(),
    target = s.spawn("pedestrian", 2, 15);
  s.attack(p);
  assert.equal(target.health, 100);
  assert.equal(s.inventory.equipped(p)?.ammo, 11);
  p.cooldown = 0;
  target.x = 0;
  s.city.buildings = [{ x: 0, z: 7, w: 10, d: 1, h: 8, color: "#ffffff", style: 0 }];
  s.attack(p);
  assert.equal(target.health, 100);
  p.cooldown = 0;
  s.city.buildings = [];
  s.attack(p);
  assert.equal(target.health, 75);
});
test("lag compensation rewinds moving targets, but never beyond 200 ms", () => {
  const { s, p } = setup(),
    target = s.join("Target", "#ffffff");
  target.x = 0;
  target.z = 15;
  s.inputs.set(target.id, { ...idle(), right: true });
  for (let i = 0; i < 6; i++) s.tick(1 / 30);
  assert.ok(target.x > 0.42);
  s.inputs.set(p.id, { ...idle(), shotTime: s.time - 0.16 });
  s.attack(p);
  assert.equal(target.health, 75);
  target.health = 100;
  p.cooldown = 0;
  for (let i = 0; i < 12; i++) s.tick(1 / 30);
  p.cooldown = 0;
  s.inputs.set(p.id, { ...idle(), shotTime: -999 });
  s.attack(p);
  assert.equal(target.health, 100);
});

test("missed melee attacks emit a swing and empty weapons emit rate-limited dry fire", () => {
  const { s, p } = setup();
  s.inventory.equip(p, 0);
  s.attack(p);
  assert.deepEqual(
    s.drainEvents().map((event) => event.sound),
    ["swing"],
  );
  p.cooldown = 0;
  s.inventory.equip(p, 1);
  const gun = s.inventory.equipped(p)!;
  gun.ammo = gun.reserve = 0;
  s.attack(p);
  s.attack(p);
  assert.deepEqual(
    s.drainEvents().map((event) => event.sound),
    ["dryFire"],
  );
  assert.equal(p.reloadUntil, undefined);
  p.cooldown = 0;
  gun.reserve = 12;
  s.attack(p);
  assert.ok(p.reloadUntil);
  assert.deepEqual(s.drainEvents(), []);
});
