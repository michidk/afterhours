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

test("control changes send promptly without creating extra simulation slots", () => {
  const clock = new InputClock();
  const timestamps: number[] = [];
  const send = (timestamp: number) => timestamps.push(timestamp);
  clock.advance(0, send);
  clock.advance(10, send);
  clock.transition(10, send);
  assert.deepEqual(timestamps, [0, 10]);
  clock.advance(40, send);
  assert.deepEqual(timestamps, [0, 10], "the early command consumed the next slot");
  // Repeated presses/releases can borrow at most the next tick, not speed up time.
  for (let now = 41; now <= 3000; now++) {
    clock.advance(now, send);
    clock.transition(now, send);
  }
  assert.equal(timestamps.length, 92);
  clock.reset();
  clock.transition(4000, send);
  assert.equal(timestamps.length, 92, "a reset clock cannot send before joining");
});
