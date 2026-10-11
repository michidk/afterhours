import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CityScene } from "../client/scene.ts";
import { DestructionRenderer } from "../client/world/destruction.ts";
import type { DebrisState, Destructible } from "../shared/destruction.ts";

test("streamed fixtures hide, debris interpolates/fades, lights restore and meshes dispose", () => {
  const engine = new NullEngine(),
    scene = new Scene(engine),
    casters = new Set<Mesh>();
  const host = Object.assign(Object.create(CityScene.prototype), {
    scene,
    materials: new Map(),
    target: new Vector3(0, 0, 0),
    shadowCandidates: [],
    lights: [],
    lighting: { lamps: [], signs: [] },
    shadows: {
      addShadowCaster: (m: Mesh) => casters.add(m),
      removeShadowCaster: (m: Mesh) => casters.delete(m),
    },
  }) as CityScene;
  host.streetGlow = host.mat("#ffe5a1", true);
  const renderer = new DestructionRenderer(host),
    source: Destructible = {
      id: "lamp:0,0",
      kind: "lamp",
      x: 0,
      z: 0,
      h: 6,
      w: 0.38,
      d: 0.38,
    };
  const state: DebrisState = {
    id: source.id,
    source,
    brokenAt: 0,
    expiresAt: 30,
    position: { x: 2, y: 1, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: { x: 2, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
  };
  try {
    renderer.setBroken([source.id]);
    renderer.syncStatic([source]);
    assert.equal(host.lighting.lamps.length, 0, "late-loaded destroyed lamps stay off");
    const standing = scene.getTransformNodeByName("fixture:" + source.id)!;
    assert.equal(standing.isEnabled(), false);
    renderer.receive([state], 0, 0);
    renderer.receive([{ ...state, position: { x: 4, y: 1, z: 0 } }], 0.1, 100);
    renderer.update(130);
    const debris = scene.getTransformNodeByName("debris:" + source.id)!;
    assert.ok(Math.abs(debris.position.x - 3) < 1e-8);
    renderer.receive([state], 28, 1000);
    renderer.update(1000);
    assert.ok(
      debris
        .getChildMeshes()
        .every((m) => Math.abs((m as Mesh).visibility - 2 / 3) < 1e-8),
    );
    renderer.receive([], 30, 2000);
    renderer.setBroken([]);
    renderer.update(2000);
    assert.equal(scene.getTransformNodeByName("debris:" + source.id), null);
    assert.equal(standing.isEnabled(), true);
    assert.equal(host.lighting.lamps.length, 1);
    renderer.syncStatic([]);
    assert.equal(scene.meshes.length, 0);
    assert.equal(casters.size, 0);
    assert.equal(host.shadowCandidates.length, 0);
    assert.equal(host.lighting.lamps.length, 0);
    assert.ok(scene.materials.length > 0, "palette survives chunk eviction");
  } finally {
    renderer.dispose();
    scene.dispose();
    engine.dispose();
  }
});
