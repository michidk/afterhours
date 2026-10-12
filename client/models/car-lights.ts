import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Entity } from "../../shared/world.ts";

export function buildHeadlightCones(scene: Scene, root: TransformNode) {
  let material = scene.getMaterialByName("headlight beam");
  if (!material) {
    material = new ShaderMaterial(
      "headlight beam",
      scene,
      {
        vertexSource: `precision highp float;
        attribute vec3 position; uniform mat4 worldViewProjection;
        varying float fade;
        void main(){fade=clamp(position.y/24.0+0.5,0.0,1.0);
          gl_Position=worldViewProjection*vec4(position,1.0);}`,
        fragmentSource: `precision highp float; varying float fade;
        void main(){gl_FragColor=vec4(1.0,0.93,0.72,0.055*fade*fade);}`,
      },
      {
        attributes: ["position"],
        uniforms: ["worldViewProjection"],
        needAlphaBlending: true,
      },
    );
    material.disableDepthWrite = true;
  }
  for (const side of [-1, 1]) {
    const cone = MeshBuilder.CreateCylinder(
      "headlight cone",
      {
        height: 24,
        diameterTop: 0.1,
        diameterBottom: 8,
        tessellation: 24,
        cap: 0,
      },
      scene,
    );
    cone.material = material;
    cone.parent = root;
    cone.position.set(side * 0.65, 0.72 - 12 * 0.025, 14.2);
    cone.rotation.x = -Math.PI / 2 + 0.025;
    cone.isPickable = false;
    cone.setEnabled(false);
  }
}

export class CarLights {
  private lights: SpotLight[];
  constructor(scene: Scene) {
    // shortcut: four nearby beams have real lighting, increase only after GPU checks.
    this.lights = Array.from({ length: 4 }, (_, i) => {
      const light = new SpotLight(
        `car headlight ${i}`,
        Vector3.Zero(),
        new Vector3(0, -0.025, 1),
        0.64,
        2,
        scene,
      );
      light.diffuse = Color3.FromHexString("#fff1b8");
      light.specular = Color3.Black();
      light.range = 26;
      light.intensity = 2;
      light.renderPriority = 1;
      light.setEnabled(false);
      return light;
    });
  }
  update(entities: Entity[], nodes: Map<string, TransformNode>, focus: Vector3) {
    const cars = entities
      .filter(
        (e) =>
          e.kind === "car" &&
          e.lightsOn &&
          !e.wreck &&
          e.health > 0 &&
          nodes.get(e.id)?.isEnabled() &&
          Math.hypot(e.x - focus.x, e.z - focus.z) < 65,
      )
      .sort(
        (a, b) =>
          Math.hypot(a.x - focus.x, a.z - focus.z) -
          Math.hypot(b.x - focus.x, b.z - focus.z),
      )
      .slice(0, 2);
    for (const [i, light] of this.lights.entries()) {
      const car = cars[Math.floor(i / 2)];
      light.setEnabled(!!car);
      if (!car) continue;
      const root = nodes.get(car.id)!;
      const matrix = root.computeWorldMatrix(true);
      light.position.copyFrom(
        Vector3.TransformCoordinates(
          new Vector3(i % 2 ? 0.65 : -0.65, 0.72, 2.2),
          matrix,
        ),
      );
      light.direction.copyFrom(
        Vector3.TransformNormal(new Vector3(0, -0.025, 1), matrix).normalize(),
      );
    }
  }
}
