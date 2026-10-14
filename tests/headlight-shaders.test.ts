import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MaterialHelper } from "@babylonjs/core/Materials/materialHelper";
import {
  StandardMaterial,
  StandardMaterialDefines,
} from "@babylonjs/core/Materials/standardMaterial";
import { EnvironmentLighting } from "../client/lighting/index.ts";
import { CarLights } from "../client/models/car-lights.ts";
import type { Entity } from "../shared/world.ts";

test("headlight selection changes illumination without changing mesh shader variants", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const environment = new EnvironmentLighting(
      scene,
      new DirectionalLight("sun", Vector3.Down(), scene),
      new HemisphericLight("sky", Vector3.Up(), scene),
      new StandardMaterial("glow", scene),
    );
    const lights = new CarLights(scene);
    const beams = scene.lights.filter((light) =>
      light.name.startsWith("car headlight"),
    );
    const mesh = new Mesh("street", scene);
    const nodes = new Map([["car", new TransformNode("car", scene)]]);
    const car: Entity = {
      id: "car",
      kind: "car",
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      angle: 0,
      health: 100,
      color: "#fff",
      lightsOn: true,
    };
    const shader = () => {
      const defines = new StandardMaterialDefines();
      MaterialHelper.PrepareDefinesForLights(
        scene,
        mesh,
        defines,
        true,
        environment.windows.maxSimultaneousLights,
      );
      return defines.toString();
    };
    lights.update([], nodes, Vector3.Zero());
    const unlit = shader();
    assert.match(unlit, /#define LIGHTCOUNT 10\n/);
    assert.equal(unlit.match(/#define SPOTLIGHT\d/g)?.length, 4);
    assert.equal(unlit.match(/#define POINTLIGHT\d/g)?.length, 4);
    assert.equal(
      beams
        .filter((light) => light.isEnabled())
        .reduce((sum, light) => sum + light.intensity, 0),
      0,
    );
    lights.update([car], nodes, Vector3.Zero());
    assert.equal(
      shader(),
      unlit,
      "turning on headlights must reuse the prepared shader",
    );
    assert.equal(beams.filter((light) => light.intensity > 0).length, 2);
    environment.lamps.push(Vector3.Zero());
    environment.selectLamps(Vector3.Zero());
    assert.equal(
      shader(),
      unlit,
      "streaming street lamps must reuse the prepared shader",
    );
    lights.update([car], nodes, new Vector3(100, 0, 0));
    assert.equal(
      shader(),
      unlit,
      "driving out of range must reuse the prepared shader",
    );
    assert.equal(
      beams
        .filter((light) => light.isEnabled())
        .reduce((sum, light) => sum + light.intensity, 0),
      0,
    );
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
