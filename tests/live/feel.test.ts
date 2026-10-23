// What the player sees, end to end: a real server, the real client network and prediction
// code driven by scripts/drive-client.ts, over clean and bad links. Every check is about a
// number the player would feel, never a proxy:
//   drawnGap          the drawn body is the predicted one, at most a tick ahead of it (it was
//                     4 m behind at 18 m/s)
//   freezes/lurches   one tick of motion per frame, not a stall and a double jump
//   groundClearance   wheels and feet are drawn on the ground
//   corrections       the server rarely disagrees with the prediction
//   server tick       the tick fits its 33 ms budget
// Frame-pacing limits are shares of frames, loose enough for a loaded machine but far below
// the 50% stall/lurch the draw path had when it stepped at 30 Hz. See docs/testing.md.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const seconds = Number(process.env.FEEL_SECONDS ?? 20);

interface Report {
  frames: number;
  freezes: number;
  forwardLurches: number;
  backward: number;
  corrections: number;
  correctionsOver1m: number;
  maxPending: number;
  topSpeed: number;
  drawnGapMean: number;
  drawnGapMax: number;
  rosterSize: number;
  positionsSeen: number;
  groundClearanceP95: number;
  server?: { tickCpuP95Ms: number; tickP95Ms: number; late: number };
}

let server: ChildProcess;
let url: string;
let dir: string;

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "afterhours-feel-"));
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  server = spawn("cargo", ["run", "-q", "--release", "-p", "afterhours-server"], {
    env: { ...process.env, PORT: String(port), CITY_REGENERATE: "0", ALLOW_DEBUG: "1" },
    stdio: "ignore",
  });
  const deadline = Date.now() + 600_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      // still compiling or booting
    }
    if (Date.now() > deadline) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 500));
  }
});

after(() => {
  server?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function drive(name: string, args: string[]): Promise<Report> {
  const json = join(dir, `${name}.json`);
  await run(
    "bunx",
    [
      "tsx",
      "scripts/drive-client.ts",
      ...["--url", url, "--pattern", "track", "--seconds", String(seconds)],
      ...["--json", json, ...args],
    ],
    { timeout: (seconds + 90) * 1000, maxBuffer: 1 << 24 },
  );
  const report = JSON.parse(readFileSync(json, "utf8")) as Report;
  console.log(name, JSON.stringify(report));
  return report;
}

const share = (count: number, report: Report) => count / Math.max(1, report.frames);

function feels(r: Report, minSpeed: number, spiky = false) {
  assert.ok(r.frames > seconds * 20, `only ${r.frames} frames measured`);
  assert.ok(r.topSpeed > minSpeed, `never got moving: top speed ${r.topSpeed}`);
  // The draw carries the body on by up to one 30 Hz tick, so a healthy mean is about half a
  // tick of travel; the bug that drew the server copy had a mean of about 4 m. A 150 ms spike
  // makes the server hold the last controls and the late inputs correct the prediction by up to
  // a metre, so only the clean link is held to the worst case.
  const tickOfTravel = r.topSpeed / 30;
  assert.ok(
    r.drawnGapMean < tickOfTravel,
    `drawn ${r.drawnGapMean} m from the predicted body on average (one tick is ${tickOfTravel.toFixed(2)} m)`,
  );
  assert.ok(
    r.drawnGapMax < (spiky ? 2 : tickOfTravel + 0.25),
    `drawn ${r.drawnGapMax} m from the predicted body at worst`,
  );
  assert.ok(share(r.freezes, r) < 0.08, `${r.freezes}/${r.frames} frames stalled`);
  assert.ok(share(r.forwardLurches, r) < 0.08, `${r.forwardLurches} lurches`);
  assert.ok(share(r.backward, r) < 0.05, `${r.backward} frames moved backward`);
  assert.ok(
    r.groundClearanceP95 < 0.6,
    `drawn ${r.groundClearanceP95} m off the ground`,
  );
  assert.ok(
    r.corrections <= (spiky ? 15 : 3),
    `${r.corrections} prediction corrections`,
  );
  assert.equal(r.correctionsOver1m, 0, "the prediction was off by over a metre");
  assert.ok(r.maxPending <= 20, `${r.maxPending} inputs waiting for the server`);
  // The player list reads "Connecting…" until the roster arrives.
  assert.ok(r.rosterSize >= 1, "no player roster reached the client");
  assert.ok(r.positionsSeen >= 1, "no player positions reached the client");
  assert.ok(r.server, "no server diagnostics (is debug enabled?)");
  assert.ok(
    r.server.tickCpuP95Ms < 20,
    `server tick ${r.server.tickCpuP95Ms} ms of CPU (95th percentile)`,
  );
}

const laggy = ["--delay", "37", "--jitter", "20", "--spike", "150"];
for (const [label, model, speed] of [
  ["walking", "none", "4.5"],
  ["sprinting", "none", "8"],
  ["driving a sedan", "sedan", "18"],
] as const) {
  test(`${label} on a clean link`, async () => {
    feels(
      await drive(`${label}-clean`.replaceAll(" ", "-"), [
        "--model",
        model,
        "--speed",
        speed,
      ]),
      model === "none" ? 4 : 12,
    );
  });
  test(`${label} on a 74 ms link with jitter and 150 ms spikes`, async () => {
    feels(
      await drive(`${label}-laggy`.replaceAll(" ", "-"), [
        "--model",
        model,
        "--speed",
        speed,
        ...laggy,
      ]),
      model === "none" ? 4 : 12,
      true,
    );
  });
}
