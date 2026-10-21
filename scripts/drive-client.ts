// Live second client. Joins any running AFTERHOURS server with the real browser
// networking stack (GameNetwork, prediction, input clock), spawns a car on a
// debug-enabled server, drives it at full speed, and reports every correction a
// player on that link would feel. Optional one-way delay, jitter and spikes are
// injected on this client's socket only, so it can sit next to a real browser
// session on the same server. Example:
//   bun run bot:drive -- --url http://localhost:5173 --delay 60 --jitter 40 --spike 150
import { setTimeout as pause } from "node:timers/promises";
import { WebSocket as NodeWebSocket } from "ws";
import { GameNetwork } from "../client/network/index.ts";
import { InputClock } from "../client/input/clock.ts";
import { OrderedDelay } from "./ordered-delay.ts";
import { appendFileSync, existsSync } from "node:fs";
import { CityStream } from "../client/world/stream.ts";
import {
  mapManifestSchema,
  cityWaterSchema,
  type ClientMap,
} from "../shared/city-stream.ts";
import { unpackHeights } from "../shared/city-pack.ts";
import { TERRAIN_SIDE } from "../shared/terrain.ts";
import { idle, spawnOrigin, type Input } from "../shared/world.ts";
import { debugCommandSchema } from "../shared/debug.ts";
import { VEHICLES } from "../shared/catalog.ts";
import { CAR, clamp, wrap } from "../shared/physics/vehicle.ts";
import { groundLevel } from "../shared/water.ts";
import { Worker } from "node:worker_threads";
import { ChunkDecoder, type ChunkReply } from "../client/world/chunk-decoder.ts";

// Node's built-in WebSocket does not support the browser event surface used by GameNetwork.
globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const url = new URL(arg("url", "http://localhost:5173"));
const name = arg("name", "Drive bot");
const model = arg("model", "sport");
const seconds = Number(arg("seconds", "60"));
const delay = Number(arg("delay", "0"));
const jitter = Number(arg("jitter", "0"));
const spike = Number(arg("spike", "0"));
const spikeRate = Number(arg("spike-rate", "0.03"));
const pattern = arg("pattern", "loop");
const regulate = arg("regulate", "1") === "1";
const targetSpeed = Number(arg("speed", "20"));
if (
  ![seconds, targetSpeed].every((value) => Number.isFinite(value) && value > 0) ||
  ![delay, jitter, spike].every((value) => Number.isFinite(value) && value >= 0) ||
  !Number.isFinite(spikeRate) ||
  spikeRate < 0 ||
  spikeRate > 1
)
  throw Error(
    "Durations and speed must be positive; link delays nonnegative; spike-rate in [0, 1]",
  );
const spawnCommand =
  model === "none" ? undefined : debugCommandSchema.parse({ kind: "spawn", model });
const vehicleModel = spawnCommand?.kind === "spawn" ? spawnCommand.model : undefined;
const kind = vehicleModel ? VEHICLES[vehicleModel].kind : "none";
if (kind !== "none" && kind !== "car" && kind !== "helicopter" && kind !== "plane")
  throw Error(
    `--model must be a car, plane or helicopter model or "none", got ${model}`,
  );
/** A helicopter climbs first, then flies straight; only the cruise is measured. */
const flying = kind === "helicopter",
  climbSeconds = 4,
  warmup = flying ? climbSeconds + 4 : 0;

const output = arg("output", "");
const request = async (path: string) => {
  const response = await fetch(new URL(path, url), {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`${path}: HTTP ${response.status}`);
  return response;
};
const map: ClientMap = mapManifestSchema.parse(await (await request("/city")).json());
if (map.hasTerrain) {
  const heights = unpackHeights(
    new Uint8Array(await (await request(`/city/terrain/${map.mapId}`)).arrayBuffer()),
  );
  if (heights.length !== TERRAIN_SIDE ** 2) throw Error("Incomplete terrain");
  map.terrain = { heights };
}
if (map.hasWater)
  map.water = cityWaterSchema.parse(
    await (await request(`/city/water/${map.mapId}`)).json(),
  );
const chunkWorker = new Worker(new URL("./chunk-worker.mjs", import.meta.url));
const decoder = new ChunkDecoder((request) => chunkWorker.postMessage(request));
chunkWorker.on("message", (reply: ChunkReply) => decoder.receive(reply));
chunkWorker.on("error", (error) => decoder.fail(error));
const stream = new CityStream(
  map,
  () => {},
  (path, options) => fetch(new URL(String(path), url), options),
  decoder.decode,
);
const city = stream.city;
const radius = Number(arg("radius", "50"));
if (!Number.isFinite(radius) || radius <= 0) throw Error("--radius must be positive");
// Use the generated spawn lane for vehicle probes. The airport is flat but its
// decorative terminal colliders can overlap a debug car, which measures a wall
// collision instead of driving and makes the lag result meaningless.
const origin = spawnOrigin(city);
const center = {
  x: Number(arg("x", String(origin.x))),
  z: Number(arg("z", String(origin.z))),
};
await stream.prepare(spawnOrigin(city));
await stream.prepare(center);
const mapId = map.mapId;
Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { protocol: url.protocol, host: url.host },
});
let seed = 97;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const oneWay = () => delay + rand() * jitter + (rand() < spikeRate ? spike : 0);

let recording = false;
let serverMap = "",
  debugAllowed = false;
const network = new GameNetwork(
  {
    welcome(m) {
      serverMap = m.map.mapId;
      debugAllowed = m.debug;
    },
    state() {},
    chat() {},
    status(state) {
      console.error(`[status] ${state}: ${network.stats().lastDisconnect ?? ""}`);
      if (recording && output)
        appendFileSync(
          output,
          JSON.stringify({ type: "status", at: Date.now(), state }) + "\n",
        );
    },
  },
  name,
  "#e07a5f",
  city,
);
network.worldReady = (point) => stream.ready(point);
const clock = new InputClock();
if (regulate) network.clock = clock;
network.connect();
const until = async (check: () => boolean, what: string, ms = 15000) => {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw Error(`Timed out: ${what}`);
    await pause(10);
  }
};
await until(() => !!network.prediction?.body, "join");
if (serverMap !== mapId)
  throw Error(
    `Server map ${serverMap} differs from local ${mapId}; prediction needs the same artifact (CITY_PATH)`,
  );
// Inject the link impairment on this socket only, preserving order like TCP does.
const socket = network.socket!;
const send = socket.send.bind(socket),
  receive = socket.onmessage!;
const outgoing = new OrderedDelay(),
  incoming = new OrderedDelay();
let outgoingAt = 0,
  incomingAt = 0;
socket.send = (data) => {
  outgoingAt = Math.max(outgoingAt, performance.now() + oneWay());
  outgoing.schedule(outgoingAt, () => {
    if (socket.readyState === WebSocket.OPEN) send(data);
  });
};
socket.onmessage = (event) => {
  incomingAt = Math.max(incomingAt, performance.now() + oneWay());
  incoming.schedule(incomingAt, () => {
    receive.call(socket, event);
    recordCorrection();
  });
};

let recordedCorrection: object | undefined;
function recordCorrection() {
  const correction = network.prediction?.lastCorrection;
  if (correction === recordedCorrection) return;
  recordedCorrection = correction;
  if (recording && output && correction && correction.distance > 0.3)
    appendFileSync(
      output,
      JSON.stringify({
        type: "correction",
        at: Date.now(),
        distance: correction.distance,
      }) + "\n",
    );
}

let control: Input = idle();
let maxInputLag = 0;
let lastPump = performance.now();
const pump = setInterval(() => {
  const now = performance.now();
  maxInputLag = Math.max(maxInputLag, now - lastPump - 5);
  lastPump = now;
  clock.advance(now, (timestamp) => {
    maxInputLag = Math.max(maxInputLag, now - timestamp);
    network.input(control, timestamp);
    recordCorrection();
  });
}, 5);
// The server rate-limits debug commands to one per 100 ms.
const debug: typeof network.debug = async (command) => {
  await pause(150);
  return network.debug(command);
};
let bodyId = network.playerId;
if (arg("gate", "") && debugAllowed)
  await debug({ kind: "teleport", x: center.x, z: center.z, near: true });
await stream.prepare(network.prediction!.body!);
if (spawnCommand) {
  if (!debugAllowed)
    throw Error(
      "Spawning a vehicle needs a debug-enabled server (dev, or ALLOW_DEBUG=1)",
    );
  await debug({ kind: "teleport", x: center.x, z: center.z, near: true });
  const before = new Set((await debug({ kind: "state" })).entities.map((e) => e.id));
  const spawned = await debug(spawnCommand);
  const car = spawned.entities.find((e) => e.model === model && !before.has(e.id));
  if (!car) throw Error("spawn produced no car");
  await debug({ kind: "teleport", x: car.x + 3, z: car.z });
  // The first snapshot after a spawn may still carry the character's previous
  // position. Retry the edge action across a few snapshots so the probe measures
  // vehicle prediction rather than a flaky boarding race.
  for (let attempt = 0; attempt < 4; attempt++) {
    network.send({ type: "interact" });
    await pause(500);
    if (network.entities.get(network.playerId)?.vehicle === car.id) break;
  }
  await until(
    () => network.entities.get(network.playerId)?.vehicle === car.id,
    "board the car",
  );
  bodyId = car.id;
}
// Setup teleports are hard resets; measure only the drive.
await pause(300);
network.prediction!.corrections = 0;
const gate = arg("gate", "");
if (gate) {
  await stream.prepare(network.prediction!.body!);
  appendFileSync(
    output,
    JSON.stringify({ type: "ready", at: Date.now(), bodyId }) + "\n",
  );
  await until(() => existsSync(gate), "all five clients ready", 180000);
}
recording = true;
const limit = vehicleModel ? VEHICLES[vehicleModel].speed : 8;
maxInputLag = 0;
const started = performance.now();
// Proportional steering (as a gamepad would send) around the airfield centre keeps a
// full-speed car alive for minutes; keyboard full lock at 52 m/s spins it into scenery.
const circle = Math.min(1, Math.atan(2.7 / radius) / CAR.steer);
const steer = (t: number): Partial<Input> => {
  if (pattern === "straight") return {};
  if (pattern === "zigzag") return { moveX: t % 6 >= 3 ? -circle : circle, moveY: 1 };
  const body = network.prediction?.body;
  if (!body) return {};
  const speed = Math.hypot(body.vx, body.vz);
  const turnCenter = { x: center.x + radius, z: center.z };
  const angle = Math.atan2(body.x - turnCenter.x, body.z - turnCenter.z);
  const lookahead = Math.max(6, speed * 0.5) / radius;
  const target = {
    x: turnCenter.x + Math.sin(angle + lookahead) * radius,
    z: turnCenter.z + Math.cos(angle + lookahead) * radius,
  };
  const heading = Math.atan2(target.x - body.x, target.z - body.z);
  if (kind === "none")
    return { up: false, moveX: Math.sin(heading), moveY: Math.cos(heading) };
  return {
    moveX: clamp(
      wrap(heading - body.angle) * 1.5 - (body.angularVelocity ?? 0) * 0.3,
      -1,
      1,
    ),
    moveY: kind === "plane" ? 1 : clamp((targetSpeed - speed) * 0.3, -0.5, 1),
  };
};
const summary = {
  frames: 0,
  /** Frames whose drawn speed differs from the body's speed by over 10%. */
  hitches: 0,
  /** 95th percentile and worst relative error of the drawn per-frame speed. */
  speedErrorP95: 0,
  speedErrorMax: 0,
  /** 95th percentile and worst change of the drawn speed between consecutive frames: stutter. */
  speedJitterP95: 0,
  speedJitterMax: 0,
  /** Drawn vertical movement per frame in metres beyond what the body's climb explains. */
  verticalWobbleMax: 0,
  backward: 0,
  forwardLurches: 0,
  freezes: 0,
  maxStep: 0,
  corrections: 0,
  correctionsOver1m: 0,
  maxCorrection: 0,
  maxPending: 0,
  topSpeed: 0,
};
let previousPose: { x: number; y: number; z: number; at: number } | undefined;
const speedErrors: number[] = [],
  speedJitters: number[] = [];
let previousError: number | undefined;
let lastCorrections = 0;
let lastSample = 0;
let lastFrame = performance.now();
let maxFrameGapMs = 0;
const sampler = setInterval(() => {
  const now = performance.now();
  maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrame);
  lastFrame = now;
  const controlled = network.prediction?.body;
  if (controlled) stream.setView(controlled, controlled);
  const rendered = network.renderEntities(now);
  recordCorrection();
  const pose = rendered.find((e) => e.id === bodyId);
  const p = network.prediction;
  if (now - lastSample >= 100) {
    lastSample = now;
    const s = network.stats(now);
    const body = network.entities.get(bodyId);
    if (output)
      appendFileSync(
        output,
        JSON.stringify({
          type: "sample",
          at: Date.now(),
          elapsed: (performance.now() - started) / 1000,
          stats: s,
          body: body && {
            id: body.id,
            x: body.x,
            y: body.y,
            z: body.z,
            speed: Math.hypot(body.vx, body.vz),
            clearance: body.y - groundLevel(body.x, body.z, city),
            owned: body.id === network.playerId || body.driver === network.playerId,
            health: body.health,
            burning: body.burning,
            wreck: body.wreck,
            driver: body.driver,
          },
          mapReady: body ? stream.ready(body) : false,
          maxInputLagMs: maxInputLag,
          maxFrameGapMs,
          pose: pose && { x: pose.x, y: pose.y, z: pose.z },
          remoteCars: rendered
            .filter((e) => e.kind === "car" && e.driver && e.id !== bodyId)
            .map((e) => ({ id: e.id, x: e.x, y: e.y, z: e.z })),
        }) + "\n",
      );
  }
  if (!pose || !p) return;
  const speed = Math.hypot(pose.vx, pose.vz);
  summary.topSpeed = Math.max(summary.topSpeed, speed);
  const measuring = (now - started) / 1000 >= warmup;
  if (previousPose && speed > 5 && measuring) {
    const dt = (now - previousPose.at) / 1000;
    const along =
      ((pose.x - previousPose.x) * pose.vx + (pose.z - previousPose.z) * pose.vz) /
      speed;
    const expected = speed * dt;
    const error = Math.abs(along - expected) / Math.max(expected, 1e-6);
    speedErrors.push(error);
    const signed = (along - expected) / Math.max(expected, 1e-6);
    if (previousError !== undefined)
      speedJitters.push(Math.abs(signed - previousError));
    previousError = signed;
    if (error > 0.1) summary.hitches++;
    if (process.env.FRAME_LOG)
      appendFileSync(
        process.env.FRAME_LOG,
        JSON.stringify({
          at: +now.toFixed(1),
          dt: +(dt * 1000).toFixed(1),
          error: +((along - expected) / expected).toFixed(3),
          snapshot: network.received > previousPose.at,
          pending: p.pending.length,
          ack: network.ack,
          seq: network.seq,
          lastInput: (
            p as unknown as { lastInput?: { timestamp: number; interval: number } }
          ).lastInput,
          offset: +Math.hypot(p.offset.x, p.offset.z).toFixed(4),
        }) + "\n",
      );
    summary.verticalWobbleMax = Math.max(
      summary.verticalWobbleMax,
      Math.abs(pose.y - previousPose.y - pose.vy * dt),
    );
    summary.frames++;
    summary.maxStep = Math.max(summary.maxStep, along);
    if (along < -0.005) summary.backward++;
    if (along > expected * 1.5) summary.forwardLurches++;
    if (along < expected * 0.5) summary.freezes++;
  }
  previousPose = { x: pose.x, y: pose.y, z: pose.z, at: now };
  if (p.corrections !== lastCorrections) {
    summary.corrections++;
    if (p.lastCorrection.distance > 1) summary.correctionsOver1m++;
    summary.maxCorrection = Math.max(summary.maxCorrection, p.lastCorrection.distance);
    lastCorrections = p.corrections;
  }
  summary.maxPending = Math.max(summary.maxPending, p.pending.length);
}, 16);
const reporter = setInterval(() => {
  const s = network.stats();
  const body = network.entities.get(bodyId);
  console.log(
    [
      `t=${((performance.now() - started) / 1000).toFixed(0)}s`,
      `speed=${body ? Math.hypot(body.vx, body.vz).toFixed(1) : "?"}m/s`,
      `rtt=${s.rtt?.toFixed(0) ?? "?"}ms`,
      `snapshots=${s.snapshotsPerSecond}/s`,
      `inputs=${s.inputsPerSecond}/s`,
      `pending=${s.pending}`,
      `serverQueue=${s.queued ?? "?"}`,
      `corrections=${s.corrections}`,
      `last=${s.correction.toFixed(2)}m`,
      `offset=${s.offset.toFixed(2)}m`,
      `resyncs=${s.resyncs}`,
      s.prediction,
    ].join(" "),
  );
}, 1000);
let finished = false;
const finish = async () => {
  if (finished) return;
  finished = true;
  const completed = performance.now() - started >= seconds * 1000;
  clearInterval(pump);
  clearInterval(sampler);
  clearInterval(reporter);
  control = idle();
  speedErrors.sort((a, b) => a - b);
  summary.speedErrorP95 = +(
    speedErrors[Math.floor(speedErrors.length * 0.95)] ?? 0
  ).toFixed(3);
  summary.speedErrorMax = +(speedErrors.at(-1) ?? 0).toFixed(3);
  speedJitters.sort((a, b) => a - b);
  summary.speedJitterP95 = +(
    speedJitters[Math.floor(speedJitters.length * 0.95)] ?? 0
  ).toFixed(3);
  summary.speedJitterMax = +(speedJitters.at(-1) ?? 0).toFixed(3);
  summary.verticalWobbleMax = +summary.verticalWobbleMax.toFixed(3);
  let health: unknown;
  try {
    health = await (
      await fetch(new URL("/health", url), { signal: AbortSignal.timeout(4000) })
    ).json();
  } catch (error) {
    health = String(error);
  }
  outgoing.clear();
  incoming.clear();
  network.close();
  await chunkWorker.terminate();
  if (output)
    appendFileSync(
      output,
      JSON.stringify({
        type: "summary",
        at: Date.now(),
        completed,
        summary,
        health,
      }) + "\n",
    );
  console.log(
    JSON.stringify(
      {
        url: url.href,
        model,
        pattern,
        link: { delay, jitter, spike, spikeRate },
        regulate,
        limit,
        ...summary,
        maxInputLagMs: +maxInputLag.toFixed(1),
        health,
      },
      null,
      1,
    ),
  );
  process.exit(0);
};
process.on("SIGINT", () => void finish());
let takeoffComplete = false;
while (performance.now() - started < seconds * 1000) {
  const t = (performance.now() - started) / 1000;
  const body = network.prediction?.body;
  const clearance = body ? body.y - groundLevel(body.x, body.z, city) : 0;
  if (clearance > 40) takeoffComplete = true;
  control =
    kind === "plane"
      ? {
          ...idle(),
          moveY: 1,
          ...(takeoffComplete ? steer(t) : {}),
          ascend: clearance < 60,
        }
      : flying
        ? // Climb clear of the roofs, then full speed straight ahead (north).
          { ...idle(), up: t >= climbSeconds, ascend: t < climbSeconds }
        : { ...idle(), up: true, sprint: model === "none", ...steer(t) };
  await pause(50);
}
await finish();
