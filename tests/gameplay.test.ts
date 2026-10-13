import { generateCity } from "../scripts/city-generator.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import { idle } from "../shared/world.ts";
import {
  carForces,
  contact,
  entityBox,
  resolveContact,
  predictStep,
} from "../shared/physics/index.ts";
const empty = () => {
  const s = new Simulation(generateCity());
  s.entities.clear();
  s.city.props = [];
  s.city.buildings = [];
  s.inventory.pickups.clear();
  return s;
};
const run = (s: Simulation, seconds: number) => {
  for (let i = 0; i < Math.ceil(seconds * 30); i++) s.tick(1 / 30);
};
test("four tyres provide symmetric rolling resistance and steering torque", () => {
  const s = empty(),
    car = s.spawn("car", 0, 0);
  car.vz = 10;
  carForces(car, { throttle: 0, steer: 0, brake: false }, 1 / 120);
  assert.ok(Math.abs(car.vz - (10 - 1.3 / 120)) < 1e-8);
  assert.ok(Math.abs(car.angularVelocity || 0) < 1e-8);
  carForces(car, { throttle: 0, steer: 1, brake: false }, 1 / 120);
  assert.ok((car.angularVelocity || 0) > 0);
  car.rearGripLoss = 1;
  for (let i = 0; i < 20; i++)
    carForces(car, { throttle: 0, steer: 0, brake: false }, 1 / 120);
  assert.equal(car.rearGripLoss, 0);
});
test("car steering builds to full lock and recentres faster on release", () => {
  const car = empty().spawn("car", 0, 0);
  carForces(car, { throttle: 0, steer: 1, brake: false }, 1 / 30);
  assert.ok((car.steering || 0) > 0 && (car.steering || 0) < 0.55);
  for (let i = 0; i < 15; i++)
    carForces(car, { throttle: 0, steer: 1, brake: false }, 1 / 30);
  assert.equal(car.steering, 0.55);
  carForces(car, { throttle: 0, steer: 0, brake: false }, 1 / 30);
  assert.ok((car.steering || 0) < 0.5);
  for (let i = 0; i < 6; i++)
    carForces(car, { throttle: 0, steer: 0, brake: false }, 1 / 30);
  assert.equal(car.steering, 0);
});
test("off-centre collision spins a car without adding linear energy", () => {
  const s = empty(),
    a = s.spawn("car", 0, 0),
    b = s.spawn("car", 0.8, 4);
  a.vz = 20;
  const c = contact(entityBox(a), entityBox(b));
  assert.ok(c);
  resolveContact(a, b, c!);
  assert.ok(Math.abs(a.angularVelocity || 0) > 0);
  assert.ok(a.vz < 20);
  assert.ok(b.vz > 0);
});
test("high-speed wall impact cannot tunnel and causes fire then explosion", () => {
  const s = empty(),
    car = s.spawn("car", 0, 0);
  s.city.buildings = [{ x: 0, z: 10, w: 12, d: 1, h: 10, color: "#fff", style: 0 }];
  car.vz = 60;
  run(s, 0.3);
  assert.ok(car.z < 9);
  assert.ok(car.burning !== undefined);
  run(s, 6.1);
  assert.ok(car.wreck);
  assert.ok(s.drainEvents().some((e) => e.kind === "explosion"));
});
test("explosion releases occupants and damages nearby vehicles once", () => {
  const s = empty(),
    p = s.join("A", "#ffffff"),
    car = s.spawn("car", p.x, p.z),
    other = s.spawn("car", p.x + 4, p.z);
  s.interact(p.id);
  s.damage(car, 90);
  run(s, 6.05);
  assert.equal(p.vehicle, undefined);
  assert.ok(p.down);
  assert.ok(other.health < 100);
  assert.equal(s.drainEvents().filter((e) => e.kind === "explosion").length, 1);
});
test("character slides along walls and stops promptly", () => {
  const s = empty(),
    p = s.join("A", "#ffffff");
  p.x = 0;
  p.z = 0;
  s.city.buildings = [{ x: 2, z: 0, w: 2, d: 20, h: 10, color: "#fff", style: 0 }];
  s.inputs.set(p.id, { ...idle(), right: true, up: true });
  run(s, 1);
  assert.ok(p.x + 0.42 <= 1.005);
  assert.ok(p.z > 2);
  s.inputs.set(p.id, idle());
  run(s, 0.2);
  assert.ok(Math.hypot(p.vx, p.vz) < 0.01);
});

test("walking or sprinting into parked vehicles never damages or knocks down characters", () => {
  for (const kind of ["player", "pedestrian"] as const)
    for (const carFirst of [false, true])
      for (const sprint of [false, true])
        for (const angle of [0, Math.PI / 2]) {
          const s = empty();
          const car = carFirst ? s.spawn("car", 0, 0) : undefined;
          const p = s.spawn(kind, -4, 0);
          const v = car || s.spawn("car", 0, 0);
          v.angle = angle;
          s.inputs.set(p.id, { ...idle(), right: true, brake: sprint });
          let knocked = false;
          for (let i = 0; i < 60; i++) {
            s.tick(1 / 30);
            knocked ||= !!p.down;
          }
          assert.equal(
            knocked,
            false,
            `${kind}, carFirst=${carFirst}, sprint=${sprint}, angle=${angle}`,
          );
          assert.equal(p.health, 100);
          assert.equal(v.health, 100);
          const c = contact(entityBox(p), entityBox(v));
          assert.ok(
            !c || c.depth < 0.03,
            "the physical collision still blocks passage",
          );
        }
});

test("catching up to a departing car and meeting a creeping car do not cause knockdown", () => {
  for (const carSpeed of [-1, 4]) {
    const s = empty();
    const p = s.spawn("player", 0, -4);
    const car = s.spawn("car", 0, 0);
    car.vz = carSpeed;
    s.inputs.set(p.id, { ...idle(), up: true, brake: true });
    let knocked = false;
    for (let i = 0; i < 45; i++) {
      s.tick(1 / 30);
      knocked ||= !!p.down;
    }
    assert.equal(knocked, false, `car speed ${carSpeed}`);
    assert.equal(p.health, 100);
    assert.equal(car.health, 100);
  }
});

test("a car driving into a character still causes impact damage and knockdown", () => {
  for (const carFirst of [false, true]) {
    const s = empty();
    const car = carFirst ? s.spawn("car", 0, 0) : undefined;
    const p = s.spawn("player", 0, 5);
    const v = car || s.spawn("car", 0, 0);
    v.vz = 12;
    run(s, 0.4);
    assert.ok(p.down);
    assert.ok(p.health < 100);
    assert.ok(v.health < 100);
    assert.ok(s.drainEvents().some((e) => e.kind === "hit"));
  }
});
test("helicopter needs pilot climb to cross a roof and keeps moving after parachute exit", () => {
  const s = empty(),
    p = s.join("Pilot", "#ffffff");
  p.x = 0;
  p.z = 0;
  const heli = s.spawn("helicopter", 0, 0);
  s.city.buildings = [{ x: 22, z: 0, w: 12, d: 20, h: 25, color: "#fff", style: 0 }];
  s.interact(p.id);
  s.inputs.set(p.id, { ...idle(), right: true, ascend: true });
  run(s, 1.5);
  s.inputs.set(p.id, { ...idle(), right: true });
  for (let i = 0; i < 120; i++) {
    s.tick(1 / 30);
    assert.ok(heli.x < 14, "a low helicopter cannot fly into the wall");
  }
  s.inputs.set(p.id, { ...idle(), right: true, ascend: true });
  for (let i = 0; i < 240; i++) {
    s.tick(1 / 30);
    if (heli.x > 16 && heli.x < 28) assert.ok(heli.y >= 26.8, "roof clearance");
  }
  assert.ok(heli.x > 16);
  s.interact(p.id);
  assert.equal(heli.flight, "falling");
  assert.equal(p.vehicle, undefined);
  assert.equal(p.parachute, true);
  s.inputs.set(p.id, idle());
  const x = heli.x;
  run(s, 3);
  assert.ok(heli.x > x + 10);
  run(s, 5);
  assert.equal(heli.flight, "grounded");
  assert.equal(p.vehicle, undefined);
  assert.equal(heli.y, 0);
});
test("disconnect releases a helicopter to fall rather than land automatically", () => {
  const s = empty(),
    p = s.join("Pilot", "#fff"),
    h = s.spawn("helicopter", p.x, p.z);
  s.interact(p.id);
  s.inputs.set(p.id, { ...idle(), ascend: true });
  run(s, 3);
  s.leave(p.id);
  assert.equal(h.flight, "falling");
  run(s, 5);
  assert.equal(h.flight, "grounded");
});

test("unused helicopters stay still and ground friction settles collision rotation", () => {
  const s = empty(),
    h = s.spawn("helicopter", 0, 0);
  run(s, 2);
  assert.equal(h.angle, 0);
  assert.equal(h.y, 0);
  h.angularVelocity = 2;
  run(s, 2);
  assert.equal(h.angularVelocity, 0);
  const angle = h.angle;
  run(s, 1);
  assert.equal(h.angle, angle);
  const p = s.join("Pilot", "#fff");
  p.x = p.z = 0;
  s.interact(p.id);
  s.interact(p.id);
  assert.equal(h.flight, "grounded", "exiting before takeoff cancels automatic lift");
  run(s, 1);
  assert.equal(h.y, 0);
});
test("helicopter refuses a blocked landing and reroutes around a new obstruction", () => {
  const s = empty(),
    p = s.join("Pilot", "#fff");
  p.x = p.z = 0;
  const h = s.spawn("helicopter", 0, 0, undefined, "utility");
  s.interact(p.id);
  s.inputs.set(p.id, { ...idle(), ascend: true });
  run(s, 3);
  s.inputs.set(p.id, idle());
  s.city.buildings = [{ x: 0, z: 0, w: 120, d: 120, h: 20, color: "#fff", style: 0 }];
  s.requestLanding(h);
  assert.notEqual(h.flight, "landing");
  run(s, 5);
  assert.equal(p.vehicle, h.id);
  assert.ok(h.y > 21, "a roof beneath the fuselage lifts the hovering helicopter");
  s.city.buildings = [];
  s.requestLanding(h);
  assert.equal(h.flight, "landing");
  const obstacle = s.spawn("car", h.landingX!, h.landingZ!);
  run(s, 30);
  assert.equal(h.flight, "grounded");
  assert.equal(p.vehicle, undefined);
  assert.ok(Math.hypot(h.x - obstacle.x, h.z - obstacle.z) > 8);
});
test("utility helicopter keeps clearance across its larger rotor footprint", () => {
  const s = empty(),
    p = s.join("Pilot", "#fff");
  p.x = p.z = 0;
  const h = s.spawn("helicopter", 0, 0, undefined, "utility");
  s.interact(p.id);
  s.city.buildings = [{ x: 6, z: 0, w: 1, d: 12, h: 24, color: "#fff", style: 0 }];
  run(s, 10);
  assert.equal(
    h.y,
    0,
    "a wall under the outer rotor does not lift a parked helicopter",
  );
  s.inputs.set(p.id, { ...idle(), ascend: true });
  run(s, 10);
  s.inputs.set(p.id, idle());
  assert.ok(h.y > 35);
  s.requestLanding(h);
  run(s, 20);
  assert.equal(h.flight, "grounded");
  assert.ok(Math.abs(h.x - 6) >= 6.1 || Math.abs(h.z) >= 11.6);
});
test("weapon pickup is exclusive and drop preserves ammo; reload consumes reserve", () => {
  const s = empty(),
    a = s.join("A", "#fff"),
    b = s.join("B", "#fff");
  s.inventory.spawn(a.x, a.z, s.inventory.item("pistol"), 0);
  assert.equal(s.inventory.pickup(a, 0), true);
  assert.equal(s.inventory.pickup(b, 0), false);
  s.attack(a);
  assert.equal(s.inventory.equipped(a)?.ammo, 11);
  s.inventory.drop(a, 0);
  assert.equal(a.weapon, "fists");
  assert.equal(s.inventory.pickup(b, 0), true);
  assert.equal(s.inventory.equipped(b)?.ammo, 11);
  s.inventory.reload(b, 0);
  s.inventory.tick(b, 2);
  assert.equal(s.inventory.equipped(b)?.ammo, 12);
  assert.equal(s.inventory.equipped(b)?.reserve, 47);
});
test("nearer weapons take priority over vehicles, limits hold and pads restock", () => {
  const s = empty(),
    p = s.join("A", "#ffffff");
  s.inventory.sources = [];
  const car = s.spawn("car", p.x + 4, p.z);
  s.inventory.addSource(p.x, p.z, "pistol");
  s.interact(p.id);
  assert.equal(p.weapon, "pistol");
  assert.equal(p.vehicle, undefined);
  s.inventory.give(p, "bat");
  s.inventory.give(p, "smg");
  assert.equal(s.inventory.give(p, "bat"), false);
  s.inventory.cleanup(1);
  s.inventory.cleanup(22);
  assert.equal(s.inventory.pickups.size, 1);
  s.inventory.drop(p, 22);
  const drop = [...s.inventory.pickups.values()].find(
    (e) => e.kind === "weapon" && e.item.kind === "smg",
  )!;
  assert.ok(drop);
  s.inventory.cleanup(143);
  assert.equal(s.inventory.pickups.has(drop.id), false);
  assert.equal(car.driver, undefined);
});
test("prediction and server movement agree in unobstructed space", () => {
  const s = empty(),
    p = s.join("A", "#fff");
  p.x = 0;
  p.z = 0;
  const predicted = structuredClone(p),
    input = { ...idle(), right: true, up: true };
  s.inputs.set(p.id, input);
  for (let i = 0; i < 30; i++) {
    s.tick(1 / 30);
    predictStep(predicted, input, s.city, [], 1 / 30);
  }
  assert.ok(Math.hypot(predicted.x - p.x, predicted.z - p.z) < 1e-6);
});
test("AI cars and pedestrians remain active over a full traffic cycle", () => {
  const s = new Simulation(generateCity());
  const start = new Map(
    [...s.entities.values()].map((e) => [e.id, { x: e.x, z: e.z }]),
  );
  run(s, 22);
  const cars = [...s.entities.values()].filter((e) => e.ai && e.kind === "car"),
    people = [...s.entities.values()].filter(
      (e) => e.ai && e.kind === "pedestrian" && start.has(e.id),
    );
  assert.ok(
    cars.filter(
      (e) => Math.hypot(e.x - start.get(e.id)!.x, e.z - start.get(e.id)!.z) > 8,
    ).length > 20,
  );
  assert.ok(
    people.filter(
      (e) => Math.hypot(e.x - start.get(e.id)!.x, e.z - start.get(e.id)!.z) > 8,
    ).length > 40,
  );
});
test("a sedan survives ordinary crashes and burns only from a very hard wall impact", () => {
  const crash = (speed: number) => {
    const s = empty(),
      car = s.spawn("car", 0, 0);
    s.city.buildings = [{ x: 0, z: 10, w: 12, d: 1, h: 10, color: "#fff", style: 0 }];
    car.vz = speed;
    run(s, 1.2);
    return car;
  };
  const slow = crash(10),
    town = crash(20),
    fast = crash(28),
    flat = crash(40);
  assert.ok(slow.health > 90, `a bump at 36 km/h barely scratches: ${slow.health}`);
  assert.ok(
    town.health > 55 && town.health < 80,
    `a 72 km/h wall costs about a third: ${town.health}`,
  );
  assert.equal(town.burning, undefined);
  assert.ok(fast.health > 25, `a 100 km/h wall does not set it alight: ${fast.health}`);
  assert.equal(fast.burning, undefined);
  assert.ok(flat.burning !== undefined, "a 144 km/h wall wrecks it");
  // The first crash no longer decides the car: a second one at the same speed does.
  const s = empty(),
    car = s.spawn("car", 0, 0);
  s.city.buildings = [{ x: 0, z: 10, w: 12, d: 1, h: 10, color: "#fff", style: 0 }];
  car.vz = 20;
  run(s, 1.2);
  const afterFirst = car.health;
  car.z = 0;
  car.vz = 20;
  run(s, 1.2);
  assert.ok(
    car.health < afterFirst - 20 && car.health > 0,
    `second hit: ${car.health}`,
  );
  assert.equal(car.burning, undefined, "two 72 km/h crashes still leave it running");
});
