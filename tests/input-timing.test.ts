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
import { decodeSnapshot, applyPatch } from "../shared/codec.ts";
import { Prediction } from "../client/network/prediction.ts";
import type { Entity } from "../shared/world.ts";

// Advance authority explicitly, so packet batching tests do not depend on CPU speed.
test("an input burst cannot delay the newest stop, duplicate it, or accelerate authority", async () => {
  const sim = new Simulation(generateCity());
  sim.entities.clear();
  sim.city.props = [];
  sim.city.buildings = [];
  const server = createServer();
  const sessions = new Sessions(server, sim, false, new CityStore(sim.city).manifest);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  try {
    await once(ws, "open");
    const peer = [...sessions.clients.keys()][0];
    const send = async (message: unknown) => {
      const received = once(peer, "message");
      ws.send(JSON.stringify(message));
      await received;
    };
    await send({ type: "join", version: VERSION, name: "Burst", color: "#ffffff" });
    const session = sessions.clients.get(peer)!;
    const chats: string[] = [];
    ws.on("message", (raw, binary) => {
      if (!binary) {
        const m = JSON.parse(String(raw));
        assert.equal(typeof m.time, "number", "server messages carry simulation time");
        if (m.type === "chat") chats.push(m.text);
      }
    });
    const chatReceived = new Promise<void>((resolve) => {
      ws.on("message", (raw, binary) => {
        if (!binary && JSON.parse(String(raw)).type === "chat") resolve();
      });
    });
    await send({ type: "reload", timestamp: 1 });
    await send({ type: "chat", timestamp: 2, text: "Action delivered" });
    await chatReceived;
    assert.deepEqual(
      chats,
      ["Action delivered"],
      "one action cannot suppress another type",
    );
    const p = sim.entities.get(session.id!)!;
    p.x = p.z = 0;
    const prediction = new Prediction(sim.city);
    prediction.reconcile(p, [p], -1);
    for (let seq = 0; seq < 12; seq++) {
      await send({ type: "input", seq, timestamp: seq * 33, ...idle(), up: seq < 11 });
      prediction.input(
        { seq, timestamp: seq * 33, input: { ...idle(), up: seq < 11 } },
        [p],
      );
    }
    sessions.tick();
    sim.tick(1 / 30);
    assert.equal(session.ack, 10, "retain at most two ticks of jitter buffering");
    sessions.tick();
    sim.tick(1 / 30);
    assert.equal(session.ack, 11, "the newest stop is applied within two ticks");
    assert.ok(
      Math.abs(p.z - 0.04125) < 1e-8,
      "one accelerating tick and one braking tick",
    );
    const stopped = p.z;
    prediction.reconcile(p, [p], session.ack);
    assert.equal(prediction.pending.length, 0);
    assert.deepEqual(prediction.body, p, "authority replaces discarded speculation");
    assert.equal(sessions.rejected, 0, "backlog must not reject a valid stop");
    await send({ type: "input", seq: 10, timestamp: 0, ...idle(), up: true });
    sessions.tick();
    sim.tick(1 / 30);
    assert.equal(session.ack, 11);
    assert.equal(p.z, stopped, "duplicate old inputs cannot restart movement");
    for (let seq = 12; seq < 24; seq++) {
      await send({ type: "input", seq, timestamp: seq * 33, ...idle(), up: true });
      prediction.input({ seq, timestamp: seq * 33, input: { ...idle(), up: true } }, [
        p,
      ]);
    }
    sessions.tick();
    sim.tick(1 / 30);
    assert.equal(session.ack, 22);
    assert.ok(
      p.z > stopped && p.z - stopped < 0.03,
      "a burst grants one fixed tick, not twelve",
    );
    const received = new Promise<ReturnType<typeof decodeSnapshot>>((resolve) => {
      ws.on("message", (raw, binary) => {
        if (binary && Buffer.isBuffer(raw)) resolve(decodeSnapshot(raw));
      });
    });
    sessions.broadcast();
    const snapshot = await received;
    assert.equal(
      snapshot.ackTimestamp,
      22 * 33,
      "ack echoes applied browser timestamp",
    );
    assert.equal(
      snapshot.ack,
      22,
      "wire ack marks the applied input after shedding old backlog",
    );
    const entities = new Map<string, Entity>();
    for (const patch of snapshot.entities) applyPatch(entities, patch);
    prediction.reconcile(entities.get(p.id)!, [...entities.values()], snapshot.ack);
    assert.deepEqual(
      prediction.pending.map((frame) => frame.seq),
      [23],
    );
    sessions.tick();
    sim.tick(1 / 30);
    assert.ok(
      Math.abs(prediction.body!.z - p.z) < 0.002,
      "replay predicts the remaining tick within wire quantization",
    );
  } finally {
    ws.terminate();
    sessions.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sim.destruction.dispose();
  }
});
