import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { OrderedDelay } from "../scripts/ordered-delay.ts";

test("simulated transport preserves order through coalesced and overdue deadlines", async () => {
  const transport = new OrderedDelay();
  const received: number[] = [];
  const deadline = performance.now() + 20;
  await new Promise<void>((resolve) => {
    for (const id of [0, 1, 2, 3, 4, 5])
      transport.schedule(id < 3 ? deadline : deadline - 10, () => {
        received.push(id);
        if (id === 5) resolve();
      });
  });
  assert.deepEqual(received, [0, 1, 2, 3, 4, 5]);
  transport.schedule(performance.now() + 5, () => received.push(6));
  transport.clear();
  await pause(20);
  assert.deepEqual(received, [0, 1, 2, 3, 4, 5]);
});
