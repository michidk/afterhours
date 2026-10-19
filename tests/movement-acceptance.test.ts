import { test } from "node:test";
import assert from "node:assert/strict";
import { assessMovement } from "../scripts/movement-acceptance.ts";

function trace() {
  return Array.from({ length: 201 }, (_, i) => ({
    type: "sample",
    at: i * 100,
    elapsed: i / 10,
    mapReady: true,
    maxInputLagMs: 5,
    stats: {
      connected: true,
      snapshotAge: 30,
      ackAge: 90,
      correction: 0,
      prediction: "predicting",
      resyncs: 0,
      serverTime: i / 10,
    },
    body: { x: i, z: 0, speed: 25, clearance: 30, owned: true },
  }));
}
const encode = (records: unknown[], completed = true) =>
  records.map((r) => JSON.stringify(r)).join("\n") +
  (completed ? '\n{"type":"summary","at":20000,"completed":true}' : "");

test("five-client acceptance accepts sustained complete flight evidence", () => {
  assert.deepEqual(assessMovement(encode(trace()), "planes", 0, 10).failures, []);
});
test("screenshot latency and correction fail even while connected", () => {
  const records = trace();
  Object.assign(records[150].stats, {
    snapshotAge: 392,
    ackAge: 778,
    correction: 2.058,
  });
  assert.deepEqual(assessMovement(encode(records), "people", 0, 10).failures, [
    "snapshot age >300ms",
    "applied input age >400ms",
    "correction >0.3m",
  ]);
});
test("reconnects and between-sample corrections cannot disappear", () => {
  const records: unknown[] = trace();
  records.push(
    { type: "status", at: 12050, state: "reconnecting" },
    { type: "status", at: 12080, state: "connected" },
    { type: "correction", at: 14050, distance: 1.2 },
  );
  const result = assessMovement(encode(records), "cars", 0, 10);
  assert.ok(result.failures.includes("connection interrupted"));
  assert.ok(result.failures.includes("correction >0.3m"));
});
test("crashes, sparse telemetry and malformed records fail", () => {
  const result = assessMovement(
    encode(trace().slice(0, 140), false) + "\n{}",
    "cars",
    0,
    10,
  );
  for (const failure of [
    "incomplete client",
    "missing samples",
    "missing end of phase",
    "malformed telemetry",
  ])
    assert.ok(result.failures.includes(failure), failure);
});
test("parked cars and taxiing planes cannot pass", () => {
  const records = trace();
  for (const r of records) {
    r.body.speed = 0;
    r.body.clearance = 0;
  }
  const result = assessMovement(encode(records), "planes", 0, 10);
  assert.ok(result.failures.includes("did not sustain movement"));
  assert.ok(result.failures.includes("did not sustain flight"));
});
test("prediction suspension and generator stalls fail", () => {
  const records = trace();
  records[150].stats.prediction = "waiting for acknowledgements";
  records[150].maxInputLagMs = 300;
  const result = assessMovement(encode(records), "people", 0, 10);
  assert.ok(result.failures.includes("prediction suspended"));
  assert.ok(result.failures.includes("load generator stalled >250ms"));
});

test("the report includes corrections captured by samples as well as events", () => {
  const records = trace();
  records[150].stats.correction = 2.058;
  assert.equal(
    assessMovement(encode(records), "people", 0, 10).maxCorrectionMeters,
    2.058,
  );
});
