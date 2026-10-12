import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { buildTerrain } from "../client/world/terrain.ts";
import { generateTerrain } from "../scripts/terrain-generator.ts";

test("terrain faces and normals point up so the island is visible from above", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const mesh = buildTerrain(
      { scene, mat: () => new StandardMaterial("terrain", scene) },
      generateTerrain(713),
    );
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    for (let i = 1; i < normals.length; i += 3) assert.ok(normals[i] > 0);
    assert.ok(mesh.getBoundingInfo().boundingBox.maximum.y > 170);
    assert.equal(mesh.getTotalVertices(), 9409);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
