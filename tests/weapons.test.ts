import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import { Inventory } from "../server/inventory.ts";
import { Grenades } from "../server/grenades.ts";
import { Destruction } from "../server/destruction.ts";
import { loadCity } from "../server/city-loader.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { emptyCity } from "../shared/city-stream.ts";
import { WEAPONS } from "../shared/catalog.ts";

function setup() {
  const city = generateCity();
  const s = new Simulation(city);
  s.entities.clear();
  s.inventory.pickups.clear();
  s.inventory.sources = [];
  city.buildings = [];
  city.props = [];
  city.parks = [];
  city.roads = [];
  const p = s.join("A", "#ffffff");
  p.x = p.z = 0;
  p.angle = 0;
  return { s, p };
}

test("ammo pickups work with full slots, preserve surplus and require compatible owned weapons", () => {
  const { s, p } = setup();
  for (const kind of ["pistol", "smg", "knife"] as const) s.inventory.give(p, kind);
  const handgun = p.inventory!.find((i) => i.kind === "pistol")!;
  handgun.reserve = 45;
  const pickup = s.inventory.spawnAmmo(0, 0, "handgun", 20, 0);
  assert.equal(s.inventory.pickup(p, 0), true);
  assert.equal(p.inventory!.length, 4);
  assert.equal(handgun.reserve, 48);
  assert.equal(pickup.kind === "ammo" && pickup.amount, 17);
  assert.equal(s.inventory.pickup(p, 0), false);
  assert.ok(s.inventory.pickups.has(pickup.id));
  s.inventory.pickups.clear();
  const rifle = s.inventory.spawnAmmo(0, 0, "rifle", 60, 0);
  assert.equal(s.inventory.pickup(p, 0), false);
  assert.ok(s.inventory.pickups.has(rifle.id));
  assert.equal(p.inventory!.length, 4);
});

test("jetpacks equip independently, active pack drops conserve fuel, and death resets equipment", () => {
  const { s, p } = setup();
  for (const kind of ["pistol", "smg", "knife"] as const) s.inventory.give(p, kind);
  s.inventory.spawnJetpack(0, 0, 12, 0);
  assert.equal(s.inventory.pickup(p, 0), true);
  assert.deepEqual(p.jetpack, { fuel: 12, active: false });
  p.jetpack!.active = true;
  p.jetpack!.fuel = 7;
  s.inventory.drop(p, 0);
  assert.equal(p.jetpack, undefined);
  const pack = [...s.inventory.pickups.values()][0];
  assert.equal(pack.kind === "jetpack" && pack.fuel, 7);
  assert.equal(s.inventory.pickup(p, 0), true);
  s.inventory.initialize(p);
  assert.equal(p.jetpack, undefined);
});

test("knife has distinct close melee and machine gun consumes ammo and reloads", () => {
  const { s, p } = setup();
  s.inventory.give(p, "knife");
  const near = s.spawn("pedestrian", 0, 1.5);
  s.attack(p);
  assert.equal(near.health, 65);
  p.cooldown = 0;
  near.z = 2;
  s.attack(p);
  assert.equal(near.health, 65);
  s.inventory.give(p, "machinegun");
  near.z = 50;
  p.cooldown = 0;
  s.attack(p);
  assert.equal(near.health, 46);
  const gun = s.inventory.equipped(p)!;
  assert.equal(gun.ammo, 59);
  gun.ammo = 0;
  p.cooldown = 0;
  s.attack(p);
  assert.equal(near.health, 46);
  assert.equal(p.reloadUntil, 3);
  s.inventory.tick(p, 3);
  assert.equal(gun.ammo, 60);
  assert.equal(gun.reserve, 120);
  assert.notEqual(WEAPONS.machinegun.cooldown, WEAPONS.smg.cooldown);
});

test("flame cone consumes fuel, damages multiple targets and is blocked by walls and props", () => {
  const { s, p } = setup();
  s.inventory.give(p, "flamethrower");
  const a = s.spawn("pedestrian", 0, 5),
    b = s.spawn("pedestrian", 1, 6),
    side = s.spawn("pedestrian", 5, 1);
  s.attack(p);
  assert.equal(a.health, 95);
  assert.equal(b.health, 95);
  assert.equal(side.health, 100);
  assert.equal(s.inventory.equipped(p)!.ammo, 99);
  s.city.buildings = [{ x: 0, z: 3, w: 8, d: 1, h: 8, color: "#ffffff", style: 0 }];
  p.cooldown = 0;
  s.attack(p);
  assert.equal(a.health, 95);
  assert.equal(b.health, 95);
  s.city.buildings = [];
  s.city.props = [{ x: 0, z: 3, h: 6, kind: "lamp" }];
  s.destruction = new Destruction(s.city);
  p.cooldown = 0;
  s.attack(p);
  assert.equal(a.health, 95);
  assert.equal(b.health, 90);
  const fuel = s.inventory.equipped(p)!;
  fuel.ammo = 0;
  fuel.reserve = 0;
  p.cooldown = 0;
  const events = s.events.length;
  s.attack(p);
  assert.equal(s.events.length, events + 1);
  assert.equal(s.events.at(-1)?.kind, "dryFire");
  assert.equal(s.events.at(-1)?.sound, "dryFire");
  assert.equal(a.health, 95);
  assert.equal(fuel.ammo, 0);
});

test("grenades have finite stock, replenish from ammo and preserve thrown state", () => {
  const { s, p } = setup();
  s.inventory.give(p, "grenade");
  const held = s.inventory.equipped(p)!;
  for (let i = 0; i < 3; i++) {
    p.cooldown = 0;
    s.attack(p);
  }
  assert.equal(held.ammo, 0);
  assert.equal(s.grenades.active.size, 3);
  p.cooldown = 0;
  s.attack(p);
  assert.equal(s.grenades.active.size, 3);
  assert.equal(p.reloadUntil, undefined);
  const pickup = s.inventory.spawnAmmo(0, 0, "grenade", 5, 0);
  assert.equal(s.inventory.pickup(p, 0), true);
  assert.equal(held.ammo, 3);
  assert.equal(pickup.kind === "ammo" && pickup.amount, 2);
  const snap = s.grenades.snapshot(0, 0, 110);
  assert.equal(snap.length, 3);
  assert.equal(snap[0].owner, p.id);
  assert.equal(snap[0].detonateAt, 3);
  snap[0].x = 999;
  assert.equal([...s.grenades.active.values()][0].x, 0);
});

test("grenades bounce off ground, walls and roofs, detonate once, and bound active work", () => {
  const { p } = setup();
  const city = emptyCity({ seed: 42, airport: { x: 640, z: -640, w: 220, d: 220 } });
  const g = new Grenades();
  assert.equal(g.throw(p, 0), true);
  const projectile = [...g.active.values()][0];
  projectile.y = 0.17;
  projectile.vy = -3;
  projectile.vx = 0;
  projectile.vz = 0;
  let blasts = 0;
  const blast = () => {
    blasts++;
  };
  g.step(city, 0.1, 1 / 120, blast);
  assert.equal(projectile.y, 0.16);
  assert.ok(projectile.vy > 0);
  city.buildings = [{ x: 0, z: 3, w: 10, d: 1, h: 8, color: "#ffffff", style: 0 }];
  projectile.z = 2.3;
  projectile.y = 1;
  projectile.vz = 15;
  g.step(city, 0.2, 1 / 120, blast);
  assert.ok(projectile.z <= 2.34);
  assert.ok(projectile.vz < 0);
  projectile.x = 0;
  projectile.z = 3;
  projectile.y = 10;
  projectile.vz = 0;
  projectile.vy = -10;
  g.step(city, 0.3, 1 / 120, blast);
  assert.ok(projectile.y >= 9.96);
  assert.ok(projectile.vy > 0);
  g.step(city, 3, 1 / 120, blast);
  g.step(city, 4, 1 / 120, blast);
  assert.equal(blasts, 1);
  assert.equal(g.active.size, 0);
  for (let i = 0; i < 96; i++) assert.equal(g.throw(p, 5), true);
  assert.equal(g.throw(p, 5), false);
  assert.equal(g.active.size, 96);
});

test("grenades bounce off rotated vehicles and characters without contact damage", () => {
  const { s, p } = setup();
  const car = s.spawn("car", 0, 0);
  car.angle = Math.PI / 2;
  const actor = s.spawn("pedestrian", 0, 6);
  const g = new Grenades();
  g.throw(p, 0);
  const projectile = [...g.active.values()][0];
  projectile.x = -2.4;
  projectile.z = 0;
  projectile.y = 1;
  projectile.vx = 15;
  projectile.vy = projectile.vz = 0;
  const blasts: number[] = [];
  const blast = () => {
    blasts.push(1);
  };
  g.step(s.city, 0.1, 1 / 120, blast, s.entities.values());
  assert.ok(projectile.x <= -2.31 + 1e-8);
  assert.equal(projectile.vx, -7.5);
  assert.equal(car.health, 100);
  projectile.x = 0;
  projectile.z = 5.35;
  projectile.y = 1;
  projectile.vx = projectile.vy = 0;
  projectile.vz = 15;
  g.step(s.city, 0.2, 1 / 120, blast, s.entities.values());
  assert.ok(projectile.z <= 5.42 + 1e-8);
  assert.equal(projectile.vz, -7.5);
  assert.equal(actor.health, 100);
  projectile.x = projectile.z = 0;
  projectile.y = 2;
  projectile.vx = projectile.vz = 0;
  projectile.vy = -10;
  g.step(s.city, 0.3, 1 / 120, blast, [car]);
  assert.equal(projectile.y, 1.96);
  assert.ok(projectile.vy > 0);
  assert.equal(blasts.length, 0);
  assert.deepEqual([p.health, car.health, actor.health], [100, 100, 100]);
  g.step(
    s.city,
    3,
    1 / 120,
    (x, y, z, radius, damage) => {
      blasts.push(1);
      s.blast(x, y, z, radius, damage);
    },
    s.entities.values(),
  );
  assert.equal(blasts.length, 1);
  assert.ok(car.health < 100);
  assert.ok(actor.health < 100);
  s.destruction.dispose();
});

test("grenades grant brief owner clearance and skip seated or dead character contacts", () => {
  const { s, p } = setup();
  const g = new Grenades();
  g.throw(p, 0);
  const projectile = [...g.active.values()][0];
  const reset = () => {
    projectile.x = -0.5;
    projectile.z = 0;
    projectile.y = 1;
    projectile.vx = 15;
    projectile.vy = projectile.vz = 0;
  };
  const blast = () => {
    assert.fail("fuse has not expired");
  };
  reset();
  g.step(s.city, 0.01, 1 / 120, blast, [p]);
  assert.equal(projectile.x, -0.375);
  assert.equal(projectile.vx, 15);
  reset();
  g.step(s.city, 0.25, 1 / 120, blast, [p]);
  assert.equal(projectile.x, -0.58);
  assert.equal(projectile.vx, -7.5);
  assert.equal(p.health, 100);
  const rider = s.spawn("player", 0, 0);
  rider.vehicle = "occupied-car";
  const dead = s.spawn("pedestrian", 0, 0);
  dead.health = 0;
  reset();
  g.step(s.city, 0.3, 1 / 120, blast, [rider, dead]);
  assert.equal(projectile.x, -0.375);
  assert.equal(projectile.vx, 15);
});

test("grenade blasts hit seated occupants exactly once and vehicle wreck blasts exclude released occupants", () => {
  const { s, p } = setup();
  p.x = 0;
  p.z = 0;
  const rider = s.join("B", "#ffffff");
  rider.x = rider.z = 0;
  const car = s.spawn("car", 0, 0);
  s.interact(p.id);
  s.interact(rider.id);
  assert.equal(p.vehicle, car.id);
  assert.equal(rider.vehicle, car.id);
  const counts = new Map<string, number>();
  const original = s.damage.bind(s);
  s.damage = (e, amount) => {
    counts.set(e.id, (counts.get(e.id) || 0) + 1);
    original(e, amount);
  };
  s.blast(0, 0, 0, 12, 30);
  assert.equal(p.health, 70);
  assert.equal(rider.health, 70);
  assert.equal(car.health, 70);
  assert.equal(counts.get(p.id), 1);
  assert.equal(counts.get(rider.id), 1);
  counts.clear();
  car.burning = 0;
  s.tick(1 / 120);
  assert.equal(counts.get(p.id), 1);
  assert.equal(counts.get(rider.id), 1);
  assert.equal(p.vehicle, undefined);
  assert.equal(rider.vehicle, undefined);
  assert.equal(s.events.filter((e) => e.kind === "explosion").length, 2);
  s.destruction.dispose();
});

test("lethal grenade damage releases riders from a surviving utility helicopter and allows respawn", () => {
  const { s, p } = setup();
  const rider = s.join("B", "#ffffff");
  rider.x = rider.z = 0;
  const helicopter = s.spawn("helicopter", 0, 0, undefined, "utility");
  s.interact(p.id);
  s.interact(rider.id);
  assert.equal(p.vehicle, helicopter.id);
  assert.equal(rider.vehicle, helicopter.id);
  const thrower = s.spawn("player", 20, 0);
  s.grenades.throw(thrower, s.time);
  const grenade = [...s.grenades.active.values()][0];
  grenade.x = grenade.z = grenade.y = 0;
  grenade.detonateAt = s.time;
  s.tick(1 / 120);
  assert.equal(helicopter.health, 70);
  assert.equal(helicopter.wreck, undefined);
  assert.equal(helicopter.driver, undefined);
  assert.ok(helicopter.seats!.every((id) => id === null));
  for (const player of [p, rider]) {
    assert.equal(player.health, 0);
    assert.ok(player.down! > 0);
    assert.equal(player.vehicle, undefined);
    assert.equal(player.seat, undefined);
  }
  assert.equal(
    [...s.destruction.active.values()].filter(
      (body) => body.state.source.kind === "corpse",
    ).length,
    2,
  );
  for (let i = 0; i < 100; i++) s.tick(1 / 30);
  for (const player of [p, rider]) {
    assert.equal(player.health, 100);
    assert.equal(player.down, 0);
    assert.equal(player.vehicle, undefined);
  }
  s.destruction.dispose();
});

test("saved city supplies every new weapon, compatible ammo and a jetpack without changing the artifact", async () => {
  const city = await loadCity();
  const before = JSON.stringify(city);
  const s = new Simulation(city);
  const pickups = [...s.inventory.pickups.values()];
  for (const kind of ["knife", "machinegun", "flamethrower", "grenade"])
    assert.ok(
      pickups.some((p) => p.kind === "weapon" && p.item.kind === kind),
      `missing ${kind}`,
    );
  for (const kind of ["handgun", "light", "rifle", "fuel", "grenade"])
    assert.ok(
      pickups.some((p) => p.kind === "ammo" && p.ammoKind === kind),
      `missing ${kind} ammo`,
    );
  assert.ok(pickups.some((p) => p.kind === "jetpack"));
  assert.equal(JSON.stringify(city), before);
});

test("new supplies refill at full quantity after collection, with fresh weapon IDs", () => {
  const { s, p } = setup();
  const inv = new Inventory();
  inv.initialize(p);
  inv.give(p, "machinegun");
  inv.equipped(p)!.reserve = 0;
  inv.addSupplySource(0, 0, { kind: "ammo", ammoKind: "rifle", amount: 60 });
  inv.addSupplySource(10, 0, { kind: "weapon", item: inv.item("knife") });
  const first = [...inv.pickups.values()].find((p) => p.kind === "weapon")!;
  assert.equal(inv.pickup(p, 0), true);
  p.x = 10;
  assert.equal(inv.pickup(p, 0), true);
  inv.cleanup(1);
  inv.cleanup(21);
  assert.equal(inv.pickups.size, 2);
  assert.equal([...inv.pickups.values()].find((p) => p.kind === "ammo")?.amount, 60);
  const next = [...inv.pickups.values()].find((p) => p.kind === "weapon")!;
  assert.notEqual(
    next.kind === "weapon" && next.item.id,
    first.kind === "weapon" && first.item.id,
  );
  s.destruction.dispose();
});
