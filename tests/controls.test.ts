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
