// A bounded lag probe against an already running server.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const url = process.env.FEEL_URL ?? "http://127.0.0.1:46725";
const seconds = Number(process.env.FEEL_SECONDS ?? 8);

test("live lag probe reports bounded frame gaps and motion jitter", async () => {
  const json = `/tmp/afterhours-lag-${process.pid}.json`;
  try {
    await run(
      "bunx",
      [
        "tsx",
        "scripts/drive-client.ts",
        "--url",
        url,
        "--pattern",
        "track",
        "--model",
        "sedan",
        "--seconds",
        String(seconds),
        "--json",
        json,
      ],
      { timeout: (seconds + 15) * 1000, maxBuffer: 1 << 20 },
    );
    const report = JSON.parse(await readFile(json, "utf8")) as {
      frames: number;
      frameGapP95: number;
      frameGapMax: number;
      speedJitterP95: number;
      freezes: number;
      forwardLurches: number;
      backward: number;
      drawnGapMean: number;
      correctionsOver1m: number;
    };
    assert.ok(report.frames >= seconds * 20, `only ${report.frames} frames measured`);
    assert.ok(report.frameGapP95 < 30, `frame gap p95 ${report.frameGapP95} ms`);
    assert.ok(report.frameGapMax < 120, `frame gap max ${report.frameGapMax} ms`);
    assert.ok(report.speedJitterP95 < 0.5, `speed jitter p95 ${report.speedJitterP95}`);
    assert.ok(
      report.freezes / report.frames < 0.08,
      `${report.freezes}/${report.frames} frames stalled`,
    );
    assert.ok(
      report.forwardLurches / report.frames < 0.08,
      `${report.forwardLurches}/${report.frames} frames lurched`,
    );
    assert.ok(
      report.backward / report.frames < 0.05,
      `${report.backward}/${report.frames} frames moved backward`,
    );
    assert.ok(report.drawnGapMean < 0.75, `drawn lag ${report.drawnGapMean} m`);
    assert.equal(report.correctionsOver1m, 0, "prediction correction exceeded 1 m");
  } finally {
    await rm(json, { force: true });
  }
});
