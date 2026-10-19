import { test } from "node:test";
import assert from "node:assert/strict";
import { Prediction } from "../client/network/prediction.ts";
import { emptyCity } from "../shared/city-stream.ts";
import { idle, type Entity } from "../shared/world.ts";
import { predictStep } from "../shared/physics/index.ts";
import { TUNING } from "../shared/catalog.ts";

for (const kind of ["car", "plane"] as const)
  test(`${kind} presentation keeps its clock when authority acknowledges held slots ahead of inputs`, () => {
    const city = emptyCity({ seed: 1, airport: { x: 0, z: 0, w: 100, d: 100 } });
    const body: Entity = {
      id: "vehicle",
      kind,
      model: kind === "car" ? "sport" : "plane",
      x: 0,
      y: kind === "plane" ? 60 : 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: kind === "plane" ? 40 : 52,
      angle: 0,
      color: "#fff",
      health: 100,
      driver: "player",
    };
    const player: Entity = { ...body, id: "player", kind: "player", vehicle: body.id };
    const input = { ...idle(), up: true };
    const prediction = new Prediction(city);
    prediction.reconcile(player, [player, body], -1, 0);
    prediction.input({ seq: 0, timestamp: 0, input }, [player, body]);
    prediction.render(0);
    for (let tick = 1; tick <= 6; tick++) {
      predictStep(body, input, city, [], TUNING.tick);
      const now = tick * TUNING.tick * 1000;
      if (tick % 2 === 0) {
        prediction.reconcile(player, [player, body], tick - 1, now);
        assert.ok(
          prediction.lastCorrection.distance < 0.01,
          `held-slot acknowledgement cannot add a movement tick: ${prediction.lastCorrection.distance}m`,
        );
      }
      prediction.render(now);
    }
    assert.equal(prediction.corrections, 0);
  });
