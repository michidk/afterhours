import { test } from "node:test";
import assert from "node:assert/strict";
import { probeDriving } from "../scripts/drive-probe.ts";
import { TUNING } from "../shared/catalog.ts";

// Full-speed driving over jittered links and mismatched clocks. Before the held-slot
// policy, every late or bunched packet cost a one-tick correction (1.7 m at 52 m/s);
// the server now applies exactly the commands the client sent, and an observer on a
// clean link sees the car move every frame.
for (const scenario of [
  { profile: "spiky", serverSlow: 0 },
  { profile: "wan", serverSlow: 0 },
  { profile: "lan", serverSlow: 1 },
  { profile: "lan", serverSlow: -1 },
] as const)
  test(`full-speed driving stays correction-free on a ${scenario.profile} link with a ${scenario.serverSlow} ms server clock error`, async () => {
    const report = await probeDriving({ ...scenario, seconds: 10, wakeup: 16 });
    const detail = JSON.stringify(report);
    assert.ok(report.cruise.frames > 200, `reaches cruise: ${detail}`);
    assert.equal(report.client.corrections, 0, detail);
    assert.equal(report.server.dropped, 0, "no commands shed");
    assert.equal(
      report.server.mispredicted,
      0,
      "held controls matched the late commands",
    );
    assert.ok(
      report.server.maxAhead < 30,
      `the regulated clock ends held-slot runs before the server must: ${report.server.maxAhead}`,
    );
    assert.equal(report.server.frozen, 0, "no skipped ticks for a regulated client");
    assert.ok(
      report.applied <= report.inputsSent + report.server.speculated,
      "authority never acknowledges beyond sent commands plus slots owed",
    );
    assert.equal(report.cruise.backward, 0, "display never reverses");
    assert.equal(report.cruise.surges, 0, "display never lurches a tick ahead");
    assert.equal(report.cruise.dips, 0, "display never stalls for a frame");
    assert.ok(report.remote.frames > 200, `observer sees the cruise: ${detail}`);
    assert.equal(report.remote.backward, 0, "observer never sees the car reverse");
    assert.equal(report.remote.dips, 0, `observer never sees the car stall: ${detail}`);
    assert.equal(
      report.remote.surges,
      0,
      `observer never sees the car jump: ${detail}`,
    );
  });

test("the regulated input clock keeps spare commands buffered at the server", async () => {
  const regulated = await probeDriving({ profile: "lan", seconds: 6, wakeup: 16 });
  assert.ok(
    regulated.server.queueDepthMean >= TUNING.inputBuffer &&
      regulated.server.queueDepthMean <= TUNING.inputBuffer + 2,
    `buffer settles near the target: ${regulated.server.queueDepthMean}`,
  );
  assert.equal(regulated.server.speculated, 0, "no held slots on a calm link");
});
