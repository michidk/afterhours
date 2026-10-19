import { LIMIT } from "../shared/world.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CityStore } from "../server/city-stream.ts";
import {
  CityStream,
  COLLISION_RADIUS,
  SCENERY_RADIUS,
} from "../client/world/stream.ts";
import { TUNING } from "../shared/catalog.ts";
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
test("loading and evicting seam duplicates preserves the collision geometry", async () => {
  const store = new CityStore(fixture());
  const stream = new CityStream(
    store.manifest,
    () => {},
    async (url) => {
      const parts = String(url).split("/");
      return new Response(
        JSON.stringify(store.chunks.get(`${parts.at(-2)},${parts.at(-1)}`)),
      );
    },
  );
  stream.setView(undefined, { x: 64, z: 20 }, 1);
  await settle();
  const buildings = stream.city.buildings;
  assert.equal(buildings.length, 1);
  stream.setView(undefined, { x: 128, z: 20 }, 1);
  await settle();
  assert.equal(stream.chunks.size, 2);
  assert.equal(
    stream.city.buildings,
    buildings,
    "a duplicate does not rebuild colliders",
  );
  stream.setView(undefined, { x: 180, z: 20 }, 1);
  await settle();
  assert.equal(stream.chunks.size, 1);
  assert.equal(
    stream.city.buildings,
    buildings,
    "evicting one seam copy keeps colliders",
  );
  stream.setView(undefined, { x: 650, z: 650 }, 1);
  await settle();
  assert.notEqual(stream.city.buildings, buildings);
  assert.equal(stream.city.buildings[0].x, 650);
});
test("startup and moving views render buildings over 400 m ahead", async () => {
  const city = fixture();
  city.buildings[1].x = 450;
  city.buildings[1].z = 25;
  const store = new CityStore(city);
  let renderedBuildings: number[] = [];
  const stream = new CityStream(
    store.manifest,
    (chunks) => {
      renderedBuildings = chunks.flatMap((chunk) => chunk.buildings.map((b) => b.id));
    },
    async (url) => {
      const parts = String(url).split("/");
      return new Response(
        JSON.stringify(store.chunks.get(`${parts.at(-2)},${parts.at(-1)}`)),
      );
    },
  );
  await stream.prepare();
  assert.ok(renderedBuildings.includes(1), "distant building is ready before entering");
  assert.ok(stream.ready({ x: 11, z: 25 }));
  stream.setView({ x: 40, z: 25 }, { x: 40, z: 25 });
  assert.ok(renderedBuildings.includes(1), "ongoing streaming keeps the wider view");
  assert.equal(stream.diagnostics.pending, 0, "small moves reuse prepared scenery");
});
test("offshore coverage excludes land chunks when the clipped bounds do not overlap", () => {
  assert.deepEqual(
    chunksAround(-LIMIT - COLLISION_RADIUS - 1, 0, COLLISION_RADIUS),
    [],
  );
  assert.deepEqual(chunksAround(0, LIMIT + COLLISION_RADIUS + 1, COLLISION_RADIUS), []);
  assert.deepEqual(chunksAround(-LIMIT - 4, 0, 48), ["-12,-1", "-12,0"]);
});
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
  assert.deepEqual(
    [...stream.chunks.keys()].sort(),
    chunksAround(11, 25, SCENERY_RADIUS).sort(),
    "startup prepares the full scenery radius as well as spawn collisions",
  );
  assert.equal(stream.ready({ x: 11, z: 25 }), true);
  assert.ok(stream.chunks.size < store.chunks.size / 4);
  assert.equal(stream.city.buildings.length, 1);
  assert.equal(stream.city.buildings[0].x, 127);
  const oldArray = stream.city.buildings;
  for (let i = 0; i < 12; i++) {
    stream.setView({ x: 11, z: 25 }, { x: 650, z: 650 }, 96);
    await settle();
  }
  assert.equal(stream.ready({ x: 11, z: 25 }), true);
  assert.equal(stream.ready({ x: 650, z: 650 }, 96), true);
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
test("collision coverage exceeds snapshots while rendering only camera chunks", async () => {
  const store = new CityStore(fixture()),
    player = { x: 128, z: 128 },
    camera = { x: 650, z: 650 },
    requests: string[] = [];
  let rendered: string[] = [];
  const stream = new CityStream(
    store.manifest,
    (chunks) => {
      rendered = chunks.map((chunk) => chunk.key).sort();
    },
    async (url) => {
      const parts = String(url).split("/"),
        key = `${parts.at(-2)},${parts.at(-1)}`;
      requests.push(key);
      return new Response(JSON.stringify(store.chunks.get(key)));
    },
  );
  assert.ok(COLLISION_RADIUS > TUNING.interestRadius);
  stream.setView(player, camera, 48);
  assert.ok(requests.length > 0);
  assert.ok(
    requests.every((key) => chunksAround(128, 128, COLLISION_RADIUS).includes(key)),
    "player collision requests precede distant camera requests",
  );
  for (let i = 0; i < 20; i++) {
    stream.setView(player, camera, 48);
    await settle();
  }
  assert.equal(stream.ready(player), true);
  assert.equal(stream.ready({ x: 180, z: 128 }), true, "movement uses prefetched data");
  assert.deepEqual(rendered, ["4,4", "4,5", "5,4", "5,5"]);
  assert.equal(stream.city.buildings.length, 2, "unrendered geometry remains physical");
  assert.ok(stream.chunks.size > rendered.length);
  const downloads = requests.length;
  stream.setView(player, player, 48);
  assert.deepEqual(rendered, ["0,0", "0,1", "1,0", "1,1"]);
  assert.equal(
    requests.length,
    downloads,
    "cached collision chunks can become scenery",
  );
  assert.equal(stream.city.buildings[0].x, 127);
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
  assert.equal(stream.ready({ x: 650, z: 650 }, 48), true);
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
  assert.equal(stream.ready({ x: 20, z: 20 }, 48), true);
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

test("startup preloads the generated city's spawn rather than the old map origin", async () => {
  const city = fixture();
  city.centre = { x: -272, z: 632 };
  const store = new CityStore(city);
  const download: typeof fetch = async (url) => {
    const parts = String(url).split("/");
    return new Response(
      JSON.stringify(store.chunks.get(`${parts.at(-2)},${parts.at(-1)}`)),
    );
  };
  const stream = new CityStream(store.manifest, () => {}, download);
  await stream.prepare();
  assert.deepEqual(
    [...stream.chunks.keys()].sort(),
    chunksAround(-261, 657, SCENERY_RADIUS).sort(),
  );
  assert.equal(stream.ready({ x: -261, z: 657 }), true);
  assert.equal(stream.ready({ x: 11, z: 25 }), false);
});
