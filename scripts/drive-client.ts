// Live second client. Joins any running AFTERHOURS server with the real browser
// networking stack (GameNetwork, prediction, input clock), spawns a car on a
// debug-enabled server, drives it at full speed, and reports every correction a
// player on that link would feel. Optional one-way delay, jitter and spikes are
// injected on this client's socket only, so it can sit next to a real browser
// session on the same server. Example:
//   bun run bot:drive -- --url http://localhost:5173 --delay 60 --jitter 40 --spike 150
import { setTimeout as pause } from "node:timers/promises";
import { GameNetwork } from "../client/network/index.ts";
import { InputClock } from "../client/input/clock.ts";
import { OrderedDelay } from "./ordered-delay.ts";
import { loadCity } from "../server/city-loader.ts";
import { CityStore } from "../server/city-stream.ts";
import { idle, type Input } from "../shared/world.ts";
import { VEHICLES } from "../shared/catalog.ts";
import { CAR } from "../shared/physics/vehicle.ts";

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
if (
  model !== "none" &&
  (!(model in VEHICLES) || VEHICLES[model as keyof typeof VEHICLES].kind !== "car")
)
  throw Error(`--model must be a car model or "none", got ${model}`);

const city = await loadCity();
const mapId = new CityStore(city).manifest.mapId;
Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { protocol: url.protocol, host: url.host },
});
let seed = 97;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const oneWay = () => delay + rand() * jitter + (rand() < spikeRate ? spike : 0);

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
      console.error(`[status] ${state}`);
    },
  },
  name,
  "#e07a5f",
  structuredClone(city),
);
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
  incoming.schedule(incomingAt, () => receive.call(socket, event));
};

let control: Input = idle();
let maxInputLag = 0;
const pump = setInterval(() => {
  const now = performance.now();
  clock.advance(now, (timestamp) => {
    maxInputLag = Math.max(maxInputLag, now - timestamp);
    network.input(control, timestamp);
  });
}, 5);
// The server rate-limits debug commands to one per 100 ms.
const debug: typeof network.debug = async (command) => {
  await pause(150);
  return network.debug(command);
};
const radius = Math.max(50, Math.min(city.airport.w, city.airport.d) / 2 - 45);
let bodyId = network.playerId;
if (model !== "none") {
  if (!debugAllowed)
    throw Error("Spawning a car needs a debug-enabled server (dev, or ALLOW_DEBUG=1)");
  await debug({ kind: "teleport", x: city.airport.x - radius, z: city.airport.z });
  const before = new Set((await debug({ kind: "state" })).entities.map((e) => e.id));
  const spawned = await debug({ kind: "spawn", model: model as "sport" });
  const car = spawned.entities.find((e) => e.model === model && !before.has(e.id));
  if (!car) throw Error("spawn produced no car");
  await debug({ kind: "teleport", x: car.x + 3, z: car.z });
  network.send({ type: "interact" });
  await until(
    () => network.entities.get(network.playerId)?.vehicle === car.id,
    "board the car",
  );
  bodyId = car.id;
}
// Setup teleports are hard resets; measure only the drive.
await pause(300);
network.prediction!.corrections = 0;
const limit = model === "none" ? 8 : VEHICLES[model as keyof typeof VEHICLES].speed;
const started = performance.now();
// Proportional steering (as a gamepad would send) around the airfield centre keeps a
// full-speed car alive for minutes; keyboard full lock at 52 m/s spins it into scenery.
const circle = Math.min(1, Math.atan(2.7 / radius) / CAR.steer);
const steer = (t: number): Partial<Input> => {
  if (pattern === "straight") return {};
  if (pattern === "zigzag") return { moveX: t % 6 >= 3 ? -circle : circle, moveY: 1 };
  return { moveX: circle, moveY: 1 };
};
const summary = {
  frames: 0,
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
let previousPose: { x: number; z: number; at: number } | undefined;
let lastCorrections = 0;
const sampler = setInterval(() => {
  const now = performance.now();
  const pose = network.renderEntities(now).find((e) => e.id === bodyId);
  const p = network.prediction;
  if (!pose || !p) return;
  const speed = Math.hypot(pose.vx, pose.vz);
  summary.topSpeed = Math.max(summary.topSpeed, speed);
  if (previousPose && speed > 5) {
    const dt = (now - previousPose.at) / 1000;
    const along =
      ((pose.x - previousPose.x) * pose.vx + (pose.z - previousPose.z) * pose.vz) /
      speed;
    const expected = speed * dt;
    summary.frames++;
    summary.maxStep = Math.max(summary.maxStep, along);
    if (along < -0.005) summary.backward++;
    if (along > expected * 1.5) summary.forwardLurches++;
    if (along < expected * 0.5) summary.freezes++;
  }
  previousPose = { x: pose.x, z: pose.z, at: now };
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
const finish = async () => {
  clearInterval(pump);
  clearInterval(sampler);
  clearInterval(reporter);
  control = idle();
  let health: unknown;
  try {
    health = await (await fetch(new URL("/health", url))).json();
  } catch (error) {
    health = String(error);
  }
  outgoing.clear();
  incoming.clear();
  network.close();
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
while (performance.now() - started < seconds * 1000) {
  const t = (performance.now() - started) / 1000;
  control = { ...idle(), up: true, sprint: model === "none", ...steer(t) };
  await pause(50);
}
await finish();
