import { test } from "node:test";
import assert from "node:assert/strict";
import { Prediction, loadPhysics, yawPitchRoll } from "../client/network/prediction.ts";
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
const drive = (cars: Entity[]) => {
  const [driver, car] = player("sedan");
  const prediction = new Prediction({});
  prediction.reconcile(driver, car, snapshot, undefined, cars);
  for (let tick = 1; tick <= 90; tick++) prediction.input(tick, input);
  return prediction.body!;
};
const parked = (z: number): Entity => ({
  id: "parked-1",
  kind: "car",
  model: "sedan",
  x: 0,
  y: 0,
  z,
  angle: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  color: "#fff",
  health: 100,
});

// A car the server has in front of the driver is solid on the client too; without it the
// predicted body drove through and was corrected back by metres on every touch.
test("prediction collides with a parked car the server also collides with", async () => {
  await loadPhysics();
  const through = drive([]);
  assert.ok(
    through.z > 30 && through.vz > 20,
    `free run z=${through.z} v=${through.vz}`,
  );
  const blocked = drive([parked(14)]);
  // The car hits the sedan 14 m ahead at about 12 m/s and shoves it along at half the speed.
  assert.ok(
    blocked.vz < 8,
    `predicted body kept ${blocked.vz} m/s through the parked car`,
  );
  assert.ok(blocked.z < through.z - 15, `z=${blocked.z} vs free ${through.z}`);
});

test("neighbour poses round-trip through the quaternion the physics reads back", () => {
  for (const [yaw, pitch, roll] of [
    [0.7, 0.1, -0.05],
    [-2.5, -0.15, 0.1],
    [3.0, 0.05, 0.12],
  ]) {
    const [x, y, z, w] = yawPitchRoll(yaw, pitch, roll);
    const back = {
      yaw: Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z)),
      pitch: Math.asin(2 * (w * x - y * z)),
      roll: Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z)),
    };
    assert.ok(Math.abs(back.yaw - yaw) < 0.01, `yaw ${back.yaw} vs ${yaw}`);
    assert.ok(Math.abs(back.pitch - pitch) < 0.01, `pitch ${back.pitch} vs ${pitch}`);
    assert.ok(Math.abs(back.roll - roll) < 0.01, `roll ${back.roll} vs ${roll}`);
  }
});

// The footprint frame has local x along (cos a, sin a) (see `insideBuilding` and `buildBuilding`);
// the predicted collider must sit exactly there or cars drive through rotated buildings.
test("prediction blocks where a rotated building is drawn", async () => {
  await loadPhysics();
  const angle = 0.7,
    prediction = new Prediction({}) as unknown as {
      world: { step(): void; cast_ray(...a: number[]): number[] };
      syncStatic(c: { buildings: unknown[]; parks: unknown[] }): void;
    };
  prediction.syncStatic({
    buildings: [{ x: 100, z: 200, w: 40, d: 6, h: 30, y: 0, angle }],
    parks: [],
  });
  prediction.world.step();
  const at = (u: number, v: number) => ({
    x: 100 + u * Math.cos(angle) - v * Math.sin(angle),
    z: 200 + u * Math.sin(angle) + v * Math.cos(angle),
  });
  // A ray from 60 m up meets a 30 m wall at 30 m, open ground at 60 m.
  const top = (x: number, z: number) => {
    const [, t] = prediction.world.cast_ray(x, 60, z, 0, -1, 0, 100, 0);
    return t < 45 ? [t] : [];
  };
  for (const u of [-18, 18]) {
    const drawn = at(u, 0),
      mirror = { x: drawn.x, z: 400 - drawn.z };
    assert.ok(top(drawn.x, drawn.z).length, `no wall at footprint offset ${u}`);
    assert.equal(top(mirror.x, mirror.z).length, 0, `wall at the mirrored spot of ${u}`);
  }
});
