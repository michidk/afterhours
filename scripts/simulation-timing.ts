import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadCity } from "../server/city-loader.ts";
import { Simulation } from "../server/simulation.ts";
import { TUNING } from "../shared/catalog.ts";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "900" },
    profile: { type: "string" },
  },
});
const seconds = Number(values.seconds);
if (!Number.isFinite(seconds) || seconds <= 0)
  throw Error("--seconds must be a positive number");
const ticks = Math.ceil(seconds / TUNING.tick);
const sim = new Simulation(await loadCity());
sim.join("Timing diagnostic", "#55a9b8");
const profiler = values.profile ? new Session() : undefined;
const profileStart = Math.max(0, ticks - Math.ceil(30 / TUNING.tick));
const reportEvery = Math.round(60 / TUNING.tick);
const wall: number[] = [],
  cpu: number[] = [];
const summarize = (samples: number[]) => {
  samples.sort((a, b) => a - b);
  return {
    mean: samples.reduce((sum, n) => sum + n, 0) / samples.length,
    p50: samples[Math.floor(samples.length * 0.5)],
    p95: samples[Math.floor(samples.length * 0.95)],
    max: samples.at(-1),
  };
};
console.log(
  JSON.stringify({
    measurement: "accelerated simulation only; excludes sockets and rendering",
    node: process.version,
    arch: process.arch,
    availableParallelism: availableParallelism(),
    seconds,
    ticks,
    tickSeconds: TUNING.tick,
  }),
);
const started = performance.now();
try {
  if (profiler) {
    profiler.connect();
    await profiler.post("Profiler.enable");
  }
  for (let tick = 0; tick < ticks; tick++) {
    if (profiler && tick === profileStart) await profiler.post("Profiler.start");
    const beforeCpu = process.threadCpuUsage(),
      before = performance.now();
    sim.tick(TUNING.tick);
    wall.push(performance.now() - before);
    const used = process.threadCpuUsage(beforeCpu);
    cpu.push((used.user + used.system) / 1000);
    if ((tick + 1) % reportEvery === 0 || tick === ticks - 1) {
      console.log(
        JSON.stringify({
          simulatedSeconds: sim.time,
          elapsedSeconds: (performance.now() - started) / 1000,
          ticks: wall.length,
          profiled: !!profiler && tick >= profileStart,
          wallMs: summarize(wall),
          mainThreadCpuMs: summarize(cpu),
          entities: sim.entities.size,
          memoryMB: Math.round(process.memoryUsage().rss / 1048576),
          traffic: sim.traffic.diagnostics,
        }),
      );
      wall.length = cpu.length = 0;
    }
  }
  if (profiler && values.profile) {
    const { profile } = await profiler.post("Profiler.stop");
    await writeFile(values.profile, JSON.stringify(profile));
  }
} finally {
  profiler?.disconnect();
  sim.destruction.dispose();
}
