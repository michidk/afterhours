import { test } from "node:test";
import assert from "node:assert/strict";
import { Destruction } from "../server/destruction.ts";
import { Simulation } from "../server/simulation.ts";
import { destructibles, setBrokenProps } from "../shared/destruction.ts";
import { staticGeometry } from "../shared/physics/static.ts";
import { emptyCity } from "../shared/city-stream.ts";
import { TUNING, WEAPONS } from "../shared/catalog.ts";
import http from "node:http";
import { WebSocket } from "ws";
import { Sessions } from "../server/session.ts";
import { CityStore } from "../server/city-stream.ts";
import { VERSION } from "../shared/protocol.ts";
import { LIMIT } from "../shared/world.ts";
import { WATER_LEVEL } from "../shared/water.ts";
import { decodeSnapshot } from "../shared/codec.ts";

test("saturated airborne corpses keep falling and lie on roofs, land or water until expiry", () => {
  const city = fixture();
  city.parks = [];
  city.props = [];
  city.buildings = [{ x: 0, z: 0, w: 16, d: 16, h: 10, color: "#ffffff", style: 0 }];
  const sim = new Simulation(fixture()),
    d = new Destruction(city);
  try {
    const person = sim.spawn("player", 0, 0);
    person.y = 20;
    const sites = [
      { x: 0, z: 0, floor: 12.1 },
      { x: 50, z: 0, floor: 0.3 },
      { x: -LIMIT - 84, z: 0, floor: -1.1 },
    ];
    for (let i = 0; i < 131; i++) {
      person.x = i < 3 ? sites[i].x : 250 + (i % 16) * 4;
      person.z = i < 3 ? sites[i].z : 250 + Math.floor(i / 16) * 4;
      d.corpse(person, 0);
    }
    assert.equal(d.active.size, 128);
    const airborne = [...d.retained.values()];
    assert.equal(airborne.length, 3);
    for (const state of airborne) assert.equal(state.position.y, 21);
    d.update(1 / 30, 1 / 30, []);
    for (const state of airborne)
      assert.ok(state.position.y < 21, "retired bodies still fall");
    for (let i = 2; i <= 90; i++) d.update(i / 30, 1 / 30, []);
    for (const [i, state] of airborne.entries()) {
      assert.ok(
        Math.abs(state.position.y - sites[i].floor) < 1e-6,
        `supporting height ${state.position.y}`,
      );
      assert.ok(
        Math.abs(state.rotation.w) < 0.8,
        "corpse lies down instead of floating upright",
      );
      assert.deepEqual(state.velocity, { x: 0, y: 0, z: 0 });
    }
    d.update(179.99, 1 / 30, []);
    for (const state of airborne)
      assert.ok(d.snapshot(state.source, 2).some((s) => s.id === state.id));
    d.update(180, 1 / 30, []);
    assert.equal(d.snapshot({ x: 0, z: 0 }, 2000).length, 0);
  } finally {
    d.dispose();
    sim.destruction.dispose();
  }
});

test("corpses retain their entire lifetime when dynamic debris capacity is full", () => {
  const city = fixture();
  city.parks = [];
  city.roads = [];
  city.props = Array.from({ length: 128 }, (_, i) => ({
    x: 200 + i * 3,
    z: 200,
    h: 6,
    kind: "lamp" as const,
  }));
  const d = new Destruction(city),
    sim = new Simulation(fixture());
  try {
    for (const p of d.fixtures.values())
      assert.equal(d.hit(p.id, 100, 0, { x: 0, y: 0, z: 0 }), true);
    assert.equal(d.active.size, 128);
    const person = sim.spawn("player", 50, 50);
    person.vx = 3;
    d.corpse(person, 1);
    let states = d.snapshot({ x: 0, z: 0 }, 2000);
    const corpse = states.find((s) => s.source.kind === "corpse");
    assert.ok(corpse, "full prop budget must not omit a corpse");
    assert.equal(corpse.expiresAt, 181);
    assert.equal(
      states.length,
      129,
      "retiring physics must not remove the old prop snapshot",
    );
    assert.ok(d.active.size <= 128);
    d.update(1 + 1 / 30, 1 / 30, []);
    assert.ok(
      d.snapshot({ x: 0, z: 0 }, 2000).find((s) => s.id === corpse.id)!.position.x > 50,
      "new corpses receive physical motion",
    );
    d.update(30, 1 / 30, []);
    states = d.snapshot({ x: 0, z: 0 }, 2000);
    assert.equal(states.length, 1, "frozen props restore on their original timer");
    d.update(180.99, 1 / 30, []);
    assert.equal(d.snapshot({ x: 0, z: 0 }, 2000).length, 1);
    d.update(181, 1 / 30, []);
    assert.equal(d.snapshot({ x: 0, z: 0 }, 2000).length, 0);
  } finally {
    d.dispose();
    sim.destruction.dispose();
  }
});

test("repeated deaths retain snapshots beyond the Rapier cap with independent expiry", () => {
  const city = fixture(),
    sim = new Simulation(city),
    d = new Destruction(city);
  try {
    const person = sim.spawn("player", 250, 250);
    for (let i = 0; i < 1400; i++) d.corpse(person, i / 10);
    assert.ok(d.active.size <= 128);
    assert.equal(d.snapshot(person, 10).length, 1400);
    d.update(179.99, 1 / 30, []);
    assert.equal(d.snapshot(person, 100).length, 1400);
    d.update(180, 1 / 30, []);
    assert.equal(d.snapshot(person, 100).length, 1399);
    d.update(250, 1 / 30, []);
    assert.equal(d.snapshot(person, 100).length, 699);
    d.update(320, 1 / 30, []);
    assert.equal(d.snapshot(person, 100).length, 0);
  } finally {
    d.dispose();
    sim.destruction.dispose();
  }
});

test("corpses preserve their spawn altitude, settle on water and roofs, and freeze after physics", () => {
  const city = fixture();
  city.parks = [];
  city.props = [];
  city.roads = [];
  city.buildings = [{ x: 0, z: 0, w: 12, d: 12, h: 10, color: "#ffffff", style: 0 }];
  const sim = new Simulation(fixture()),
    d = new Destruction(city);
  try {
    const swimmer = sim.spawn("player", -LIMIT - 50, 0);
    swimmer.y = WATER_LEVEL;
    d.corpse(swimmer, 0);
    const rooftop = sim.spawn("player", 0, 0);
    rooftop.y = 11.8;
    d.corpse(rooftop, 0);
    const fresh = d.snapshot(swimmer, 5)[0];
    assert.ok(
      Math.abs(fresh.position.y + 0.1) < 1e-6,
      "initial snapshot starts at the actual water pose",
    );
    for (let i = 1; i <= 360; i++) d.update(i / 30, 1 / 30, []);
    const sea = d.snapshot(swimmer, 20)[0],
      roof = d.snapshot(rooftop, 20)[0];
    assert.ok(
      sea.position.y > -1.2 && sea.position.y < -0.9,
      `water resting height ${sea.position.y}`,
    );
    assert.ok(roof.position.y > 11.8 && roof.position.y < 12.3);
    assert.deepEqual(sea.velocity, { x: 0, y: 0, z: 0 });
    assert.equal(d.active.size, 0, "settled corpses release their dynamic bodies");
    d.update(179.99, 1 / 30, []);
    assert.equal(d.snapshot(swimmer, 20).length, 1);
    d.update(180, 1 / 30, []);
    assert.equal(d.snapshot(swimmer, 20).length, 0);
  } finally {
    d.dispose();
    sim.destruction.dispose();
  }
});

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
    const body = sim.destruction.snapshot(npc, 1000)[0];
    assert.equal(body.expiresAt - body.brokenAt, 180);
    assert.equal(sim.destruction.snapshot(npc, 1000).length, 1);
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
    assert.equal(
      sim.destruction.snapshot({ x: 250, z: 250 }, 100).length,
      1,
      "body survives player respawn",
    );
    const body = sim.destruction.snapshot({ x: 250, z: 250 }, 100)[0];
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

test("punching a weapon crate open drops a loaded weapon and the crate returns", () => {
  const city = fixture();
  // A street whose midpoint selects a crate.
  city.roads.push({
    x: 0,
    z: -42,
    ax: -30,
    az: -42,
    bx: 30,
    bz: -42,
    width: 12,
    kind: "street",
  });
  const sim = new Simulation(city);
  sim.entities.clear();
  try {
    const crate = [...sim.destruction.fixtures.values()].find(
      (p) => p.kind === "crate",
    );
    assert.ok(crate, "streets carry weapon crates");
    const player = sim.join("Looter", "#ffffff");
    player.x = crate.x;
    player.z = crate.z - 1.2;
    player.y = 0;
    player.angle = 0;
    const before = sim.inventory.pickups.size;
    for (let i = 0; i < 2; i++) {
      player.cooldown = 0;
      sim.attack(player);
    }
    assert.equal(sim.destruction.broken.has(crate.id), true, "two punches open it");
    sim.tick(1 / 30);
    const drops = [...sim.inventory.pickups.values()].filter(
      (p) => p.kind === "weapon" && Math.hypot(p.x - crate.x, p.z - crate.z) < 0.01,
    );
    assert.equal(sim.inventory.pickups.size, before + 1);
    assert.equal(drops.length, 1);
    const item = drops[0].kind === "weapon" ? drops[0].item : undefined;
    assert.ok(item && item.kind !== "fists");
    const spec = WEAPONS[item.kind];
    assert.equal(item.ammo, spec.magazine, "a full magazine");
    assert.equal(item.reserve, spec.reserve, "and full reserve ammunition");
    for (let i = 0; i < (TUNING.crateRespawnSeconds + 2) * 30; i++) sim.tick(1 / 30);
    assert.equal(sim.destruction.broken.has(crate.id), false, "the crate is back");
  } finally {
    sim.destruction.dispose();
  }
});

test("full debris capacity never prevents a new prop from breaking", () => {
  const city = fixture();
  city.parks = [];
  city.roads = [];
  city.props = Array.from({ length: 129 }, (_, i) => ({
    x: 200 + i * 3,
    z: 200,
    h: 6,
    kind: "tree" as const,
  }));
  const destruction = new Destruction(city);
  try {
    for (const prop of destruction.fixtures.values())
      assert.equal(destruction.hit(prop.id, 100, 1, { x: 0, y: 2, z: 20 }), true);
    assert.equal(destruction.active.size, 128);
    assert.equal(destruction.retained.size, 1);
    assert.equal(destruction.broken.size, 129);
    assert.equal(destruction.snapshot({ x: 200, z: 200 }, 500).length, 129);
    assert.equal(
      staticGeometry(city).query(584, 200, 1).length,
      0,
      "the newest tree is no longer a solid obstacle",
    );
  } finally {
    destruction.dispose();
  }
});

test("signal heads face oncoming traffic and lamp arms reach over the street", () => {
  const city = fixture();
  city.parks = [];
  city.roads = [
    { x: 30, z: 40, ax: 0, az: 0, bx: 60, bz: 80, width: 12, kind: "street" as const },
  ].map((road) => ({ ...road, signalA: true, signalB: true, stopA: 9, stopB: 9 }));
  city.props = [{ x: 10, z: 0, h: 6, kind: "lamp", angle: Math.PI / 2 }];
  const fixtures = destructibles(city);
  for (const s of fixtures.filter((p) => p.kind === "signal")) {
    // The lit face is local -z; the junction it guards is the nearer road end.
    const face = { x: -Math.sin(s.angle!), z: -Math.cos(s.angle!) },
      [jx, jz] =
        Math.hypot(s.x, s.z) < Math.hypot(s.x - 60, s.z - 80) ? [0, 0] : [60, 80];
    assert.ok(face.x * (jx - s.x) + face.z * (jz - s.z) < 0);
  }
  assert.equal(fixtures.find((p) => p.kind === "lamp")?.angle, Math.PI / 2);
});
