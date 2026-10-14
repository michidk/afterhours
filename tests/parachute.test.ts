import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { idle } from "../shared/world.ts";
import { predictStep } from "../shared/physics/index.ts";
import { applyPatch, encodeSnapshot, decodeSnapshot } from "../shared/codec.ts";

function setup() {
  const city = generateCity();
  city.buildings = [];
  city.props = [];
  const simulation = new Simulation(city);
  simulation.entities.clear();
  const player = simulation.join("Pilot", "#fff");
  player.x = player.z = 0;
  return { simulation, player };
}

for (const kind of ["helicopter", "plane"] as const) {
  test(`${kind} airborne exit releases ownership and lands a steerable parachute`, () => {
    const { simulation: s, player: p } = setup();
    const aircraft = s.spawn(kind, 0, 0);
    s.interact(p.id);
    aircraft.y = 30;
    aircraft.vz = 20;
    s.interact(p.id);
    assert.equal(p.vehicle, undefined);
    assert.equal(aircraft.driver, undefined);
    assert.equal(p.parachute, true);
    assert.equal(p.y, 30, "exit retains altitude");
    const start = p.x;
    s.inputs.set(p.id, { ...idle(), right: true });
    for (let i = 0; i < 60; i++) s.tick(1 / 30);
    assert.ok(p.x > start + 8, "WASD steers the descent");
    assert.ok(p.y > 20 && p.y < 24);
    assert.ok(p.vy >= -4 && p.vy < -3.9, "bounded gentle descent");
    s.interact(p.id);
    assert.equal(p.vehicle, undefined, "cannot enter ground vehicles from the air");
    s.inputs.set(p.id, idle());
    for (let i = 0; i < 300; i++) s.tick(1 / 30);
    assert.equal(p.y, 0);
    assert.equal(p.vy, 0);
    assert.equal(p.parachute, undefined);
    assert.equal(p.health, 100);
  });
}

test("parachute lands on roofs, walks off safely, and shares predicted movement", () => {
  const { simulation: s, player: p } = setup();
  s.city.buildings = [{ x: 0, z: 0, w: 8, d: 8, h: 10, color: "#fff", style: 0 }];
  p.y = 25;
  p.parachute = true;
  const predicted = { ...p };
  for (let i = 0; i < 180; i++) {
    s.tick(1 / 30);
    predictStep(predicted, idle(), s.city, [], 1 / 30);
    assert.ok(Math.abs(predicted.y - p.y) < 1e-8);
    assert.equal(predicted.parachute, p.parachute);
  }
  assert.equal(p.y, 11.8);
  assert.equal(p.parachute, undefined);
  s.inputs.set(p.id, { ...idle(), right: true });
  for (let i = 0; i < 45; i++) s.tick(1 / 30);
  assert.ok(p.x > 4);
  assert.equal(p.parachute, true);
  assert.ok(p.y < 11.8 && p.y > 0);
  for (let i = 0; i < 150; i++) s.tick(1 / 30);
  assert.equal(p.y, 0);
  assert.equal(p.parachute, undefined);
});

test("parachute cannot lift a player onto an adjacent higher roof", () => {
  const { simulation: s, player: p } = setup();
  s.city.buildings = [{ x: 2, z: 0, w: 2, d: 20, h: 30, color: "#fff", style: 0 }];
  p.y = 15;
  p.parachute = true;
  s.inputs.set(p.id, { ...idle(), right: true });
  for (let i = 0; i < 60; i++) s.tick(1 / 30);
  assert.ok(p.y < 10);
  assert.ok(p.x + 0.42 <= 1.005, "wall contact blocks penetration below its roof");
});

for (const kind of ["helicopter", "plane"] as const) {
  test(`empty ${kind} continues its course, crashes, burns, and explodes`, () => {
    const { simulation: s, player: p } = setup();
    const aircraft = s.spawn(kind, 0, 0);
    s.interact(p.id);
    aircraft.y = 50;
    aircraft.vz = 12;
    s.interact(p.id);
    for (let i = 0; i < 30; i++) s.tick(1 / 30);
    assert.ok(aircraft.z > 11 && aircraft.z < 13, "retain forward momentum");
    assert.ok(aircraft.y < 46, "empty aircraft falls instead of seeking a landing");
    for (let i = 0; i < 90; i++) s.tick(1 / 30);
    assert.equal(aircraft.y, 0);
    assert.equal(aircraft.health, 0);
    assert.ok(aircraft.burning !== undefined);
    assert.ok(s.events.some((e) => e.kind === "hit" && e.sound === "impact"));
    for (let i = 0; i < 180; i++) s.tick(1 / 30);
    assert.ok(aircraft.wreck);
    assert.equal(s.events.filter((e) => e.kind === "explosion").length, 1);
  });
}

test("abandoned aircraft crashes onto a roof instead of passing through it", () => {
  const { simulation: s } = setup();
  s.city.buildings = [{ x: 0, z: 0, w: 20, d: 20, h: 10, color: "#fff", style: 0 }];
  const aircraft = s.spawn("helicopter", 0, 0);
  aircraft.y = 50;
  aircraft.flight = "falling";
  for (let i = 0; i < 90; i++) s.tick(1 / 30);
  assert.equal(aircraft.y, 11.8);
  assert.equal(aircraft.health, 0);
  assert.ok(aircraft.burning !== undefined);
});

test("grounded exits stay grounded and parachute state clears over the wire", () => {
  const { simulation: s, player: p } = setup();
  const aircraft = s.spawn("plane", 0, 0);
  s.interact(p.id);
  s.interact(p.id);
  assert.equal(p.vehicle, undefined);
  assert.equal(p.parachute, undefined);
  assert.equal(p.y, 0);
  const states = new Map([[p.id, { ...p, parachute: true }]]);
  applyPatch(states, { id: p.id, parachute: null });
  assert.equal(states.get(p.id)?.parachute, undefined);
  // Snapshot codecs must preserve the optional deployed state for observers.
  const snapshot = {
    type: "state" as const,
    version: 1,
    frame: 1,
    base: 0,
    full: true,
    removed: [],
    time: 1,
    day: 16,
    entities: [{ ...p, parachute: true }],
    events: [],
    pickups: [],
    players: 1,
    ack: 0,
  };
  assert.equal(decodeSnapshot(encodeSnapshot(snapshot)).entities[0].parachute, true);
});

test("disconnect retains a parachuting player for reconnect and releases the aircraft", () => {
  const { simulation: s, player: p } = setup();
  const aircraft = s.spawn("helicopter", 0, 0);
  s.interact(p.id);
  aircraft.y = 30;
  aircraft.vz = 10;
  s.inputs.set(p.id, { ...idle(), up: true });
  s.disconnect(p.id);
  assert.equal(s.entities.get(p.id), p);
  assert.equal(p.vehicle, undefined);
  assert.equal(p.parachute, true);
  assert.equal(aircraft.driver, undefined);
  assert.equal(aircraft.flight, "falling");
  assert.deepEqual(s.inputs.get(p.id), idle());
  for (let i = 0; i < 30; i++) s.tick(1 / 30);
  assert.ok(p.y > 26 && p.y < 28);
  assert.ok(aircraft.z > 9);
});

for (const kind of ["helicopter", "plane"] as const)
  test(`${kind} exploding in the air throws its pilot out under a parachute`, () => {
    const { simulation: s, player: p } = setup();
    const aircraft = s.spawn(kind, 0, 0);
    s.interact(p.id);
    aircraft.y = 60;
    aircraft.burning = 0.001;
    s.tick(1 / 120);
    assert.ok(aircraft.wreck);
    assert.equal(p.vehicle, undefined);
    assert.ok(!p.down && p.health > 0, "the pilot survives");
    assert.equal(p.parachute, true);
    assert.ok(p.y > 50, "the pilot keeps the aircraft's height");
  });
