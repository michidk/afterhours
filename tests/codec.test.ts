import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeSnapshot, decodeSnapshot, applyPatch } from "../shared/codec.ts";
import type { Snapshot } from "../shared/protocol.ts";
import { Simulation } from "../server/simulation.ts";
import { generateCity } from "../scripts/city-generator.ts";
test("binary snapshots preserve poses and explicit field removal through deltas", () => {
  const s = new Simulation(generateCity()),
    p = s.join("A", "#ffffff"),
    map = new Map([[p.id, p]]);
  p.vehicle = "e1";
  const frame: Snapshot = {
    type: "state",
    version: 1,
    frame: 2,
    base: 1,
    full: false,
    time: 1,
    day: 12,
    ack: 10,
    entities: [{ id: p.id, x: 12.345, angle: -1.23456, vehicle: null }],
    removed: [],
    pickups: [],
    events: [],
    players: 1,
  };
  const bytes = encodeSnapshot(frame),
    decoded = decodeSnapshot(bytes);
  assert.deepEqual(decoded, frame);
  applyPatch(map, decoded.entities[0]);
  assert.equal(map.get(p.id)!.vehicle, undefined);
  assert.equal(map.get(p.id)!.x, 12.345);
  assert.equal(map.get(p.id)!.health, 100);
});
