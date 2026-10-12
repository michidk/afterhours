import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { GameNetwork } from "../client/network/index.ts";
import { Simulation } from "../server/simulation.ts";
import { Sessions } from "../server/session.ts";
import { CityStore } from "../server/city-stream.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { idle } from "../shared/world.ts";
import { messageSchema } from "../shared/protocol.ts";

test("network diagnostics measure real RTT, timestamped inputs and applied acknowledgements", async () => {
  const sim = new Simulation(generateCity());
  sim.entities.clear();
  sim.city.buildings = [];
  sim.city.props = [];
  const server = createServer();
  const sessions = new Sessions(server, sim, true, new CityStore(sim.city).manifest);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "http:", host: `127.0.0.1:${address.port}` },
  });
  let ready!: () => void;
  const welcome = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let state!: () => void;
  const network = new GameNetwork(
    { welcome: ready, state: () => state?.(), chat() {}, status() {} },
    "Stats",
    "#ffffff",
    sim.city,
  );
  try {
    network.connect();
    network.input({ ...idle(), up: true });
    assert.equal(network.seq, 0, "never predict or send before welcome");
    await welcome;
    const peer = [...sessions.clients.keys()][0];
    const received: Record<string, unknown>[] = [];
    peer.on("message", (raw) => received.push(JSON.parse(String(raw))));
    const snapshot = () =>
      new Promise<void>((resolve) => {
        state = resolve;
        sessions.broadcast();
      });
    const p = sim.entities.get(network.playerId)!;
    const near = sim.spawn("car", p.x + 180, p.z);
    const far = sim.spawn("car", p.x + 230, p.z);
    sim.tick(1 / 30);
    await snapshot();
    assert.ok(network.entities.has(near.id), "traffic at 180 m reaches the client");
    assert.equal(
      network.entities.has(far.id),
      false,
      "traffic beyond 220 m stays outside snapshots",
    );
    const inputReceived = once(peer, "message");
    network.input({
      ...idle(),
      up: true,
      right: true,
      sprint: true,
      ascend: true,
      descend: true,
      brake: true,
      attack: true,
      aim: -Math.PI + 0.02,
    });
    await inputReceived;
    const message = received.find((m) => m.type === "input")!;
    assert.equal(message.seq, 0);
    assert.equal(typeof message.timestamp, "number");
    for (const key of ["up", "right", "sprint", "ascend", "descend", "brake", "attack"])
      assert.equal(message[key], true, key);
    assert.equal(message.aim, -Math.PI + 0.02);
    sessions.tick();
    sim.tick(1 / 30);
    await snapshot();
    const stats = network.stats();
    assert.ok(stats.rtt !== undefined && stats.rtt >= 0);
    assert.equal(stats.connected, true);
    assert.equal(stats.seq, 0);
    assert.equal(stats.ack, 0);
    assert.equal(stats.pending, 0);
    assert.equal(stats.inputsPerSecond, 1);
    assert.equal(stats.snapshotsPerSecond, 2);
    assert.ok(stats.ackAge !== undefined && stats.ackAge >= 0);
    assert.equal(network.ackTimestamp, message.timestamp);
    assert.equal(stats.prediction, "predicting");
    const player = network.entities.get(network.playerId)!;
    assert.ok(
      Math.abs(player.aim! - (-Math.PI + 0.02)) < 0.00001,
      "server applies aim independently of walking yaw",
    );
    const actionReceived = once(peer, "message");
    network.send({ type: "reload" });
    await actionReceived;
    assert.equal(typeof received.at(-1)!.timestamp, "number");
    const future = network.stats(performance.now() + 2000);
    assert.equal(future.inputsPerSecond, 0, "rates fall to zero without traffic");
    assert.equal(future.snapshotsPerSecond, 0);
    assert.ok(future.snapshotAge! >= 2000);
    network.close();
    assert.equal(network.stats().connected, false);
  } finally {
    network.close();
    sessions.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sim.destruction.dispose();
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("optional action timestamps are validated at the socket boundary", () => {
  assert.equal(
    messageSchema.safeParse({ type: "reload", timestamp: -1 }).success,
    false,
  );
  assert.equal(
    messageSchema.safeParse({ type: "reload", timestamp: "now" }).success,
    false,
  );
  assert.equal(
    messageSchema.safeParse({ type: "reload", timestamp: 42 }).success,
    true,
  );
});
