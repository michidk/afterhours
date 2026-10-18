import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Simulation } from "../server/simulation.ts";
import { Sessions } from "../server/session.ts";
import { CityStore } from "../server/city-stream.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { idle } from "../shared/world.ts";
import { VERSION } from "../shared/version.ts";
import { predictStep } from "../shared/physics/index.ts";

for (const held of [6, 12])
  for (const driving of [false, true])
    test(`a delayed batch preserves new ${driving ? "driving" : "walking"} commands after ${held} held slots`, async (t) => {
      const sim = new Simulation(generateCity());
      sim.entities.clear();
      sim.city.props = [];
      sim.city.buildings = [];
      const server = createServer();
      const sessions = new Sessions(
        server,
        sim,
        false,
        new CityStore(sim.city).manifest,
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      let wall = Date.now();
      t.mock.method(Date, "now", () => wall);
      try {
        await once(ws, "open");
        const peer = [...sessions.clients.keys()][0];
        const send = async (message: object) => {
          const received = once(peer, "message");
          ws.send(JSON.stringify(message));
          await received;
        };
        await send({
          type: "join",
          version: VERSION,
          name: "Recovery",
          color: "#ffffff",
        });
        const session = sessions.clients.get(peer)!;
        const player = sim.entities.get(session.id!)!;
        player.x = player.z = 0;
        const body = driving ? sim.spawn("car", 0, 0, undefined, "sport") : player;
        if (driving) {
          body.driver = player.id;
          player.vehicle = body.id;
          player.seat = 0;
        }
        const up = { ...idle(), up: true };
        const tick = () => {
          wall += 1000 / 30;
          sessions.tick();
          sim.tick(1 / 30);
        };
        const command = (seq: number) =>
          send({ type: "input", seq, timestamp: (seq * 1000) / 30, ...up });
        await command(0);
        tick();
        const expected = structuredClone(body);
        // Missing commands have already moved the body on held controls.
        for (let i = 0; i < held; i++) tick();
        for (let i = 0; i < held; i++) predictStep(expected, up, sim.city, [], 1 / 30);
        // TCP delivers the held slots plus eight new commands before the next tick.
        for (let seq = 1; seq <= held + 8; seq++) await command(seq);
        assert.equal(
          sessions.dropped,
          0,
          "already simulated slots must not crowd out new commands",
        );
        tick();
        assert.equal(
          session.ack,
          held + 1,
          "held slots fill once, then the first new command steps",
        );
        assert.equal(
          session.queued,
          7,
          "the remaining new commands are still buffered",
        );
        for (let i = 0; i < 7; i++) tick();
        for (let i = 0; i < 8; i++) predictStep(expected, up, sim.city, [], 1 / 30);
        assert.equal(session.ack, held + 8);
        assert.equal(session.queued, 0);
        assert.ok(
          Math.hypot(body.x - expected.x, body.z - expected.z) < 1e-9,
          "authority matches all movement ticks without losing or doubling a step",
        );
      } finally {
        ws.terminate();
        sessions.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        sim.destruction.dispose();
      }
    });
