import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeSnapshot, decodeSnapshot, applyPatch } from "../shared/codec.ts";
import type { Snapshot } from "../shared/protocol.ts";
import { Simulation } from "../server/simulation.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { VERSION } from "../shared/protocol.ts";
test("binary snapshots preserve poses and explicit field removal through deltas", () => {
  const s = new Simulation(generateCity()),
    p = s.join("A", "#ffffff"),
    map = new Map([[p.id, p]]);
  p.vehicle = "e1";
  const frame: Snapshot = {
    type: "state",
    version: VERSION,
    frame: 2,
    base: 1,
    full: false,
    time: 1,
    day: 12,
    ack: 10,
    entities: [
      {
        id: p.id,
        x: 12.345,
        angle: -1.23456,
        vehicle: null,
        jetpack: { active: true, fuel: 7 },
      },
    ],
    removed: [],
    pickups: [
      {
        id: "ammo",
        kind: "ammo",
        ammoKind: "fuel",
        amount: 42,
        x: 0,
        y: 0,
        z: 0,
        expires: 120,
      },
      { id: "pack", kind: "jetpack", fuel: 12, x: 2, y: 0, z: 0, expires: 120 },
    ],
    grenades: [
      {
        id: "grenade",
        owner: p.id,
        x: 1,
        y: 2,
        z: 3,
        vx: 4,
        vy: 5,
        vz: 6,
        radius: 0.16,
        detonateAt: 4,
      },
    ],
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
  assert.deepEqual(map.get(p.id)!.jetpack, { active: true, fuel: 7 });
  applyPatch(map, { id: p.id, jetpack: null });
  assert.equal(map.get(p.id)!.jetpack, undefined);
});
