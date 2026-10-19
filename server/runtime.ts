import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { performance } from "node:perf_hooks";
import { TUNING } from "../shared/catalog.ts";
import type { Simulation } from "./simulation.ts";
import type { Sessions } from "./session.ts";
export class Runtime {
  private timer: ReturnType<typeof setInterval> | undefined;
  private samples: { wallMs: number; cpuMs: number }[] = [];
  ticks = 0;
  late = 0;
  catchUpTicks = 0;
  backlogMs = 0;
  private lastPumpAt = 0;
  private cpuSampleAt = 0;
  private cpuSample = process.cpuUsage();
  private cpuPercent = 0;
  droppedMs = 0;
  constructor(
    readonly sim: Simulation,
    readonly sessions: Sessions,
  ) {
    sessions.diagnostics = () => this.metrics();
    sessions.pendingTicks = () =>
      this.timer
        ? Math.min(
            TUNING.inputQueue,
            Math.floor(
              (this.backlogMs + Math.max(0, performance.now() - this.lastPumpAt)) /
                (TUNING.tick * 1000) +
                1e-6,
            ),
          )
        : 0;
  }
  start() {
    this.lastPumpAt = performance.now();
    this.cpuSampleAt = this.lastPumpAt;
    this.cpuSample = process.cpuUsage();
    let last = this.lastPumpAt,
      accumulator = 0;
    const snapshotInterval = TUNING.tick * 2000;
    let nextSnapshot = last + snapshotInterval;
    let lastSnapshotTick = this.ticks;
    this.timer = setInterval(() => {
      const now = performance.now();
      if (now - this.cpuSampleAt >= 1000) {
        const cpu = process.cpuUsage();
        this.cpuPercent =
          (100 *
            (cpu.user + cpu.system - this.cpuSample.user - this.cpuSample.system)) /
          ((now - this.cpuSampleAt) * 1000);
        this.cpuSample = cpu;
        this.cpuSampleAt = now;
      }
      accumulator += Math.max(0, (now - last) / 1000);
      const maxBacklog = TUNING.inputQueue * TUNING.tick;
      if (accumulator > maxBacklog) {
        this.late++;
        this.droppedMs += (accumulator - maxBacklog) * 1000;
        accumulator = maxBacklog;
      }
      last = now;
      this.lastPumpAt = now;
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
        if (catchup > 0) this.catchUpTicks++;
        catchup++;
      }
      this.backlogMs = accumulator * 1000;
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
    }, 5);
  }
  metrics() {
    const wall = this.samples.map((s) => s.wallMs).sort((a, b) => a - b),
      cpu = this.samples.map((s) => s.cpuMs).sort((a, b) => a - b);
    const memory = process.memoryUsage(),
      memoryLimit = Math.min(process.constrainedMemory() || totalmem(), totalmem());
    return {
      cpuPercent: this.cpuPercent,
      memoryPercent: (100 * memory.rss) / memoryLimit,
      memoryLimitMB: memoryLimit / 1048576,
      tickBudgetMs: TUNING.tick * 1000,
      backlogMs:
        this.backlogMs +
        (this.timer ? Math.max(0, performance.now() - this.lastPumpAt) : 0),
      droppedMs: this.droppedMs,
      heapUsedMB: memory.heapUsed / 1048576,
      heapLimitMB: getHeapStatistics().heap_size_limit / 1048576,
      availableMemoryMB: process.availableMemory() / 1048576,
      players: this.sessions.clients.size,
      entities: this.sim.entities.size,
      traffic: this.sim.traffic.diagnostics,
      ticks: this.ticks,
      late: this.late,
      inputSpeculated: this.sessions.speculated,
      inputMispredicted: this.sessions.mispredicted,
      inputFrozen: this.sessions.frozen,
      catchUpTicks: this.catchUpTicks,
      inputDrops: this.sessions.dropped,
      tickP95Ms: wall[Math.floor(wall.length * 0.95)] || 0,
      tickMaxMs: wall.at(-1) || 0,
      tickCpuP95Ms: cpu[Math.floor(cpu.length * 0.95)] || 0,
      tickCpuMaxMs: cpu.at(-1) || 0,
      bytesSent: this.sessions.bytes,
      rejectedMessages: this.sessions.rejected,
      memoryMB: Math.round(memory.rss / 1048576),
    };
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.sessions.close();
    this.sim.destruction.dispose();
  }
}
