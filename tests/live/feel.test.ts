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
  maxCorrection: number;
  strike?: {
    predicted: boolean;
    confirmed: boolean;
    showsLateMs?: number;
    leadMs?: number;
  };
  actions?: {
    enterMs?: number;
    steerMs?: number;
    enterSamples: number;
    steerSamples: number;
  };
  clientCpuMs: {
    draw: { mean: number; p95: number; max: number };
    input: { mean: number; p95: number; max: number };
  };
  server?: { tickCpuP95Ms: number; tickP95Ms: number; late: number };
}

interface Booted {
  child: ChildProcess;
  url: string;
}
let city: Booted;
let world: Booted;
let worldFile: string;
let dir: string;

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

/** Starts the Rust server on a free port and waits until it answers. */
async function boot(env: Record<string, string>): Promise<Booted> {
  const port = await freePort();
  const child = spawn("cargo", ["run", "-q", "--release", "-p", "afterhours-server"], {
    env: { ...process.env, PORT: String(port), ALLOW_DEBUG: "1", ...env },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 600_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/health`)).ok) return { child, url };
    } catch {
      // still compiling, generating or booting
    }
    if (Date.now() > deadline) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 500));
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "afterhours-feel-"));
  worldFile = join(dir, "world.json");
  // The real city serves the files on disk; the test world is generated on boot into `dir`.
  [city, world] = await Promise.all([
    boot({ CITY_REGENERATE: "0" }),
    boot({
      TEST_WORLD: "1",
      CITY_PATH: worldFile,
      CITY_MESH_PATH: join(dir, "world.msgpack"),
    }),
  ]);
});

after(() => {
  city?.child.kill();
  world?.child.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Runs the bot with `argv` against a server and returns its report. */
async function bot(name: string, argv: string[], target: Booted): Promise<Report> {
  const json = join(dir, `${name}.json`);
  await run(
    "bunx",
    [
      "tsx",
      "scripts/drive-client.ts",
      ...["--url", target.url, "--json", json],
      ...argv,
    ],
    { timeout: (seconds + 90) * 1000, maxBuffer: 1 << 24 },
  );
  const report = JSON.parse(readFileSync(json, "utf8")) as Report;
  console.log(name, JSON.stringify(report));
  return report;
}

/** A lap of the city's racetrack on foot or in a car. */
const drive = (name: string, args: string[]) =>
  bot(name, ["--pattern", "track", "--seconds", String(seconds), ...args], city);

const share = (count: number, report: Report) => count / Math.max(1, report.frames);

function feels(r: Report, minSpeed: number, spiky = false) {
  assert.ok(r.frames > seconds * 20, `only ${r.frames} frames measured`);
  assert.ok(r.topSpeed > minSpeed, `never got moving: top speed ${r.topSpeed}`);
  // The draw carries the body on by up to one 30 Hz tick, so a healthy mean is about half a
  // tick of travel; the bug that drew the server copy had a mean of about 4 m. A 150 ms spike
  // makes the server hold the last controls and the late inputs correct the prediction by up to
  // a metre, so only the clean link is held to the worst case: the carry is capped at two ticks,
  // which a late frame (1 run in 6 here) reaches, so that cap is the limit.
  const tickOfTravel = r.topSpeed / 30;
  assert.ok(
    r.drawnGapMean < tickOfTravel,
    `drawn ${r.drawnGapMean} m from the predicted body on average (one tick is ${tickOfTravel.toFixed(2)} m)`,
  );
  assert.ok(
    r.drawnGapMax < (spiky ? 2 : 2 * tickOfTravel + 0.1),
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
  // The client's own cost per frame (prediction and draw list) and per input: about 1 ms each
  // here, with 12-20 ms stalls now and then that this loaded host adds (not the game: nothing was
  // added to the physics world at those steps). A slow machine multiplies the cost, so the mean
  // is held to a few ms; a 6 ms regression in the draw list reads 6+ here.
  assert.ok(
    r.clientCpuMs.draw.mean < 3,
    `draw list ${r.clientCpuMs.draw.mean} ms on average`,
  );
  assert.ok(
    r.clientCpuMs.input.mean < 4,
    `predicting ${r.clientCpuMs.input.mean} ms on average`,
  );
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

// Trees, palms and lamps stood only on the server: the prediction drove through them and showed
// the break a round trip late, and the physics stopped a fast car dead instead of breaking them.
// The test world's prop alley has a clear run-up to each, so the hit is the same every time.
for (const [kind, skip, args] of [
  ["lamp", 0, []],
  ["tree", 0, []],
  ["lamp", 1, laggy],
  ["palm", 0, laggy],
] as const) {
  test(`driving into a ${kind}${args.length ? " on the laggy link" : ""} breaks it at the impact`, async () => {
    const r = await bot(
      `strike-${kind}-${skip}${args.length ? "-laggy" : ""}`,
      [
        ...["--city", worldFile, "--model", "sedan", "--pattern", "straight"],
        ...[
          "--strike",
          kind,
          "--strike-skip",
          String(skip),
          "--seconds",
          "14",
          ...args,
        ],
      ],
      world,
    );
    assert.ok(r.strike?.confirmed, "the server never broke it: the car stopped dead?");
    assert.ok(r.strike.predicted, "the client did not predict the break");
    // It showed 100-230 ms after the car reached it before: now at the impact.
    assert.ok(
      r.strike.showsLateMs! <= 60,
      `shown ${r.strike.showsLateMs} ms after the impact`,
    );
    assert.ok(
      r.strike.leadMs! > 30,
      `predicted only ${r.strike.leadMs} ms ahead of the server`,
    );
    assert.ok(r.corrections <= 5, `${r.corrections} corrections around the hit`);
    assert.ok(
      r.maxCorrection < 1.5,
      `the hit corrected the car by ${r.maxCorrection} m`,
    );
  });
}

// What the player waits for after a key press, measured on the drawn frames (the Networking
// panel's Enter / exit and Turn response rows). A plane is not predicted, so these include the
// link and the whole snapshot path: before the urgent snapshot after enter/exit and drawing the
// piloted craft from the newest snapshot they were 202/193 ms clean and 368/445 ms laggy; the
// limits sit just above today's 145 and 160 ms clean, 245 and 245 ms laggy. Drawing the craft from
// the interpolated copy again gives a 225 and 380 ms turn, which fails them.
// Each plane is flown away by its run, so the two links use the two showroom planes.
for (const [label, model, args, enterLimit, steerLimit] of [
  ["clean", "plane", [], 200, 190],
  ["laggy", "aerobatic", laggy, 330, 320],
] as const) {
  test(`entering, leaving and turning a plane on a ${label} link show on screen quickly`, async () => {
    const r = await bot(
      `actions-${label}`,
      [
        ...["--city", worldFile, "--model", model, "--board", "--cycle", "3"],
        ...["--pattern", "weave", "--seconds", "55", ...args],
      ],
      world,
    );
    const a = r.actions!;
    assert.ok(a.enterSamples >= 5, `only ${a.enterSamples} enter/exit samples`);
    assert.ok(a.steerSamples >= 3, `only ${a.steerSamples} turn samples`);
    assert.ok(a.enterMs! <= enterLimit, `enter/exit took ${a.enterMs} ms`);
    assert.ok(a.steerMs! <= steerLimit, `the turn showed after ${a.steerMs} ms`);
  });
}
