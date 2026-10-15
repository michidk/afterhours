import { test } from "node:test";
import assert from "node:assert/strict";
import { loadoutHTML } from "../client/ui/loadout.ts";

const item = (kind: "fists" | "pistol" | "smg", ammo = 0, reserve = 0) =>
  ({ id: kind, kind, ammo, reserve }) as const;

test("the weapon strip shows every slot, ammunition and the active weapon", () => {
  const html = loadoutHTML([item("fists"), item("pistol", 9, 36)], 1, false);
  assert.equal(html.match(/class="slot/g)?.length, 4);
  assert.match(
    html,
    /slot active"><kbd>2<\/kbd><span>Pistol<\/span><div><b>9<\/b><small>\/ 36</,
  );
  assert.match(html, /<kbd>1<\/kbd><span>Fists<\/span><div><small>melee/);
  assert.match(html, /slot none"><kbd>4/);
  assert.doesNotMatch(loadoutHTML([item("pistol", 1, 1)], 0, false), /reloading|dry/);
  assert.match(loadoutHTML([item("pistol", 1, 1)], 0, true), /active reloading/);
  assert.match(loadoutHTML([item("smg", 0, 0)], 0, false), /active dry/);
});
