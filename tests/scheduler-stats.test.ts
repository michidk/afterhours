import { test } from "node:test";
import assert from "node:assert/strict";
import { readSchedulerStats } from "../server/scheduler-stats.ts";

test(
  "scheduler sampling reads real main-thread CPU counters",
  { skip: process.platform !== "linux" },
  async () => {
    const read = async () => {
      const sample = await readSchedulerStats();
      assert.ok(sample.completedAt >= sample.startedAt);
      const main = sample.counters.find(
        (counter) => counter.path === "/proc/self/schedstat",
      );
      assert.ok(main && "text" in main && typeof main.text === "string");
      assert.match(main.text.trim(), /^\d+\s+\d+\s+\d+$/);
      const [cpuNs] = main.text.trim().split(/\s+/).map(BigInt);
      return cpuNs;
    };
    const before = await read();
    const end = performance.now() + 30;
    while (performance.now() < end) Math.sqrt(performance.now());
    const after = await read();
    assert.ok(after > before, "main thread execution must advance its CPU counter");
  },
);
