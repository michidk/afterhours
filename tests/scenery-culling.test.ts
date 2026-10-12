import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { SceneryCulling } from "../client/world/culling.ts";

test("scenery culling retains visible scenery, moving actors and synchronous spawns across streaming", () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const camera = new FreeCamera("camera", new Vector3(0, 20, -30), scene);
    camera.maxZ = 150;
    camera.setTarget(Vector3.Zero());
    const culling = new SceneryCulling(scene);
    for (let x = -1000; x <= 1000; x += 100)
      for (let z = -1000; z <= 1000; z += 100) {
        const mesh = MeshBuilder.CreateBox(`${x}:${z}`, { size: 10 }, scene);
        mesh.position.set(x, 0, z);
        culling.add(mesh);
      }
    const fixtureRoot = new TransformNode("fixture", scene);
    fixtureRoot.position.set(1000, 0, 1000);
    fixtureRoot.rotation.y = Math.PI / 4;
    const fixture = MeshBuilder.CreateBox("parented fixture", { size: 5 }, scene);
    fixture.parent = fixtureRoot;
    culling.add(fixture);
    const actor = MeshBuilder.CreateBox("moving actor", {}, scene);
    actor.position.set(1000, 0, 1000);
    const check = () => {
      scene.updateTransformMatrix(true);
      for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
      const candidates = scene.getActiveMeshCandidates();
      const selected = new Set(candidates.data.slice(0, candidates.length));
      for (const mesh of scene.meshes)
        if (mesh.isInFrustum(scene.frustumPlanes))
          assert.ok(selected.has(mesh), `visible mesh retained: ${mesh.name}`);
      assert.ok(selected.has(actor), "actors can move outside old bounds");
      assert.ok(
        selected.size < scene.meshes.length / 4,
        `most distant scenery is excluded: ${selected.size}/${scene.meshes.length}`,
      );
      return selected;
    };
    check();
    actor.position.set(0, 0, 0);
    const spawned = MeshBuilder.CreateBox("new spawn", {}, scene);
    assert.ok(check().has(spawned), "spawn is eligible before deferred observers run");
    culling.add(spawned);
    assert.ok(check().has(spawned), "newly streamed scenery is immediately indexed");
    spawned.dispose();
    assert.ok(!check().has(spawned), "eviction removes stale octree entries");
    camera.position.set(1000, 20, 970);
    camera.setTarget(new Vector3(1000, 0, 1000));
    assert.ok(check().has(fixture), "parent transforms are included in static bounds");
    fixtureRoot.setEnabled(false);
    check();
    fixtureRoot.setEnabled(true);
    assert.ok(check().has(fixture), "restored fixtures remain indexed");
    const ocean = MeshBuilder.CreateGround(
      "outside index bounds",
      { width: 10000, height: 10000 },
      scene,
    );
    culling.add(ocean);
    assert.ok(check().has(ocean), "geometry beyond the index bounds remains eligible");
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
