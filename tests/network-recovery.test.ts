import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { GameNetwork } from "../client/network/index.ts";
import { Simulation } from "../server/simulation.ts";
import { Sessions } from "../server/session.ts";
import { CityStore } from "../server/city-stream.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { idle } from "../shared/world.ts";

for (const reason of [
  "size",
  "age",
  "silent",
  "browser stall",
  "draining queue",
  "paused queue",
] as const)
  test(`client recovers from ${reason} without predicting unsent controls`, async (t) => {
    const sim = new Simulation(generateCity());
    const server = createServer();
    const sessions = new Sessions(server, sim, true, new CityStore(sim.city).manifest);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const location = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "http:", host: `127.0.0.1:${address.port}` },
    });
    let clock = 100;
    t.mock.method(performance, "now", () => clock);
    t.mock.timers.enable({ apis: ["setInterval"] });
    let welcome!: () => void;
    const ready = new Promise<void>((resolve) => {
      welcome = resolve;
    });
    const statuses: string[] = [];
    const network = new GameNetwork(
      {
        welcome: () => welcome(),
        state() {},
        chat() {},
        status(s) {
          statuses.push(s);
        },
      },
      "Recovery",
      "#ffffff",
      sim.city,
    );
    try {
      network.connect();
      await ready;
      const socket = network.socket!;
      const oldClose = socket.onclose;
      const oldMessage = socket.onmessage;
      const peer = [...sessions.clients.keys()][0];
      const prediction = network.prediction!;
      const input = t.mock.method(prediction, "input");
      const sends = t.mock.method(socket, "send");
      let buffered = 0;
      Object.defineProperty(socket, "bufferedAmount", { get: () => buffered });
      if (reason === "paused queue") {
        buffered = 1;
        assert.equal(network.send({ type: "ping" }), true);
        clock += 6000;
        assert.equal(
          network.send({ type: "ping" }),
          true,
          "allow bufferedAmount to update after the browser resumes",
        );
        buffered = 0;
        clock += 100;
        assert.equal(network.send({ type: "ping" }), true);
        assert.equal(network.socket, socket);
        return;
      }
      if (reason === "draining queue") {
        buffered = 1;
        for (let i = 0; i < 10; i++) {
          assert.equal(
            network.send({ type: "ping" }),
            true,
            "the remaining byte belongs to the latest write, not an old backlog",
          );
          clock += 100;
        }
        assert.equal(network.socket, socket);
        return;
      }
      if (reason === "browser stall") {
        clock += 6000;
        t.mock.timers.tick(1000);
        assert.equal(
          network.socket,
          socket,
          "a stalled event loop must allow queued replies to run",
        );
        assert.equal(network.stats().connected, true);
        oldMessage?.call(
          socket,
          new MessageEvent("message", {
            data: JSON.stringify({ type: "pong", timestamp: clock }),
          }),
        );
        clock += 1000;
        t.mock.timers.tick(1000);
        assert.equal(network.socket, socket);
        assert.equal(statuses.at(-1), "connected");
        return;
      }
      if (reason === "silent") {
        peer.removeAllListeners("message");
        // Flush the first pong before measuring a silent peer's deadline.
        await new Promise((resolve) => setTimeout(resolve, 20));
        for (let second = 0; second < 5; second++) {
          clock += 1000;
          t.mock.timers.tick(1000);
        }
      } else {
        buffered = reason === "size" ? 4096 : 1;
        if (reason === "age") {
          assert.equal(
            network.send({ type: "ping" }),
            true,
            "short queues are allowed",
          );
          clock += 249;
          assert.equal(network.send({ type: "ping" }), true);
          buffered = 0;
          assert.equal(
            network.send({ type: "ping" }),
            true,
            "a drained queue clears its age",
          );
          clock += 300;
          buffered = 0;
          assert.equal(network.send({ type: "ping" }), true);
          buffered = 1;
          clock += 250;
        }
        const count = sends.mock.callCount();
        network.input({ ...idle(), up: true });
        assert.equal(
          sends.mock.callCount(),
          count,
          "congested controls never reach send",
        );
      }
      assert.equal(input.mock.callCount(), 0);
      assert.equal(
        prediction.body,
        undefined,
        "discard provisional history immediately",
      );
      assert.equal(network.stats().connected, false);
      assert.equal(network.send({ type: "reload" }), false);
      assert.equal(statuses.at(-1), "reconnecting");
      const rejoined = new Promise<void>((resolve) => {
        welcome = resolve;
      });
      network.connect();
      const replacement = network.socket;
      oldClose?.call(socket, new CloseEvent("close"));
      oldMessage?.call(
        socket,
        new MessageEvent("message", {
          data: JSON.stringify({ type: "versionMismatch" }),
        }),
      );
      assert.equal(
        network.socket,
        replacement,
        "obsolete callbacks cannot close the replacement",
      );
      assert.equal(statuses.at(-1), "connecting");
      await rejoined;
      assert.equal(network.seq, 0);
      assert.equal(network.stats().connected, true);
    } finally {
      network.close();
      for (const peer of sessions.clients.keys()) peer.terminate();
      sessions.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sim.destruction.dispose();
      if (location) Object.defineProperty(globalThis, "location", location);
      else Reflect.deleteProperty(globalThis, "location");
    }
  });

test("an open socket that never welcomes the client reaches the response deadline", async (t) => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "http:", host: `127.0.0.1:${address.port}` },
  });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const statuses: string[] = [];
  const network = new GameNetwork(
    {
      welcome() {},
      state() {},
      chat() {},
      status(s) {
        statuses.push(s);
      },
    },
    "Handshake",
    "#ffffff",
  );
  try {
    const connected = once(sockets, "connection");
    network.connect();
    await connected;
    for (let second = 0; second < 4; second++) {
      now += 1000;
      t.mock.timers.tick(1000);
    }
    now = 4999;
    t.mock.timers.tick(999);
    assert.ok(network.socket, "wait for the full response deadline");
    now = 5000;
    t.mock.timers.tick(1);
    assert.equal(network.socket, undefined);
    assert.equal(statuses.at(-1), "reconnecting");
  } finally {
    network.close();
    for (const peer of sockets.clients) peer.terminate();
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (location) Object.defineProperty(globalThis, "location", location);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
