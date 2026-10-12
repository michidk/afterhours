import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Simulation } from "../server/simulation.ts";
import { Sessions } from "../server/session.ts";
import { CityStore } from "../server/city-stream.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { VERSION, type Snapshot } from "../shared/protocol.ts";
import { decodeSnapshot } from "../shared/codec.ts";

// Drive broadcasts explicitly; this checks transport and delta history without timer jitter.
test("shared snapshot preparation preserves nested changes and removals for every peer", async () => {
  const sim = new Simulation(generateCity());
  sim.entities.clear();
  const server = createServer();
  const sessions = new Sessions(server, sim, false, new CityStore(sim.city).manifest);
  const sockets: WebSocket[] = [];
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (let i = 0; i < 2; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      sockets.push(ws);
      await once(ws, "open");
      const peer = [...sessions.clients.keys()].at(-1)!;
      const received = once(peer, "message");
      ws.send(
        JSON.stringify({
          type: "join",
          version: VERSION,
          name: `Peer ${i}`,
          color: "#ffffff",
        }),
      );
      await received;
    }
    const player = [...sim.entities.values()][0];
    player.jetpack = { fuel: 30, active: false };
    const car = sim.spawn("car", player.x + 10, player.z);
    sim.tick(1 / 30);
    const broadcast = async () => {
      const states = sockets.map(
        (ws) =>
          new Promise<Snapshot>((resolve) => {
            const receive = (raw: Buffer, binary: boolean) => {
              if (!binary) return;
              ws.off("message", receive);
              resolve(decodeSnapshot(raw));
            };
            ws.on("message", receive);
          }),
      );
      sessions.broadcast();
      return Promise.all(states);
    };
    const full = await broadcast();
    assert.ok(full.every((s) => s.full));
    car.seats![0] = player.id;
    player.jetpack.fuel = 29;
    for (const snapshot of await broadcast()) {
      assert.equal(snapshot.full, false);
      assert.equal(
        snapshot.entities.find((e) => e.id === car.id)?.seats?.[0],
        player.id,
      );
      assert.equal(
        snapshot.entities.find((e) => e.id === player.id)?.jetpack?.fuel,
        29,
      );
    }
    car.seats![0] = null;
    player.jetpack = undefined;
    for (const snapshot of await broadcast()) {
      assert.equal(snapshot.entities.find((e) => e.id === car.id)?.seats?.[0], null);
      assert.equal(snapshot.entities.find((e) => e.id === player.id)?.jetpack, null);
    }
    assert.equal(full[0].entities.find((e) => e.id === car.id)?.seats?.[0], null);
  } finally {
    for (const ws of sockets) ws.terminate();
    sessions.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sim.destruction.dispose();
  }
});
