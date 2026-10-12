import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Scene } from "@babylonjs/core/scene";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { buildTerrain } from "../client/world/terrain.ts";
import { generateTerrain } from "../scripts/terrain-generator.ts";
import { TERRAIN_SIDE } from "../shared/terrain.ts";

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
    assert.equal(mesh.getTotalVertices(), TERRAIN_SIDE ** 2);
    const camera = new FreeCamera("view", new Vector3(0, 60, -40), scene);
    camera.maxZ = 250;
    camera.setTarget(Vector3.Zero());
    mesh.computeWorldMatrix(true);
    const planes = Frustum.GetPlanes(
      camera.getViewMatrix().multiply(camera.getProjectionMatrix()),
    );
    const visibleIndices = mesh.subMeshes
      .filter((part) => part.isInFrustum(planes))
      .reduce((sum, part) => sum + part.indexCount, 0);
    assert.ok(visibleIndices > 0, "the visible ground is retained");
    assert.ok(
      visibleIndices < mesh.getTotalIndices() / 4,
      `a street-level view does not draw the whole island: ${visibleIndices}/${mesh.getTotalIndices()}`,
    );
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
