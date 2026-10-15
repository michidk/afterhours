import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { CityScene } from "../client/scene.ts";
import { SceneryCulling } from "../client/world/culling.ts";
import { EnvironmentLighting } from "../client/lighting/index.ts";
import { DestructionRenderer } from "../client/world/destruction.ts";
import {
  advanceDebris,
  correctionRate,
  restingHeight,
} from "../client/world/debris-motion.ts";
import {
  DEBRIS_LIFT,
  debrisRotation,
  debrisSpin,
  strikeVelocity,
  type DebrisState,
  type Destructible,
} from "../shared/destruction.ts";

const flat = () => 0;

test("debris rests on its lowest face and never sinks through the ground", () => {
  const box = { w: 0.4, h: 6, d: 0.4 };
  assert.equal(restingHeight({ x: 0, y: 0, z: 0, w: 1 }, box), 3);
  const lying = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
  assert.ok(Math.abs(restingHeight(lying, box) - 0.2) < 1e-9);
  const velocity = strikeVelocity({ vx: 0, vz: 30 });
  const pose = {
    position: { x: 0, y: 3 + DEBRIS_LIFT, z: 0 },
    rotation: debrisRotation(0),
    velocity: { ...velocity },
    angularVelocity: debrisSpin(velocity),
  };
  let lowest = Infinity;
  for (let i = 0; i < 180; i++) {
    advanceDebris(pose, 1 / 60, flat, box);
    lowest = Math.min(lowest, pose.position.y - restingHeight(pose.rotation, box));
  }
  assert.ok(lowest > -1e-9, "the box never dips below the ground");
  assert.ok(pose.position.z > 20, "a struck pole is thrown well clear of the car");
  assert.ok(
    Math.hypot(pose.velocity.x, pose.velocity.z) < 15,
    "ground friction slows it",
  );
});

test("small corrections settle gently and large ones catch up faster", () => {
  assert.equal(correctionRate(0.1), 3);
  assert.equal(correctionRate(2), 10);
  assert.ok(correctionRate(0.6) > 3 && correctionRate(0.6) < 10);
});

test("the server taking over a predicted launch slides the debris instead of snapping", () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  const host = Object.assign(Object.create(CityScene.prototype), {
    scene,
    culling: new SceneryCulling(scene),
    materials: new Map(),
    target: new Vector3(0, 0, 0),
    shadowCandidates: [],
    lights: [],
    lighting: { lamps: [], signs: [] },
    shadows: { addShadowCaster() {}, removeShadowCaster() {} },
  }) as CityScene;
  host.streetGlow = host.mat("#ffe5a1", true);
  host.lighting = new EnvironmentLighting(
    scene,
    new DirectionalLight("sun", new Vector3(0, -1, 0), scene),
    new HemisphericLight("ambient", Vector3.Up(), scene),
    host.streetGlow,
  );
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
  try {
    renderer.syncStatic([source]);
    const velocity = strikeVelocity({ vx: 0, vz: 25 });
    // The car's frame runs 0.15 s ahead of the newest snapshot.
    let serverTime = 10;
    const clock = () => ({ remote: serverTime - 0.1, local: serverTime + 0.15 });
    renderer.setPredictedImpacts(new Map([[source.id, velocity]]), clock());
    renderer.update(1000);
    for (let now = 1016; now <= 1100; now += 16) {
      serverTime += 0.016;
      renderer.setPredictedImpacts(new Map(), clock());
      renderer.update(now);
    }
    const node = scene.getTransformNodeByName("debris:" + source.id)!;
    const before = node.position.clone();
    // The server's body flew 1.5 m further sideways than the cosmetic launch.
    const state: DebrisState = {
      id: source.id,
      source,
      brokenAt: 10,
      expiresAt: 40,
      position: { x: 1.5, y: before.y, z: before.z - 0.15 * velocity.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      velocity: { ...velocity },
      angularVelocity: { x: 0, y: 0, z: 0 },
    };
    renderer.setBroken([source.id]);
    renderer.receive([state], serverTime, 1116);
    serverTime += 0.016;
    renderer.setPredictedImpacts(new Map(), clock());
    renderer.update(1116);
    const step = Vector3.Distance(before, node.position);
    assert.ok(step < 0.6, `drawn pose moved ${step.toFixed(2)} m in one frame`);
    assert.ok(node.position.x < 0.5, "the sideways error is not applied at once");
    for (let now = 1132; now <= 2200; now += 16) {
      serverTime += 0.016;
      renderer.setPredictedImpacts(new Map(), clock());
      renderer.update(now);
    }
    assert.ok(node.position.x > 1.3, "and converges onto the server's trajectory");
  } finally {
    renderer.dispose();
    scene.dispose();
    engine.dispose();
  }
});
