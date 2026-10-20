import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CityRenderer, type GeometryOptions } from "../client/world/render.ts";
import type { CityScene } from "../client/scene.ts";
import type { City } from "../shared/world.ts";
import { CityStore } from "../server/city-stream.ts";
import { emptyCity } from "../shared/city-stream.ts";

test("streamed meshes batch synchronously, boundary buildings render once and eviction disposes geometry", () => {
  const engine = new NullEngine(),
    scene = new Scene(engine),
    material = new StandardMaterial("shared", scene),
    existing = MeshBuilder.CreateBox("existing scenery", {}, scene);
  existing.material = material;
  const city = emptyCity({ seed: 42, airport: { x: 600, z: 600, w: 20, d: 40 } });
  city.buildings = [{ x: 127, z: 20, w: 8, d: 8, h: 20, color: "#ffffff", style: 0 }];
  city.roads = [
    { x: 128, z: 0, ax: 64, az: 0, bx: 192, bz: 0, width: 18, kind: "avenue" },
  ];
  const store = new CityStore(city),
    casters: Mesh[] = [];
  let buildingBuilds = 0,
    batches = 0;
  const host = {
    scene,
    shadowCandidates: [] as Mesh[],
    lights: [],
    lighting: { lamps: [], signs: [] },
    shadows: {
      getShadowMap: () => ({ renderList: casters }),
      removeShadowCaster: (mesh: Mesh) => {
        const i = casters.indexOf(mesh);
        if (i >= 0) casters.splice(i, 1);
      },
    },
    build(data: City, options: GeometryOptions) {
      if (options.roads)
        for (const road of data.roads)
          MeshBuilder.CreateBox("road", {}, scene).material = material;
      for (const building of data.buildings) {
        buildingBuilds++;
        for (let i = 0; i < 3; i++) {
          const mesh = MeshBuilder.CreateBox("building", {}, scene);
          mesh.position.x = building.x + i;
          mesh.material = material;
          casters.push(mesh);
        }
      }
    },
    batchStatic(meshes: Mesh[]) {
      assert.ok(
        meshes.length > 0,
        "deferred Babylon observers must not leave the batch empty",
      );
      batches++;
      if (meshes.length > 1) {
        for (const mesh of meshes) this.shadows.removeShadowCaster(mesh);
        const merged = Mesh.MergeMeshes(meshes, true, true)!;
        casters.push(merged);
      }
    },
  };
  const renderer = new CityRenderer(host as unknown as CityScene, store.manifest);
  try {
    renderer.sync([store.chunks.get("0,0")!, store.chunks.get("1,0")!]);
    assert.equal(buildingBuilds, 1);
    assert.equal(scene.meshes.length, 3);
    assert.equal(batches, 2);
    renderer.sync([store.chunks.get("1,0")!]);
    assert.equal(buildingBuilds, 1);
    assert.equal(scene.meshes.length, 3);
    renderer.sync([]);
    assert.deepEqual(scene.meshes, [existing]);
    assert.equal(existing.isDisposed(), false);
    assert.equal(casters.length, 0);
    assert.equal(host.shadowCandidates.length, 0);
    assert.ok(
      scene.materials.includes(material),
      "shared palette materials survive unloading",
    );
    renderer.sync([store.chunks.get("0,0")!]);
    assert.equal(buildingBuilds, 2);
    assert.equal(scene.meshes.length, 3);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test("buildings fade only when the camera's line to the player crosses them", () => {
  const engine = new NullEngine(),
    scene = new Scene(engine),
    material = new StandardMaterial("shared", scene);
  const city = emptyCity({ seed: 7, airport: { x: 600, z: 600, w: 20, d: 40 } });
  // A tower 20 m wide with its west wall at x = 30, and a second one well away from it.
  city.buildings = [
    { x: 40, z: 40, w: 20, d: 20, h: 30, y: 0, color: "#ffffff", style: 0 },
    { x: 100, z: 100, w: 20, d: 20, h: 30, y: 0, color: "#ffffff", style: 0 },
  ];
  const store = new CityStore(city);
  const host = {
    scene,
    shadowCandidates: [] as Mesh[],
    lights: [],
    lighting: { lamps: [], signs: [] },
    shadows: { getShadowMap: () => ({ renderList: [] }), removeShadowCaster() {} },
    build(data: City) {
      for (const b of data.buildings) {
        // Real-sized geometry, so bounds-based tests see what the player sees.
        const mesh = MeshBuilder.CreateBox(
          "building",
          { width: b.w, depth: b.d, height: b.h - (b.y ?? 0) },
          scene,
        );
        mesh.position.set(b.x, ((b.y ?? 0) + b.h) / 2, b.z);
        mesh.computeWorldMatrix(true);
        mesh.material = material;
      }
    },
    batchStatic() {},
  };
  const renderer = new CityRenderer(host as unknown as CityScene, store.manifest);
  try {
    renderer.sync([store.chunks.get("0,0")!]);
    const [tower, other] = scene.meshes.filter((m) => m.name === "building");
    assert.ok(tower && other && tower !== other);
    const settle = (camera: Vector3, target: Vector3, frames = 40, follow = true) => {
      for (let i = 0; i < frames; i++)
        renderer.fadeOccluders(camera, target, 1 / 30, follow);
    };
    // Standing 4 m from the tower's west wall with the camera behind on the same side.
    settle(new Vector3(10, 12, 40), new Vector3(26, 0, 40));
    assert.equal(tower.visibility, 1, "a building beside the player stays solid");
    // A nearby wall outside the silhouette does not obstruct the player.
    settle(new Vector3(28, 14, 70), new Vector3(28, 0, 40));
    assert.equal(
      tower.visibility,
      1,
      "a wall outside the player silhouette stays solid",
    );
    assert.equal(other.visibility, 1, "an unrelated building never fades");
    // Camera on the far side of the tower: it is in the way, so it dithers out.
    settle(new Vector3(70, 12, 40), new Vector3(26, 0, 40));
    assert.equal(tower.visibility, 0, "a building that blocks the view fades");
    assert.equal(other.visibility, 1, "and only that building");
    settle(new Vector3(40, 50, 20), new Vector3(40, 0, 40), 40, false);
    assert.equal(tower.visibility, 1, "free inspection restores the focused building");
    settle(new Vector3(40, 12, 40), new Vector3(40, 12, 60), 40, false);
    assert.equal(
      tower.visibility,
      1,
      "fly inspection keeps buildings solid even inside",
    );
    settle(new Vector3(70, 12, 40), new Vector3(26, 0, 40));
    assert.equal(tower.visibility, 0, "returning to follow restores player occlusion");
    // The sight line clears again: it returns.
    settle(new Vector3(10, 12, 40), new Vector3(26, 0, 40));
    assert.equal(tower.visibility, 1, "an unobstructed building fades back in");
    // Partway through a fade the dither is gradual, not a pop.
    renderer.fadeOccluders(new Vector3(70, 12, 40), new Vector3(26, 0, 40), 1 / 30);
    assert.ok(tower.visibility < 1 && tower.visibility > 0.5, `${tower.visibility}`);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
