import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { TUNING, VEHICLES, type VehicleModel } from "../shared/catalog.ts";
import { availableSeat, occupiedSeats, seatCapacity } from "../shared/seats.ts";
import { idle, type Entity } from "../shared/world.ts";
import { Prediction } from "../client/network/prediction.ts";
import { GameNetwork } from "../client/network/index.ts";
import { applyPatch, encodeSnapshot, decodeSnapshot } from "../shared/codec.ts";
import { VERSION } from "../shared/version.ts";
import { predictStep } from "../shared/physics/index.ts";

function setup(model: VehicleModel = "sedan") {
  const city = generateCity();
  city.buildings = [];
  city.props = [];
  city.pickups = [];
  const simulation = new Simulation(city);
  simulation.entities.clear();
  const vehicle = simulation.spawn(VEHICLES[model].kind, 0, 0, undefined, model);
  const board = (name: string) => {
    const player = simulation.join(name, "#fff");
    player.x = player.z = 0;
    simulation.interact(player.id);
    return player;
  };
  return { simulation, vehicle, board };
}

test("every vehicle allocates distinct seats up to its catalog capacity", () => {
  for (const model of Object.keys(VEHICLES) as VehicleModel[]) {
    const { vehicle: v, board } = setup(model);
    const occupants = Array.from({ length: seatCapacity(v) }, (_, i) => board(`P${i}`));
    assert.equal(v.driver, occupants[0].id);
    assert.deepEqual(
      v.seats,
      occupants.map((p) => p.id),
    );
    for (const [seat, player] of occupants.entries()) {
      assert.equal(player.vehicle, v.id);
      assert.equal(player.seat, seat);
    }
    const extra = board("No room");
    assert.equal(extra.vehicle, undefined, model);
    assert.equal(extra.seat, undefined);
    assert.equal(availableSeat(v), -1);
    assert.equal(occupiedSeats(v), seatCapacity(v));
  }
});

test("only driver input moves a shared car; passengers follow and leave independently", () => {
  const { simulation: s, vehicle: v, board } = setup();
  const driver = board("Driver"),
    passenger = board("Passenger");
  s.inputs.set(passenger.id, { ...idle(), up: true, right: true });
  for (let i = 0; i < 30; i++) s.tick(1 / 30);
  assert.equal(v.z, 0);
  assert.equal(v.angle, 0);
  s.inputs.set(driver.id, { ...idle(), up: true });
  for (let i = 0; i < 30; i++) s.tick(1 / 30);
  assert.ok(v.z > 1);
  assert.equal(passenger.x, v.x);
  assert.equal(passenger.z, v.z);
  s.interact(passenger.id);
  assert.equal(passenger.vehicle, undefined);
  assert.equal(passenger.seat, undefined);
  assert.equal(v.driver, driver.id);
  assert.deepEqual(v.seats, [driver.id, null, null, null]);
  s.interact(passenger.id);
  assert.equal(passenger.seat, 1, "a freed passenger seat is reusable");
});

test("disconnect and blocked exits free only the departing player's seat", () => {
  const { simulation: s, vehicle: v, board } = setup("sport");
  const driver = board("Driver"),
    passenger = board("Passenger");
  v.y = 2; // Grounded exit is blocked while a car is jumping.
  s.disconnect(passenger.id);
  assert.equal(v.driver, driver.id);
  assert.equal(v.seats?.[1], null);
  assert.equal(passenger.vehicle, undefined);
  assert.equal(passenger.seat, undefined);
  v.y = 0;
  passenger.y = 0;
  passenger.x = passenger.z = 0;
  s.interact(passenger.id);
  s.leave(driver.id);
  assert.equal(v.driver, undefined);
  assert.equal(v.seats?.[0], null);
  assert.equal(v.seats?.[1], passenger.id);
  const replacement = board("Replacement driver");
  assert.equal(replacement.seat, 0);
  assert.equal(v.driver, replacement.id);
  assert.equal(passenger.seat, 1);
});

for (const model of ["scout", "plane"] as const) {
  test(`${model} passenger parachutes without interrupting the pilot`, () => {
    const { simulation: s, vehicle: v, board } = setup(model);
    const pilot = board("Pilot"),
      passenger = board("Passenger");
    v.y = 30;
    v.flight = "cruising";
    s.interact(passenger.id);
    assert.equal(passenger.parachute, true);
    assert.equal(passenger.y, 30);
    assert.equal(passenger.vehicle, undefined);
    assert.equal(v.driver, pilot.id);
    assert.equal(v.flight, "cruising");
    assert.equal(v.seats?.[1], null);
  });
}

test("helicopter boarding pause allows later passengers and shares prediction", () => {
  const { simulation: s, vehicle: v, board } = setup("utility");
  const pilot = board("Pilot");
  const predicted = structuredClone(v);
  for (let i = 0; i < 24; i++) {
    s.tick(1 / 30);
    predictStep(predicted, idle(), s.city, [], 1 / 30);
  }
  assert.equal(v.y, 0);
  assert.equal(predicted.y, 0);
  const passenger = board("Passenger");
  assert.equal(passenger.seat, 1);
  assert.equal(v.takeoffDelay, 0.5);
  s.tick(1 / 30);
  assert.equal(v.y, 0);
  s.inputs.set(passenger.id, { ...idle(), up: true });
  s.tick(1 / 30);
  assert.equal(v.y, 0, "a passenger cannot bypass the boarding pause");
  s.inputs.set(pilot.id, { ...idle(), ascend: true });
  s.tick(1 / 30);
  assert.ok(v.y > 0);
  assert.equal(v.takeoffDelay, undefined);
});

test("pilot exit leaves passengers aboard a falling aircraft until they exit", () => {
  const { simulation: s, vehicle: v, board } = setup("utility");
  const pilot = board("Pilot"),
    passenger = board("Passenger");
  v.y = 30;
  s.interact(pilot.id);
  assert.equal(v.flight, "falling");
  assert.equal(v.driver, undefined);
  assert.equal(passenger.vehicle, v.id);
  s.tick(1 / 30);
  assert.ok(v.y < 30);
  assert.equal(passenger.y, v.y);
  s.interact(passenger.id);
  assert.equal(passenger.parachute, true);
  assert.equal(passenger.seat, undefined);
  assert.equal(occupiedSeats(v), 0);
});

test("explosions throw every occupant out alive and clear the full seat manifest", () => {
  const { simulation: s, vehicle: v, board } = setup("utility");
  const occupants = Array.from({ length: seatCapacity(v) }, (_, i) => board(`P${i}`));
  v.burning = 0.001;
  s.tick(1 / 120);
  assert.ok(v.wreck);
  assert.equal(v.driver, undefined);
  assert.equal(occupiedSeats(v), 0);
  for (const p of occupants) {
    assert.equal(p.vehicle, undefined);
    assert.equal(p.seat, undefined);
    assert.equal(p.health, (p.maxHealth ?? 100) - TUNING.ejectDamage);
    assert.ok(!p.down);
  }
});

test("passenger controls never predict a vehicle; role changes reset pending inputs", () => {
  const { simulation: s, vehicle: v, board } = setup();
  const driver = board("Driver"),
    passenger = board("Passenger");
  const prediction = new Prediction(s.city);
  prediction.reconcile(driver, [driver, passenger, v], -1);
  prediction.input({ seq: 0, timestamp: 0, input: { ...idle(), up: true } }, [v]);
  assert.equal(prediction.pending.length, 1);
  prediction.reconcile(passenger, [driver, passenger, v], 0);
  assert.equal(prediction.body, undefined);
  assert.equal(prediction.pending.length, 0);
  prediction.input({ seq: 1, timestamp: 33, input: { ...idle(), up: true } }, [v]);
  assert.equal(prediction.render(50), undefined);
  assert.equal(prediction.pending.length, 0);
  s.leave(driver.id);
  s.interact(passenger.id);
  passenger.x = passenger.z = 0;
  s.interact(passenger.id);
  prediction.reconcile(passenger, [passenger, v], 1);
  assert.equal(prediction.render(100)?.body.id, v.id);
  assert.equal(prediction.ownership, v.id);
  assert.equal(prediction.pending.length, 0);
});

test("local passengers use the vehicle's interpolated pose instead of snapshot steps", () => {
  const { vehicle: v, board } = setup();
  board("Driver");
  const passenger = board("Passenger");
  const network = new GameNetwork(
    { welcome() {}, state() {}, chat() {}, status() {} },
    "Test",
    "#fff",
  );
  network.playerId = passenger.id;
  network.entities.set(passenger.id, { ...passenger, x: 90 });
  // Stub only the sampled render pose, keeping the public rendering path real.
  (network as unknown as { timeline: { sample(): Entity[] } }).timeline = {
    sample: () => [
      { ...passenger, x: 80 },
      { ...v, x: 12, z: 34, y: 8, angle: 1 },
    ],
  };
  const rendered = network.renderEntities(0);
  const p = rendered.find((e) => e.id === passenger.id)!;
  assert.deepEqual([p.x, p.z, p.y, p.angle], [12, 34, 8, 1]);
});

test("binary snapshots preserve vacant seats and removal of player seat zero", () => {
  const { vehicle: v, board } = setup("sport");
  const p = board("Driver");
  const snapshot = decodeSnapshot(
    encodeSnapshot({
      type: "state",
      version: VERSION,
      frame: 1,
      base: 0,
      full: true,
      time: 0,
      day: 12,
      ack: -1,
      players: 1,
      pickups: [],
      events: [],
      removed: [],
      entities: [v, p],
    }),
  );
  const entities = new Map<string, Entity>();
  for (const patch of snapshot.entities) applyPatch(entities, patch);
  assert.deepEqual(entities.get(v.id)?.seats, [p.id, null]);
  assert.equal(entities.get(p.id)?.seat, 0);
  applyPatch(entities, { id: p.id, seat: null, vehicle: null });
  assert.equal(entities.get(p.id)?.seat, undefined);
  assert.equal(entities.get(p.id)?.vehicle, undefined);
});
