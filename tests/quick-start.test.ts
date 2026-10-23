import { test } from "node:test";
import assert from "node:assert/strict";
import { quickStart } from "../client/ui/quick-start.ts";

test("?play skips the character screen, ?name sets the name", () => {
  assert.equal(quickStart(""), undefined);
  assert.equal(quickStart("?name=Ann"), undefined);
  assert.equal(quickStart("?play=0"), undefined);
  assert.deepEqual(quickStart("?play"), { name: undefined });
  assert.deepEqual(quickStart("?play=1&name=Tester"), { name: "Tester" });
  assert.deepEqual(quickStart("?play&name=%20%20"), { name: undefined });
  assert.equal(
    quickStart("?play&name=abcdefghijklmnopqrstuvwxyz")?.name,
    "abcdefghijklmnopqr",
  );
});
