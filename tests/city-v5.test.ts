import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildingBox, contact, insideBuilding } from "../shared/physics/collision.ts";
import type { Building, RoadSurface } from "../shared/world.ts";
import { generateMap } from "../mapgen/pipeline.ts";
import { cityFromMap } from "../scripts/mapgen-city.ts";
import { cityFileSchema, CITY_FORMAT_VERSION } from "../shared/city-schema.ts";
import {
  PACK_CHUNK_SIZE,
  chunkOrigin,
  packCity,
  packSurfaceChunks,
  unpackCity,
  unpackHeights,
  unpackSurface,
  unpackSurfaceChunks,
} from "../shared/city-pack.ts";
import { cityChunkSchema } from "../shared/city-stream.ts";
import { CityStore } from "../scripts/city-store.ts";
import { terrainHeight } from "../shared/terrain.ts";
import { WATER_LEVEL } from "../shared/water.ts";

/** Footprint corner in the frame used by the generator and the client renderer. */
const corner = (b: Building, x: number, z: number) => {
  const a = b.angle ?? 0;
  return {
    x: b.x + x * Math.cos(a) - z * Math.sin(a),
    z: b.z + x * Math.sin(a) + z * Math.cos(a),
  };
};

test("rotated building collision matches the rendered footprint frame", () => {
  const b: Building = {
    x: 10,
    z: -5,
    w: 40,
    d: 10,
    h: 20,
    angle: 0.5,
    color: "#ffffff",
    style: 0,
  };
  const inside = corner(b, 15, 3),
    outside = corner(b, 15, 8),
    mirrored = {
      x: b.x + 15 * Math.cos(0.5) + 3 * Math.sin(0.5),
      z: b.z - 15 * Math.sin(0.5) + 3 * Math.cos(0.5),
    };
  const probe = (p: { x: number; z: number }) =>
    contact({ x: p.x, z: p.z, w: 0.3, d: 0.3, angle: 0 }, buildingBox(b));
  assert.ok(probe(inside), "point inside the drawn walls must collide");
  assert.ok(!probe(outside), "point beside the drawn walls must be free");
  assert.ok(!probe(mirrored), "the mirror image of the footprint must not block");
  assert.ok(insideBuilding(b, inside.x, inside.z));
  assert.ok(!insideBuilding(b, outside.x, outside.z));
  assert.ok(insideBuilding(b, outside.x, outside.z, 6));
});

test("packed street polygons round-trip to the centimetre inside their chunk", () => {
  const quad = (x: number, z: number, y: number) => [
    x,
    y,
    z,
    x + 4,
    y,
    z,
    x + 4,
    y,
    z + 4,
    x,
    y,
    z + 4,
  ];
  const surface: RoadSurface = {
    asphalt: [quad(-130, 10, 12.34), quad(126, 126, -1.1), quad(0.5, 0.5, 239.99)],
    sidewalks: [quad(-1, -1, 0.07)],
    markings: [
      { color: "white", polygon: quad(300, -300, 3) },
      { color: "yellow", polygon: quad(301, -301, 3.01) },
    ],
  };
  const chunks = packSurfaceChunks(surface);
  assert.deepEqual(Object.keys(chunks), ["-1,0", "0,0", "1,1", "2,-3"]);
  assert.equal(chunks["0,0"].asphalt.counts.length, 1, "bucketed by centroid");
  assert.equal(chunkOrigin("-1,0").x, -PACK_CHUNK_SIZE);
  const restored = unpackSurfaceChunks(chunks);
  const near = (a: number[], b: number[]) =>
    a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 0.005);
  for (const polygon of surface.asphalt)
    assert.ok(
      restored.asphalt.some((p) => near(p, polygon)),
      "asphalt survives",
    );
  assert.ok(near(restored.sidewalks[0], surface.sidewalks[0]));
  assert.equal(restored.markings.filter((m) => m.color === "yellow").length, 1);
  assert.ok(
    near(
      unpackSurface(chunks["2,-3"], chunkOrigin("2,-3")).markings[0].polygon,
      quad(300, -300, 3),
    ),
  );
});

test("generated artifact validates, packs compactly and places everything on land", async () => {
  const map = generateMap({ seed: 5, size: 3072, cell: 8 });
  const city = cityFromMap(map);
  const packed = packCity(city);
  const file = cityFileSchema.parse({
    format: "afterhours-city",
    version: CITY_FORMAT_VERSION,
    city: packed,
  });
  const loaded = unpackCity(file.city);
  assert.deepEqual(
    loaded.terrain,
    city.terrain,
    "centimetre heights round-trip exactly",
  );
  assert.ok(city.centre);
  assert.ok(city.surface && Object.keys(city.surface).length > 20);
  const total = Object.values(city.surface).reduce(
    (n, s) => n + s.asphalt.counts.length,
    0,
  );
  assert.ok(total > 50);
  for (const [key, chunk] of Object.entries(city.surface)) {
    const origin = chunkOrigin(key),
      s = unpackSurface(chunk, origin);
    for (const polygon of [
      ...s.asphalt,
      ...s.sidewalks,
      ...s.markings.map((m) => m.polygon),
    ]) {
      let x = 0,
        z = 0;
      for (let v = 0; v < polygon.length; v += 3) {
        x += polygon[v];
        z += polygon[v + 2];
      }
      const n = polygon.length / 3;
      // Ear clipping a polygon that is not planar makes chords across its profile.
      // Its plane runs through the three corners spanning the most ground.
      let a = 0,
        b = 1,
        c = 2,
        spread = 0;
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++)
          for (let k = j + 1; k < n; k++) {
            const s = Math.abs(
              (polygon[j * 3] - polygon[i * 3]) *
                (polygon[k * 3 + 2] - polygon[i * 3 + 2]) -
                (polygon[j * 3 + 2] - polygon[i * 3 + 2]) *
                  (polygon[k * 3] - polygon[i * 3]),
            );
            if (s > spread) [a, b, c, spread] = [i, j, k, s];
          }
      const [pa, pb, pc] = [a, b, c].map((i) => polygon.slice(i * 3, i * 3 + 3)),
        u = pb.map((v, i) => v - pa[i]),
        w = pc.map((v, i) => v - pa[i]),
        normal = [
          u[1] * w[2] - u[2] * w[1],
          u[2] * w[0] - u[0] * w[2],
          u[0] * w[1] - u[1] * w[0],
        ];
      if (n > 3 && spread > 0.01)
        for (let v = 0; v < polygon.length; v += 3)
          assert.ok(
            Math.abs(
              ((polygon[v] - pa[0]) * normal[0] +
                (polygon[v + 1] - pa[1]) * normal[1] +
                (polygon[v + 2] - pa[2]) * normal[2]) /
                normal[1],
            ) < 0.15,
            `street pieces are planar near ${polygon[0]}, ${polygon[2]}`,
          );
      assert.ok(x / n >= origin.x - 0.01 && x / n < origin.x + PACK_CHUNK_SIZE + 0.01);
      assert.ok(z / n >= origin.z - 0.01 && z / n < origin.z + PACK_CHUNK_SIZE + 0.01);
      for (let v = 0; v < polygon.length; v += 3)
        assert.ok(
          Math.hypot(polygon[v] - x / n, polygon[v + 2] - z / n) < 100,
          "polygons stay short",
        );
    }
  }
  for (const b of city.buildings) {
    assert.ok(b.y !== undefined && b.y > WATER_LEVEL, "pads sit above water");
    assert.ok(b.h > b.y!, "roof above pad");
    assert.ok(
      b.y! >= terrainHeight(b.x, b.z, city) - 0.011 &&
        b.y! - terrainHeight(b.x, b.z, city) <= 4.4,
      "building stands above terrain with its foundation touching ground",
    );
  }
  for (const r of city.roads) {
    assert.ok(terrainHeight(r.x, r.z, city) > WATER_LEVEL, "lanes stay on land");
    assert.ok(Math.hypot(r.bx - r.ax, r.bz - r.az) <= 24.5, "lane segments stay short");
  }
  for (const p of city.pickups) assert.ok(terrainHeight(p.x, p.z, city) > WATER_LEVEL);
  const a = city.airport;
  for (const [dx, dz] of [
    [-a.w / 2 + 2, -a.d / 2 + 2],
    [a.w / 2 - 2, a.d / 2 - 2],
    [0, 0],
  ]) {
    const h = terrainHeight(a.x + dx, a.z + dz, city);
    assert.ok(Math.abs(h - terrainHeight(a.x, a.z, city)) < 0.6, "airfield is flat");
  }

  // The server streams the packed chunks and binary terrain, gzip when accepted.
  const store = new CityStore(loaded);
  assert.equal(store.manifest.hasTerrain, true);
  assert.equal(store.manifest.surface, true);
  assert.ok(
    JSON.stringify(store.manifest).length < 2000,
    "the welcome manifest stays small",
  );
  const server = createServer((req, res) => {
    if (!store.serve(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}/city`;
  try {
    const raw = await fetch(`${base}/terrain/${store.manifest.mapId}`, {
      headers: { "accept-encoding": "identity" },
    });
    assert.equal(raw.headers.get("content-encoding"), null);
    const heights = unpackHeights(new Uint8Array(await raw.arrayBuffer()));
    assert.deepEqual(heights, city.terrain!.heights);
    const zipped = await fetch(`${base}/terrain/${store.manifest.mapId}`, {
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(zipped.headers.get("content-encoding"), "gzip");
    const key = Object.keys(city.surface)[0],
      [cx, cz] = key.split(",");
    const chunk = cityChunkSchema.parse(
      await (await fetch(`${base}/chunks/${store.manifest.mapId}/${cx}/${cz}`)).json(),
    );
    assert.deepEqual(chunk.surface, city.surface[key]);
    assert.equal(
      (await fetch(`${base}/terrain/${"0".repeat(64)}`)).status,
      409,
      "stale map identities are refused",
    );
  } finally {
    server.close();
  }
});
