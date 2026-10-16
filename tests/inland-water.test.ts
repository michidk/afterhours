import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { InlandWaterRenderer } from "../client/world/inland-water.ts";
import { buildInlandWater } from "../client/world/terrain.ts";
import { TERRAIN_SIDE, terrainHeight } from "../shared/terrain.ts";
import { emptyCity } from "../shared/city-stream.ts";

test("inland water replaces an independently restored material without touching ocean", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const lake = new Mesh("inland water", scene);
    lake.material = new StandardMaterial("saved:#478E9C", scene);
    const ocean = new Mesh("animated water", scene);
    const oceanMaterial = new StandardMaterial("ocean", scene);
    ocean.material = oceanMaterial;
    const renderer = new InlandWaterRenderer({
      scene,
      city: emptyCity({ seed: 1, airport: { x: 0, z: 0, w: 10, d: 10 } }),
    });
    assert.equal(lake.material.pluginManager?.getPlugin("InlandWater"), renderer);
    assert.equal(ocean.material, oceanMaterial);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test("river stations retain continuous channel coverage and downstream coordinates", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const city = emptyCity({ seed: 1, airport: { x: 0, z: 0, w: 10, d: 10 } });
    city.terrain = { heights: Array(TERRAIN_SIDE ** 2).fill(0) };
    city.terrain.heights[
      Math.floor(TERRAIN_SIDE / 2) * TERRAIN_SIDE + Math.floor(TERRAIN_SIDE / 2)
    ] = 4;
    const water = { lakes: [], rivers: [{ points: [0, -8, 0.2, 4, 0, 8, 0.2, 4] }] };
    const mesh = buildInlandWater(
      { scene, city, mat: () => new StandardMaterial("water", scene) },
      water,
    )!;
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind)!;
    assert.equal(mesh.getTotalVertices(), 34);
    for (let i = 0; i < positions.length; i += 6) {
      const x = (positions[i] + positions[i + 3]) / 2;
      const z = (positions[i + 2] + positions[i + 5]) / 2;
      assert.ok(positions[i + 1] >= terrainHeight(x, z, city) + 0.119);
    }
    assert.deepEqual(Array.from(uvs.slice(0, 4)), [-1, 0, 1, 0]);
    assert.deepEqual(Array.from(uvs.slice(-4)), [-1, 16, 1, 16]);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
