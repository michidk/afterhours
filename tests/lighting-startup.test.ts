import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { EnvironmentLighting } from "../client/lighting/index.ts";

test("spawn lamp selection is ready before the first gameplay frame and stays stable", (t) => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const lighting = new EnvironmentLighting(
      scene,
      new DirectionalLight("sun", Vector3.Down(), scene),
      new HemisphericLight("sky", Vector3.Up(), scene),
      new StandardMaterial("glow", scene),
    );
    lighting.lamps.push(new Vector3(-260, 6, 658));
    lighting.selectLamps(new Vector3(-261, 0, 657));
    const lamps = scene.lights.filter((light) =>
      light.name.startsWith("nearby street lamp"),
    );
    assert.equal(
      lamps.filter((light) => light.isEnabled()).length,
      1,
      "startup enables the actual shader light set without advancing gameplay",
    );
    const transitions = lamps.map((light) => t.mock.method(light, "setEnabled"));
    lighting.update(16.5, new Vector3(-261, 0, 660), 0.3);
    assert.ok(
      transitions.every((mock) => mock.mock.callCount() === 0),
      "first gameplay selection does not invalidate lighting shaders",
    );
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
