import { performance } from "node:perf_hooks";
import { TUNING } from "../shared/catalog.ts";
import type { Simulation } from "./simulation.ts";
import type { Sessions } from "./session.ts";
export class Runtime {
  private timer: ReturnType<typeof setInterval> | undefined;
  private samples: number[] = [];
  ticks = 0;
  late = 0;
  constructor(
    readonly sim: Simulation,
    readonly sessions: Sessions,
  ) {}
  start() {
    let last = performance.now(),
      accumulator = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      accumulator += Math.min(0.2, (now - last) / 1000);
      last = now;
      let catchup = 0;
      while (accumulator >= TUNING.tick && catchup < 4) {
        const start = performance.now();
        this.sessions.tick();
        this.sim.tick(TUNING.tick);
        if (++this.ticks % 2 === 0) this.sessions.broadcast();
        this.samples.push(performance.now() - start);
        if (this.samples.length > 600) this.samples.shift();
        accumulator -= TUNING.tick;
        catchup++;
      }
      if (accumulator > 0.15) {
        this.late++;
        accumulator = 0.03;
      }
    }, 5);
  }
  metrics() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      players: this.sessions.clients.size,
      entities: this.sim.entities.size,
      traffic: this.sim.traffic.diagnostics,
      ticks: this.ticks,
      late: this.late,
      tickP95Ms: sorted[Math.floor(sorted.length * 0.95)] || 0,
      tickMaxMs: sorted.at(-1) || 0,
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
