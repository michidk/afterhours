import { test } from "node:test";
import assert from "node:assert/strict";
import { Controls } from "../client/input/index.ts";

test("all control presses survive release between network samples without adding ticks", () => {
  const controls = new Controls();
  for (const [code, field] of [
    ["KeyW", "up"],
    ["ArrowUp", "up"],
    ["KeyS", "down"],
    ["ArrowDown", "down"],
    ["KeyA", "left"],
    ["ArrowLeft", "left"],
    ["KeyD", "right"],
    ["ArrowRight", "right"],
    ["Space", "brake"],
    ["ShiftLeft", "sprint"],
    ["ShiftRight", "sprint"],
    ["KeyE", "ascend"],
    ["KeyQ", "descend"],
    ["KeyJ", "attack"],
  ] as const) {
    controls.press(code);
    controls.keys.delete(code);
    assert.equal(
      controls.read()[field],
      false,
      "render reads must not consume pending presses",
    );
    assert.equal(controls.sample()[field], true, code);
    assert.equal(
      controls.sample()[field],
      false,
      "release follows on next regular tick",
    );
  }
  controls.click();
  controls.mouseDown = false;
  assert.equal(controls.sample().attack, true);
  assert.equal(controls.sample().attack, false);
  controls.press("KeyW");
  assert.equal(controls.sample().up, true);
  assert.equal(controls.sample().up, true, "holding must repeat without OS key repeat");
  controls.aim = 1;
  controls.pointer = { x: 1, y: 2 };
  controls.clear();
  assert.equal(controls.sample().up, false);
  assert.equal(controls.aim, undefined);
  assert.equal(controls.pointer, undefined);
});

test("standard gamepads provide analog movement and edge-triggered actions", () => {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  const pad = { axes: [0.6, 0], buttons };
  const controls = new Controls(() => [pad]);

  buttons[0] = { pressed: true, value: 1 };
  buttons[3] = { pressed: true, value: 1 };
  buttons[7] = { pressed: true, value: 0.75 };
  const input = controls.sample();
  assert.ok(Math.abs((input.moveX || 0) - 0.5) < 1e-8);
  assert.ok(Math.abs((input.moveY || 0) - 0.6875) < 1e-8);
  assert.equal(input.brake, true);
  assert.equal(controls.gamepadPressed(3), true);
  controls.sample();
  assert.equal(
    controls.gamepadPressed(3),
    false,
    "holding an action must not repeat it",
  );

  buttons[3] = { pressed: false, value: 0 };
  controls.sample();
  buttons[3] = { pressed: true, value: 1 };
  controls.sample();
  assert.equal(controls.gamepadPressed(3), true, "a new press must trigger again");
});
