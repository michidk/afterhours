import { test } from "node:test";
import assert from "node:assert/strict";
import { InputStamper } from "../client/network/lead.ts";
import { simulate, type Link } from "./support/link.ts";

const LINKS: Record<string, Link> = {
  lan: { base: 3, jitter: 1 },
  "74 ms, 40 ms jitter": { base: 37, jitter: 20 },
  "74 ms with stalls": { base: 37, jitter: 20, stall: [0.03, 150] },
};
const TICK = 1000 / 30;

// A browser timer that fires a little faster than 30 Hz used to queue one extra input per
// second at the server until a resync, so the "server input buffer" crept past 9 commands.
for (const hz of [30, 31, 32.3]) {
  for (const [name, link] of Object.entries(LINKS)) {
    test(`inputs stay about two ticks ahead at ${hz} Hz sends over ${name}`, () => {
      const r = simulate(link, 60, 1, new InputStamper(), 1000 / hz);
      assert.ok(r.lead < 3.2, `lead ${r.lead.toFixed(2)} ticks`);
      assert.ok(r.age < 115, `input age ${r.age.toFixed(0)} ms`);
      assert.ok(r.dropped < 0.03, `${(r.dropped * 100).toFixed(1)}% dropped`);
    });
  }
}

test("one input per tick: a fast timer skips slots instead of queueing them", () => {
  const stamper = new InputStamper();
  stamper.reset(0);
  const stamps = Array.from({ length: 200 }, (_, i) =>
    stamper.stamp((i * TICK * 0.9) / TICK),
  );
  const sent = stamps.filter((s) => s !== undefined) as number[];
  assert.ok(new Set(sent).size === sent.length, "a tick was stamped twice");
  assert.ok(sent.length < 200, "no slot was skipped");
});
