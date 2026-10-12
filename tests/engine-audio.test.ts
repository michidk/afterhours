import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { GameAudio } from "../client/audio/index.ts";
import { SOUND_BANKS } from "../client/audio/banks.ts";
import type { Entity } from "../shared/world.ts";

test("sound preloading downloads every clip once with at most four requests in flight", async (t) => {
  const requested: string[] = [];
  let active = 0,
    maximum = 0;
  const server = createServer(async (req, res) => {
    requested.push(req.url ?? "");
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    res.end(Buffer.from([1, 2, 3, 4]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const fetchClip = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    fetchClip(new URL(String(input), `http://127.0.0.1:${address.port}`), init),
  );
  try {
    const audio = new GameAudio(),
      loading = audio.preload();
    assert.equal(audio.preload(), loading);
    await loading;
    const expected = [...new Set(Object.values(SOUND_BANKS).flatMap((b) => b.files))]
      .map((name) => `/audio/${name}.wav`)
      .sort();
    assert.deepEqual(requested.sort(), expected);
    assert.ok(maximum <= 4, "sound downloads must not exceed four concurrent requests");
    assert.deepEqual(audio.diagnostics.failed, []);
    await audio.preload();
    assert.equal(requested.length, expected.length);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("pushing idle vehicles never starts engines; powering and shutdown control loops", () => {
  const listener: Entity = {
    id: "p",
    kind: "player",
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    angle: 0,
    color: "#ffffff",
    health: 100,
  };
  for (const kind of ["car", "helicopter", "plane"] as const) {
    let starts = 0,
      stops = 0;
    const parameter = { setTargetAtTime() {} };
    const audio = new GameAudio();
    Object.assign(audio, {
      context: { currentTime: 0, state: "running" },
      voice: (sound: string) => ({
        sound,
        rate: 1,
        variation: 1,
        cutoff: 16000,
        filter: { frequency: parameter },
        source: {
          buffer: { duration: 1 },
          start() {
            starts++;
          },
          stop() {
            stops++;
          },
          playbackRate: parameter,
        },
        gain: { gain: parameter },
        pan: { pan: parameter },
      }),
    });
    const body: Entity = { ...listener, id: "v", kind, vz: 3, flight: "grounded" };
    audio.update([body], listener, 1);
    assert.equal(starts, 0, `${kind} pushed with its engine off`);
    body.driver = listener.id;
    if (kind === "helicopter") body.flight = "takingOff";
    audio.update([body], listener, 1);
    assert.equal(starts, 1, `${kind} powered`);
    body.driver = undefined;
    body.flight = "falling";
    audio.update([body], listener, 1);
    assert.equal(stops, 1, `${kind} abandoned`);
    body.driver = listener.id;
    body.wreck = 180;
    audio.update([body], listener, 1);
    assert.equal(starts, 1, `${kind} wrecked`);
  }
});

test("observer jetpacks attenuate with distance while local parachute wind stays audible", () => {
  const listener: Entity = {
    id: "listener",
    kind: "player",
    x: 0,
    y: 20,
    z: 0,
    vx: 0,
    vy: -4,
    vz: 0,
    angle: 0,
    color: "#ffffff",
    health: 100,
    parachute: true,
  };
  const gains = new Map<string, number>();
  const audio = new GameAudio();
  const parameter = { setTargetAtTime() {} };
  Object.assign(audio, {
    context: { currentTime: 0, state: "running" },
    voice: (sound: string) => ({
      sound,
      rate: 1,
      variation: 1,
      cutoff: 16000,
      filter: { frequency: parameter },
      pan: { pan: parameter },
      gain: {
        gain: {
          setTargetAtTime(value: number) {
            gains.set(sound, value);
          },
        },
      },
      source: {
        buffer: { duration: 1 },
        start() {},
        stop() {},
        playbackRate: parameter,
      },
    }),
  });
  const flyer = {
    ...listener,
    id: "flyer",
    vy: 3,
    parachute: undefined,
    jetpack: { active: true, fuel: 45 },
  };
  audio.update([flyer], listener, 1);
  const near = gains.get("jetpack")!;
  assert.ok(near > 0);
  flyer.x = 20;
  audio.update([flyer], listener, 1);
  assert.ok(gains.get("jetpack")! < near);
  flyer.x = 100;
  audio.update([flyer], listener, 1);
  assert.ok(!audio.diagnostics.loopSounds.includes("jetpack"));
  assert.ok(audio.diagnostics.loopSounds.includes("wind"));
});
