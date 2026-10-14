import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapshotTimeline } from "../client/network/timeline.ts";
import type { Entity } from "../shared/world.ts";
const car: Entity = {
  id: "fast",
  kind: "car",
  model: "sport",
  x: 0,
  y: 0,
  z: 0,
  vx: 52,
  vy: 0,
  vz: 0,
  angle: 0,
  color: "#fff",
  health: 100,
};

test("delivery spikes grow a bounded buffer without freezing or rewinding fast traffic", () => {
  const timeline = new SnapshotTimeline();
  const packets = Array.from({ length: 450 }, (_, i) => ({
    time: i * 0.064,
    // Ordered TCP bursts every second: hold three snapshots, then deliver together.
    received: i * 64 + (i % 16 >= 12 ? (15 - (i % 16)) * 64 : 0),
  }));
  let next = 0,
    previous = 0,
    frozen = 0;
  for (let now = 0; now < 28000; now += 16) {
    while (next < packets.length && packets[next].received <= now) {
      const p = packets[next++];
      timeline.push(p.time, [{ ...car, x: p.time * 52 }], p.received);
    }
    const x = timeline.sample(now)[0].x;
    if (now > 12000) {
      assert.ok(x >= previous, "clock never rewinds");
      assert.ok(x - previous <= 52 * 0.016 * 1.101, "no packet arrival jumps");
      if (x === previous) frozen++;
    }
    previous = x;
  }
  assert.equal(frozen, 0, "the learned buffer covers recurring 256 ms delivery gaps");
  assert.ok(timeline.delay > 0.2 && timeline.delay <= 0.25);
  let received = packets[next - 1].received;
  let time = packets[next - 1].time;
  for (let i = 0; i < 600; i++) {
    received += 64;
    time += 0.064;
    timeline.push(time, [{ ...car, x: time * 52 }], received);
    timeline.sample(received);
  }
  assert.ok(
    Math.abs(timeline.delay - 0.1) < 1e-8,
    "steady delivery sheds extra latency",
  );
  const stopped = timeline.sample(received + 2000)[0].x;
  assert.equal(timeline.sample(received + 3000)[0].x, stopped);
  timeline.reset();
  assert.equal(timeline.delay, 0.1);
  assert.deepEqual(timeline.sample(received), []);
});

test("steady and uniformly slow delivery keep the baseline buffer", () => {
  for (const interval of [64, 100]) {
    const timeline = new SnapshotTimeline();
    for (let i = 0; i < 100; i++) timeline.push(i * 0.064, [car], i * interval);
    assert.ok(Math.abs(timeline.delay - 0.1) < 1e-8);
  }
});
