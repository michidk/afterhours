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
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
// `--hitch 40` blocks the main thread for that many ms about every 0.7 s, like a garbage-collection
// pause: frames come late and the input clock steps several slots at once.
const median = (values: number[]) =>
  values.length ? [...values].sort((a, b) => a - b)[values.length >> 1] : undefined;
const hitch = Number(arg("hitch", "0"));
if (hitch > 0)
  setInterval(() => {
    const until = performance.now() + hitch;
    while (performance.now() < until);
  }, 700);
// `--board` climbs into a parked craft of `--model` (the test world's showroom has every one)
// instead of spawning a car, which is how a plane or helicopter is flown here.
const board = process.argv.includes("--board");
const spawnCommand =
  model === "none" || board
    ? undefined
    : debugCommandSchema.parse({ kind: "spawn", model });
const vehicleModel = board
  ? (model as keyof typeof VEHICLES)
  : spawnCommand?.kind === "spawn"
    ? spawnCommand.model
    : undefined;
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
// `--pattern track` laps the city's racetrack (data/city.json) with a pure-pursuit driver.
const racetrack =
  pattern === "track"
    ? (JSON.parse(readFileSync(arg("city", "data/city.json"), "utf8")).city
        .racetrack as {
        path: number[];
        grid: { x: number; z: number }[];
      })
    : undefined;
const trackPath = racetrack
  ? Array.from({ length: racetrack.path.length / 2 }, (_, i) => ({
      x: racetrack.path[2 * i],
      z: racetrack.path[2 * i + 1],
    }))
  : [];
// `--strike lamp|tree|palm` aims the car at a prop of that kind with a clear 50 m run-up and
// reports when the break was predicted and when the server confirmed it.
const strikeKind = arg("strike", "");
const strikeTarget = strikeKind
  ? (() => {
      // The streamed client city has no props until their chunks arrive; the file has them all.
      const source = JSON.parse(readFileSync(arg("city", "data/city.json"), "utf8"))
        .city as {
        props: { kind: string; x: number; z: number; h: number }[];
        buildings: { x: number; z: number; w: number; d: number }[];
      };
      // Props by 8 m cell, so the run-up check does not compare every pair.
      const cells = new Map<string, typeof source.props>();
      for (const o of source.props) {
        const key = `${Math.floor(o.x / 8)},${Math.floor(o.z / 8)}`;
        cells.set(key, [...(cells.get(key) ?? []), o]);
      }
      const near = (x: number, z: number, radius: number, except: object) => {
        for (
          let cx = Math.floor((x - radius) / 8);
          cx <= Math.floor((x + radius) / 8);
          cx++
        )
          for (
            let cz = Math.floor((z - radius) / 8);
            cz <= Math.floor((z + radius) / 8);
            cz++
          )
            for (const o of cells.get(`${cx},${cz}`) ?? [])
              if (o !== except && Math.hypot(o.x - x, o.z - z) < radius) return true;
        return false;
      };
      // Points along the car's 40 m run-up (it comes from +z): nothing may stand on them.
      const clear = (p: (typeof source.props)[number]) =>
        Array.from({ length: 11 }, (_, i) => ({ x: p.x, z: p.z + 4 + i * 4 })).every(
          (q) =>
            !near(q.x, q.z, 2.4, p) &&
            !source.buildings.some(
              (b) => Math.hypot(b.x - q.x, b.z - q.z) < Math.max(b.w, b.d) / 2 + 3,
            ),
        );
      const found = source.props
        .filter((p) => p.kind === strikeKind && clear(p))
        .at(Number(arg("strike-skip", "0")));
      if (!found) throw Error(`no ${strikeKind} with a clear run-up`);
      return {
        ...found,
        id: `${found.kind}:${found.x.toFixed(4)},${found.z.toFixed(4)}`,
      };
    })()
  : undefined;
let strikePredictedAt: number | undefined,
  strikeConfirmedAt: number | undefined,
  strikeReachedAt: number | undefined;
// The car stands 8 m east and 5.5 m north of the player: start so it faces the prop 40 m away.
const center = strikeTarget
  ? { x: strikeTarget.x - 8, z: strikeTarget.z + 45.5 }
  : {
      x: Number(arg("x", String(racetrack?.grid[0].x ?? origin.x))),
      z: Number(arg("z", String(racetrack?.grid[0].z ?? origin.z))),
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
/** What the player list and the island map would show. */
let rosterSize = 0,
  positionsSeen = 0;
const network = new GameNetwork(
  {
    welcome(m) {
      serverMap = m.map.mapId;
      debugAllowed = m.debug;
    },
    state() {},
    chat() {},
    roster(players) {
      rosterSize = players.length;
    },
    destruction(ids) {
      if (strikeTarget && ids.includes(strikeTarget.id))
        strikeConfirmedAt ??= performance.now();
    },
    positions(players) {
      positionsSeen = players.length;
    },
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
/** CPU time the client spends per frame on the prediction and the draw list, and per input. */
const drawCosts: number[] = [];
const inputCosts: number[] = [];
const pump = setInterval(() => {
  const now = performance.now();
  maxInputLag = Math.max(maxInputLag, now - lastPump - 5);
  lastPump = now;
  clock.advance(now, (timestamp) => {
    maxInputLag = Math.max(maxInputLag, now - timestamp);
    const inputStart = performance.now();
    network.input(control, timestamp);
    inputCosts.push(performance.now() - inputStart);
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
if (board) {
  if (!debugAllowed)
    throw Error("Boarding a craft needs a debug-enabled server (ALLOW_DEBUG=1)");
  // The nearest one: an earlier flight may have left another far away.
  const craft = () => {
    const me = network.entities.get(network.playerId);
    return [...network.entities.values()]
      .filter((e) => e.model === model && me)
      .sort(
        (a, b) =>
          Math.hypot(a.x - me!.x, a.z - me!.z) - Math.hypot(b.x - me!.x, b.z - me!.z),
      )[0];
  };
  await until(() => !!craft(), `see a parked ${model}`);
  const target = craft()!;
  await debug({ kind: "teleport", x: target.x + 3, z: target.z });
  // Let the teleport reach the snapshots, so the one key press below is a clean enter sample.
  await pause(1200);
  for (let attempt = 0; attempt < 3; attempt++) {
    network.send({ type: "interact" });
    await pause(1500);
    if (network.entities.get(network.playerId)?.vehicle === target.id) break;
  }
  await until(
    () => network.entities.get(network.playerId)?.vehicle === target.id,
    `board the ${model}`,
  );
  bodyId = target.id;
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
  // Sitting in the vehicle with the pedals up: handled where the controls are assembled.
  // Two seconds of steering, two of none: clear onsets for the turn-response timer.
  if (pattern === "weave") return { moveX: Math.floor(t / 2) % 2 ? 0.8 : 0 };
  if (pattern === "track") {
    const body = network.prediction?.body;
    if (!body) return {};
    const near = trackPath.reduce(
      (best, p, i) =>
        Math.hypot(p.x - body.x, p.z - body.z) <
        Math.hypot(trackPath[best].x - body.x, trackPath[best].z - body.z)
          ? i
          : best,
      0,
    );
    let i = near,
      run = 0;
    while (run < 10) {
      const next = (i + 1) % trackPath.length;
      run += Math.hypot(
        trackPath[next].x - trackPath[i].x,
        trackPath[next].z - trackPath[i].z,
      );
      i = next;
    }
    // On foot the move keys are a world direction, not a turn: head straight for the point.
    if (kind === "none") {
      const heading = Math.atan2(trackPath[i].x - body.x, trackPath[i].z - body.z);
      return {
        moveX: Math.sin(heading),
        moveY: Math.cos(heading),
        sprint: targetSpeed > 5,
      };
    }
    const err = wrap(
        Math.atan2(trackPath[i].x - body.x, trackPath[i].z - body.z) - body.angle,
      ),
      speed = Math.hypot(body.vx, body.vz),
      cruise = targetSpeed * (1 - 0.5 * Math.min(1, Math.abs(err)));
    return {
      moveX: clamp(err * 1.5, -1, 1),
      moveY: speed < cruise ? 1 : 0,
      brake: speed > cruise + 1,
    };
  }
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
const cost = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: +(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)).toFixed(3),
    p95: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(3),
    max: +(sorted.at(-1) ?? 0).toFixed(3),
  };
};
const summary = {
  frames: 0,
  /** Frames where the seated vehicle was not drawn / not in the client's entity map. */
  missingFrames: 0,
  missingEntityFrames: 0,
  /** Frames whose drawn speed differs from the body's speed by over 10%. */
  hitches: 0,
  /** 95th percentile and worst relative error of the drawn per-frame speed. */
  speedErrorP95: 0,
  speedErrorMax: 0,
  /** 95th percentile and worst change of the drawn speed between consecutive frames: stutter. */
  speedJitterP95: 0,
  speedJitterMax: 0,
  frameGapP95: 0,
  frameGapMax: 0,
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
  /** Drawn body to predicted body (m): above a few cm the player sees something late. */
  drawnGapMean: 0,
  drawnGapMax: 0,
  /** Drawn height over the terrain (m): feet and wheel contact. */
  groundClearanceP95: 0,
  groundClearanceMax: 0,
};
let previousPose: { x: number; y: number; z: number; at: number } | undefined;
/** Distance from the drawn body to the predicted one, and the drawn height over the ground. */
const drawnGaps: number[] = [],
  clearances: number[] = [];
const speedErrors: number[] = [],
  speedJitters: number[] = [],
  frameGaps: number[] = [];
let previousError: number | undefined;
let lastCorrections = 0;
let lastSample = 0;
let lastFrame = performance.now();
let maxFrameGapMs = 0;
const sampler = setInterval(() => {
  const now = performance.now();
  const frameGap = now - lastFrame;
  frameGaps.push(frameGap);
  maxFrameGapMs = Math.max(maxFrameGapMs, frameGap);
  lastFrame = now;
  const controlled = network.prediction?.body;
  if (controlled) stream.setView(controlled, controlled);
  const drawStart = performance.now();
  const rendered = network.renderEntities(now);
  drawCosts.push(performance.now() - drawStart);
  recordCorrection();
  const pose = rendered.find((e) => e.id === bodyId);
  // The vehicle this bot sits in must stay in the draw list: it once vanished while idle.
  if (bodyId !== network.playerId) {
    if (!pose) summary.missingFrames++;
    if (!network.entities.has(bodyId)) summary.missingEntityFrames++;
  }
  const p = network.prediction;
  if (strikeTarget && p?.impacts.has(strikeTarget.id)) strikePredictedAt ??= now;
  // The nose of the predicted car (2.2 m ahead of its centre, facing -z) meets the prop.
  if (strikeTarget && p?.body && p.body.z - 2.2 <= strikeTarget.z + 0.3)
    strikeReachedAt ??= now;
  // A strike run ends 1.2 s after the impact, so its corrections belong to that one hit.
  if (strikeReachedAt && now - strikeReachedAt > 1200 && !finished) void finish();
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
  if (p.body && (kind === "none" || kind === "car") && now - started > 1000) {
    drawnGaps.push(Math.hypot(pose.x - p.body.x, pose.z - p.body.z));
    clearances.push(Math.abs(pose.y - groundLevel(pose.x, pose.z, city)));
  }
  const speed = Math.hypot(pose.vx, pose.vz);
  summary.topSpeed = Math.max(summary.topSpeed, speed);
  const measuring = (now - started) / 1000 >= warmup;
  if (previousPose && speed > 2 && measuring) {
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
          x: +pose.x.toFixed(2),
          z: +pose.z.toFixed(2),
          y: +pose.y.toFixed(2),
          vx: +pose.vx.toFixed(2),
          vz: +pose.vz.toFixed(2),
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
  frameGaps.sort((a, b) => a - b);
  summary.frameGapP95 = +(frameGaps[Math.floor(frameGaps.length * 0.95)] ?? 0).toFixed(
    3,
  );
  summary.frameGapMax = +(frameGaps.at(-1) ?? maxFrameGapMs).toFixed(3);
  summary.verticalWobbleMax = +summary.verticalWobbleMax.toFixed(3);
  const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
  const gaps = sorted(drawnGaps),
    heights = sorted(clearances);
  summary.drawnGapMean = +(
    gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1)
  ).toFixed(3);
  summary.drawnGapMax = +(gaps.at(-1) ?? 0).toFixed(3);
  summary.groundClearanceP95 = +(
    heights[Math.floor(heights.length * 0.95)] ?? 0
  ).toFixed(3);
  summary.groundClearanceMax = +(heights.at(-1) ?? 0).toFixed(3);
  let server: unknown;
  if (debugAllowed)
    try {
      server = ((await debug({ kind: "observe" } as never)) as { server?: unknown })
        ?.server;
    } catch (error) {
      server = String(error);
    }
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
  const report = {
    url: url.href,
    model,
    pattern,
    link: { delay, jitter, spike, spikeRate },
    regulate,
    limit,
    ...summary,
    maxInputLagMs: +maxInputLag.toFixed(1),
    clientCpuMs: { draw: cost(drawCosts), input: cost(inputCosts) },
    rosterSize,
    positionsSeen,
    actions: {
      controlled: network.stats().controlled,
      enterMs: median(network.actions.samples.enter),
      steerMs: median(network.actions.samples.steer),
      enterSamples: network.actions.samples.enter.length,
      steerSamples: network.actions.samples.steer.length,
    },
    strike: strikeTarget && {
      id: strikeTarget.id,
      predicted: strikePredictedAt !== undefined,
      confirmed: strikeConfirmedAt !== undefined,
      /** How late the break showed before: from the nose meeting the prop to the server's word. */
      wasLateMs:
        strikeReachedAt !== undefined && strikeConfirmedAt !== undefined
          ? Math.round(strikeConfirmedAt - strikeReachedAt)
          : undefined,
      /** How late it shows now: from the nose meeting the prop to the predicted break. */
      showsLateMs:
        strikeReachedAt !== undefined && strikePredictedAt !== undefined
          ? Math.round(strikePredictedAt - strikeReachedAt)
          : undefined,
      /** How much earlier the break shows than the server's word for it. */
      leadMs:
        strikePredictedAt !== undefined && strikeConfirmedAt !== undefined
          ? Math.round(strikeConfirmedAt - strikePredictedAt)
          : undefined,
    },
    server,
    health,
  };
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify(report, null, 1));
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
        rosterSize,
        positionsSeen,
        actions: report.actions,
        strike: report.strike,
        server,
        health,
      },
      null,
      1,
    ),
  );
  process.exit(0);
};
process.on("SIGINT", () => void finish());
// `--cycle 5` gets out and back in five times for clean enter/exit samples. A plane puts you
// well away from it, so each time the bot steps back beside the vehicle and waits for that to
// reach the snapshots before the key press, which is then the only thing being timed.
for (let i = 0; i < Number(arg("cycle", "0")); i++) {
  const seated = () => network.entities.get(network.playerId)?.vehicle === bodyId;
  await pause(1000);
  // A press can be lost on a spiky link, so ask again until it shows (a second press after
  // the first took effect would climb back in, so give each one time to show first).
  for (let attempt = 0; attempt < 4 && seated(); attempt++) {
    network.send({ type: "interact" });
    await until(() => !seated(), "get out", 2500).catch(() => undefined);
  }
  await until(() => !seated(), "get out");
  await pause(800);
  const at = network.entities.get(bodyId)!;
  await debug({ kind: "teleport", x: at.x + 3, z: at.z });
  await pause(1200);
  for (let attempt = 0; attempt < 4 && !seated(); attempt++) {
    network.send({ type: "interact" });
    await until(seated, "get back in", 2500).catch(() => undefined);
  }
  await until(seated, "get back in");
}
let takeoffComplete = false;
while (performance.now() - started < seconds * 1000) {
  const t = (performance.now() - started) / 1000;
  // Aircraft are not predicted: their altitude is the server's.
  const body =
    kind === "plane" || flying
      ? network.entities.get(bodyId)
      : network.prediction?.body;
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
        : pattern === "still"
          ? idle()
          : { ...idle(), up: true, sprint: model === "none", ...steer(t) };
  await pause(50);
}
await finish();
