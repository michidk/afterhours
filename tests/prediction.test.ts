import { test } from "node:test";
import assert from "node:assert/strict";
import { Prediction, loadPhysics } from "../client/network/prediction.ts";
import type { Entity } from "../shared/world.ts";

const player = (model: string): [Entity, Entity] => {
  const car: Entity = {
    id: "car-1",
    kind: "car",
    model: model as Entity["model"],
    x: 0,
    y: 1,
    z: 0,
    angle: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    color: "#fff",
    health: 100,
    driver: "player-1",
  };
  return [
    {
      id: "player-1",
      kind: "player",
      vehicle: car.id,
      seat: 0,
      x: 0,
      y: 1,
      z: 0,
      angle: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      color: "#fff",
      health: 100,
    },
    car,
  ];
};

const snapshot = [0, 0.8, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];

test("local prediction uses the authoritative model for a seated driver", async () => {
  await loadPhysics();
  const [driver, car] = player("sport");
  const prediction = new Prediction({});
  prediction.reconcile(driver, car, snapshot, undefined);
  const input = {
    up: true,
    down: false,
    left: false,
    right: false,
    brake: false,
    sprint: false,
    ascend: false,
    descend: false,
    attack: false,
  };
  for (let tick = 1; tick <= 30; tick++) prediction.input(tick, input);
  assert.ok(prediction.body);
  assert.ok(prediction.body.vz > 0, `predicted speed=${prediction.body.vz}`);

  const [sedanDriver, sedan] = player("sedan");
  const sedanPrediction = new Prediction({});
  sedanPrediction.reconcile(sedanDriver, sedan, snapshot, undefined);
  for (let tick = 1; tick <= 30; tick++) sedanPrediction.input(tick, input);
  assert.ok(prediction.body.vz > sedanPrediction.body!.vz);
});
