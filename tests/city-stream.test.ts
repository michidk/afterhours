import { test } from "node:test";
import assert from "node:assert/strict";
import { CityStore } from "../server/city-stream.ts";
import { CityStream } from "../client/world/stream.ts";
import { Simulation } from "../server/simulation.ts";
import { emptyCity, chunksAround, STATIC_FIELDS } from "../shared/city-stream.ts";
const fixture = () => {
  const city = emptyCity({ seed: 42, airport: { x: 640, z: -640, w: 128, d: 200 } });
  city.roads = [
    [0, 0, 128, 0],
    [128, 0, 128, 128],
    [128, 128, 0, 128],
    [0, 128, 0, 0],
  ].map(([ax, az, bx, bz]) => ({
    x: (ax + bx) / 2,
    z: (az + bz) / 2,
    ax,
    az,
    bx,
    bz,
    width: 18,
    kind: "avenue" as const,
  }));
  city.buildings = [
    { x: 127, z: 20, w: 8, d: 10, h: 20, color: "#aabbcc", style: 0 },
    { x: 650, z: 650, w: 20, d: 20, h: 40, color: "#ddeeff", style: 1 },
  ];
  city.props = [{ x: -1, z: -1, h: 8, kind: "palm" }];
  return city;
};
const settle = () => new Promise((r) => setTimeout(r, 5));
test("saved map identity is stable and chunks duplicate only boundary features with stable IDs", () => {
  const city = fixture(),
    a = new CityStore(city),
    b = new CityStore(structuredClone(city));
  assert.deepEqual(a.manifest, b.manifest);
  assert.equal("buildings" in a.manifest, false);
  assert.equal(a.chunks.get("0,0")!.buildings[0].id, 0);
  assert.equal(a.chunks.get("1,0")!.buildings[0].id, 0);
  assert.equal(a.chunks.get("0,0")!.buildings.length, 1);
  for (const field of STATIC_FIELDS) {
    const restored = new Map<number, unknown>();
    for (const chunk of a.chunks.values())
      for (const entry of chunk[field]) restored.set(entry.id, entry.value);
    assert.deepEqual(
      [...restored].sort((a, b) => a[0] - b[0]).map((e) => e[1]),
      city[field] ?? [],
    );
  }
  city.buildings[1].h++;
  assert.notEqual(a.manifest.mapId, new CityStore(city).manifest.mapId);
});
test("client fetches nearby chunks, deduplicates seams, evicts distant data and retains player collisions during free camera", async () => {
  const store = new CityStore(fixture()),
    urls: string[] = [];
  const download = (async (url) => {
    urls.push(String(url));
    const parts = String(url).split("/");
    return new Response(
      JSON.stringify(store.chunks.get(`${parts.at(-2)},${parts.at(-1)}`)),
    );
  }) as typeof fetch;
  const stream = new CityStream(store.manifest, () => {}, download);
  await stream.prepare();
  assert.ok(stream.chunks.size < store.chunks.size / 4);
  assert.equal(stream.city.buildings.length, 1);
  assert.equal(stream.city.buildings[0].x, 127);
  const oldArray = stream.city.buildings;
  for (let i = 0; i < 12; i++) {
    stream.setView({ x: 11, z: 25 }, { x: 650, z: 650 }, 96);
    await settle();
  }
  assert.equal(stream.ready({ x: 11, z: 25 }), true);
  assert.equal(stream.ready({ x: 650, z: 650 }), true);
  assert.equal(stream.city.buildings.length, 2);
  for (let i = 0; i < 12; i++) {
    stream.setView({ x: 650, z: 650 }, { x: 650, z: 650 }, 96);
    await settle();
  }
  assert.equal(stream.ready({ x: 11, z: 25 }), false);
  assert.equal(stream.city.buildings.length, 1);
  assert.equal(stream.city.buildings[0].x, 650);
  assert.notEqual(stream.city.buildings, oldArray);
  assert.ok(
    urls.every((url) => url.startsWith(`/city/chunks/${store.manifest.mapId}/`)),
  );
});
test("late responses cannot repopulate an evicted neighborhood", async () => {
  const store = new CityStore(fixture());
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const stream = new CityStream(store.manifest, () => {}, (async (url) => {
    await gate;
    const parts = String(url).split("/");
    return new Response(
      JSON.stringify(store.chunks.get(`${parts.at(-2)},${parts.at(-1)}`)),
    );
  }) as typeof fetch);
  stream.setView(undefined, { x: 0, z: 0 }, 48);
  stream.setView(undefined, { x: 650, z: 650 }, 48);
  release();
  await settle();
  assert.equal(stream.chunks.size, 0);
  for (let i = 0; i < 5; i++) {
    stream.setView(undefined, { x: 650, z: 650 }, 48);
    await settle();
  }
  assert.equal(stream.ready({ x: 650, z: 650 }), true);
  assert.ok(
    [...stream.chunks.keys()].every((key) => chunksAround(650, 650, 48).includes(key)),
  );
});
test("server continues simulating distant vehicles with the complete city and no connected viewer", () => {
  const city = fixture(),
    sim = new Simulation(city),
    store = new CityStore(city);
  const e = sim.spawn("car", 512, 600, "#ffffff");
  e.ai = false;
  e.vz = 12;
  const start = e.z;
  for (let i = 0; i < 10; i++) sim.tick(1 / 30);
  assert.ok(e.z > start + 1);
  assert.equal(sim.city, city);
  assert.equal(sim.city.buildings.length, 2);
  assert.equal(store.chunks.get("5,5")!.buildings[0].value.h, 40);
});
test("failed or wrong-map chunks remain unavailable and retry without accepting stale geometry", async () => {
  const store = new CityStore(fixture());
  let attempts = 0;
  const stream = new CityStream(store.manifest, () => {}, (async (url) => {
    attempts++;
    if (attempts <= 4) return new Response("unavailable", { status: 503 });
    const parts = String(url).split("/"),
      chunk = store.chunks.get(`${parts.at(-2)},${parts.at(-1)}`)!;
    return new Response(JSON.stringify(chunk));
  }) as typeof fetch);
  stream.setView(undefined, { x: 20, z: 20 }, 48);
  await settle();
  assert.equal(stream.ready({ x: 20, z: 20 }), false);
  assert.match(stream.error, /503/);
  stream.setView(undefined, { x: 20, z: 20 }, 48);
  await settle();
  assert.equal(attempts, 4, "avoid retry storms");
  await new Promise((r) => setTimeout(r, 1010));
  stream.setView(undefined, { x: 20, z: 20 }, 48);
  await settle();
  assert.equal(stream.ready({ x: 20, z: 20 }), true);
  assert.equal(stream.error, "");
  const wrong = new CityStream(store.manifest, () => {}, (async (url) => {
    const parts = String(url).split("/"),
      chunk = store.chunks.get(`${parts.at(-2)},${parts.at(-1)}`)!;
    return new Response(JSON.stringify({ ...chunk, mapId: "0".repeat(64) }));
  }) as typeof fetch);
  wrong.setView(undefined, { x: 20, z: 20 }, 48);
  await settle();
  assert.equal(wrong.chunks.size, 0);
  assert.match(wrong.error, /identity mismatch/);
});
