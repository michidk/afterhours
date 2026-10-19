import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir, loadavg, availableParallelism } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { parseArgs } from "node:util";
import { assessMovement } from "./movement-acceptance.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    seconds: { type: "string", default: "180" },
    output: { type: "string" },
    phase: { type: "string" },
    profile: { type: "boolean", default: false },
  },
});
if (!values.url) throw Error("--url must explicitly name a debug-enabled test target");
const seconds = Number(values.seconds);
if (!Number.isFinite(seconds) || seconds < 10)
  throw Error("--seconds must be at least 10");
const directory = await mkdtemp(join(tmpdir(), "afterhours-five-"));
const report = {
  url: values.url,
  seconds,
  directory,
  environment: {
    cores: availableParallelism(),
    load: loadavg(),
    node: process.version,
  },
  phases: [] as { name: string; clients: ReturnType<typeof assessMovement>[] }[],
};
const active = new Set<ChildProcess>();
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)
  process.once(signal, () => {
    for (const child of active) child.kill("SIGKILL");
    process.exit(code);
  });
console.log(`Artifacts: ${directory}`);
const phases = ["people", "cars", "planes"] as const;
if (values.phase && !phases.some((phase) => phase === values.phase))
  throw Error("--phase must be people, cars or planes");
for (const phase of phases.filter((phase) => !values.phase || phase === values.phase)) {
  const gate = join(directory, `${phase}.start`);
  const launch = (i: number) => {
    const path = join(directory, `${phase}-${i + 1}.jsonl`);
    const child = spawn(
      process.execPath,
      [
        ...(values.profile ? ["--cpu-prof", "--cpu-prof-dir", directory] : []),
        "--import",
        "tsx",
        "scripts/drive-client.ts",
        "--url",
        values.url!,
        "--model",
        phase === "people" ? "none" : phase === "cars" ? "sport" : "plane",
        "--name",
        `Test ${phase} ${i + 1}`,
        "--seconds",
        String(seconds + 10),
        "--x",
        String(phase === "planes" ? 285 + i * 12 : 292),
        "--z",
        String(phase === "planes" ? 600 : 590 + i * 35),
        "--radius",
        phase === "planes" ? "130" : "12",
        "--speed",
        "10",
        "--gate",
        gate,
        "--output",
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    active.add(child);
    child.once("exit", () => active.delete(child));
    let logs = "";
    child.stdout.on("data", (data) => {
      logs += String(data);
    });
    child.stderr.on("data", (data) => {
      logs += String(data);
    });
    const done = new Promise<string | null>((resolve) => {
      child.on("error", (error) => resolve(error.message));
      child.on("exit", (code, signal) =>
        resolve(code === 0 ? null : `client exited ${code}/${signal}`),
      );
    });
    return { child, path, done, logs: () => logs };
  };
  const clients: ReturnType<typeof launch>[] = [];
  let start = Date.now();
  let setupError = "";
  try {
    // Serialize debug spawning so a client cannot mistake another new car for its own.
    const deadline = Date.now() + 180000;
    for (let i = 0; i < 5; i++) {
      const client = launch(i);
      clients.push(client);
      while (
        !(await readFile(client.path, "utf8").catch(() => "")).includes(
          '"type":"ready"',
        )
      ) {
        if (
          clients.some((c) => c.child.exitCode !== null || c.child.signalCode !== null)
        )
          throw Error("client exited during setup");
        if (Date.now() > deadline)
          throw Error("five clients did not become ready in 180s");
        await pause(250);
      }
    }
    start = Date.now();
    await writeFile(gate, String(start));
    console.log(
      `${phase}: five clients ready; 10s acceleration then ${seconds}s measured`,
    );
    const finishDeadline = start + (seconds + 25) * 1000;
    while (
      clients.some((c) => c.child.exitCode === null && c.child.signalCode === null) &&
      Date.now() < finishDeadline
    )
      await pause(500);
  } catch (error) {
    setupError = String(error);
  } finally {
    for (const c of clients)
      if (c.child.exitCode === null && c.child.signalCode === null)
        c.child.kill("SIGKILL");
  }
  const results = await Promise.all(
    clients.map(async (c) => {
      const exit = await c.done;
      await writeFile(c.path + ".log", c.logs());
      const result = assessMovement(
        await readFile(c.path, "utf8").catch(() => ""),
        phase,
        start,
        seconds,
      );
      if (exit) result.failures.push(exit);
      if (setupError) result.failures.push(setupError);
      return result;
    }),
  );
  while (results.length < 5) {
    const missing = assessMovement("", phase, start, seconds);
    missing.failures.push("not started because phase setup failed");
    results.push(missing);
  }
  report.phases.push({ name: phase, clients: results });
  console.log(JSON.stringify({ phase, clients: results }));
  await writeFile(
    values.output ?? join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
if (report.phases.some((p) => p.clients.some((c) => c.failures.length)))
  process.exitCode = 1;
