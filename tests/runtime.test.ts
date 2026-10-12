import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createServer } from "node:http";
import { Runtime } from "../server/runtime.ts";
import { Simulation } from "../server/simulation.ts";
import { Sessions } from "../server/session.ts";
import { CityStore } from "../server/city-stream.ts";
import { generateCity } from "../scripts/city-generator.ts";

for (const cost of [0, 40]) {
  test(`runtime yields between overloaded ticks (${cost} ms work)`, (t) => {
    const sim = new Simulation(generateCity());
    const sessions = new Sessions(
      createServer(),
      sim,
      false,
      new CityStore(sim.city).manifest,
    );
    const runtime = new Runtime(sim, sessions);
    let clock = 0;
    t.mock.method(performance, "now", () => clock);
    t.mock.timers.enable({ apis: ["setInterval"] });
    t.mock.method(sim, "tick", () => {
      clock += cost;
    });
    const inputs = t.mock.method(sessions, "tick", () => {});
    t.mock.method(sessions, "broadcast", () => {});
    try {
      runtime.start();
      clock = 140;
      t.mock.timers.tick(5);
      assert.equal(
        inputs.mock.callCount(),
        cost ? 1 : 4,
        "slow catch-up must yield to sockets after one tick; fast catch-up stays bounded at four",
      );
    } finally {
      runtime.stop();
    }
  });
}
