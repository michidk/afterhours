import { test } from "node:test";
import assert from "node:assert/strict";
import { claimsKey, typingIn } from "../client/input/focus.ts";

const field = (tagName: string, visible: boolean) => ({
  tagName,
  getClientRects: () => ({ length: visible ? 1 : 0 }),
});

test("a visible text field has the keyboard, a hidden or other element does not", () => {
  assert.equal(typingIn(field("INPUT", true)), true);
  assert.equal(typingIn(field("TEXTAREA", true)), true);
  // The character screen's name box after joining: still the active element, display none.
  assert.equal(typingIn(field("INPUT", false)), false);
  assert.equal(typingIn(field("CANVAS", true)), false);
  assert.equal(typingIn(field("BUTTON", true)), false);
  assert.equal(typingIn(null), false);
});

test("the page claims game keys unless a browser shortcut is held", () => {
  const key = (
    code: string,
    mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey", true>> = {},
  ) => claimsKey({ code, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  for (const code of ["KeyA", "KeyW", "KeyF", "Digit2", "Space", "ArrowLeft", "F1"])
    assert.equal(key(code), true, code);
  assert.equal(key("KeyR", { metaKey: true }), false, "Cmd+R reloads the page");
  assert.equal(key("KeyL", { ctrlKey: true }), false);
  for (const code of ["Tab", "Enter", "Digit9", "ShiftLeft", "F5"])
    assert.equal(key(code), false, code);
});

test("the frame window reports the median rate and the slowest frame of the last five seconds", async () => {
  const { FrameWindow } = await import("../client/performance/index.ts");
  const w = new FrameWindow();
  for (let i = 0; i < 60; i++) w.record(10_000 + i * 16, 16);
  w.record(11_000, 250);
  assert.ok(Math.abs(w.stats.fps - 62.5) < 0.1, `${w.stats.fps}`);
  assert.equal(w.stats.worstMs, 250);
  w.record(17_000, 16); // the slow frame is now over five seconds old
  assert.equal(w.stats.worstMs, 16);
});
