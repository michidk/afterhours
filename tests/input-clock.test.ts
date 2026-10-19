import { test } from "node:test";
import assert from "node:assert/strict";
import { InputClock } from "../client/input/clock.ts";

for (const interval of [16, 33, 50, 80, 280, 400]) {
  test(`input clock preserves 30 Hz movement with ${interval} ms wakeups`, () => {
    const clock = new InputClock();
    const timestamps: number[] = [];
    for (let now = 0; now < 3000; now += interval)
      clock.advance(now, (timestamp) => timestamps.push(timestamp));
    clock.advance(3000, (timestamp) => timestamps.push(timestamp));
    assert.equal(timestamps.length, 91);
    for (let i = 1; i < timestamps.length; i++)
      assert.ok(Math.abs(timestamps[i] - timestamps[i - 1] - 1000 / 30) < 1e-6);
  });
}
test("a suspended tab discards clock debt and overlapping wakeups send no duplicates", () => {
  const clock = new InputClock();
  const timestamps: number[] = [];
  const send = (timestamp: number) => timestamps.push(timestamp);
  clock.advance(0, send);
  clock.advance(0, send);
  clock.advance(2000, send);
  assert.deepEqual(timestamps, [0, 2000]);
  clock.reset();
  clock.advance(2010, send);
  assert.deepEqual(timestamps, [0, 2000, 2010]);
});
