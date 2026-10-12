import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { rampMesh } from "../client/models/ramp.ts";
import { RAMP } from "../shared/physics/ramps.ts";

test("ramp decoration stays on the shared slope in a single disposable mesh", () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const mesh = rampMesh(scene, 3.5, 91),
      positions = mesh.getVerticesData(VertexBuffer.PositionKind)!,
      colors = mesh.getVerticesData(VertexBuffer.ColorKind)!,
      normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    assert.equal(scene.meshes.length, 1);
    assert.deepEqual(mesh.position.asArray(), [3.5, 0.3, 91]);
    assert.equal(colors.length, (positions.length / 3) * 4);
    for (let i = 0; i < 18; i += 3)
      assert.ok(normals[i + 1] > 0.9, "driving surface faces upward");
    for (let i = 72; i < positions.length; i += 3) {
      const [x, y, z] = positions.slice(i, i + 3);
      assert.ok(Math.abs(x) <= RAMP.width / 2);
      assert.ok(Math.abs(z) <= RAMP.length / 2);
      assert.ok(Math.abs(y - ((z + 3.5) / 7) * 1.6 - 0.008) < 1e-6);
      assert.ok(normals[i + 1] > 0.9, "paint faces upward");
    }
    assert.ok(colors.some((value, i) => i % 4 === 0 && value > 0.9));
    mesh.dispose();
    assert.equal(scene.meshes.length, 0);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
