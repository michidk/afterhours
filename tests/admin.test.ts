import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Simulation } from "../server/simulation.ts";
import { Sessions } from "../server/session.ts";
import { CityStore } from "../server/city-stream.ts";
import { executeDebug } from "../server/debug.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { VERSION, type Welcome } from "../shared/protocol.ts";
import { debugCommandSchema, type DebugCommand } from "../shared/debug.ts";
import { groundLevel, isWater, WORLD_LIMIT } from "../shared/water.ts";
import { spawnOrigin, type Entity } from "../shared/world.ts";
import { adminPlaces, kindLabel } from "../client/debug/admin.ts";

const city = generateCity();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t: TestContext, debug: boolean) {
  const sim = new Simulation(city);
  sim.entities.clear();
  const server = createServer();
  const previous = process.env.ALLOW_DEBUG;
  delete process.env.ALLOW_DEBUG;
  const sessions = new Sessions(server, sim, !debug, new CityStore(sim.city).manifest);
  if (previous !== undefined) process.env.ALLOW_DEBUG = previous;
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
  let serial = 0;
  const join = async (name: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    sockets.push(ws);
    await once(ws, "open");
    const chat: string[] = [];
    const replies = new Map<number, (m: { state?: unknown; error?: string }) => void>();
    let welcome: (m: Welcome) => void;
    const welcomed = new Promise<Welcome>((resolve) => (welcome = resolve));
    ws.on("message", (raw, binary) => {
      if (binary) return;
      const m = JSON.parse(String(raw));
      if (m.type === "welcome") welcome(m);
      if (m.type === "chat") chat.push(`${m.name}: ${m.text}`);
      if (m.type === "debugResult") replies.get(m.requestId)?.(m);
    });
    ws.send(JSON.stringify({ type: "join", version: VERSION, name, color: "#ffffff" }));
    const { id } = await welcomed;
    let last = 0;
    const command = async (command: DebugCommand) => {
      // Respect the server's per-connection debug action limit.
      await pause(Math.max(0, 110 - (performance.now() - last)));
      last = performance.now();
      const requestId = ++serial;
      const reply = new Promise<{ state?: unknown; error?: string }>((resolve) =>
        replies.set(requestId, resolve),
      );
      ws.send(JSON.stringify({ type: "debugCommand", requestId, command }));
      const result = await reply;
      if (result.error) throw Error(result.error);
      return result.state;
    };
    return { ws, id, chat, command, entity: () => sim.entities.get(id)! };
  };
  return { sim, join };
}

/** Landmarks sorted by distance from spawn, farthest first. */
function farLandmarks() {
  const spawn = spawnOrigin(city);
  return [...city.landmarks].sort(
    (a, b) =>
      Math.hypot(b.x - spawn.x, b.z - spawn.z) -
      Math.hypot(a.x - spawn.x, a.z - spawn.z),
  );
}

function assertGrounded(sim: Simulation, e: Entity) {
  assert.equal(e.y, groundLevel(e.x, e.z, sim.city));
  assert.deepEqual([e.vx, e.vy, e.vz], [0, 0, 0]);
  assert.equal(sim.blocked(e.x, e.z), false);
}

test("admin teleports are rejected when the server has debug disabled", async (t) => {
  const { join } = await fixture(t, false);
  const admin = await join("Admin");
  const other = await join("Other");
  const before = { ...other.entity() };
  const far = farLandmarks()[0];
  for (const command of [
    { kind: "gotoPlayer", id: other.id },
    { kind: "bringPlayer", id: other.id },
    { kind: "teleport", x: far.x, z: far.z, near: true },
  ] as DebugCommand[])
    await assert.rejects(admin.command(command), /disabled/);
  assert.equal(other.entity().x, before.x);
  assert.equal(other.entity().z, before.z);
  assert.deepEqual(other.chat, []);
});

test("admin can go to a distant player and bring them back", async (t) => {
  const { sim, join } = await fixture(t, true);
  const admin = await join("Admin");
  const other = await join("Other");
  const far = farLandmarks()[0];
  executeDebug(sim, other.entity(), {
    kind: "teleport",
    x: far.x,
    z: far.z,
    near: true,
  });
  const start = { x: admin.entity().x, z: admin.entity().z };
  assert.ok(Math.hypot(other.entity().x - start.x, other.entity().z - start.z) > 300);

  await admin.command({ kind: "gotoPlayer", id: other.id });
  const a = admin.entity(),
    o = other.entity();
  assert.ok(Math.hypot(a.x - o.x, a.z - o.z) < 40, "admin arrives beside the player");
  assert.ok(Math.hypot(a.x - o.x, a.z - o.z) >= 2, "admin does not land on them");
  assertGrounded(sim, a);

  // Bring them back to a fresh spot the admin chooses.
  await admin.command({ kind: "teleport", x: start.x, z: start.z, near: true });
  await admin.command({ kind: "bringPlayer", id: other.id });
  const brought = other.entity();
  assert.ok(
    Math.hypot(brought.x - admin.entity().x, brought.z - admin.entity().z) < 40,
  );
  assertGrounded(sim, brought);
  const deadline = Date.now() + 2000;
  while (!other.chat.length && Date.now() < deadline) await pause(10);
  assert.match(other.chat[0], /^Admin: Admin moved you to them$/);
  assert.deepEqual(admin.chat, []);
});

test("bringing a seated driver moves the vehicle and passengers; a passenger leaves", async (t) => {
  const { sim, join } = await fixture(t, true);
  const admin = await join("Admin");
  const driver = await join("Driver");
  const passenger = await join("Passenger");
  const far = farLandmarks()[0];
  executeDebug(sim, driver.entity(), {
    kind: "teleport",
    x: far.x,
    z: far.z,
    near: true,
  });
  const d = driver.entity(),
    p = passenger.entity();
  const car = sim.spawn("car", d.x + 6, d.z, undefined, "sedan");
  car.angle = 1.2;
  car.vx = 9;
  car.driver = d.id;
  car.seats = [d.id, p.id, null, null].slice(0, car.seats!.length);
  Object.assign(d, { vehicle: car.id, seat: 0, x: car.x, z: car.z });
  Object.assign(p, { vehicle: car.id, seat: 1, x: car.x, z: car.z });

  await admin.command({ kind: "bringPlayer", id: driver.id });
  const a = admin.entity();
  assert.ok(
    Math.hypot(car.x - a.x, car.z - a.z) < 40,
    "the car arrives beside the admin",
  );
  assert.ok(
    Math.hypot(car.x - a.x, car.z - a.z) > 3,
    "the car does not land on the admin",
  );
  assert.equal(car.driver, d.id);
  assert.equal(d.vehicle, car.id);
  assert.equal(p.vehicle, car.id, "passengers ride along");
  assert.deepEqual([p.x, p.z], [car.x, car.z]);
  assert.equal(car.y, groundLevel(car.x, car.z, sim.city));
  assert.equal(isWater(car.x, car.z, sim.city), false);
  assert.deepEqual([car.vx, car.vy, car.vz, car.angularVelocity], [0, 0, 0, 0]);
  assert.equal(car.angle, 1.2, "the vehicle keeps its heading");

  // A passenger is unseated and arrives on foot; the car and its driver stay put.
  await admin.command({ kind: "teleport", x: far.x, z: far.z, near: true });
  const carAt = { x: car.x, z: car.z };
  await admin.command({ kind: "bringPlayer", id: passenger.id });
  assert.equal(p.vehicle, undefined);
  assert.equal(p.seat, undefined);
  assert.equal(car.seats?.includes(p.id), false);
  assert.equal(car.driver, d.id);
  assert.deepEqual({ x: car.x, z: car.z }, carAt);
  assert.ok(Math.hypot(p.x - admin.entity().x, p.z - admin.entity().z) < 40);
  assertGrounded(sim, p);
});

test("invalid admin targets and coordinates are rejected", async (t) => {
  const { sim, join } = await fixture(t, true);
  const admin = await join("Admin");
  const other = await join("Other");
  await assert.rejects(
    admin.command({ kind: "gotoPlayer", id: "nobody" }),
    /Unknown player/,
  );
  await assert.rejects(
    admin.command({ kind: "bringPlayer", id: admin.id }),
    /Unknown player|another player/,
  );
  assert.throws(
    () => executeDebug(sim, admin.entity(), { kind: "bringPlayer", id: admin.id }),
    /Choose another player/,
  );
  const pedestrian = sim.spawn("pedestrian", admin.entity().x + 30, admin.entity().z);
  await assert.rejects(
    admin.command({ kind: "bringPlayer", id: pedestrian.id }),
    /Unknown player/,
  );
  // A disconnected player keeps a reconnect ghost but is no longer a target.
  other.ws.close();
  await once(other.ws, "close");
  await pause(50);
  assert.ok(sim.entities.has(other.id));
  await assert.rejects(
    admin.command({ kind: "gotoPlayer", id: other.id }),
    /Unknown player/,
  );
  for (const command of [
    { kind: "teleport", x: Number.NaN, z: 0 },
    { kind: "teleport", x: WORLD_LIMIT, z: 0, near: true },
    { kind: "teleport", x: 0, z: -Infinity },
    { kind: "gotoPlayer", id: "" },
    { kind: "bringPlayer" },
    { kind: "gotoPlayer", id: "x".repeat(121) },
  ])
    assert.equal(debugCommandSchema.safeParse(command).success, false);
});

test("landmark teleports land on the ground at rest", (t) => {
  const sim = new Simulation(city);
  t.after(() => sim.destruction.dispose());
  sim.entities.clear();
  const player = sim.join("Admin", "#fff");
  assert.ok(city.landmarks.length > 0);
  for (const landmark of city.landmarks) {
    player.vx = 5;
    player.vy = -3;
    player.parachute = true;
    executeDebug(sim, player, {
      kind: "teleport",
      x: landmark.x,
      z: landmark.z,
      near: true,
    });
    assert.ok(
      Math.hypot(player.x - landmark.x, player.z - landmark.z) < 40,
      landmark.name,
    );
    assert.equal(player.parachute, undefined);
    assertGrounded(sim, player);
  }
  // Exact teleports keep their strict obstruction check.
  const building = city.buildings[0];
  assert.throws(
    () => executeDebug(sim, player, { kind: "teleport", x: building.x, z: building.z }),
    /obstructed/,
  );
});

test("admin places list every landmark kind plus fixed points without duplicates", () => {
  const groups = adminPlaces({ centre: { x: 100, z: 100 }, airport: city.airport }, [
    { x: 500, z: 500, name: "Pier", kind: "harbour" },
    { x: city.airport.x, z: city.airport.z, name: "Paloma Intl", kind: "airport" },
    { x: 700, z: 0, name: "Ring", kind: "raceTrack" },
    { x: 300, z: 0, name: "Tower", kind: "tower" },
  ]);
  assert.equal(groups[0].label, "General");
  assert.deepEqual(
    groups[0].places.map((p) => p.name),
    ["City centre", "Spawn"],
    "the airport landmark replaces the fixed airport point",
  );
  assert.deepEqual(
    groups.slice(1).map((g) => g.label),
    ["Airport", "Harbour", "Race track", "Tower"],
  );
  assert.equal(kindLabel("town_hall"), "Town hall");
  assert.equal(kindLabel(""), "Other");
});
