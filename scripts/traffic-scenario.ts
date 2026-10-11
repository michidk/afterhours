import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Simulation } from "../server/simulation.ts";
import { TRAFFIC } from "../server/traffic.ts";
import { loadCity } from "../server/city-loader.ts";

// An isolated test world: ordinary AI/physics driving into a barricaded street.
// The artifact on disk and any running server are untouched.
const sim = new Simulation(structuredClone(await loadCity()));
sim.entities.clear();
sim.ai.routes.clear();
sim.city.buildings.push(
  { x: 1.5, z: 35.5, w: 1, d: 40, h: 3, color: "#fff", style: 0 },
  { x: 5.5, z: 35.5, w: 1, d: 40, h: 3, color: "#fff", style: 0 },
  { x: 3.5, z: 16, w: 5, d: 1, h: 3, color: "#fff", style: 0 },
  { x: 3.5, z: 55, w: 5, d: 1, h: 3, color: "#fff", style: 0 },
);
const observer = sim.join("Traffic observer", "#fff");
const original = Array.from({ length: 6 }, (_, i) => {
  const car = sim.spawn(
    "car",
    3.5,
    20 + i * 6,
    undefined,
    (["sedan", "sport", "van"] as const)[i % 3],
  );
  sim.ai.assignCar(car, 24, 25, (20 + i * 6) / 64, i);
  return car.id;
});
const samples = [];
const despawns: number[] = [];
const respawns: { time: number; id: string; distanceFromPlayer: number }[] = [];
let previous = sim.traffic.diagnostics;
for (let tick = 0; tick < 100 * 30; tick++) {
  const before = new Set(sim.entities.keys());
  sim.tick(1 / 30);
  const current = sim.traffic.diagnostics;
  if (current.despawned > previous.despawned) despawns.push(sim.time);
  if (current.respawned > previous.respawned) {
    const car = [...sim.entities.values()].find((e) => !before.has(e.id))!;
    const distance = Math.hypot(car.x - observer.x, car.z - observer.z);
    assert.ok(distance >= TRAFFIC.spawnPlayerDistance);
    respawns.push({ time: sim.time, id: car.id, distanceFromPlayer: distance });
  }
  const cars = [...sim.entities.values()].filter((e) => e.kind === "car");
  assert.equal(cars.length + current.pendingRespawns, original.length);
  if (tick % 150 === 0)
    samples.push({
      time: sim.time,
      originalCarsRemaining: cars.filter((e) => original.includes(e.id)).length,
      activeCars: cars.length,
      ...current,
    });
  previous = current;
}
assert.ok(despawns.length > 0, "Physical gridlock was not detected");
assert.ok(respawns.length > 0, "Traffic was not replenished");
for (let i = 1; i < despawns.length; i++)
  assert.ok(despawns[i] - despawns[i - 1] >= TRAFFIC.despawnSeconds);
for (let i = 1; i < respawns.length; i++)
  assert.ok(respawns[i].time - respawns[i - 1].time >= TRAFFIC.respawnSeconds);
const report = {
  date: new Date().toISOString(),
  passed: true,
  scope:
    "100 simulated seconds of real AI/contact physics in a barricaded street; not a WAN or hardware performance test",
  tuning: TRAFFIC,
  despawns,
  respawns,
  samples,
  final: sim.traffic.diagnostics,
};
await writeFile("docs/traffic-test.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
