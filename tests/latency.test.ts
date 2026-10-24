import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionLatency } from "../client/network/latency.ts";

test("entering a car is timed from the key to the first frame that shows the driver seated", () => {
  const l = new ActionLatency();
  l.pressInteract(1000, false);
  l.frame(1050, false, undefined);
  l.frame(1100, false, undefined);
  assert.equal(l.enterMs, undefined);
  l.frame(1180, true, undefined);
  assert.equal(l.enterMs, 180);
  // Leaving is timed the same way, from seated to not seated.
  l.pressInteract(5000, true);
  l.frame(5120, false, undefined);
  assert.equal(l.enterMs, 120);
});

test("a press with nothing to enter is dropped after three seconds", () => {
  const l = new ActionLatency();
  l.pressInteract(0, false);
  l.frame(3100, false, undefined);
  l.frame(3200, true, undefined);
  assert.equal(l.enterMs, undefined, "a later, unrelated entry was timed");
});

test("a turn is timed from steering leaving the centre to a degree of drawn heading", () => {
  const l = new ActionLatency();
  const at = (angle: number, speed = 20) => ({ angle, speed });
  l.controls(1000, 0, at(0));
  l.controls(1010, 0.8, at(0));
  l.frame(1100, true, at(0.005));
  assert.equal(l.steerMs, undefined, "under a degree");
  l.frame(1260, true, at(0.03));
  assert.equal(l.steerMs, 250);
});

test("steering at rest or released before it shows is not timed", () => {
  const l = new ActionLatency();
  l.controls(0, 0, { angle: 0, speed: 0 });
  l.controls(10, 1, { angle: 0, speed: 0.5 });
  l.frame(500, true, { angle: 0.5, speed: 0.5 });
  assert.equal(l.steerMs, undefined, "a body at rest cannot turn");
  l.controls(1000, 0, { angle: 0, speed: 20 });
  l.controls(1010, 1, { angle: 0, speed: 20 });
  l.controls(1050, 0, { angle: 0, speed: 20 });
  l.frame(1300, true, { angle: 0.4, speed: 20 });
  assert.equal(l.steerMs, undefined, "a released turn was timed");
});
