import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { decode } from "@msgpack/msgpack";
import { emptyCity } from "../shared/city-stream.ts";
import { packCity } from "../shared/city-pack.ts";
import { CITY_FORMAT_VERSION } from "../shared/city-schema.ts";
import { TERRAIN_SIDE } from "../shared/terrain.ts";
import { cityChunkSchema } from "../shared/city-stream.ts";

test("baking keeps airports and ground-mounted scenery on elevated terrain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "afterhours-bake-"));
  try {
    const city = emptyCity({
      seed: 1,
      airport: { x: 400, z: 400, w: 80, d: 180 },
      terrain: { heights: Array(TERRAIN_SIDE ** 2).fill(30) },
    });
    city.roads = [
      {
        x: -200,
        z: -200,
        ax: -220,
        az: -200,
        bx: -180,
        bz: -200,
        width: 8,
        kind: "street",
      },
    ];
    city.parks = [{ x: 0, z: 0, w: 20, d: 20, kind: "civic" }];
    city.surfaces = [{ x: 40, z: 40, w: 20, d: 20, kind: "parking" }];
    city.landmarks = [{ x: 80, z: 80, kind: "plaza", name: "HIGH PLAZA" }];
    const source = join(dir, "city.json"),
      output = join(dir, "meshes.msgpack");
    await writeFile(
      source,
      JSON.stringify({
        format: "afterhours-city",
        version: CITY_FORMAT_VERSION,
        city: packCity(city),
      }),
    );
    await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/bake-city-meshes.ts",
        "--city",
        source,
        "--out",
        output,
      ],
      { timeout: 180000 },
    );
    const artifact = decode(await readFile(output)) as {
      chunks: Record<string, Uint8Array>;
    };
    const chunks = Object.values(artifact.chunks).map((bytes) =>
      cityChunkSchema.parse(JSON.parse(gunzipSync(bytes).toString())),
    );
    for (const key of ["parks:0", "surfaces:0", "landmarks:0"]) {
      const group = chunks.flatMap((c) => c.geometry?.features[key] ?? []);
      assert.ok(group.length, `${key} was baked`);
      for (const mesh of group)
        for (let i = 1; i < mesh.positions.length; i += 3)
          assert.ok(
            mesh.positions[i] >= 29.99,
            `${key} is buried below its 30 m terrain`,
          );
    }
    const signMeshes = chunks.flatMap((c) => c.geometry?.features["landmarks:0"] ?? []);
    const posts = signMeshes.filter((mesh) => mesh.name.includes("landmark sign post"));
    assert.ok(posts.length, "landmark sign supports were baked");
    const postHeights = posts.flatMap((mesh) =>
      mesh.positions.filter((_, index) => index % 3 === 1),
    );
    assert.ok(Math.abs(Math.min(...postHeights) - 30) < 0.01, "posts reach terrain");
    assert.ok(
      Math.abs(Math.max(...postHeights) - 36.5) < 0.01,
      "posts reach panel top",
    );
    const airport = chunks.find((c) => c.geometry?.airport)?.geometry?.airport;
    assert.ok(airport?.length, "runway and apron were baked");
    for (const mesh of airport)
      for (let i = 1; i < mesh.positions.length; i += 3)
        assert.ok(
          mesh.positions[i] >= 29.99,
          "airport is buried below its 30 m plateau",
        );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
