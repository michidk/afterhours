// Times every section of every tick of an in-process server and reports the slowest ticks.
//   node --import tsx scripts/tick-spikes.ts --seconds 120
import { parseArgs } from "node:util";
import { loadCity } from "../server/city-loader.ts";
import { Simulation } from "../server/simulation.ts";
import { TUNING } from "../shared/catalog.ts";
const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "120" },
    players: { type: "string", default: "2" },
  },
});
const sim = new Simulation(await loadCity());
sim.destruction.prepare();
for (let i = 0; i < Number(values.players); i++) sim.join("P" + i, "#55a9b8");
type Timed = Record<string, number>;
let cur: Timed = {};
const wrap = (obj: any, name: string, label: string) => {
  const original = obj[name].bind(obj);
  obj[name] = (...args: unknown[]) => {
    const t = performance.now();
    try {
      return original(...args);
    } finally {
      cur[label] = (cur[label] ?? 0) + performance.now() - t;
    }
  };
};
wrap(sim, "step", "step(x4)");
wrap(sim.traffic, "update", "traffic.update");
wrap(sim.destruction, "update", "destruction.update");
wrap(sim.combat, "record", "combat.record");
wrap(sim.inventory, "cleanup", "inventory.cleanup");
wrap(sim.ai, "pedestrian", "ai.pedestrian");
wrap(sim.ai, "car", "ai.car");
const ticks = Math.ceil(Number(values.seconds) / TUNING.tick);
const all: { tick: number; total: number; parts: Timed }[] = [];
for (let tick = 0; tick < ticks; tick++) {
  cur = {};
  const t = performance.now();
  sim.tick(TUNING.tick);
  all.push({ tick, total: performance.now() - t, parts: cur });
}
const totals = all.map((x) => x.total).sort((a, b) => a - b);
const q = (f: number) => totals[Math.floor(f * (totals.length - 1))].toFixed(1);
console.log(
  `ticks ${ticks}  mean ${(totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(2)} ms  p50 ${q(0.5)}  p95 ${q(0.95)}  p99 ${q(0.99)}  max ${q(1)}`,
);
console.log("\nslowest 12 ticks (ms):");
for (const x of [...all].sort((a, b) => b.total - a.total).slice(0, 12)) {
  const parts = Object.entries(x.parts)
    .filter(([, v]) => v > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v.toFixed(0)}`)
    .join(", ");
  console.log(
    `tick ${String(x.tick).padStart(5)}  ${x.total.toFixed(0).padStart(4)} ms   ${parts}`,
  );
}
const spiky = all.filter((x) => x.total > 25);
console.log(
  `\n${spiky.length} ticks over 25 ms (${((spiky.length / all.length) * 100).toFixed(1)}%). Which section dominated them:`,
);
const dominant = new Map<string, number>();
for (const x of spiky) {
  const top = Object.entries(x.parts).sort((a, b) => b[1] - a[1])[0];
  if (top) dominant.set(top[0], (dominant.get(top[0]) ?? 0) + 1);
}
console.log([...dominant].map(([k, v]) => `${k}: ${v}`).join("   "));
const sum = (k: string) =>
  all.reduce((a, x) => a + (x.parts[k] ?? 0), 0) / Number(values.seconds);
console.log(
  "\naverage ms per second of simulation:",
  Object.fromEntries(
    [
      "step(x4)",
      "ai.pedestrian",
      "ai.car",
      "traffic.update",
      "destruction.update",
      "combat.record",
      "inventory.cleanup",
    ].map((k) => [k, +sum(k).toFixed(1)]),
  ),
);
process.exit(0);
