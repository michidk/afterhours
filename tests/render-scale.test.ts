import assert from "node:assert/strict";
import test from "node:test";
import { RenderScale } from "../client/performance/index.ts";

/** Feeds frames of `ms` for `seconds`, returning every level change. */
function run(scale: RenderScale, from: number, seconds: number, ms: number) {
  const changes: number[] = [];
  let now = from;
  for (const end = from + seconds * 1000; now < end; now += ms) {
    const level = scale.frame(now, ms);
    if (level !== undefined) changes.push(level);
  }
  return { changes, now };
}

test("a machine drawing 8 fps gets fewer pixels, in steps up to the limit", () => {
  const scale = new RenderScale(1);
  const { changes } = run(scale, 0, 30, 125);
  assert.ok(changes.length >= 3, `only ${changes.length} steps`);
  assert.equal(scale.level, 2);
  assert.ok(changes.every((level, i) => i === 0 || level > changes[i - 1]));
});

test("60 fps, and a 30 Hz display, keep the full resolution", () => {
  for (const ms of [16.7, 33.3]) {
    const scale = new RenderScale(1);
    assert.deepEqual(run(scale, 0, 30, ms).changes, []);
    assert.equal(scale.level, 1);
  }
});

test("one stall is not a slow machine", () => {
  const scale = new RenderScale(1);
  let now = 0;
  for (let i = 0; i < 100; i++) ((now += 16.7), scale.frame(now, 16.7));
  assert.equal(scale.frame((now += 900), 900), undefined);
  for (let i = 0; i < 100; i++)
    ((now += 16.7), assert.equal(scale.frame(now, 16.7), undefined));
  assert.equal(scale.level, 1);
});

test("a hidden tab does not count", () => {
  const scale = new RenderScale(1);
  for (let i = 0; i < 10; i++) assert.equal(scale.frame(i * 60_000, 60_000), undefined);
  assert.equal(scale.level, 1);
});

test("it steps back after the cooldown once frames are fast, and waits longer after a relapse", () => {
  const scale = new RenderScale(1);
  let { now } = run(scale, 0, 10, 100);
  const lowered = scale.level;
  assert.ok(lowered > 1);
  // Fast again: nothing before the 20 s cooldown, then one step down.
  const early = run(scale, now, 15, 16.7);
  assert.deepEqual(early.changes, []);
  const late = run(scale, early.now, 10, 16.7);
  assert.equal(late.changes[0], lowered / 1.25);
  // Slow again right away: it goes back up and the next cooldown is longer.
  now = late.now;
  run(scale, now, 5, 100);
  assert.equal(scale.level, lowered);
  const wait = run(scale, now + 5000, 25, 16.7);
  assert.deepEqual(wait.changes, [], "the doubled cooldown (40 s) is not over");
});
