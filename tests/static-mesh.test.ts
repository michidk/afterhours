import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decode } from "@msgpack/msgpack";
import { gunzipSync } from "node:zlib";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { loadCity } from "../server/city-loader.ts";
import { loadCityMeshes } from "../server/city-mesh-loader.ts";
import { CityStore } from "../server/city-stream.ts";
import { cityChunkSchema } from "../shared/city-stream.ts";
import { meshGroupSchema, type MeshGroup } from "../shared/city-mesh.ts";
import { CityScene } from "../client/scene.ts";
import { EnvironmentLighting } from "../client/lighting/index.ts";
import { DestructionRenderer } from "../client/world/destruction.ts";
import { CityRenderer } from "../client/world/render.ts";
import { destructibles } from "../shared/destruction.ts";

test("saved geometry is tied to the persisted city with complete, validated spawn buffers", async () => {
  const city = await loadCity();
  const store = new CityStore(city);
  await loadCityMeshes(store);
  assert.equal(store.manifest.geometryVersion, 1);
  const artifact = decode(await readFile("data/city-meshes.msgpack")) as {
    mapId: string;
    base: Uint8Array;
    chunks: Record<string, Uint8Array>;
  };
  assert.equal(artifact.mapId, store.manifest.mapId);
  assert.equal(Object.keys(artifact.chunks).length, store.chunks.size);
  const base = meshGroupSchema.parse(JSON.parse(gunzipSync(artifact.base).toString()));
  assert.ok(base[0].positions.length > 10000);
  const chunk = cityChunkSchema.parse(
    JSON.parse(gunzipSync(artifact.chunks["0,0"]).toString()),
  );
  assert.ok(chunk.geometry);
  for (const field of [
    "roads",
    "buildings",
    "props",
    "parks",
    "surfaces",
    "ramps",
    "landmarks",
  ] as const)
    for (const entry of chunk[field])
      assert.ok(chunk.geometry.features[`${field}:${entry.id}`]);
  const mismatch = new CityStore({ ...city, seed: city.seed + 1 });
  await assert.rejects(loadCityMeshes(mismatch), /do not match/);
});

test("saved chunks upload buffers without procedural builders, and fixtures retain destruction ownership", async () => {
  const city = await loadCity();
  const artifact = decode(await readFile("data/city-meshes.msgpack")) as {
    chunks: Record<string, Uint8Array>;
  };
  const lampChunk = [...new CityStore(city).chunks.values()].find((chunk) =>
    chunk.props.some((entry) => entry.value.kind === "lamp"),
  );
  assert.ok(lampChunk);
  const chunk = cityChunkSchema.parse(
    JSON.parse(gunzipSync(artifact.chunks[lampChunk.key]).toString()),
  );
  const fixtureCity = {
    ...city,
    props: chunk.props.map((p) => p.value),
    roads: chunk.roads.map((r) => r.value),
    parks: chunk.parks.map((p) => p.value),
  };
  const lamp = destructibles(fixtureCity).find((p) => p.kind === "lamp")!;
  assert.ok(lamp);
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const casters = new Set<Mesh>();
  const host = Object.assign(Object.create(CityScene.prototype), {
    scene,
    materials: new Map(),
    target: Vector3.Zero(),
    shadowCandidates: [],
    lights: [],
    staticFixtures: new Map<string, MeshGroup>(),
    shadows: {
      addShadowCaster: (mesh: Mesh) => casters.add(mesh),
      removeShadowCaster: (mesh: Mesh) => casters.delete(mesh),
      getShadowMap: () => ({ renderList: [...casters] }),
    },
  }) as CityScene;
  host.streetGlow = host.mat("#ffe5a1", true);
  host.lighting = new EnvironmentLighting(
    scene,
    new DirectionalLight("sun", Vector3.Down(), scene),
    new HemisphericLight("sky", Vector3.Up(), scene),
    host.streetGlow,
  );
  host.destruction = new DestructionRenderer(host);
  host.build = () => {
    throw Error("Procedural static generation called");
  };
  host.batchStatic = () => {
    throw Error("Runtime merging called");
  };
  host.box =
    host.cylinder =
    host.palm =
      (() => {
        throw Error("Procedural fixture generation called");
      }) as typeof host.box & typeof host.cylinder & typeof host.palm;
  // Use a road-only region so the test does not need a browser's sign-text canvas.
  chunk.buildings = [];
  chunk.parks = [];
  chunk.landmarks = [];
  chunk.props = chunk.props.filter((p) => p.value.kind === "lamp");
  chunk.geometry!.features = Object.fromEntries(
    Object.entries(chunk.geometry!.features).filter(
      ([key]) => !/^(buildings|parks|landmarks):/.test(key),
    ),
  );
  const store = new CityStore(city);
  store.manifest.geometryVersion = 1;
  const renderer = new CityRenderer(host, store.manifest);
  try {
    renderer.sync([chunk]);
    const root = scene.getTransformNodeByName("fixture:" + lamp.id)!;
    assert.ok(root);
    assert.equal(root.position.x, lamp.x);
    assert.equal(root.position.z, lamp.z);
    host.destruction.setBroken([lamp.id]);
    assert.equal(root.isEnabled(), false);
    host.destruction.setBroken([]);
    assert.equal(root.isEnabled(), true);
    renderer.sync([]);
    assert.equal(scene.getTransformNodeByName("fixture:" + lamp.id), null);
    assert.equal(host.staticFixtures.size, 0);
  } finally {
    host.destruction.dispose();
    scene.dispose();
    engine.dispose();
  }
});
