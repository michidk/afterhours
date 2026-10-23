import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  Prediction,
  loadPhysics,
  withPredicted,
  yawPitchRoll,
} from "../client/network/prediction.ts";
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
    assert.equal(
      top(mirror.x, mirror.z).length,
      0,
      `wall at the mirrored spot of ${u}`,
    );
  }
});

// The mesh and the camera follow the car entity. Swapping the predicted body into the player
// alone left them on the server copy, 4 m behind a car at 18 m/s.
test("the driven car is drawn at the predicted pose, other vehicles are left alone", () => {
  const [driver, car] = player("sedan");
  const other: Entity = { ...car, id: "car-2", driver: "player-2", z: 50 };
  const heli: Entity = { ...car, id: "heli-1", kind: "helicopter", driver: "player-1" };
  const me: Entity = {
    ...driver,
    x: 5,
    y: 1.5,
    z: 20,
    vz: 18,
    angle: 0.3,
    pitch: 0.01,
    roll: 0.02,
    steering: 0.1,
  };
  const out = withPredicted([driver, car, other, heli], me, "player-1");
  const drawn = out.find((e) => e.id === "car-1")!;
  assert.deepEqual(
    [drawn.x, drawn.z, drawn.vz, drawn.angle, drawn.pitch, drawn.steering],
    [5, 20, 18, 0.3, 0.01, 0.1],
  );
  assert.equal(drawn.model, "sedan");
  assert.equal(drawn.driver, "player-1");
  assert.equal(
    out.find((e) => e.id === "car-2"),
    other,
  );
  assert.equal(
    out.find((e) => e.id === "heli-1"),
    heli,
  );
  assert.equal(out.find((e) => e.id === "player-1")!.z, 20);
  // Still boarding: the predicted body has no pitch yet, so the car keeps the server pose.
  const boarding = withPredicted(
    [driver, car],
    { ...driver, pitch: undefined },
    "player-1",
  );
  assert.equal(boarding.find((e) => e.id === "car-1")!.z, car.z);
});

// The body advances on 30 Hz input ticks; a 60 Hz screen drew a stall and a double jump.
test("the drawn body keeps moving between input ticks, by at most two", async () => {
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
  for (let tick = 1; tick <= 60; tick++) prediction.input(tick, input);
  const t = performance.now(),
    at = (ms: number) => prediction.render(t + ms)!.z;
  assert.ok(at(16) > at(0), "no movement between ticks");
  const speed = prediction.body!.vz;
  assert.ok(at(16) - at(0) < speed / 30, "more than a tick of carry in 16 ms");
  assert.ok(at(1000) - at(67) < 0.05, "carry is not capped at two ticks");
});

// Collisions are simulated against the predicted world, so the cars you can hit must be drawn
// from it: the server copy is a quarter of a second behind, and a car passing at 10 m/s was
// drawn about three metres from where the predicted body actually met it.
test("cars within reach are drawn from the predicted world, far ones from the server", async () => {
  await loadPhysics();
  const [driver, car] = player("sedan");
  const passer = (id: string, x: number): Entity =>
    ({ ...car, id, driver: undefined, ai: true, x, y: 0, z: 0, vz: 10 }) as Entity;
  const near = passer("near", 8),
    far = passer("far", 30);
  const prediction = new Prediction({});
  const idle = {
    up: false,
    down: false,
    left: false,
    right: false,
    brake: false,
    sprint: false,
    ascend: false,
    descend: false,
    attack: false,
  };
  prediction.reconcile(driver, car, snapshot, undefined, [car, near, far]);
  // Eight unacknowledged ticks: the world is replayed to "now" on the next snapshot.
  for (let tick = 1; tick <= 8; tick++) prediction.input(tick, idle);
  prediction.reconcile(driver, car, snapshot, 0, [car, near, far]);
  const t = performance.now();
  let me: Entity | undefined;
  for (let i = 0; i < 8; i++) me = prediction.render(t + i * 100);
  const frame = [driver, car, near, far];
  const drawn = withPredicted(frame, me!, "player-1", prediction.drawnCars);
  const z = (id: string) => drawn.find((e) => e.id === id)!.z;
  // Eight ticks at about 10 m/s, plus up to two ticks of carry: 2.5 to 3.5 m ahead of the
  // snapshot the server copy is still at.
  assert.ok(z("near") > 2 && z("near") < 3.6, `near car drawn at z=${z("near")}`);
  assert.equal(z("far"), 0, "a car beyond reach stays on its server copy");
  // Driving on, the passer leaves the 16 m ring: it fades back instead of jumping.
  const gone = { ...near, x: 20 };
  prediction.reconcile(driver, car, snapshot, 0, [car, gone, far]);
  prediction.render(t + 800 + 50);
  const half = withPredicted(frame, me!, "player-1", prediction.drawnCars).find(
    (e) => e.id === "near",
  )!;
  assert.ok(half.z > 0.2 && half.z < z("near"), `no fade: z=${half.z}`);
  for (let i = 0; i < 6; i++) prediction.render(t + 900 + i * 100);
  assert.equal(
    prediction.drawnCars.has("near"),
    false,
    "the faded car is still swapped",
  );
});

// The car's drawn suspension springs are driven by how fast the drawn velocity changes from one
// frame to the next. A velocity that only moves on 30 Hz ticks is 0 on one 60 fps frame and double
// on the next, which kicks heave, pitch and roll back and forth: a micro-stutter.
test("the drawn velocity changes evenly from frame to frame, not once per tick", async () => {
  await loadPhysics();
  const [driver, car] = player("sedan");
  const prediction = new Prediction({});
  prediction.reconcile(driver, car, snapshot, undefined);
  const throttle = {
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
  let clock = 1000;
  const mocked = mock.method(performance, "now", () => clock);
  try {
    const speeds: number[] = [];
    for (let tick = 1; tick <= 60; tick++) {
      prediction.input(tick, throttle);
      // Two 60 fps frames per 30 Hz tick.
      for (const offset of [0, 1000 / 60])
        speeds.push(prediction.render(clock + offset)!.vz);
      clock += 1000 / 30;
    }
    const steps = speeds
      .slice(20, 100)
      .map((v, i, all) => (i ? v - all[i - 1] : 0))
      .slice(1);
    assert.ok(
      Math.min(...steps) > 0,
      `speed stalled between frames: ${Math.min(...steps)}`,
    );
    assert.ok(
      Math.max(...steps) < 2 * Math.min(...steps),
      `frame-to-frame speed change ranges ${Math.min(...steps).toFixed(4)} to ${Math.max(...steps).toFixed(4)}`,
    );
  } finally {
    mocked.mock.restore();
  }
});

// The same through the real suspension springs: this is what the player sees as the body rocking.
test("the drawn body's pitch and roll do not jitter at 60 fps", async () => {
  const { CarSuspension } = await import("../client/world/car-suspension.ts");
  await loadPhysics();
  const [driver, car] = player("sedan");
  const prediction = new Prediction({});
  prediction.reconcile(
    driver,
    car,
    [0, 1.3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    undefined,
  );
  const suspension = new CarSuspension();
  let clock = 1000;
  const mocked = mock.method(performance, "now", () => clock);
  try {
    const pitch: number[] = [],
      roll: number[] = [];
    for (let tick = 1; tick <= 240; tick++) {
      prediction.input(tick, {
        up: tick < 120 || tick > 150,
        down: false,
        left: false,
        right: false,
        moveX: tick > 120 ? 0.5 * Math.sin(tick / 15) : 0,
        moveY: 1,
        brake: false,
        sprint: false,
        ascend: false,
        descend: false,
        attack: false,
      });
      for (const offset of [0, 1000 / 60]) {
        const body = suspension.update(
          prediction.render(clock + offset)!,
          1 / 60,
          true,
          () => 0,
          (clock + offset) / 1000,
        );
        pitch.push(body.pitch.value);
        roll.push(body.roll.value);
      }
      clock += 1000 / 30;
    }
    // Mean frame-to-frame change of the change (jerk); stepwise velocity measured 9e-4 here.
    const jerk = (v: number[]) =>
      v
        .slice(80, -1)
        .reduce(
          (sum, _, i) => sum + Math.abs(v[80 + i + 1] - 2 * v[80 + i] + v[80 + i - 1]),
          0,
        ) /
      (v.length - 81);
    assert.ok(jerk(pitch) < 2e-4, `pitch jerk ${jerk(pitch).toExponential(2)}`);
    assert.ok(jerk(roll) < 3e-4, `roll jerk ${jerk(roll).toExponential(2)}`);
  } finally {
    mocked.mock.restore();
  }
});

// Trees, palms and lamps exist only on the server. Without them in the predicted world the car
// drove through a prop and its break showed a round trip later; the server's own rule runs here.
const driveInto = (
  prop: { kind: "lamp" | "tree" | "palm"; x: number; z: number; h: number },
  ticks: number,
) => {
  const [driver, car] = player("sedan");
  const prediction = new Prediction({});
  prediction.reconcile(driver, car, snapshot, undefined);
  const props = [prop];
  const id = `${prop.kind}:${prop.x.toFixed(4)},${prop.z.toFixed(4)}`;
  prediction.syncProps(props, new Set(), 0);
  const throttle = {
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
  for (let tick = 1; tick <= ticks; tick++) prediction.input(tick, throttle);
  return { prediction, props, id };
};

test("a fast hit breaks a lamp at once and the car keeps its speed", async () => {
  await loadPhysics();
  // 15 m/s into a lamp (45 health breaks above about 5 m/s).
  const lamp = { kind: "lamp" as const, x: 0, z: 40, h: 6 };
  const { prediction, id } = driveInto(lamp, 100);
  assert.ok(prediction.impacts.has(id), "no predicted break");
  const launch = prediction.impacts.get(id)!;
  assert.ok(launch.z > 5 && launch.y > 2.5, `launch ${JSON.stringify(launch)}`);
  assert.ok(prediction.body!.z > 40, `the car stopped at z=${prediction.body!.z}`);
  assert.ok(prediction.body!.vz > 8, `the car lost its speed: ${prediction.body!.vz}`);
});

test("a slow hit leaves a tree standing and the car stops at it", async () => {
  await loadPhysics();
  // Two metres from the nose a sedan has not reached the 8 m/s a tree needs to break.
  const tree = { kind: "tree" as const, x: 0, z: 4, h: 9 };
  const { prediction, id } = driveInto(tree, 36);
  assert.equal(prediction.impacts.has(id), false, "a slow hit broke the tree");
  assert.ok(prediction.body!.z < 4.5, `drove through: z=${prediction.body!.z}`);
});

test("a break the server never confirms stands the prop up again, a confirmed one does not", async () => {
  await loadPhysics();
  const lamp = { kind: "lamp" as const, x: 0, z: 40, h: 6 };
  const standing = (p: Prediction, id: string) =>
    (p as unknown as { props: Map<string, unknown> }).props.has(id);
  const { prediction, props, id } = driveInto(lamp, 100);
  assert.equal(standing(prediction, id), false, "the broken prop still stands");
  const t = performance.now();
  // Just after: neither confirmed nor expired, so it stays broken.
  prediction.syncProps(props, new Set(), t + 300);
  assert.equal(standing(prediction, id), false);
  // The server confirms it: it stays out, and so does the cosmetic launch's cue after a while.
  prediction.syncProps(props, new Set([id]), t + 400);
  prediction.syncProps(props, new Set([id]), t + 5000);
  assert.equal(standing(prediction, id), false, "a confirmed break came back");
  assert.equal(prediction.impacts.size, 0, "the launch cue was never withdrawn");
  // The server's debris expires: the fixture stands again.
  prediction.syncProps(props, new Set(), t + 40000);
  assert.equal(standing(prediction, id), true, "the prop did not come back");

  const second = driveInto(lamp, 100);
  second.prediction.syncProps(second.props, new Set(), performance.now() + 2000);
  assert.equal(second.prediction.impacts.size, 0, "an unconfirmed strike was kept");
  assert.equal(
    standing(second.prediction, second.id),
    true,
    "the unconfirmed prop stays gone",
  );
});
