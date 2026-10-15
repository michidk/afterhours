import { test } from "node:test";
import assert from "node:assert/strict";
import { CarSuspension, SUSPENSION } from "../client/world/car-suspension.ts";
import type { Entity } from "../shared/world.ts";

const car = (): Entity => ({
  id: "car",
  kind: "car",
  model: "sedan",
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  angle: 0,
  health: 100,
  color: "#fff",
});
const dt = 1 / 60;

test("the body settles on the slope under all four wheels", () => {
  const body = new CarSuspension(),
    e = car(),
    hill = (_x: number, z: number) => z * 0.2;
  let pose = body.update(e, dt, true, hill, 0);
  for (let i = 1; i < 120; i++) pose = body.update(e, dt, true, hill, i * dt);
  assert.ok(Math.abs(pose.pitch.value - Math.atan(0.2)) < 0.01, "nose up the hill");
  assert.ok(Math.abs(pose.roll.value) < 0.01);
});

test("a landing squashes the body and the wheels hang in the air", () => {
  const body = new CarSuspension(),
    e = car(),
    flat = () => 0;
  e.vz = 30;
  body.update(e, dt, true, flat, 0);
  e.vy = 4;
  let pose = body.update(e, dt, false, flat, dt);
  for (let i = 2; i < 40; i++) {
    e.vy -= 18 * dt;
    pose = body.update(e, dt, false, flat, i * dt);
  }
  assert.ok(pose.heave.value > SUSPENSION.droop * 0.8, "wheels droop below the body");
  assert.ok(pose.pitch.value < 0, "the nose follows the falling flight path");
  e.vy = 0;
  let lowest = Infinity;
  for (let i = 40; i < 70; i++) {
    pose = body.update(e, dt, true, flat, i * dt);
    lowest = Math.min(lowest, pose.heave.value);
  }
  assert.ok(lowest < -0.05, "landing compresses the springs");
  for (let i = 70; i < 200; i++) pose = body.update(e, dt, true, flat, i * dt);
  assert.ok(Math.abs(pose.heave.value) < 0.01, "and the body settles again");
});

test("braking dips the nose and a turn leans the body out", () => {
  const body = new CarSuspension(),
    e = car(),
    flat = () => 0;
  e.vz = 30;
  body.update(e, dt, true, flat, 0);
  let pose = body.update(e, dt, true, flat, dt);
  for (let i = 2; i < 20; i++) {
    e.vz -= 10 * dt;
    pose = body.update(e, dt, true, flat, i * dt);
  }
  assert.ok(pose.pitch.value < -0.02, "nose dives under braking");
  // Turning right: the velocity swings toward +x, so the body leans left.
  for (let i = 20; i < 60; i++) {
    e.vx += 15 * dt;
    pose = body.update(e, dt, true, flat, i * dt);
  }
  assert.ok(pose.roll.value > 0.02, "right side rises in a right turn");
});
