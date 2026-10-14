import { Prediction } from "../client/network/prediction.ts";
import { emptyCity } from "../shared/city-stream.ts";
import { idle, type Entity } from "../shared/world.ts";

/** Deterministic pileup: 40 cars, six-command acknowledgement backlog, 30 Hz input, 60 Hz render. */
export function predictionWorkload(Predict = Prediction, frames = 360) {
  const city = emptyCity({ seed: 1, airport: { x: 1000, z: 1000, w: 100, d: 100 } });
  city.buildings = [{ x: 9, z: 0, w: 3, d: 80, h: 10, color: "#888", style: 0 }];
  const cars: Entity[] = Array.from({ length: 40 }, (_, i) => ({
    id: `car-${String(i).padStart(2, "0")}`,
    kind: "car",
    model: "sport",
    x: (i % 5) * 2.1,
    z: Math.floor(i / 5) * 4.1,
    y: 0,
    angle: 0,
    vx: 0,
    vy: 0,
    vz: i === 0 ? 52 : 10,
    color: "#fff",
    health: 100,
    driver: `driver-${i}`,
    drive: { throttle: i === 0 ? 1 : 0, steer: 0, brake: i > 0 },
  }));
  const player: Entity = {
    ...cars[0],
    id: "player",
    kind: "player",
    vehicle: cars[0].id,
  };
  cars[0].driver = player.id;
  const entities = [player, ...cars];
  const authority = JSON.stringify(entities);
  const input = { ...idle(), up: true };
  const prediction = new Predict(city);
  const samples: number[] = [];
  const stages = { reconcile: 0, input: 0, render: 0 };
  let seq = 0,
    contacts = 0,
    checksum = 0;
  prediction.reconcile(player, entities, -1, 0);
  for (let frame = 0; frame < frames + 60; frame++) {
    const now = (frame * 1000) / 60;
    const start = performance.now();
    if (frame % 4 === 0) {
      const at = performance.now();
      prediction.reconcile(player, entities, seq - 7, now);
      if (frame >= 60) stages.reconcile += performance.now() - at;
    }
    if (frame % 2 === 0) {
      const at = performance.now();
      prediction.input({ seq: seq++, timestamp: now, input }, entities);
      if (frame >= 60) stages.input += performance.now() - at;
    }
    const at = performance.now();
    const rendered = prediction.render(now + 8)!;
    if (frame >= 60) {
      stages.render += performance.now() - at;
      samples.push(performance.now() - start);
      contacts += rendered.contacts.size - 1;
      checksum += rendered.body.x + rendered.body.z + rendered.body.vz;
    }
  }
  if (JSON.stringify(entities) !== authority)
    throw Error("Prediction mutated authority");
  if (!Number.isFinite(checksum) || contacts === 0 || prediction.pending.length > 8)
    throw Error("Invalid pileup workload");
  samples.sort((a, b) => a - b);
  return {
    frames,
    cars: cars.length,
    contacts,
    checksum,
    pending: prediction.pending.length,
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms: samples[Math.floor(samples.length * 0.95)],
    totalMs: samples.reduce((a, b) => a + b, 0),
    stages,
  };
}
