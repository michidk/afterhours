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
sim.join("Traffic observer", "#fff");
const original = Array.from({ length: 6 }, (_, i) => {
  const car = sim.spawn(
    "car",
    3.5,
    20 + i * 6,
    undefined,
    (["sedan", "sport", "van"] as const)[i % 3],
  );
  sim.ai.assignCar(car, 24, 25, (20 + i * 6) / 64, i);
  car.x = 3.5;
  car.z = 20 + i * 6;
  car.angle = 0;
  sim.ai.routes.get(car.id)!.points = [{ x: 3.5, z: 75 }];
  return car.id;
});
const samples = [];
for (let tick = 0; tick < 100 * 30; tick++) {
  sim.tick(1 / 30);
  const current = sim.traffic.diagnostics;
  sim.drainEvents();
  const cars = [...sim.entities.values()].filter((e) => e.kind === "car");
  assert.equal(cars.length + current.pendingRespawns, original.length);
  if (tick % 150 === 0)
    samples.push({
      time: sim.time,
      originalCarsRemaining: cars.filter((e) => original.includes(e.id)).length,
      activeCars: cars.length,
      ...current,
    });
}
assert.ok(sim.traffic.diagnostics.honks > 0, "Blocked AI cars must honk");
assert.ok(
  original.every((id) => sim.entities.has(id)),
  "Blocked cars must retain their identities",
);
assert.equal(sim.traffic.diagnostics.respawned, 0);
const report = {
  date: new Date().toISOString(),
  passed: true,
  scope:
    "100 simulated seconds of real AI/contact physics in a barricaded street; not a WAN or hardware performance test",
  tuning: TRAFFIC,
  samples,
  final: sim.traffic.diagnostics,
};
await writeFile("docs/traffic-test.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
