import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameProfiler } from "../client/performance/index.ts";

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
