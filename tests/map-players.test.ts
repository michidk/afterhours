import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";
import { Simulation } from "../server/simulation.ts";
import { Sessions } from "../server/session.ts";
import { CityStore } from "../server/city-stream.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { VERSION } from "../shared/protocol.ts";
import { decodeSnapshot } from "../shared/codec.ts";
import type { Entity } from "../shared/world.ts";
import { mapPlayers, swatch } from "../client/ui/map-players.ts";

const body = (id: string, x: number, z: number, extra: Partial<Entity> = {}) =>
  ({
    id,
    kind: "player",
    x,
    z,
    y: 0,
    angle: 1,
    vx: 0,
    vz: 0,
    vy: 0,
    health: 100,
    color: "#fff",
    ...extra,
  }) as Entity;

test("map players use live bodies, their vehicle, or the last far position, you first", () => {
  const roster = [
    { id: "b", name: "Bea", color: "#112233" },
    { id: "a", name: "Zed", color: "#445566" },
    { id: "c", name: "Cy", color: "#778899" },
    { id: "d", name: "Dee", color: "#aabbcc" },
    { id: "gone", name: "Nobody", color: "#000000" },
  ];
  const car = { ...body("car", 50, 60), kind: "car" } as Entity;
  const players = mapPlayers(
    roster,
    [body("a", 1, 2), body("b", 9, 9, { vehicle: "car" }), car, body("d", 5, 5)],
    new Map([
      ["c", { id: "c", x: 700, z: -700, angle: 0.5 }],
      ["d", { id: "d", x: 1, z: 1, angle: 0 }],
    ]),
    "a",
  );
  assert.deepEqual(
    players.map((p) => [p.name, p.x, p.z, p.self]),
    [
      ["Zed", 1, 2, true],
      ["Bea", 50, 60, false],
      ["Cy", 700, -700, false],
      ["Dee", 5, 5, false],
    ],
  );
  assert.equal(swatch("#e8b63f"), "#e8b63f");
  assert.equal(swatch("red; background:url(x)"), "#7dcada");
});

test("every joined player's position reaches every client, even beyond network interest", async () => {
  const city = generateCity();
  city.buildings = [];
  city.props = [];
  const sim = new Simulation(city),
    server = http.createServer(),
    sessions = new Sessions(server, sim, false, new CityStore(sim.city).manifest),
    sockets: WebSocket[] = [];
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing server address");
  const wait = async (predicate: () => boolean) => {
    const end = Date.now() + 3000;
    while (!predicate() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    assert.ok(predicate(), "condition reached");
  };
  const connect = async (name: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`),
      messages: any[] = [];
    sockets.push(ws);
    ws.on("message", (raw, binary) =>
      messages.push(binary ? decodeSnapshot(raw as Buffer) : JSON.parse(String(raw))),
    );
    await new Promise<void>((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ type: "join", version: VERSION, name, color: "#aabbcc" }));
    await wait(() => messages.some((m) => m.type === "welcome"));
    return {
      ws,
      messages,
      id: messages.find((m) => m.type === "welcome").id as string,
    };
  };
  try {
    const a = await connect("Alice"),
      b = await connect("Bob");
    sim.entities.get(a.id)!.x = -600;
    sim.entities.get(a.id)!.z = 500;
    sim.entities.get(b.id)!.x = 640;
    sim.entities.get(b.id)!.z = -300;
    sim.tick(1 / 30);
    sessions.broadcast();
    await wait(() => b.messages.some((m) => m.type === "positions"));
    const last = (c: typeof a) =>
      c.messages.filter((m) => m.type === "positions").at(-1);
    assert.deepEqual(
      last(b).players.map((p: any) => [p.id, p.x, p.z]),
      [a.id, b.id]
        .sort()
        .map((id) => [id, ...(id === a.id ? [-600, 500] : [640, -300])]),
    );
    // Rate limited: an immediate second broadcast does not repeat it.
    const count = b.messages.filter((m) => m.type === "positions").length;
    sessions.broadcast();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(b.messages.filter((m) => m.type === "positions").length, count);
  } finally {
    for (const ws of sockets) ws.close();
    sessions.close();
    server.close();
  }
});
