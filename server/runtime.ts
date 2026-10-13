import { performance } from "node:perf_hooks";
import { TUNING } from "../shared/catalog.ts";
import type { Simulation } from "./simulation.ts";
import type { Sessions } from "./session.ts";
export class Runtime {
  private timer: ReturnType<typeof setInterval> | undefined;
  private samples: { wallMs: number; cpuMs: number }[] = [];
  ticks = 0;
  late = 0;
  constructor(
    readonly sim: Simulation,
    readonly sessions: Sessions,
  ) {}
  start() {
    let last = performance.now(),
      accumulator = 0;
    const snapshotInterval = TUNING.tick * 2000;
    let nextSnapshot = last + snapshotInterval;
    let lastSnapshotTick = this.ticks;
    this.timer = setInterval(() => {
      const now = performance.now();
      accumulator += Math.min(0.2, (now - last) / 1000);
      last = now;
      let catchup = 0;
      while (
        accumulator >= TUNING.tick &&
        catchup < 4 &&
        (catchup === 0 || performance.now() - now < TUNING.tick * 1000)
      ) {
        const startCpu = process.threadCpuUsage(),
          start = performance.now();
        this.sessions.tick();
        this.sim.tick(TUNING.tick);
        this.ticks++;
        const wallMs = performance.now() - start,
          cpu = process.threadCpuUsage(startCpu);
        this.samples.push({ wallMs, cpuMs: (cpu.user + cpu.system) / 1000 });
        if (this.samples.length > 600) this.samples.shift();
        accumulator -= TUNING.tick;
        catchup++;
      }
      if (this.ticks !== lastSnapshotTick && performance.now() >= nextSnapshot) {
        const startCpu = process.threadCpuUsage(),
          start = performance.now();
        this.sessions.broadcast();
        lastSnapshotTick = this.ticks;
        const finished = performance.now(),
          cpu = process.threadCpuUsage(startCpu);
        // Publish the latest completed state once, skipping missed deadlines.
        nextSnapshot +=
          (Math.floor((finished - nextSnapshot) / snapshotInterval) + 1) *
          snapshotInterval;
        const sample = this.samples[this.samples.length - 1];
        sample.wallMs += finished - start;
        sample.cpuMs += (cpu.user + cpu.system) / 1000;
      }
      if (accumulator > 0.15) {
        this.late++;
        // Dropping accumulated time loses whole ticks that clients already sent
        // commands for; grant catch-up credit rather than queueing or shedding them.
        this.sessions.skipped(Math.floor((accumulator - 0.03) / TUNING.tick));
        accumulator = 0.03;
      }
    }, 5);
  }
  metrics() {
    const wall = this.samples.map((s) => s.wallMs).sort((a, b) => a - b),
      cpu = this.samples.map((s) => s.cpuMs).sort((a, b) => a - b);
    return {
      players: this.sessions.clients.size,
      entities: this.sim.entities.size,
      traffic: this.sim.traffic.diagnostics,
      ticks: this.ticks,
      late: this.late,
      inputSpeculated: this.sessions.speculated,
      inputMispredicted: this.sessions.mispredicted,
      inputFrozen: this.sessions.frozen,
      inputCatchUps: this.sessions.caughtUp,
      inputDrops: this.sessions.dropped,
      tickP95Ms: wall[Math.floor(wall.length * 0.95)] || 0,
      tickMaxMs: wall.at(-1) || 0,
      tickCpuP95Ms: cpu[Math.floor(cpu.length * 0.95)] || 0,
      tickCpuMaxMs: cpu.at(-1) || 0,
      bytesSent: this.sessions.bytes,
      rejectedMessages: this.sessions.rejected,
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    };
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.sessions.close();
    this.sim.destruction.dispose();
  }
}
