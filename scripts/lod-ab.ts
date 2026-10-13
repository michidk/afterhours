// Fair A/B of server tick cost: two identical worlds, LOD off vs on, run in alternating
// blocks in one process and compared by thread CPU time, which load from other processes
// on the machine does not distort the way wall time is.
import { loadCity } from "../server/city-loader.ts";
import { Simulation } from "../server/simulation.ts";
import { TUNING } from "../shared/catalog.ts";
import { spawnOrigin } from "../shared/world.ts";
const rounds = Number(process.argv[2] ?? 16),
  block = 150;
const place = process.argv[3] ?? "spawn";
async function world(lod: boolean) {
  const city = await loadCity();
  const sim = new Simulation(city);
  sim.lod = lod;
  const o = spawnOrigin(city);
  const at = place === "edge" ? { x: o.x + 500, z: o.z + 500 } : o;
  for (let i = 0; i < 2; i++) {
    const p = sim.join("P" + i, "#55a9b8");
    p.x = at.x + i * 40;
    p.z = at.z;
  }
  return sim;
}
const sims = { off: await world(false), on: await world(true) };
const samples: Record<"off" | "on", number[]> = { off: [], on: [] };
const run = (key: "off" | "on", ticks: number, keep: boolean) => {
  for (let i = 0; i < ticks; i++) {
    const c0 = process.threadCpuUsage();
    sims[key].tick(TUNING.tick);
    const c = process.threadCpuUsage(c0);
    if (keep) samples[key].push((c.user + c.system) / 1000);
  }
};
for (const k of ["off", "on"] as const) run(k, 240, false);
for (let r = 0; r < rounds; r++)
  for (const k of (r % 2 ? ["on", "off"] : ["off", "on"]) as ("off" | "on")[])
    run(k, block, true);
const stat = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y),
    q = (f: number) => s[Math.floor(f * (s.length - 1))];
  return {
    mean: a.reduce((x, y) => x + y, 0) / a.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: s.at(-1)!,
  };
};
const f = (n: number) => n.toFixed(2).padStart(6);
console.log(
  `players at ${place}; ${rounds * block} ticks each; thread CPU ms per tick`,
);
for (const k of ["off", "on"] as const) {
  const s = stat(samples[k]);
  console.log(
    `lod ${k.padEnd(3)}  mean ${f(s.mean)}  p50 ${f(s.p50)}  p95 ${f(s.p95)}  p99 ${f(s.p99)}  max ${f(s.max)}`,
  );
}
const a = stat(samples.off),
  b = stat(samples.on);
console.log(
  `=> mean ${(a.mean / b.mean).toFixed(2)}x cheaper, p95 ${(a.p95 / b.p95).toFixed(2)}x, p99 ${(a.p99 / b.p99).toFixed(2)}x`,
);
const far = [...sims.on.entities.values()].filter((e) => e.ai).length;
console.log(`AI bodies: ${far} of ${sims.on.entities.size} entities`);
process.exit(0);
