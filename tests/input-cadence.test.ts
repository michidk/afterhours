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
    assert.equal(report.timerFirings, 20, "both heartbeat timers use virtual time");
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

for (const serverSlow of [8, 16, 30])
  test(`driving follows a slow server without shedding inputs or resetting at ${serverSlow} ms extra per tick`, async () => {
    const report = await probeDriving({
      profile: "lan",
      serverSlow,
      seconds: 20,
    });
    const detail = JSON.stringify(report);
    assert.equal(report.server.dropped, 0, detail);
    assert.equal(report.client.corrections, 0, detail);
    assert.ok(report.cruise.frames > 200, detail);
    assert.equal(report.cruise.backward, 0, detail);
    assert.equal(report.cruise.surges, 0, detail);
    assert.equal(report.cruise.dips, 0, detail);
    assert.ok(
      Math.abs(report.cruise.meanStep - report.cruise.expectedStep) < 0.02,
      detail,
    );
  });

test("virtual driving repeats the same packet sequence and heartbeat schedule", async () => {
  const options = { profile: "wan", seconds: 6 } as const;
  const first = await probeDriving(options);
  const second = await probeDriving(options);
  assert.equal(first.timerFirings, 12);
  assert.deepEqual(second, first);
});

test("driving survives slowdown after entering cruise and recovers its normal speed", async () => {
  const report = await probeDriving({
    profile: "lan",
    seconds: 25,
    serverSlow: 30,
    serverSlowWindow: { from: 5, until: 15 },
  });
  const detail = JSON.stringify(report);
  assert.equal(report.server.dropped, 0, detail);
  assert.equal(report.client.corrections, 0, detail);
  assert.equal(report.cruise.backward, 0, detail);
  assert.equal(report.cruise.surges, 0, detail);
  assert.ok(report.recovered && report.recovered.frames > 200, detail);
  assert.equal(report.recovered.backward, 0, detail);
  assert.equal(report.recovered.surges, 0, detail);
  assert.equal(report.recovered.dips, 0, detail);
  assert.ok(Math.abs(report.recovered.meanStep - 0.832) < 0.02, detail);
});

test("a helicopter at full speed over a jittery link draws at a steady speed", async () => {
  const report = await probeDriving({ profile: "spiky", model: "scout", seconds: 15 });
  const detail = JSON.stringify({ client: report.client, cruise: report.cruise });
  assert.equal(report.client.corrections, 0, detail);
  // Input pacing changes on every server report must not reach the drawn speed.
  assert.equal(report.cruise.hitches, 0, detail);
  assert.ok(report.cruise.jerkMax < 0.03, detail);
  assert.equal(report.cruise.backward, 0, detail);
});

test("driving rides out a 220 ms delivery spike without stopping or shedding the returning batch", async () => {
  const report = await probeDriving({
    profile: { base: 40, spread: 30, spike: 220, p: 0.04 },
    seconds: 15,
  });
  const detail = JSON.stringify(report);
  assert.equal(report.server.dropped, 0, detail);
  assert.equal(report.client.corrections, 0, detail);
  assert.equal(report.cruise.surges, 0, detail);
  assert.equal(report.cruise.dips, 0, detail);
});

for (const wakeup of [280, 400])
  test(`held driving keeps real-time speed through ${wakeup} ms input wakeups`, async () => {
    const report = await probeDriving({ profile: "lan", seconds: 10, wakeup });
    const detail = JSON.stringify(report);
    assert.ok(report.inputsSent >= 290, detail);
    assert.equal(report.server.dropped, 0, detail);
    assert.equal(report.server.frozen, 0, detail);
    assert.equal(report.cruise.backward, 0, detail);
    assert.ok(Math.abs(report.cruise.meanStep - 0.832) < 0.02, detail);
  });

test("acceleration does not rewind when browser input and snapshots arrive in batches", async () => {
  const report = await probeDriving({
    profile: "none",
    model: "sedan",
    wakeup: 280,
    batchIncoming: true,
    snapshotDelay: 150,
    startAfter: 5,
    seconds: 12,
  });
  const detail = JSON.stringify(report);
  assert.equal(report.server.mispredicted, 0, detail);
  assert.equal(report.server.dropped, 0, detail);
  assert.equal(report.client.corrections, 0, detail);
  assert.ok(report.finalAuthorityZ > 170, detail);
});
