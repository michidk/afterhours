import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameProfiler, profileNetwork } from "../client/performance/index.ts";
import { GameNetwork } from "../client/network/index.ts";

test("profiles include network stalls and corrections during the same capture", async () => {
  const network = new GameNetwork(
    { welcome() {}, state() {}, chat() {}, status() {} },
    "Profiler",
    "#ffffff",
  );
  let slow = false;
  const report = await profileNetwork(
    async () => {
      slow = true;
      return { durationSeconds: 20 };
    },
    () => ({
      ...network.stats(),
      connected: true,
      ackAge: slow ? 500 : 100,
      snapshotAge: slow ? 200 : 10,
      pending: slow ? 15 : 3,
      queued: slow ? 7 : 2,
      corrections: slow ? 9 : 2,
      serverTime: slow ? 115 : 100,
    }),
  );
  assert.equal(report.durationSeconds, 20);
  assert.deepEqual(report.network.ackAgeMs, { p95: 500, max: 500 });
  assert.deepEqual(report.network.snapshotAgeMs, { p95: 200, max: 200 });
  assert.deepEqual(report.network.pendingInputs, { p95: 15, max: 15 });
  assert.deepEqual(report.network.serverQueue, { p95: 7, max: 7 });
  assert.equal(report.network.corrections, 7);
  assert.equal(report.network.serverElapsedSeconds, 15);
});

test("full profiles count elapsed time and explain hidden-tab invalidation", async () => {
  const documentStub = Object.assign(new EventTarget(), { hidden: false });
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentStub,
  });
  try {
    const profiler = new FrameProfiler();
    const capture = profiler.profile(1);
    for (let i = 0; i < 4; i++)
      profiler.record({ interval: 10, update: 1, render: 3, ui: 0 });
    const valid = await capture;
    assert.equal(valid.valid, true);
    assert.deepEqual(valid.invalidReasons, []);
    assert.equal(valid.hiddenSeconds, 0);
    assert.equal(valid.fps, valid.samples / valid.durationSeconds);
    assert.ok(valid.fps < 5, "do not exclude elapsed periods without frames");
    const interrupted = profiler.profile(1);
    profiler.record({ interval: 10, update: 1, render: 3, ui: 0 });
    documentStub.hidden = true;
    documentStub.dispatchEvent(new Event("visibilitychange"));
    const invalid = await interrupted;
    assert.equal(invalid.valid, false);
    assert.deepEqual(invalid.invalidReasons, ["tab-hidden"]);
    assert.ok(invalid.hiddenSeconds > 0.9);
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
