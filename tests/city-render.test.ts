import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
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
    material = new StandardMaterial("shared", scene);
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
    assert.equal(scene.meshes.length, 2);
    assert.equal(batches, 2);
    renderer.sync([store.chunks.get("1,0")!]);
    assert.equal(buildingBuilds, 1);
    assert.equal(scene.meshes.length, 2);
    renderer.sync([]);
    assert.equal(scene.meshes.length, 0);
    assert.equal(casters.length, 0);
    assert.equal(host.shadowCandidates.length, 0);
    assert.ok(
      scene.materials.includes(material),
      "shared palette materials survive unloading",
    );
    renderer.sync([store.chunks.get("0,0")!]);
    assert.equal(buildingBuilds, 2);
    assert.equal(scene.meshes.length, 2);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
