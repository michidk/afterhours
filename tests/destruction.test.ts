import { test } from "node:test";
import assert from "node:assert/strict";
import { Destruction } from "../server/destruction.ts";
import { Simulation } from "../server/simulation.ts";
import { destructibles, setBrokenProps } from "../shared/destruction.ts";
import { staticGeometry } from "../shared/physics/static.ts";
import { emptyCity } from "../shared/city-stream.ts";
import { TUNING } from "../shared/catalog.ts";
import http from "node:http";
import { WebSocket } from "ws";
import { Sessions } from "../server/session.ts";
import { CityStore } from "../server/city-stream.ts";
import { VERSION } from "../shared/protocol.ts";
import { decodeSnapshot } from "../shared/codec.ts";

const fixture = () => {
  const city = emptyCity({ seed: 42, airport: { x: 640, z: -640, w: 220, d: 220 } });
  city.roads = [
    [-100, -100, 100, -100],
    [100, -100, 100, 100],
    [100, 100, -100, 100],
    [-100, 100, -100, -100],
  ].map(([ax, az, bx, bz]) => ({
    x: (ax + bx) / 2,
    z: (az + bz) / 2,
    ax,
    az,
    bx,
    bz,
    width: 18,
    kind: "avenue" as const,
    signalA: true,
    signalB: true,
  }));
  city.props = [
    { x: 0, z: 10, h: 6, kind: "lamp" },
    { x: -10, z: 10, h: 7, kind: "palm" },
    { x: -20, z: 10, h: 8, kind: "tree" },
  ];
  city.parks = [{ x: 50, z: 50, w: 38, d: 38 }];
  return city;
};

test("destructible fixtures have stable IDs, collision overlays and immutable saved-map data", () => {
  const city = fixture(),
    original = JSON.stringify(city),
    d = new Destruction(city);
  try {
    assert.deepEqual(destructibles(city), destructibles(structuredClone(city)));
    assert.ok(
      ["palm", "tree", "lamp", "bench", "signal", "hydrant"].every((kind) =>
        [...d.fixtures.values()].some((p) => p.kind === kind),
      ),
    );
    const p = [...d.fixtures.values()][0];
    assert.ok(
      staticGeometry(city)
        .query(p.x, p.z, 1)
        .some((b) => b.destructibleId === p.id),
    );
    assert.equal(d.hit(p.id, 20, 0, { x: 5, y: 2, z: 0 }), false);
    assert.equal(d.hit(p.id, 25, 0, { x: 5, y: 2, z: 0 }), true);
    assert.equal(d.hit(p.id, 100, 0, { x: 0, y: 0, z: 0 }), false);
    assert.equal(
      staticGeometry(city)
        .query(p.x, p.z, 1)
        .some((b) => b.destructibleId === p.id),
      false,
    );
    const clientCity = structuredClone(city);
    setBrokenProps(clientCity, d.broken);
    assert.equal(
      staticGeometry(clientCity)
        .query(p.x, p.z, 1)
        .some((b) => b.destructibleId === p.id),
      false,
    );
    assert.equal(JSON.stringify(city), original);
    d.update(30.01, 1 / 30, []);
    assert.equal(d.active.size, 0);
    assert.ok(
      staticGeometry(city)
        .query(p.x, p.z, 1)
        .some((b) => b.destructibleId === p.id),
    );
    assert.equal(JSON.stringify(city), original);
  } finally {
    d.dispose();
  }
});

test("rosters and destruction survive distant views and late joins without resending unchanged membership", async () => {
  const sim = new Simulation(fixture()),
    server = http.createServer(),
    sessions = new Sessions(server, sim, false, new CityStore(sim.city).manifest),
    sockets: WebSocket[] = [];
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing server address");
  const wait = async (predicate: () => boolean) => {
    const end = Date.now() + 3000;
    while (!predicate() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    assert.ok(predicate(), "transport condition reached");
  };
  const connect = async (name?: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`),
      messages: any[] = [];
    sockets.push(ws);
    ws.on("message", (raw, binary) =>
      messages.push(binary ? decodeSnapshot(raw as Buffer) : JSON.parse(String(raw))),
    );
    await new Promise<void>((resolve) => ws.once("open", resolve));
    if (name) {
      ws.send(
        JSON.stringify({ type: "join", version: VERSION, name, color: "#aabbcc" }),
      );
      await wait(() => messages.some((m) => m.type === "welcome"));
    }
    return { ws, messages, id: messages.find((m) => m.type === "welcome")?.id };
  };
  try {
    const a = await connect("Same name"),
      unjoined = await connect();
    const fixture = [...sim.destruction.fixtures.values()][0];
    sim.damageProp(fixture.id, 100, { x: 5, y: 2, z: 0 });
    sim.tick(1 / 30);
    sessions.broadcast();
    await wait(() => a.messages.some((m) => m.type === "destruction"));
    assert.equal(a.messages.find((m) => m.type === "roster").players.length, 1);
    assert.equal(unjoined.messages.length, 0);
    const b = await connect("Same name");
    const distant = sim.entities.get(b.id)!;
    distant.x = 650;
    distant.z = 650;
    sim.tick(1 / 30);
    sessions.broadcast();
    await wait(() => b.messages.some((m) => m.type === "state"));
    const roster = b.messages.find((m) => m.type === "roster");
    assert.equal(roster.players.length, 2);
    assert.equal(new Set(roster.players.map((p: any) => p.id)).size, 2);
    assert.deepEqual(b.messages.find((m) => m.type === "destruction").brokenProps, [
      fixture.id,
    ]);
    assert.equal(
      b.messages.find((m) => m.type === "state").debris.length,
      0,
      "distant bodies stay out of spatial snapshots",
    );
    const first = a.messages.filter((m) => m.type === "state").at(-1);
    assert.ok(
      first.debris.some(
        (d: any) => d.id === fixture.id && Number.isFinite(d.rotation.w),
      ),
    );
    const count = a.messages.filter((m) => m.type === "destruction").length;
    sim.tick(1 / 30);
    sessions.broadcast();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(a.messages.filter((m) => m.type === "destruction").length, count);
    a.ws.close();
    await wait(() => sessions.roster().length === 1);
    assert.ok(sim.entities.has(a.id), "reconnect ghost remains in simulation");
    sim.destruction.update(31, 1 / 30, []);
    sessions.broadcast();
    await wait(() =>
      b.messages.some((m) => m.type === "destruction" && m.brokenProps.length === 0),
    );
    assert.equal(
      b.messages.filter((m) => m.type === "roster").at(-1).players.length,
      1,
    );
  } finally {
    for (const ws of sockets) ws.terminate();
    sessions.close();
    sim.destruction.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("debris tumbles, collides with ground/buildings and rests until the thirty-second cleanup", () => {
  const city = fixture();
  city.buildings = [{ x: 4, z: 10, w: 1, d: 30, h: 12, color: "#ffffff", style: 0 }];
  const d = new Destruction(city),
    p = [...d.fixtures.values()][0];
  try {
    d.hit(p.id, 100, 0, { x: 18, y: 3, z: 0 });
    for (let i = 1; i <= 180; i++) d.update(i / 30, 1 / 30, []);
    const state = d.active.get(p.id)!.state;
    assert.ok(state.position.x < 3.6, "CCD wall stops thrown debris");
    assert.ok(
      state.position.y > 0 && state.position.y < p.h / 2,
      "fallen debris settles above terrain",
    );
    assert.ok(Math.abs(state.rotation.w) < 0.99, "body tips over");
    assert.ok(
      Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z) < 0.5,
      "debris comes to rest",
    );
    assert.equal(state.expiresAt, 30);
    d.update(29.99, 1 / 30, []);
    assert.equal(d.active.size, 1);
    d.update(30.01, 1 / 30, []);
    assert.equal(d.active.size, 0);
  } finally {
    d.dispose();
  }
});

test("fixture restoration waits until its original location is clear", () => {
  const sim = new Simulation(fixture());
  sim.entities.clear();
  const p = [...sim.destruction.fixtures.values()][0],
    car = sim.spawn("car", p.x, p.z);
  try {
    sim.damageProp(p.id, 100, { x: 3, y: 1, z: 0 });
    sim.destruction.update(31, 1 / 30, [car]);
    assert.equal(sim.destruction.broken.has(p.id), true);
    car.x += 10;
    sim.destruction.update(32, 1 / 30, [car]);
    assert.equal(sim.destruction.broken.has(p.id), false);
  } finally {
    sim.destruction.dispose();
  }
});

test("car impacts, weapons and explosions break authoritative fixtures", () => {
  const sim = new Simulation(fixture());
  sim.entities.clear();
  try {
    const lamp = [...sim.destruction.fixtures.values()].find((p) => p.kind === "lamp")!,
      car = sim.spawn("car", lamp.x, lamp.z - 3);
    car.vz = 18;
    for (let i = 0; i < 12; i++) sim.tick(1 / 30);
    assert.equal(sim.destruction.broken.has(lamp.id), true);
    assert.ok(car.z > lamp.z, "car continues through a snapped fixture");
    const tree = [...sim.destruction.fixtures.values()].find((p) => p.kind === "tree")!,
      player = sim.join("Shooter", "#ffffff");
    player.x = tree.x;
    player.z = tree.z - 4;
    player.angle = 0;
    sim.inventory.give(player, "pistol");
    for (let i = 0; i < 4; i++) {
      player.cooldown = 0;
      sim.attack(player);
    }
    assert.equal(sim.destruction.broken.has(tree.id), true);
    const hydrant = [...sim.destruction.fixtures.values()].find(
      (p) => p.kind === "hydrant",
    )!;
    sim.destruction.blast(hydrant.x, 0, hydrant.z, sim.time);
    assert.equal(sim.destruction.broken.has(hydrant.id), true);
    assert.ok(sim.drainEvents().some((e) => e.kind === "propBreak"));
  } finally {
    sim.destruction.dispose();
  }
});

test("NPC recovery stays at thirty seconds while its corpse lasts three minutes", () => {
  const sim = new Simulation(fixture());
  sim.entities.clear();
  try {
    const npc = sim.spawn("pedestrian", 250, 250);
    sim.damage(npc, 150);
    for (let i = 0; i < 31 * 30; i++) sim.tick(1 / 30);
    assert.equal(npc.health, 100);
    assert.equal(npc.down, 0);
    const body = [...sim.destruction.active.values()][0].state;
    assert.equal(body.expiresAt - body.brokenAt, 180);
    assert.equal(sim.destruction.active.size, 1);
  } finally {
    sim.destruction.dispose();
  }
});

test("fatal characters leave one timed body while players respawn and wrecks last three minutes", () => {
  const sim = new Simulation(fixture());
  sim.entities.clear();
  try {
    const p = sim.join("Player", "#abcdef");
    p.x = 250;
    p.z = 250;
    sim.damage(p, 150);
    sim.damage(p, 150);
    assert.equal(
      sim.destruction.active.size,
      1,
      "repeated damage does not duplicate corpses",
    );
    for (let i = 0; i < 4 * 30; i++) sim.tick(1 / 30);
    assert.equal(p.health, 100);
    assert.equal(sim.destruction.active.size, 1, "body survives player respawn");
    const body = [...sim.destruction.active.values()][0].state;
    assert.equal(body.expiresAt - body.brokenAt, 180);
    const car = sim.spawn("car", 300, 300);
    sim.damage(car, 200);
    for (let i = 0; i < 6.1 * 30; i++) sim.tick(1 / 30);
    assert.ok((car.wreck ?? 0) > 179);
    sim.destruction.update(body.expiresAt + 0.01, 1 / 30, []);
    assert.equal(sim.destruction.active.size, 0);
    for (let i = 0; i < 178 * 30; i++) sim.tick(1 / 30);
    assert.equal(sim.entities.has(car.id), true);
    for (let i = 0; i < 3 * 30; i++) sim.tick(1 / 30);
    assert.equal(sim.entities.has(car.id), false);
  } finally {
    sim.destruction.dispose();
  }
});
