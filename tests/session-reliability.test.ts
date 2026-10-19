import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Simulation } from "../server/simulation.ts";
import { Sessions } from "../server/session.ts";
import { CityStore } from "../server/city-stream.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { VERSION, type Welcome } from "../shared/protocol.ts";
import { TUNING } from "../shared/catalog.ts";
import { decodeSnapshot } from "../shared/codec.ts";
import { idle } from "../shared/world.ts";

async function fixture(t: TestContext) {
  const sim = new Simulation(generateCity());
  sim.entities.clear();
  const server = createServer();
  const sessions = new Sessions(server, sim, true, new CityStore(sim.city).manifest);
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    sessions.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sim.destruction.dispose();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    sockets.push(ws);
    await once(ws, "open");
    return ws;
  };
  const join = async (ws: WebSocket, token?: string) => {
    const reply = once(ws, "message");
    ws.send(
      JSON.stringify({
        type: "join",
        version: VERSION,
        name: "Peer",
        color: "#ffffff",
        token,
      }),
    );
    const [raw] = await reply;
    return JSON.parse(String(raw)) as Welcome;
  };
  return { sim, sessions, connect, join };
}

test("oversized frames close only the offending socket, before and after joining", async (t) => {
  const { sessions, connect, join } = await fixture(t);
  for (const joined of [false, true]) {
    const bad = await connect();
    if (joined) await join(bad);
    const closed = once(bad, "close");
    bad.send("x".repeat(4097));
    await closed;
    const good = await connect();
    const reply = once(good, "message");
    good.send(JSON.stringify({ type: "ping", timestamp: 42 }));
    assert.equal(JSON.parse(String((await reply)[0])).timestamp, 42);
  }
  assert.equal(sessions.rejected, 2);
});

test("congestion retries destruction and preserves the last delivered snapshot base", async (t) => {
  const { sim, sessions, connect, join } = await fixture(t);
  const ws = await connect();
  await join(ws);
  const peer = [...sessions.clients.keys()][0];
  let buffered = 255999;
  Object.defineProperty(peer, "bufferedAmount", { get: () => buffered });
  const send = peer.send.bind(peer);
  t.mock.method(peer, "send", (data: Parameters<typeof peer.send>[0]) => {
    buffered += typeof data === "string" ? Buffer.byteLength(data) : 1000;
    send(data);
  });
  sim.destruction.broken.add("prop:0");
  const roster = once(ws, "message");
  sessions.broadcast();
  assert.equal(JSON.parse(String((await roster)[0])).type, "roster");
  const received: {
    type: string;
    brokenProps?: string[];
    full?: boolean;
    base?: number;
  }[] = [];
  ws.on("message", (raw, binary) => {
    assert.ok(Buffer.isBuffer(raw));
    received.push(binary ? decodeSnapshot(raw) : JSON.parse(String(raw)));
  });
  buffered = 0;
  const state = new Promise<void>((resolve) =>
    ws.on("message", (_, binary) => {
      if (binary) resolve();
    }),
  );
  sessions.broadcast();
  await state;
  // Map positions are droppable telemetry sent alongside; the reliable messages keep their order.
  const reliable = received.filter((m) => m.type !== "positions");
  assert.deepEqual(
    reliable.map((m) => m.type),
    ["destruction", "state"],
  );
  assert.deepEqual(reliable[0].brokenProps, ["prop:0"]);
  assert.equal(reliable[1].full, true);
  assert.equal(reliable[1].base, 0);
});

test("transport diagnostics retain writes, congestion and disconnect times", async (t) => {
  const { sessions, connect, join } = await fixture(t);
  sessions.debug = true;
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const ws = await connect();
  const welcome = await join(ws);
  const peer = [...sessions.clients.keys()][0];
  const socketPeer = sessions.clients.get(peer)?.socketPeer;
  assert.ok(socketPeer);
  assert.equal(socketPeer.remoteAddress, "127.0.0.1");
  assert.equal(typeof socketPeer.remotePort, "number");
  const address = sessions.wss.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(socketPeer.localPort, address.port);
  now = 1100;
  const pong = once(ws, "message");
  ws.send(JSON.stringify({ type: "input", seq: 0, timestamp: 50, ...idle() }));
  ws.send(JSON.stringify({ type: "ping", timestamp: 51 }));
  await pong;
  now = 1200;
  const state = new Promise<void>((resolve) =>
    ws.on("message", (_, binary) => {
      if (binary) resolve();
    }),
  );
  sessions.broadcast();
  await state;
  let buffered = 256000;
  Object.defineProperty(peer, "bufferedAmount", { get: () => buffered });
  now = 1300;
  sessions.broadcast();
  assert.deepEqual(sessions.transportStats(), {
    at: 1300,
    clients: [
      {
        playerId: welcome.id,
        lastInputAt: 1100,
        lastSnapshotAt: 1200,
        skippedSnapshots: 1,
        bufferedBytes: 256000,
        ...socketPeer,
      },
    ],
    closed: [],
  });
  buffered = 0;
  now = 1400;
  const closed = once(peer, "close");
  ws.close();
  await closed;
  assert.deepEqual(sessions.transportStats(), {
    at: 1400,
    clients: [],
    closed: [
      {
        playerId: welcome.id,
        lastInputAt: 1100,
        lastSnapshotAt: 1200,
        skippedSnapshots: 1,
        bufferedBytes: 0,
        ...socketPeer,
        closedAt: 1400,
      },
    ],
  });
});

test("a full city restores an active session while rejecting a new player", async (t) => {
  const { sessions, connect, join } = await fixture(t);
  let first: Welcome | undefined;
  let original: WebSocket | undefined;
  for (let i = 0; i < TUNING.maxPlayers; i++) {
    const ws = await connect();
    const welcome = await join(ws);
    if (i === 0) {
      first = welcome;
      original = ws;
    }
  }
  assert.ok(first && original);
  const oldClosed = once(original, "close");
  const returning = await connect();
  const restored = await join(returning, first.token);
  assert.equal(restored.id, first.id);
  await oldClosed;
  assert.equal(sessions.roster().length, TUNING.maxPlayers);
  const extra = await connect();
  const refused = once(extra, "close");
  extra.send(
    JSON.stringify({ type: "join", version: VERSION, name: "Extra", color: "#ffffff" }),
  );
  assert.equal((await refused)[0], 1013);
  assert.equal(sessions.roster().length, TUNING.maxPlayers);
});

test("old protocol clients receive a refresh response before closing", async (t) => {
  const { connect } = await fixture(t);
  const ws = await connect();
  const response = once(ws, "message"),
    closed = once(ws, "close");
  ws.send(
    JSON.stringify({
      type: "join",
      version: VERSION - 1,
      name: "Old",
      color: "#ffffff",
    }),
  );
  assert.deepEqual(JSON.parse(String((await response)[0])).type, "versionMismatch");
  assert.equal((await closed)[0], 1002);
});

test("pings cannot keep an unjoined connection past the handshake deadline", async (t) => {
  const { sessions, connect } = await fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const ws = await connect();
  now += 5001;
  const pong = once(ws, "message");
  ws.send(JSON.stringify({ type: "ping", timestamp: 1 }));
  await pong;
  const closed = once(ws, "close");
  sessions.tick();
  await closed;
  assert.equal(sessions.clients.size, 0);
});

for (const takeover of [false, true])
  test(`session recovery preserves a driver's seat during ${takeover ? "active takeover" : "socket replacement"}`, async (t) => {
    const { sim, sessions, connect, join } = await fixture(t);
    const ws = await connect();
    const welcome = await join(ws);
    const player = sim.entities.get(welcome.id)!;
    player.x = player.z = 0;
    const car = sim.spawn("car", 0, 0);
    sim.interact(player.id);
    assert.equal(player.vehicle, car.id);
    if (!takeover) {
      const peer = [...sessions.clients.keys()][0];
      const closed = once(peer, "close");
      ws.close();
      await closed;
      assert.equal(player.vehicle, car.id, "transient disconnect keeps the seat");
      assert.equal(
        sim.inputs.get(player.id)?.brake,
        true,
        "stale throttle is released",
      );
    }
    const replacement = await connect();
    const restored = await join(replacement, welcome.token);
    assert.equal(restored.id, player.id);
    assert.equal(player.vehicle, car.id, "recovery never ejects the driver");
    assert.equal(car.driver, player.id);
    assert.equal(sim.inputs.get(player.id)?.brake, true);
    const peer = [...sessions.clients.keys()][0];
    const closed = once(peer, "close");
    replacement.close();
    await closed;
    const expired = Date.now() + 15001;
    t.mock.method(Date, "now", () => expired);
    sessions.tick();
    assert.equal(
      sim.entities.has(player.id),
      false,
      "expired sessions leave the world",
    );
    assert.equal(car.driver, undefined, "expired sessions release ownership");
  });
