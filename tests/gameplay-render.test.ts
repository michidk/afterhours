import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CityScene, drawnBody } from "../client/scene.ts";
import { WaterRenderer } from "../client/world/water.ts";
import { VEHICLES, WEAPONS, isVehicleModel } from "../shared/catalog.ts";
import type { Entity } from "../shared/world.ts";
import { Effects } from "../client/effects/index.ts";
import { WATER_LEVEL, watercraft } from "../shared/water.ts";

test("all catalog models, weapons, supplies, grenades, parachutes and animated water render and dispose", () => {
  const engine = new NullEngine(),
    scene = new Scene(engine),
    casters = new Set<Mesh>();
  const host: CityScene = Object.create(CityScene.prototype);
  Object.assign(host, {
    scene,
    materials: new Map(),
    target: Vector3.Zero(),
    shadowCandidates: [],
    nodes: new Map(),
    parts: new Map(),
    pickupNodes: new Map(),
    grenadeNodes: new Map(),
    lights: [],
    lighting: { lamps: [], signs: [] },
    shadows: {
      addShadowCaster: (m: Mesh) => casters.add(m),
      removeShadowCaster: (m: Mesh) => casters.delete(m),
      getShadowMap: () => ({ renderList: [...casters] }),
    },
  });
  host.streetGlow = host.mat("#ffe5a1", true);
  const base: Entity = {
    id: "p",
    kind: "player",
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    angle: 0,
    health: 100,
    color: "#ffffff",
  };
  try {
    const p = host.makeEntity(base);
    for (const kind of Object.keys(WEAPONS))
      if (kind !== "fists")
        assert.ok(
          p.getChildMeshes().some((m) => m.name === "held:" + kind),
          kind,
        );
    assert.equal(
      p.getChildMeshes().filter((m) => m.name === "parachute cell").length,
      7,
    );
    assert.equal(
      p.getChildMeshes().filter((m) => m.name === "parachute suspension").length,
      12,
    );
    assert.equal(
      p.getChildMeshes().filter((m) => m.name === "jetpack exhaust").length,
      2,
    );
    for (const [id, spec] of Object.entries(VEHICLES)) {
      assert.ok(isVehicleModel(id));
      const node = host.makeEntity({
        ...base,
        id,
        kind: spec.kind,
        model: id,
      });
      assert.ok(node.getChildMeshes().length > 0, id);
      if (watercraft(spec.kind)) {
        assert.ok(node.getChildMeshes().some((m) => m.name === "watercraft hull"));
        assert.equal(
          node.getChildMeshes().some((m) => m.name === "wings"),
          false,
        );
      }
    }
    host.updatePickups([
      {
        id: "ammo",
        kind: "ammo",
        ammoKind: "rifle",
        amount: 30,
        x: 0,
        y: 0,
        z: 0,
        expires: 30,
      },
      { id: "pack", kind: "jetpack", fuel: 20, x: 3, y: 0, z: 0, expires: 30 },
      {
        id: "knife",
        kind: "weapon",
        item: { id: "w", kind: "knife", ammo: 0, reserve: 0 },
        x: 6,
        y: 0,
        z: 0,
        expires: 30,
      },
    ]);
    assert.ok(scene.getMeshByName("ammo crate"));
    assert.ok(scene.getMeshByName("jetpack supply"));
    host.updatePickups([]);
    assert.equal(host.pickupNodes.size, 0);
    host.updateGrenades([
      {
        id: "g",
        owner: "p",
        x: 0,
        y: 1,
        z: 0,
        vx: 2,
        vy: 1,
        vz: 3,
        radius: 0.16,
        detonateAt: 3,
      },
    ]);
    assert.ok(scene.getMeshByName("thrown grenade"));
    host.updateGrenades([]);
    assert.equal(scene.getMeshByName("thrown grenade"), null);
    Object.assign(host, { camera: { position: new Vector3(100.3, 40, -50.2) } });
    const water = new WaterRenderer(host);
    const mesh = scene.getMeshByName("animated water")!;
    host.batchStatic([mesh as Mesh]);
    assert.equal(mesh.isDisposed(), false);
    // The swell is displaced on the GPU; the grid follows the camera in whole cells.
    water.update(1);
    assert.equal(mesh.position.y, WATER_LEVEL);
    assert.ok(
      Math.abs(mesh.position.x - 100.3) < 1 && Math.abs(mesh.position.z + 50.2) < 1,
    );
    assert.ok(
      mesh
        .getVerticesData(VertexBuffer.PositionKind)!
        .every((v, i) => i % 3 !== 1 || v === 0),
    );
    assert.equal(WATER_LEVEL, -1.1);
    const effects = new Effects(scene, (color, glow) => host.mat(color, glow));
    effects.effect({ kind: "flame", x: 0, y: 1, z: 0, angle: 0, length: 9 });
    assert.equal(effects.effects.length, 2);
    effects.update(3);
    assert.equal(effects.effects.length, 0);
    water.dispose();
    assert.equal(scene.getMeshByName("animated water"), null);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test("burning and wrecked vehicles stay drawn while dead characters give way to corpses", () => {
  const base = {
    id: "e",
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    angle: 0,
    color: "#fff",
  };
  const car: Entity = { ...base, kind: "car", health: 0, burning: 4 };
  assert.equal(drawnBody(car), true, "a car burning at zero health stays visible");
  assert.equal(
    drawnBody({ ...car, burning: undefined, wreck: 180 }),
    true,
    "the wreck",
  );
  assert.equal(drawnBody({ ...base, kind: "pedestrian", health: 0 }), false);
  assert.equal(
    drawnBody({ ...base, kind: "player", health: 100, vehicle: "c" }),
    false,
  );
});
