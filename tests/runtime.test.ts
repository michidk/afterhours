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

for (const cost of [0, 80]) {
  test(`snapshot delivery follows wall time with ${cost} ms simulation ticks`, (t) => {
    const sim = new Simulation(generateCity());
    const sessions = new Sessions(
      createServer(),
      sim,
      false,
      new CityStore(sim.city).manifest,
    );
    const runtime = new Runtime(sim, sessions);
    let clock = 0;
    const snapshots: number[] = [];
    t.mock.method(performance, "now", () => clock);
    t.mock.timers.enable({ apis: ["setInterval"] });
    t.mock.method(sim, "tick", () => {
      clock += cost;
    });
    t.mock.method(sessions, "tick", () => {});
    t.mock.method(sessions, "broadcast", () => {
      snapshots.push(clock);
    });
    try {
      runtime.start();
      while (clock < 1000) {
        clock += 5;
        t.mock.timers.tick(5);
      }
      assert.ok(
        snapshots.length >= 10,
        "slow physics must not halve snapshot delivery",
      );
      for (let i = 1; i < snapshots.length; i++)
        assert.ok(
          snapshots[i] - snapshots[i - 1] <= 90,
          "broadcast the completed state without waiting for another slow tick",
        );
      assert.ok(
        snapshots.length <= 16,
        "ordinary delivery stays within its 15 Hz budget",
      );
    } finally {
      runtime.stop();
    }
  });
}

test("catch-up broadcasts only the latest completed state once", (t) => {
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
  const ticks = t.mock.method(sim, "tick", () => {});
  t.mock.method(sessions, "tick", () => {});
  const sent: number[] = [];
  t.mock.method(sessions, "broadcast", () => {
    sent.push(ticks.mock.callCount());
  });
  try {
    runtime.start();
    clock = 140;
    t.mock.timers.tick(5);
    assert.deepEqual(sent, [4], "one snapshot contains the final catch-up tick");
    clock += 5;
    t.mock.timers.tick(5);
    assert.deepEqual(sent, [4], "missed deadlines do not create a snapshot backlog");
  } finally {
    runtime.stop();
  }
});

test("health separates tick CPU from wall time and includes snapshot work", (t) => {
  const sim = new Simulation(generateCity());
  const sessions = new Sessions(
    createServer(),
    sim,
    false,
    new CityStore(sim.city).manifest,
  );
  const runtime = new Runtime(sim, sessions);
  let clock = 0,
    cpu = 0;
  t.mock.method(performance, "now", () => clock);
  t.mock.method(process, "threadCpuUsage", (previous?: NodeJS.CpuUsage) => ({
    user: cpu - (previous?.user ?? 0),
    system: 0,
  }));
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.mock.method(sessions, "tick", () => {
    clock += 3;
    cpu += 2000;
  });
  t.mock.method(sim, "tick", () => {
    clock += 80;
    cpu += 12000;
  });
  t.mock.method(sessions, "broadcast", () => {
    clock += 12;
    cpu += 3000;
  });
  try {
    assert.equal(runtime.metrics().tickCpuP95Ms, 0);
    runtime.start();
    clock = 40;
    t.mock.timers.tick(5);
    const health = runtime.metrics();
    assert.equal(health.ticks, 1);
    assert.equal(health.tickP95Ms, 95);
    assert.equal(health.tickMaxMs, 95);
    assert.equal(health.tickCpuP95Ms, 17);
    assert.equal(health.tickCpuMaxMs, 17);
  } finally {
    runtime.stop();
  }
});

test("debug telemetry distinguishes queued simulation time from dropped time", (t) => {
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
  t.mock.method(sim, "tick", () => {});
  t.mock.method(sessions, "tick", () => {});
  t.mock.method(sessions, "broadcast", () => {});
  try {
    runtime.start();
    clock = 1000;
    t.mock.timers.tick(5);
    const stats = sessions.diagnostics!();
    assert.equal(stats.late, 1);
    assert.equal(stats.catchUpTicks, 3);
    assert.ok(Math.abs(stats.droppedMs - 733.3333333333334) < 0.001);
    assert.ok(Math.abs(stats.backlogMs - 133.33333333333334) < 0.001);
    clock += 10;
    assert.ok(Math.abs(runtime.metrics().backlogMs - 143.33333333333334) < 0.001);
    assert.ok(
      stats.memoryMB > 0 &&
        stats.heapUsedMB > 0 &&
        stats.heapLimitMB > stats.heapUsedMB,
    );
  } finally {
    runtime.stop();
  }
});
