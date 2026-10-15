import { emptyCity } from "../shared/city-stream.ts";
import { TERRAIN_SIDE } from "../shared/terrain.ts";
import { SceneryCulling } from "../client/world/culling.ts";
import { DEFAULT_CHARACTER } from "../shared/character.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CityScene } from "../client/scene.ts";
import { DestructionRenderer } from "../client/world/destruction.ts";
import { EnvironmentLighting } from "../client/lighting/index.ts";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { DebrisState, Destructible } from "../shared/destruction.ts";
import { encodeSnapshot, decodeSnapshot } from "../shared/codec.ts";
import { VERSION } from "../shared/protocol.ts";

test("streamed fixtures hide, debris interpolates/fades, lights restore and meshes dispose", () => {
  const engine = new NullEngine(),
    scene = new Scene(engine),
    casters = new Set<Mesh>();
  const host = Object.assign(Object.create(CityScene.prototype), {
    scene,
    culling: new SceneryCulling(scene),
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
  host.lighting = new EnvironmentLighting(
    scene,
    new DirectionalLight("sun", new Vector3(0, -1, 0), scene),
    new HemisphericLight("ambient", Vector3.Up(), scene),
    host.streetGlow,
  );
  const baseMeshes = scene.meshes.length;
  const renderer = new DestructionRenderer(host),
    source: Destructible = {
      id: "lamp:0,0",
      kind: "lamp",
      x: 0,
      z: 0,
      h: 6,
      w: 0.38,
      d: 0.38,
      angle: Math.PI / 2,
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
    renderer.syncStatic([source]);
    renderer.setPredictedImpacts(new Map([[source.id, { x: 0, y: 2, z: 30 }]]));
    renderer.update(16);
    const provisional = scene.getTransformNodeByName("fixture:" + source.id)!;
    assert.equal(
      provisional.isEnabled(),
      false,
      "a predicted strike throws the fixture",
    );
    assert.equal(renderer.diagnostics.debris, 1);
    assert.equal(host.lighting.lamps.length, 0, "a thrown lamp goes dark at once");
    for (let now = 32; now <= 160; now += 16) renderer.update(now);
    const launched = scene.getTransformNodeByName("debris:" + source.id)!;
    assert.ok(
      launched.position.z > 2,
      "the cosmetic launch flies before the server answers",
    );
    renderer.setPredictedImpacts(new Map());
    for (let now = 176; now <= 1000; now += 16) renderer.update(now);
    assert.equal(renderer.diagnostics.debris, 0, "an unconfirmed strike is withdrawn");
    assert.equal(provisional.isEnabled(), true, "and its fixture stands again");
    assert.equal(host.lighting.lamps.length, 1);
    renderer.setBroken([source.id]);
    renderer.syncStatic([source]);
    assert.equal(host.lighting.lamps.length, 0, "late-loaded destroyed lamps stay off");
    const standing = scene.getTransformNodeByName("fixture:" + source.id)!;
    const pool = scene.getMeshByName("street light pool")!;
    assert.equal(standing.isEnabled(), false);
    assert.equal(pool.isEnabled(), false, "destroyed lamps have no ground light");
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
    assert.equal(pool.isEnabled(), true);
    assert.ok(pool.material instanceof StandardMaterial);
    host.lighting.update(0, new Vector3(500, 0, 500), 1);
    assert.equal(
      pool.material.alpha,
      0.3,
      "distant lamps illuminate the ground at night",
    );
    assert.ok(host.streetGlow.emissiveColor.r > 1);
    pool.computeWorldMatrix(true);
    assert.ok(Math.abs(pool.getAbsolutePosition().y - 0.27) < 1e-6);
    assert.ok(Math.abs(pool.getAbsolutePosition().z + 1.3) < 1e-6);
    assert.ok(Math.abs(host.lighting.lamps[0].z + 1.3) < 1e-6);
    host.lighting.update(0, Vector3.Zero(), 1);
    assert.equal(pool.material.alpha, 0.3, "approaching does not switch the pool on");
    host.lighting.update(12, Vector3.Zero(), 1);
    assert.equal(pool.material.alpha, 0, "ground lights turn off by day");
    renderer.syncStatic([]);
    assert.equal(scene.meshes.length, baseMeshes);
    assert.equal(casters.size, 0);
    assert.equal(host.shadowCandidates.length, 0);
    assert.equal(host.lighting.lamps.length, 0);
    host.lighting.update(0, Vector3.Zero(), 1);
    assert.ok(
      scene.lights
        .filter((light) => light.name.startsWith("nearby street lamp"))
        .every((light) => light.intensity === 0),
      "unloaded lamps leave no point lights behind",
    );
    assert.ok(scene.materials.length > 0, "palette survives chunk eviction");
    renderer.receive(
      [
        {
          ...state,
          id: "body:test",
          source: {
            id: "body:test",
            kind: "corpse",
            x: 0,
            z: 0,
            h: 1.9,
            w: 0.65,
            d: 0.6,
            color: "#e8b63f",
            character: {
              ...DEFAULT_CHARACTER,
              skin: "#654432",
              hair: "cap",
              legs: "shorts",
            },
          },
        },
      ],
      0,
      3000,
    );
    renderer.update(3000);
    const corpse = scene.getTransformNodeByName("debris:body:test")!;
    assert.ok(
      corpse.getChildMeshes().some((mesh) => mesh.material === host.mat("#654432")),
      "corpse retains skin tone",
    );
    assert.ok(
      corpse.getChildMeshes().some((mesh) => mesh.material === host.mat("#344842")),
      "corpse retains cap",
    );
    const snapshot = decodeSnapshot(
      encodeSnapshot({
        type: "state",
        version: VERSION,
        frame: 1,
        base: 0,
        full: true,
        time: 1,
        day: 12,
        ack: 0,
        entities: [],
        removed: [],
        events: [],
        pickups: [],
        players: 1,
        debris: [
          {
            ...state,
            id: "body:npc",
            source: {
              id: "body:npc",
              kind: "corpse",
              x: 0,
              z: 0,
              h: 1.9,
              w: 0.65,
              d: 0.6,
              color: "#e8b63f",
              character: undefined,
            },
          },
        ],
      }),
    );
    renderer.receive(snapshot.debris!, 1, 3500);
    assert.doesNotThrow(
      () => renderer.update(3500),
      "an NPC corpse received over MessagePack must not freeze the render loop",
    );
    const npc = scene.getTransformNodeByName("debris:body:npc")!;
    assert.ok(
      npc
        .getChildMeshes()
        .some((mesh) => mesh.material === host.mat(DEFAULT_CHARACTER.skin)),
      "NPCs without appearance use the default character",
    );
    renderer.receive([], 30, 4000);
    renderer.update(4000);
    assert.equal(scene.meshes.length, baseMeshes);
    assert.equal(scene.transformNodes.length, 0);
    host.city = emptyCity({ seed: 1, airport: { x: 1000, z: 1000, w: 100, d: 100 } });
    host.city.terrain = { heights: Array(TERRAIN_SIDE ** 2).fill(25) };
    host.savedGeometry = true;
    host.staticFixtures = new Map([[source.id, []]]);
    renderer.syncStatic([source]);
    assert.equal(
      scene.getTransformNodeByName("fixture:" + source.id)!.position.y,
      28,
      "baked fixture transforms include the terrain below the three-metre half-height",
    );
  } finally {
    renderer.dispose();
    scene.dispose();
    engine.dispose();
  }
});
