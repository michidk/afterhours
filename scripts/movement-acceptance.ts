import { z } from "zod";

export const movementRecord = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), at: z.number(), bodyId: z.string() }),
  z.object({ type: z.literal("status"), at: z.number(), state: z.string() }),
  z.object({ type: z.literal("correction"), at: z.number(), distance: z.number() }),
  z.object({ type: z.literal("summary"), at: z.number(), completed: z.boolean() }),
  z.object({
    type: z.literal("sample"),
    at: z.number(),
    elapsed: z.number(),
    mapReady: z.boolean(),
    maxInputLagMs: z.number(),
    stats: z.object({
      connected: z.boolean(),
      lastDisconnect: z.string().optional(),
      snapshotAge: z.number().optional(),
      ackAge: z.number().optional(),
      correction: z.number(),
      prediction: z.string(),
      resyncs: z.number(),
      serverTime: z.number(),
    }),
    body: z
      .object({
        x: z.number(),
        z: z.number(),
        speed: z.number(),
        clearance: z.number(),
        owned: z.boolean(),
      })
      .optional(),
  }),
]);
export function assessMovement(
  text: string,
  phase: "people" | "cars" | "planes",
  start: number,
  seconds: number,
) {
  const failures = new Set<string>();
  const records: z.infer<typeof movementRecord>[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      records.push(movementRecord.parse(JSON.parse(line)));
    } catch {
      failures.add("malformed telemetry");
    }
  }
  // Ten seconds permit acceleration/takeoff. Link failures still count during it.
  const end = start + (seconds + 10) * 1000;
  const samples = records.filter((r) => r.type === "sample");
  const measured = samples.filter((r) => r.at >= start + 10000 && r.at <= end);
  if (!records.some((r) => r.type === "summary" && r.completed))
    failures.add("incomplete client");
  if (records.some((r) => r.type === "status" && r.state !== "connected"))
    failures.add("connection interrupted");
  if (samples.some((r) => !r.stats.connected || r.stats.lastDisconnect))
    failures.add("connection interrupted");
  if (measured.length < seconds * 8) failures.add("missing samples");
  let previous = start + 10000;
  let moving = 0,
    airborne = 0;
  for (const r of measured) {
    if (r.at - previous > 300) failures.add("sample gap >300ms");
    previous = r.at;
    if (!r.mapReady || !r.body?.owned) failures.add("map or controlled body missing");
    if ((r.stats.snapshotAge ?? Infinity) > 300) failures.add("snapshot age >300ms");
    if ((r.stats.ackAge ?? Infinity) > 400) failures.add("applied input age >400ms");
    if (r.stats.correction > 0.3) failures.add("correction >0.3m");
    if (r.stats.prediction.startsWith("waiting")) failures.add("prediction suspended");
    if (r.maxInputLagMs > 250) failures.add("load generator stalled >250ms");
    if ((r.body?.speed ?? 0) > (phase === "people" ? 2 : phase === "cars" ? 5 : 19))
      moving++;
    if ((r.body?.clearance ?? 0) > 5) airborne++;
  }
  if (end - previous > 300) failures.add("missing end of phase");
  if (
    records.some(
      (r) =>
        r.type === "correction" &&
        r.at >= start + 10000 &&
        r.at <= end &&
        r.distance > 0.3,
    )
  )
    failures.add("correction >0.3m");
  if (!measured.length || moving / measured.length < 0.9)
    failures.add("did not sustain movement");
  if (phase === "planes" && (!measured.length || airborne / measured.length < 0.9))
    failures.add("did not sustain flight");
  const first = measured[0],
    last = measured.at(-1);
  const simulationRate =
    first && last
      ? ((last.stats.serverTime - first.stats.serverTime) * 1000) / (last.at - first.at)
      : 0;
  if (simulationRate < 0.9) failures.add("simulation fell behind wall time");
  if (first && last && last.stats.resyncs > first.stats.resyncs)
    failures.add("input resynchronization");
  const max = (values: number[]) => Math.max(0, ...values);
  return {
    failures: [...failures],
    samples: measured.length,
    simulationRate,
    maxSnapshotAgeMs: max(measured.map((r) => r.stats.snapshotAge ?? 0)),
    maxAppliedInputAgeMs: max(measured.map((r) => r.stats.ackAge ?? 0)),
    maxInputLagMs: max(measured.map((r) => r.maxInputLagMs)),
    maxCorrectionMeters: max([
      ...measured.map((r) => r.stats.correction),
      ...records.flatMap((r) =>
        r.type === "correction" && r.at >= start + 10000 && r.at <= end
          ? [r.distance]
          : [],
      ),
    ]),
    movingFraction: measured.length ? moving / measured.length : 0,
    airborneFraction: measured.length ? airborne / measured.length : 0,
  };
}
