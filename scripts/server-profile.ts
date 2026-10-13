// Profiles the real server loop (Runtime, Sessions, snapshot encoding, sockets) with N
// connected players driving or walking, and prints the busiest functions by self time.
//   node --import tsx scripts/server-profile.ts --players 2 --seconds 20
import { createServer } from "node:http";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { Session } from "node:inspector/promises";
import { WebSocket } from "ws";
import { loadCity } from "../server/city-loader.ts";
import { Simulation } from "../server/simulation.ts";
import { Sessions } from "../server/session.ts";
import { Runtime } from "../server/runtime.ts";
import { CityStore } from "../server/city-stream.ts";
import { decodeSnapshot } from "../shared/codec.ts";
import { idle, spawnOrigin } from "../shared/world.ts";
import { VERSION } from "../shared/version.ts";

const { values } = parseArgs({
  options: {
    players: { type: "string", default: "2" },
    seconds: { type: "string", default: "20" },
    top: { type: "string", default: "30" },
    profile: { type: "boolean", default: true },
  },
});
const players = Number(values.players),
  seconds = Number(values.seconds);
const city = await loadCity();
const sim = new Simulation(city);
sim.destruction.prepare();
const server = createServer();
const sessions = new Sessions(server, sim, false, new CityStore(city).manifest);
const runtime = new Runtime(sim, sessions);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw Error("no address");
runtime.start();

const sockets: WebSocket[] = [],
  timers: ReturnType<typeof setInterval>[] = [];
let snapshotBytes = 0,
  snapshots = 0,
  entityPatches = 0;
const origin = spawnOrigin(city);
for (let i = 0; i < players; i++) {
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  sockets.push(ws);
  await once(ws, "open");
  let seq = 0;
  ws.on("message", (raw, binary) => {
    const size = (raw as Buffer).byteLength;
    if (binary) {
      snapshotBytes += size;
      snapshots++;
      entityPatches += decodeSnapshot(raw as Buffer).entities.length;
    }
  });
  ws.send(
    JSON.stringify({
      type: "join",
      version: VERSION,
      name: `Bot ${i}`,
      color: "#55a9b8",
      timestamp: 0,
    }),
  );
  timers.push(
    setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: "input",
          seq: seq++,
          timestamp: performance.now(),
          ...idle(),
          up: true,
          right: Math.floor(performance.now() / 2500) % 2 === 0,
          sprint: true,
        }),
      );
    }, 1000 / 30),
  );
}
// Spread players a little so they do not stack, as real players do not.
await new Promise((r) => setTimeout(r, 1500));
let i = 0;
for (const e of sim.entities.values())
  if (e.kind === "player") {
    e.x = origin.x + i * 40;
    e.z = origin.z;
    i++;
  }

const profiler = new Session();
if (values.profile) {
  profiler.connect();
  await profiler.post("Profiler.enable");
  await profiler.post("Profiler.setSamplingInterval", { interval: 200 });
  await profiler.post("Profiler.start");
}
const before = runtime.metrics();
await new Promise((r) => setTimeout(r, seconds * 1000));
const after = runtime.metrics();
type Node = {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
};
let top: [string, number][] = [],
  total = 0;
if (values.profile) {
  const { profile } = (await profiler.post("Profiler.stop")) as {
    profile: { nodes: Node[]; samples: number[]; timeDeltas: number[] };
  };
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map<string, number>();
  profile.samples.forEach((id, k) => {
    const f = byId.get(id)!.callFrame,
      name = `${f.functionName || "(anonymous)"} ${f.url.replace(/^.*[\\/](server|shared|client|node_modules)[\\/]/, "$1/").replace(/^file:.*[\\/]/, "")}:${f.lineNumber + 1}`;
    const dt = profile.timeDeltas[k] / 1000;
    self.set(name, (self.get(name) ?? 0) + dt);
    total += dt;
  });
  top = [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(values.top));
  // Inclusive time: every distinct function on a sample's stack is charged once.
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const label = (n: Node) => {
    const f = n.callFrame;
    return `${f.functionName || "(anonymous)"} ${f.url.replace(/^.*[\/](server|shared|client|node_modules)[\/]/, "$1/").replace(/^file:.*[\/]/, "")}`;
  };
  const inclusive = new Map<string, number>();
  profile.samples.forEach((id, k) => {
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const name = label(byId.get(at)!);
      if (seen.has(name)) continue;
      seen.add(name);
      inclusive.set(name, (inclusive.get(name) ?? 0) + profile.timeDeltas[k] / 1000);
    }
  });
  (globalThis as unknown as { __inclusive: [string, number][] }).__inclusive = [
    ...inclusive,
  ]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 45);
}
console.log(
  JSON.stringify({
    players,
    seconds,
    entities: after.entities,
    ticksRun: after.ticks - before.ticks,
    lateTicks: after.late - before.late,
    tickP95Ms: +after.tickP95Ms.toFixed(1),
    tickMaxMs: +after.tickMaxMs.toFixed(1),
    tickCpuP95Ms: +after.tickCpuP95Ms.toFixed(1),
    snapshotsPerPlayerPerSecond: +(snapshots / players / seconds).toFixed(1),
    kBytesPerSnapshot: +(snapshotBytes / Math.max(1, snapshots) / 1024).toFixed(1),
    entityPatchesPerSnapshot: +(entityPatches / Math.max(1, snapshots)).toFixed(0),
  }),
);
if (values.profile) {
  console.log(
    `\nSelf time over ${seconds} s (profiled ${(total / 1000).toFixed(1)} s):`,
  );
  for (const [name, ms] of top)
    console.log(
      `${((ms / total) * 100).toFixed(1).padStart(5)}%  ${(ms / seconds).toFixed(0).padStart(5)} ms/s  ${name}`,
    );
}
if (values.profile) {
  console.log("\nInclusive time (function and everything it calls):");
  for (const [name, ms] of (
    globalThis as unknown as { __inclusive: [string, number][] }
  ).__inclusive)
    if (
      !name.startsWith("(idle)") &&
      !name.startsWith("(program)") &&
      !name.startsWith("(root)")
    )
      console.log(
        `${((ms / total) * 100).toFixed(1).padStart(5)}%  ${(ms / seconds).toFixed(0).padStart(5)} ms/s  ${name}`,
      );
}
for (const t of timers) clearInterval(t);
for (const s of sockets) s.terminate();
runtime.stop();
server.close();
setTimeout(() => process.exit(0), 300).unref();
