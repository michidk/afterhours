import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Effects } from "../client/effects/index.ts";
import { createParticles } from "../client/effects/particles.ts";

test("layered effects share textures, follow firing direction, and release all transient resources", () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  const material = new StandardMaterial("test", scene);
  const effects = new Effects(scene, () => material);
  try {
    const textures = scene.textures.length;
    effects.effect({ kind: "explosion", x: 2, y: 3, z: 4 });
    assert.deepEqual(
      scene.particleSystems.map((p) => p.name),
      ["fx:flash", "fx:fire", "fx:spark", "fx:soot"],
    );
    effects.effect({ kind: "flame", x: 0, y: 1, z: 0, angle: Math.PI / 2, length: 9 });
    const jet = effects.effects.at(-2);
    assert.ok(jet?.kind === "particles");
    assert.ok(jet.system.direction1.x > 12);
    assert.ok(Math.abs(jet.system.direction1.z) <= 0.51);
    jet.system.animate(true);
    assert.ok(jet.system.getActiveCount() > 0);
    for (let frame = 0; frame < 90; frame++) jet.system.animate(true);
    assert.equal(jet.system.getActiveCount(), 0, "a burst emits once and expires");
    effects.effect({ kind: "wake", x: 2, y: -1, z: 4 });
    const wake = scene.getMeshByName("water wake");
    assert.ok(wake);
    assert.equal(wake.isPickable, false);
    effects.update(0.5);
    assert.ok(wake.scaling.x > 1);
    assert.ok(wake.visibility < 1);
    effects.update(4);
    assert.equal(effects.effects.length, 0);
    assert.equal(scene.particleSystems.length, 0);
    assert.equal(scene.getMeshByName("water wake"), null);
    const warmedTextures = scene.textures.length;
    assert.equal(warmedTextures, textures + 2);
    for (let i = 0; i < 5; i++) {
      effects.effect({ kind: "explosion", x: i, y: 1, z: 0 });
      effects.update(4);
    }
    assert.equal(scene.textures.length, warmedTextures);
    assert.equal(scene.particleSystems.length, 0);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test("combat saturation stays bounded and audio-only events create no effects", () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  const material = new StandardMaterial("test", scene);
  const effects = new Effects(scene, () => material);
  try {
    for (const kind of ["swing", "throw", "dryFire", "unknown"])
      effects.effect({ kind, x: 0, y: 0, z: 0 });
    assert.equal(effects.effects.length, 0);
    for (let i = 0; i < 200; i++)
      effects.effect({ kind: "shot", x: 0, y: 1, z: 0, length: 10 });
    assert.ok(effects.effects.length <= 96);
    assert.ok(scene.particleSystems.length <= 96);
    effects.update(4);
    assert.equal(effects.effects.length, 0);
    assert.equal(scene.particleSystems.length, 0);
    assert.equal(scene.getMeshByName("tracer"), null);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test("hydrant droplets fall under gravity while mist expands, with shared texture ownership", () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const spray = createParticles(scene, "spray", 180, Vector3.Zero());
    const mist = createParticles(scene, "mist", 48, Vector3.Zero());
    assert.ok(spray.gravity.y < 0);
    assert.ok(spray.direction1.y > 0);
    assert.ok(
      mist.getSizeGradients()!.at(-1)!.factor1 > mist.getSizeGradients()![0].factor1,
    );
    const texture = spray.particleTexture;
    spray.dispose(false, false);
    const next = createParticles(scene, "spray", 180, Vector3.Zero());
    assert.equal(next.particleTexture, texture);
    assert.equal(scene.particleSystems.length, 2);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test("hydrant fountains are idempotent and dispose both layers when streamed out", async () => {
  const { CityScene } = await import("../client/scene.ts");
  const { DestructionRenderer } = await import("../client/world/destruction.ts");
  const engine = new NullEngine(),
    scene = new Scene(engine);
  const host = Object.assign(Object.create(CityScene.prototype), {
    scene,
    materials: new Map(),
    target: Vector3.Zero(),
    shadowCandidates: [],
    lights: [],
    lighting: { lamps: [] },
    shadows: { addShadowCaster() {}, removeShadowCaster() {} },
  });
  const renderer = new DestructionRenderer(host);
  try {
    renderer.syncStatic([
      { id: "hydrant:test", kind: "hydrant", x: 2, z: 3, h: 1, w: 1, d: 1 },
    ]);
    renderer.setBroken(["hydrant:test"]);
    renderer.setBroken(["hydrant:test"]);
    assert.equal(renderer.diagnostics.fountains, 1);
    assert.deepEqual(
      scene.particleSystems.map((p) => p.name),
      ["fx:spray", "fx:mist"],
    );
    renderer.syncStatic([]);
    assert.equal(renderer.diagnostics.fountains, 0);
    assert.equal(scene.particleSystems.length, 0);
  } finally {
    renderer.dispose();
    scene.dispose();
    engine.dispose();
  }
});
