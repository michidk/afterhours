import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../server/simulation.ts";
import { Prediction } from "../client/network/prediction.ts";
import { emptyCity } from "../shared/city-stream.ts";
import { encodeSnapshot, decodeSnapshot, applyPatch } from "../shared/codec.ts";
import { VERSION } from "../shared/version.ts";
import { idle, type Entity } from "../shared/world.ts";
import { TUNING } from "../shared/catalog.ts";

for (const distantBodies of [0, 65])
  for (const [height, otherHeight, touching] of [
    [72.1498, 70.3499, true],
    [72.1504, 70.3496, true],
    [72.1506, 70.3504, false],
  ] as const)
    test(`wire-rounded plane heights ${height}/${otherHeight} preserve contacts with ${distantBodies} distant bodies`, () => {
      const city = emptyCity({
        seed: 42,
        airport: { x: 640, z: -640, w: 128, d: 200 },
      });
      city.roads = [
        { x: 0, z: 0, ax: -512, az: 0, bx: 512, bz: 0, width: 18, kind: "avenue" },
      ];
      const sim = new Simulation(city);
      sim.entities.clear();
      try {
        const pilot = sim.join("Pilot", "#ffffff");
        const otherPilot = sim.join("Other", "#ffffff");
        const plane = sim.spawn("plane", 0, 0, undefined, "plane");
        const other = sim.spawn("plane", 8.8, 0, undefined, "plane");
        pilot.vehicle = plane.id;
        otherPilot.vehicle = other.id;
        pilot.seat = otherPilot.seat = 0;
        plane.driver = pilot.id;
        other.driver = otherPilot.id;
        plane.y = height;
        other.y = otherHeight;
        plane.vz = other.vz = 40;
        for (let i = 0; i < distantBodies; i++)
          sim.spawn("car", 1000 + i * 20, 1000, undefined, "sedan");
        const wire = decodeSnapshot(
          encodeSnapshot({
            type: "state",
            version: VERSION,
            frame: 1,
            base: 0,
            full: true,
            time: 0,
            day: 12,
            ack: -1,
            entities: [...sim.entities.values()],
            removed: [],
            events: [],
            pickups: [],
            players: 2,
          }),
        );
        const entities = new Map<string, Entity>();
        for (const patch of wire.entities) applyPatch(entities, patch);
        const receivedPilot = entities.get(pilot.id);
        assert.ok(receivedPilot);
        const prediction = new Prediction(city);
        prediction.reconcile(receivedPilot, [...entities.values()], -1, 0);
        const input = { ...idle(), up: true };
        sim.inputs.set(pilot.id, input);
        sim.inputs.set(otherPilot.id, input);
        prediction.input({ seq: 0, timestamp: 0, input }, [...entities.values()]);
        sim.tick(TUNING.tick);
        assert.equal(
          plane.x < -0.3,
          touching,
          "authority resolves wings only within the contact height",
        );
        assert.ok(prediction.body);
        const error = Math.hypot(
          prediction.body.x - plane.x,
          prediction.body.z - plane.z,
        );
        assert.ok(error < 0.002, `wire rounding lost the plane contact: ${error}m`);
      } finally {
        sim.destruction.dispose();
      }
    });
