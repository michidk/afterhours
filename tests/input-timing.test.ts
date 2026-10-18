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
import { decodeSnapshot, applyPatch } from "../shared/codec.ts";
import { predictStep } from "../shared/physics/index.ts";
import { Prediction } from "../client/network/prediction.ts";
import type { Entity } from "../shared/world.ts";

// Advance authority explicitly, so packet batching tests do not depend on CPU speed.
test("the server applies exactly the commands a client sent: bounded bursts, held slots filled once, nothing invented", async (t) => {
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
  // Wall time only decides the silence rule; keep it under test control.
  let wall = Date.now();
  t.mock.method(Date, "now", () => wall);
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
    // Independent replay of whatever authority should have applied, in order.
    const expected = structuredClone(p);
    const up = { ...idle(), up: true };
    const apply = (...inputs: (typeof up)[]) => {
      for (const input of inputs) predictStep(expected, input, sim.city, [], 1 / 30);
    };
    const tick = () => {
      sessions.tick();
      sim.tick(1 / 30);
    };
    const agree = (what: string) =>
      assert.ok(
        Math.abs(p.z - expected.z) < 1e-9 && Math.abs(p.vz - expected.vz) < 1e-9,
        `${what}: authority z=${p.z} vz=${p.vz}, expected z=${expected.z} vz=${expected.vz}`,
      );
    const prediction = new Prediction(sim.city);
    prediction.reconcile(p, [p], -1);
    const frame = (seq: number, input = up) => ({ seq, timestamp: seq * 33, input });
    const command = async (seq: number, input = up) => {
      await send({ type: "input", seq, timestamp: seq * 33, ...input });
      // Like GameNetwork, never predict a slot the server already acknowledged.
      if (seq > session.ack) prediction.input(frame(seq, input), [p]);
    };
    for (let seq = 0; seq < 12; seq++) await command(seq, seq < 11 ? up : idle());
    assert.equal(
      session.queue.length,
      TUNING.inputQueue,
      "the FIFO keeps a full browser catch-up burst",
    );
    assert.equal(sessions.dropped, 12 - TUNING.inputQueue, "older commands are shed");
    tick();
    assert.equal(session.ack, 4, "a burst grants one fixed tick, not twelve");
    apply(up);
    agree("first retained command");
    for (let i = 0; i < 3; i++) tick();
    assert.equal(session.ack, 7);
    apply(up, up, up);
    agree("one command per tick, in order");
    for (let i = 0; i < 4; i++) tick();
    assert.equal(session.ack, 11, "the newest stop drains with the queue");
    apply(up, up, up, idle());
    agree("the stop applies after the retained throttle");
    assert.equal(sessions.rejected, 0, "a backlog must not reject a valid stop");
    assert.equal(session.queued, 0);
    // Nothing buffered within the silence window: the last movement controls are
    // held, the slot is acknowledged in advance, and the late command fills it later.
    tick();
    assert.equal(sessions.speculated, 1);
    assert.equal(session.ack, 12, "a held slot is acknowledged before its command");
    assert.equal(session.speculative, 1);
    apply(idle());
    agree("a held tick repeats the last movement controls");
    await command(12);
    await command(13);
    tick();
    assert.equal(session.ack, 13);
    assert.equal(session.speculative, 0, "the late command filled the held slot");
    assert.equal(
      sessions.mispredicted,
      1,
      "its controls differed from the held stop, so the client will correct",
    );
    apply(up);
    agree("a command for a held slot is not stepped again");
    tick();
    assert.equal(sessions.speculated, 2);
    assert.equal(session.ack, 14);
    apply(up);
    agree("held controls continue the last command");
    await command(14);
    await command(15);
    tick();
    assert.equal(session.ack, 15);
    assert.equal(sessions.mispredicted, 1, "matching controls are not a misprediction");
    apply(up);
    agree("only the command beyond the held slot steps");
    await send({ type: "input", seq: 10, timestamp: 0, ...up });
    assert.equal(sessions.rejected, 1, "stale sequence numbers are rejected");
    tick();
    assert.equal(session.ack, 16);
    assert.equal(sessions.speculated, 3);
    apply(up);
    agree("a duplicate old command changes nothing");
    tick();
    assert.equal(session.ack, 17, "two slots are now owed");
    assert.equal(session.speculative, 2);
    apply(up);
    await command(16);
    tick();
    assert.equal(
      session.ack,
      18,
      "filling one of several owed slots never lowers the acknowledgement",
    );
    assert.equal(session.speculative, 2, "one slot filled, one more held");
    assert.equal(session.queued, -2, "the net buffer reports slots still owed");
    apply(up);
    agree("the filled slot is not stepped again");
    await command(17);
    await command(18);
    await command(19);
    tick();
    assert.equal(session.ack, 19, "owed slots fill first, the next command steps");
    assert.equal(session.speculative, 0);
    assert.equal(session.queued, 0);
    apply(up);
    agree("exactly one step for the command beyond the owed slots");
    tick();
    assert.equal(session.ack, 20);
    assert.equal(session.speculative, 1);
    apply(up);
    for (let seq = 20; seq < 33; seq++) await command(seq);
    assert.equal(sessions.dropped, 8);
    tick();
    assert.equal(
      session.ack,
      25,
      "a shed gap moves the owed slot to the first surviving command, then one steps",
    );
    assert.equal(session.speculative, 0);
    apply(up);
    agree("a burst grants one fixed tick, not twelve");
    tick();
    assert.equal(session.ack, 26, "a burst still grants one world tick");
    apply(up);
    agree("no further acceleration");
    tick();
    tick();
    assert.equal(session.ack, 28, "catch-up uses two complete world ticks");
    apply(up, up);
    agree("both world ticks apply all contact substeps");
    const received = new Promise<ReturnType<typeof decodeSnapshot>>((resolve) => {
      ws.on("message", (raw, binary) => {
        if (binary && Buffer.isBuffer(raw)) resolve(decodeSnapshot(raw));
      });
    });
    sessions.broadcast();
    const snapshot = await received;
    assert.equal(
      snapshot.ackTimestamp,
      28 * 33,
      "ack echoes applied browser timestamp",
    );
    assert.equal(snapshot.ack, 28, "wire ack marks the newest applied command");
    assert.equal(snapshot.queued, 4, "snapshots report the remaining buffer depth");
    const entities = new Map<string, Entity>();
    for (const patch of snapshot.entities) applyPatch(entities, patch);
    prediction.reconcile(entities.get(p.id)!, [...entities.values()], snapshot.ack);
    assert.deepEqual(
      prediction.pending.map((f) => f.seq),
      [29, 30, 31, 32],
    );
    for (let i = 0; i < 4; i++) tick();
    assert.equal(session.ack, 32);
    assert.ok(
      Math.abs(prediction.body!.z - p.z) < 0.002,
      "replay predicts the remaining ticks within wire quantization",
    );
    // Silence beyond 500 ms releases controls instead of holding them forever.
    wall += 600;
    const movingVz = p.vz;
    tick();
    assert.equal(sessions.speculated, 6, "silence idles rather than speculates");
    assert.ok(p.vz < movingVz, "idle input decelerates the body");
  } finally {
    ws.terminate();
    sessions.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sim.destruction.dispose();
  }
});
