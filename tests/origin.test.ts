import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Simulation } from "../server/simulation.ts";
import { Sessions } from "../server/session.ts";
import { CityStore } from "../server/city-stream.ts";
import { generateCity } from "../scripts/city-generator.ts";

test("configured public origin works behind container NAT without trusting forwarded headers", async () => {
  const previous = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://city.example";
  const sim = new Simulation(generateCity());
  const server = createServer();
  const sessions = new Sessions(server, sim, true, new CityStore(sim.city).manifest);
  if (previous === undefined) delete process.env.PUBLIC_ORIGIN;
  else process.env.PUBLIC_ORIGIN = previous;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (const origin of [
      "https://city.example",
      "http://city.example",
      "https://malicious.example",
      "null",
    ]) {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
        origin,
        localAddress: "127.0.0.2",
        headers: { "X-Forwarded-Host": "malicious.example" },
      });
      const result = new Promise<string | number>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("Origin check timed out")), 5000);
        ws.once("open", () => ws.send(JSON.stringify({ type: "ping", timestamp: 1 })));
        ws.once("error", reject);
        ws.once("message", (message) => {
          clearTimeout(timer);
          resolve(String(message));
        });
        ws.once("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      try {
        const response = await result;
        if (origin === "https://city.example") {
          assert.equal(typeof response, "string");
          assert.equal(JSON.parse(String(response)).type, "pong");
        } else assert.equal(response, 1008);
      } finally {
        ws.terminate();
      }
    }
  } finally {
    sessions.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sim.destruction.dispose();
  }
});
