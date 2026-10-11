import { generateCity } from "../scripts/city-generator.ts";
import RAPIER from "@dimforge/rapier2d-compat";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { Simulation } from "../server/simulation.ts";
import { contact, entityBox, resolveContact } from "../shared/physics/index.ts";
import { SpatialGrid } from "../shared/spatial.ts";
import type { Entity } from "../shared/world.ts";
await RAPIER.init();
const s = new Simulation(generateCity());
s.entities.clear();
const bodies = Array.from({ length: 120 }, (_, i) => {
  const e = s.spawn("car", (i % 12) * 3, Math.floor(i / 12) * 5);
  e.vx = i % 2 ? 8 : -8;
  e.vz = i % 3 ? 12 : -12;
  return e;
});
const custom = structuredClone(bodies),
  grid = new SpatialGrid<Entity>();
const stats = (samples: number[]) => {
  samples.sort((a, b) => a - b);
  return {
    p50Ms: samples[Math.floor(samples.length * 0.5)],
    p95Ms: samples[Math.floor(samples.length * 0.95)],
    maxMs: samples.at(-1),
  };
};
const samples: number[] = [];
for (let tick = 0; tick < 720; tick++) {
  const start = performance.now();
  for (const e of custom) {
    e.x += e.vx / 120;
    e.z += e.vz / 120;
    e.angle += (e.angularVelocity || 0) / 120;
  }
  for (let pass = 0; pass < 3; pass++) {
    grid.clear();
    for (const e of custom) grid.insert(e, e.x, e.z, 6);
    for (const a of custom)
      for (const b of grid.query(a.x, a.z, 10)) {
        if (a.id >= b.id) continue;
        const c = contact(entityBox(a), entityBox(b));
        if (c) resolveContact(a, b, c);
      }
  }
  if (tick > 120) samples.push(performance.now() - start);
}
const world = new RAPIER.World({ x: 0, y: 0 });
world.timestep = 1 / 120;
for (const e of bodies) {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(e.x, e.z)
      .setLinvel(e.vx, e.vz)
      .setCcdEnabled(true),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(1, 2.15)
      .setMass(1000)
      .setRestitution(0.18)
      .setFriction(0),
    body,
  );
}
const rapier: number[] = [];
for (let tick = 0; tick < 720; tick++) {
  const start = performance.now();
  world.step();
  if (tick > 120) rapier.push(performance.now() - start);
}
const ccd = new RAPIER.World({ x: 0, y: 0 });
ccd.timestep = 1 / 30;
const body = ccd.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, 0)
    .setLinvel(0, 600)
    .setCcdEnabled(true),
);
ccd.createCollider(RAPIER.ColliderDesc.cuboid(1, 2.15).setMass(1000), body);
ccd.createCollider(RAPIER.ColliderDesc.cuboid(6, 0.5).setTranslation(0, 10));
ccd.step();
const report = {
  date: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  bodies: 120,
  stepHz: 120,
  samples: 599,
  custom: stats(samples),
  rapier: stats(rapier),
  rapierCCDStoppedBeforeWall: body.translation().y < 9.5,
  method:
    "120 equal rectangle bodies, no tyre forces/AI/vertical simulation, three SAT passes versus Rapier defaults with CCD, 120 warmup steps then 599 samples. Contact-only microbenchmark, not a full-game comparison.",
};
world.free();
ccd.free();
await writeFile("docs/physics-benchmark.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
