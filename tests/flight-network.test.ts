import { test } from "node:test";
import assert from "node:assert/strict";
import { GameNetwork } from "../client/network/index.ts";
import { Prediction } from "../client/network/prediction.ts";
import { SnapshotTimeline } from "../client/network/timeline.ts";
import { Simulation } from "../server/simulation.ts";
import { emptyCity } from "../shared/city-stream.ts";
import { idle, type Entity } from "../shared/world.ts";
import { VEHICLES } from "../shared/catalog.ts";

function airborne() {
  const city = emptyCity({ seed: 42, airport: { x: 640, z: -640, w: 128, d: 200 } });
  const helicopter: Entity = {
    id: "helicopter",
    kind: "helicopter",
    model: "scout",
    driver: "pilot",
    x: 0,
    y: 80,
    z: 0,
    angle: 0,
    vx: 0,
    vy: 0,
    vz: 15,
    health: 120,
    color: "#ffffff",
    flight: "cruising",
    targetAltitude: 80,
  };
  const player: Entity = {
    ...helicopter,
    id: "pilot",
    kind: "player",
    vehicle: helicopter.id,
    model: undefined,
    driver: undefined,
  };
  const prediction = new Prediction(city);
  prediction.reconcile(player, [player, helicopter], -1, 0);
  return { player, helicopter, prediction };
}

test("flight responds to a new turn while 400 ms of commands await acknowledgement", () => {
  const { player, helicopter, prediction } = airborne();
  for (let seq = 0; seq < 12; seq++)
    prediction.input(
      { seq, timestamp: (seq * 1000) / 30, input: { ...idle(), up: true } },
      [player, helicopter],
    );
  const before = prediction.body!.x;
  prediction.input({ seq: 12, timestamp: 400, input: { ...idle(), right: true } }, [
    player,
    helicopter,
  ]);
  assert.ok(
    prediction.body!.x > before,
    "turn locally without waiting for a round trip",
  );
  assert.equal(prediction.status, "predicting");
});

test("bounded flight retains turns and brakes and does not revive acknowledged throttle", () => {
  const { player, helicopter, prediction } = airborne();
  for (let seq = 0; seq < 30; seq++)
    prediction.input(
      {
        seq,
        timestamp: (seq * 1000) / 30,
        input: {
          ...idle(),
          up: seq < 10,
          right: seq >= 10 && seq < 20,
          brake: seq >= 20,
        },
      },
      [player, helicopter],
    );
  prediction.reconcile(player, [player, { ...helicopter, z: 5 }], 9, 1000);
  assert.ok(prediction.body!.x > 0.5, "replay the unacknowledged turn first");
  assert.equal(prediction.pending[0].seq, 10);
  prediction.reconcile(
    player,
    [player, { ...helicopter, x: 2, z: 7, vx: 10, vz: 5 }],
    19,
    1033,
  );
  assert.ok(
    Math.hypot(prediction.body!.vx, prediction.body!.vz) < 6,
    "the next replay prefix brakes",
  );
  const stopped = { ...helicopter, x: 3, z: 8, vx: 0, vz: 0 };
  prediction.reconcile(player, [player, stopped], 29, 1066);
  assert.deepEqual(prediction.body, stopped);
  assert.equal(prediction.pending.length, 0);
  const pose = prediction.render(1100)!.body;
  assert.equal(pose.vx, 0);
  assert.equal(pose.vz, 0, "render extrapolation must use the acknowledged brake");
});

test("a fresh snapshot after a one-second gap catches up smoothly without a packet backlog", () => {
  const { player, helicopter, prediction } = airborne();
  for (let seq = 0; seq < 30; seq++) {
    prediction.input(
      { seq, timestamp: (seq * 1000) / 30, input: { ...idle(), up: true } },
      [player, helicopter],
    );
    prediction.render((seq * 1000) / 30);
  }
  const before = prediction.render(983)!.body.z;
  prediction.reconcile(player, [player, { ...helicopter, z: 15 }], 29, 1000);
  assert.equal(prediction.body!.z, 15, "authority applies immediately to physics");
  const after = prediction.render(1000)!.body.z;
  assert.ok(
    after >= before && after - before < 1,
    "presentation cannot teleport to the recovery snapshot",
  );
  for (let now = 1016; now <= 2000; now += 16) prediction.render(now);
  assert.ok(prediction.render(2000)!.body.z > 15.4, "visual correction converges");
});

test("a correction arriving after a render stall starts easing at receipt time", () => {
  const { player, helicopter, prediction } = airborne();
  const before = prediction.render(1000)!.body.z;
  prediction.reconcile(player, [player, { ...helicopter, z: 2 }], -1, 2000);
  assert.equal(prediction.body!.z, 2);
  assert.equal(
    prediction.render(2000)!.body.z,
    before,
    "do not age a new correction by the preceding render stall",
  );
  const after = prediction.render(2050)!.body.z;
  assert.ok(after > before && after < 2);
});

for (const delays of [
  [120, 240, 360, 180],
  [120, 1000, 120, 180, 120],
])
  for (const model of ["scout", "utility"] as const) {
    test(`${model} never rewinds with up to ${Math.max(...delays)} ms delayed snapshots`, () => {
      const city = emptyCity({
        seed: 42,
        airport: { x: 640, z: -640, w: 128, d: 200 },
      });
      city.roads = [
        { x: 0, z: 0, ax: -512, az: 0, bx: 512, bz: 0, width: 18, kind: "avenue" },
      ];
      const sim = new Simulation(city);
      sim.entities.clear();
      const player = sim.join("Pilot", "#ffffff");
      player.x = player.z = 0;
      const helicopter = sim.spawn("helicopter", 0, 0, undefined, model);
      sim.interact(player.id);
      helicopter.flight = "cruising";
      helicopter.takeoffDelay = undefined;
      helicopter.y = helicopter.targetAltitude = 80;
      helicopter.vz = VEHICLES[model].speed;
      const input = { ...idle(), up: true };
      sim.inputs.set(player.id, input);
      const network = new GameNetwork(
        { welcome() {}, state() {}, chat() {}, status() {} },
        "Pilot",
        "#ffffff",
        city,
      );
      network.playerId = player.id;
      network.prediction = new Prediction(city);
      const timeline: unknown = Reflect.get(network, "timeline");
      assert.ok(timeline instanceof SnapshotTimeline);
      const receive = (entities: Entity[], ack: number, time: number, now: number) => {
        network.entities = new Map(entities.map((e) => [e.id, e]));
        timeline.push(time, entities, now);
        network.prediction!.reconcile(entities[0], entities, ack, now);
      };
      receive(structuredClone([player, helicopter]), -1, 0, 0);
      const packets: { entities: Entity[]; ack: number; time: number; due: number }[] =
        [];
      let previous = 0,
        worstBackstep = 0,
        largestStep = 0,
        delayed = 0;
      let worst = "";
      try {
        for (let frame = 0; frame < 600; frame++) {
          const now = (frame * 1000) / 60;
          if (frame % 2 === 0) {
            const seq = frame / 2;
            network.prediction.input({ seq, timestamp: now, input }, [
              ...network.entities.values(),
            ]);
            sim.tick(1 / 30);
            if (seq % 2 === 0) {
              const delay = delays[Math.floor(seq / 30) % delays.length];
              packets.push({
                entities: structuredClone([player, helicopter]),
                ack: seq,
                time: sim.time,
                due: now + delay,
              });
            }
          }
          // Ordered delivery also reproduces a burst when the delay falls again.
          while (packets[0]?.due <= now) {
            const p = packets.shift()!;
            receive(p.entities, p.ack, p.time, now);
          }
          if (network.prediction.pending.length > 7) delayed++;
          const rendered = network.renderEntities(now);
          const pose = rendered.find((e) => e.id === helicopter.id)!;
          const rider = rendered.find((e) => e.id === player.id)!;
          assert.deepEqual([rider.x, rider.y, rider.z], [pose.x, pose.y, pose.z]);
          if (pose.z - previous < worstBackstep)
            worst = JSON.stringify({
              frame,
              now,
              pending: network.prediction.pending.length,
              body: network.prediction.body?.z,
              offset: network.prediction.offset.z,
              pose: pose.z,
              previous,
              correction: network.prediction.lastCorrection,
            });
          worstBackstep = Math.min(worstBackstep, pose.z - previous);
          if (frame > 0) largestStep = Math.max(largestStep, pose.z - previous);
          previous = pose.z;
        }
        assert.ok(delayed > 0, "exercise delay beyond 250 ms");
        assert.ok(
          worstBackstep >= -0.01,
          `steady flight rewound ${-worstBackstep.toFixed(3)} m: ${worst}`,
        );
        assert.ok(
          largestStep < 1.5,
          `flight jumped forward ${largestStep.toFixed(3)} m in one frame`,
        );
        assert.ok(
          Math.abs(previous - helicopter.z) < 8,
          "bounded lag behind authority",
        );
      } finally {
        sim.destruction.dispose();
      }
    });
  }
