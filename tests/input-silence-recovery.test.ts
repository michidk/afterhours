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
import { TUNING } from "../shared/catalog.ts";
import { Prediction } from "../client/network/prediction.ts";
import { decodeSnapshot, applyPatch } from "../shared/codec.ts";
import type { Entity } from "../shared/world.ts";

for (const kind of ["car", "plane"] as const)
  test(`silent ${kind} coasting cannot be replayed again as pending movement`, async (t) => {
    const city = generateCity();
    city.props = [];
    city.buildings = [];
    const sim = new Simulation(city);
    sim.entities.clear();
    const server = createServer();
    const sessions = new Sessions(server, sim, false, new CityStore(city).manifest);
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
      assert.ok(peer);
      const send = async (message: object) => {
        const received = once(peer, "message");
        ws.send(JSON.stringify(message));
        await received;
      };
      const welcome = once(ws, "message");
      await send({ type: "join", version: VERSION, name: "Silence", color: "#ffffff" });
      await welcome;
      const session = sessions.clients.get(peer);
      assert.ok(session?.id);
      const player = sim.entities.get(session.id);
      assert.ok(player);
      const body = sim.spawn(kind, 0, 0, undefined, kind === "car" ? "sport" : "plane");
      body.driver = player.id;
      player.vehicle = body.id;
      player.seat = 0;
      body.y = kind === "plane" ? 60 : 0;
      body.vz = 40;
      const input = idle();
      const tick = () => {
        sessions.tick();
        sim.tick(TUNING.tick);
      };
      await send({ type: "input", seq: 0, timestamp: 0, ...input });
      tick();
      const prediction = new Prediction(city);
      prediction.reconcile(player, [player, body], 0, 0);
      for (let seq = 1; seq <= 8; seq++)
        prediction.input({ seq, timestamp: seq * TUNING.tick * 1000, input }, [
          player,
          body,
        ]);
      prediction.render(300);

      // The commands exist at the client, but their delivery has stalled.
      wall += 600;
      for (let i = 0; i < 3; i++) tick();
      const received = new Promise<ReturnType<typeof decodeSnapshot>>((resolve) => {
        ws.on("message", (raw, binary) => {
          if (binary && Buffer.isBuffer(raw)) resolve(decodeSnapshot(raw));
        });
      });
      sessions.broadcast();
      const snapshot = await received;
      const entities = new Map<string, Entity>();
      for (const patch of snapshot.entities) applyPatch(entities, patch);
      const controlled = entities.get(player.id);
      assert.ok(controlled);
      prediction.reconcile(controlled, [...entities.values()], snapshot.ack, 300);
      assert.ok(
        prediction.lastCorrection.distance < 0.01,
        `coasting was counted twice: ${prediction.lastCorrection.distance}m correction`,
      );
      assert.equal(snapshot.ack, 3, "each coasting tick consumes one command slot");
      assert.equal(snapshot.idleAck, 3, "the wire identifies silent coasting slots");
      assert.equal(snapshot.ackTimestamp, 0, "coasting cannot make stale input fresh");
      assert.ok(body.vz < 40, "silence still releases controls and permits coasting");

      await send({ type: "input", seq: 1, timestamp: TUNING.tick * 1000, ...idle() });
      tick();
      assert.equal(session.ack, 4, "late input fills its coasting slot once");
      assert.equal(
        session.ackTimestamp,
        2 * TUNING.tick * 1000,
        "late input gains only the new held tick, not past coasting time",
      );

      // A resumed client can abandon unsent slots without a second wait to fill them.
      await send({ type: "input", seq: 5, timestamp: 700, ...idle(), up: true });
      tick();
      assert.equal(session.ack, 5, "the first resumed command runs on the next tick");
      assert.equal(session.speculative, 0, "abandoned slots cannot trap fresh input");
      assert.equal(sim.inputs.get(player.id)?.up, true);
    } finally {
      ws.terminate();
      sessions.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sim.destruction.dispose();
    }
  });
