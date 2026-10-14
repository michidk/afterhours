// Independent real clients exercise the production network/prediction stack.
// Defaults to an owned local server; --url explicitly targets a live debug server.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir, loadavg, availableParallelism } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    seconds: { type: "string", default: "20" },
    delay: { type: "string", default: "0" },
    jitter: { type: "string", default: "0" },
    output: { type: "string" },
    pattern: { type: "string", default: "loop" },
  },
});
const seconds = Number(values.seconds);
if (!Number.isFinite(seconds) || seconds < 5)
  throw Error("--seconds must be at least 5");
const directory = await mkdtemp(join(tmpdir(), "afterhours-multiplayer-"));
const children: ChildProcess[] = [];
const sampleSchema = z.object({
  type: z.literal("sample"),
  at: z.number(),
  mapReady: z.boolean(),
  maxInputLagMs: z.number(),
  stats: z.object({
    connected: z.boolean(),
    rtt: z.number().optional(),
    ackAge: z.number().optional(),
    pending: z.number(),
    queued: z.number().optional(),
    correction: z.number(),
    prediction: z.string(),
    resyncs: z.number(),
    serverTime: z.number(),
    snapshotsPerSecond: z.number(),
  }),
  body: z.object({ x: z.number(), z: z.number(), speed: z.number() }).optional(),
});
async function samples(path: string) {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = sampleSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    });
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGINT");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timeout);
}
async function health(url: string) {
  return (
    await fetch(new URL("/health", url), { signal: AbortSignal.timeout(10000) })
  ).json();
}
const failures: string[] = [];
try {
  let url = values.url;
  if (!url) {
    const server = spawn(
      process.execPath,
      ["--import", "tsx", "server/index.ts", "--production"],
      {
        env: { ...process.env, PORT: "0", ALLOW_DEBUG: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(server);
    url = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(Error(`Server startup timed out: ${output}`)),
        30000,
      );
      server.stdout?.on("data", (data) => {
        output = (output + String(data)).slice(-4000);
        const port = /AFTERHOURS http:\/\/localhost:(\d+)/.exec(output)?.[1];
        if (port) {
          clearTimeout(timeout);
          resolve(`http://127.0.0.1:${port}`);
        }
      });
      server.stderr?.on("data", (data) => {
        output = (output + String(data)).slice(-4000);
      });
      server.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      server.once("exit", (code) => {
        clearTimeout(timeout);
        reject(Error(`Server exited ${code}: ${output}`));
      });
    });
  }
  const target = url;
  const launch = (id: number, duration: number) => {
    const path = join(directory, `client-${id}.jsonl`);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/drive-client.ts",
        "--url",
        target,
        "--name",
        `Network probe ${id}`,
        "--seconds",
        String(duration),
        "--pattern",
        values.pattern!,
        "--delay",
        values.delay!,
        "--jitter",
        values.jitter!,
        "--output",
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    let output = "";
    child.stdout?.on("data", (data) => {
      output = (output + String(data)).slice(-12000);
    });
    child.stderr?.on("data", (data) => {
      output = (output + String(data)).slice(-12000);
    });
    child.once("error", (error) => failures.push(`client ${id}: ${error.message}`));
    child.once("exit", (code, signal) => {
      if (code !== 0) failures.push(`client ${id} exited ${code}/${signal}: ${output}`);
    });
    return { child, path };
  };
  const ready = async (client: ReturnType<typeof launch>) => {
    const deadline = Date.now() + 60000;
    while (!(await samples(client.path)).length) {
      if (client.child.exitCode !== null || client.child.signalCode !== null)
        throw Error(failures.join("\n") || "Client exited during setup");
      if (Date.now() > deadline) throw Error("Client did not start driving");
      await pause(100);
    }
  };
  const one = launch(1, seconds * 3 + 120);
  await ready(one);
  const baselineStart = Date.now();
  const before = await health(target);
  console.log(`One client driving for ${seconds}s; artifacts: ${directory}`);
  await pause(seconds * 1000);
  const baselineEnd = Date.now();
  const baselineHealth = await health(target);
  const two = launch(2, seconds + 5);
  await ready(two);
  const pairStart = Date.now();
  console.log(`Two independent clients driving for ${seconds}s`);
  await pause(seconds * 1000);
  const pairEnd = Date.now();
  const pairHealth = await health(target);
  await stop(two.child);
  const recoveryStart = Date.now();
  console.log(`One client after disconnect for ${seconds}s`);
  await pause(seconds * 1000);
  const recoveryEnd = Date.now();
  const recoveryHealth = await health(target);
  await stop(one.child);
  const records = [await samples(one.path), await samples(two.path)];
  const phases = [
    { name: "one", start: baselineStart, end: baselineEnd, clients: [0] },
    { name: "two", start: pairStart, end: pairEnd, clients: [0, 1] },
    { name: "recovery", start: recoveryStart, end: recoveryEnd, clients: [0] },
  ].map((phase) => ({
    name: phase.name,
    clients: phase.clients.map((id) => {
      const data = records[id].filter((s) => s.at >= phase.start && s.at <= phase.end);
      const max = (get: (s: z.infer<typeof sampleSchema>) => number) =>
        Math.max(0, ...data.map(get));
      const p95 = (get: (s: z.infer<typeof sampleSchema>) => number) => {
        const sorted = data.map(get).sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      };
      if (data.length < seconds * 0.7)
        failures.push(`${phase.name} client ${id + 1}: missing samples`);
      if (max((s) => s.body?.speed ?? 0) < 5)
        failures.push(
          `${phase.name} client ${id + 1}: car never reached driving speed`,
        );
      if (data.some((s) => !s.stats.connected || !s.mapReady || !s.body))
        failures.push(
          `${phase.name} client ${id + 1}: disconnected, missing car or unloaded map`,
        );
      if (
        data.some(
          (s) =>
            (s.stats.ackAge ?? Infinity) > Math.max(1000, (s.stats.rtt ?? 0) + 600),
        )
      )
        failures.push(`${phase.name} client ${id + 1}: stale applied input`);
      if (data.some((s) => s.stats.prediction === "waiting for acknowledgements"))
        failures.push(`${phase.name} client ${id + 1}: prediction suspended`);
      if (max((s) => s.maxInputLagMs) > 250)
        failures.push(`${phase.name} client ${id + 1}: load generator stalled >250ms`);
      const first = data[0],
        last = data.at(-1);
      const simulationRate =
        first && last && last.at > first.at
          ? (last.stats.serverTime - first.stats.serverTime) /
            ((last.at - first.at) / 1000)
          : 0;
      if (simulationRate < 0.85)
        failures.push(
          `${phase.name} client ${id + 1}: server simulation fell behind wall time`,
        );
      return {
        client: id + 1,
        simulationRate,
        samples: data.length,
        ackAgeP95Ms: p95((s) => s.stats.ackAge ?? 0),
        maxAckAgeMs: max((s) => s.stats.ackAge ?? 0),
        maxPending: max((s) => s.stats.pending),
        maxRttMs: max((s) => s.stats.rtt ?? 0),
        maxQueue: max((s) => s.stats.queued ?? 0),
        maxCorrectionMeters: max((s) => s.stats.correction),
        maxInputLagMs: max((s) => s.maxInputLagMs),
        maxSpeed: max((s) => s.body?.speed ?? 0),
        serverSeconds:
          data.length > 1
            ? data.at(-1)!.stats.serverTime - data[0].stats.serverTime
            : 0,
      };
    }),
  }));
  const report = {
    environment: {
      node: process.version,
      cores: availableParallelism(),
      load: loadavg(),
    },
    url: target,
    seconds,
    delay: values.delay,
    jitter: values.jitter,
    pattern: values.pattern,
    artifacts: directory,
    phases,
    health: {
      before,
      baseline: baselineHealth,
      two: pairHealth,
      recovery: recoveryHealth,
    },
    failures,
  };
  const output = values.output ?? join(directory, "report.json");
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report: ${output}`);
  if (failures.length) process.exitCode = 1;
} finally {
  for (const child of [...children].reverse()) await stop(child);
}
