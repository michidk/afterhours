import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Character } from "../../shared/character.ts";
import { buildCharacter } from "../models/character.ts";

export class CharacterPreview {
  private engine: Engine;
  private scene: Scene;
  private root: TransformNode | undefined;
  private resize: ResizeObserver;
  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true);
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    const camera = new FreeCamera("portrait", new Vector3(3.1, 2.05, 5.4), this.scene);
    camera.setTarget(new Vector3(0, 1, 0));
    camera.fov = 0.48;
    const light = new HemisphericLight(
      "portrait light",
      new Vector3(-1, 2, 3),
      this.scene,
    );
    light.intensity = 1.3;
    light.groundColor = Color3.FromHexString("#726956");
    this.resize = new ResizeObserver(() => {
      this.engine.resize();
      this.scene.render();
    });
    this.resize.observe(canvas);
  }
  update(character: Character, color: string) {
    this.root?.dispose(false, true);
    this.root = new TransformNode("portrait", this.scene);
    const materials = new Map<string, StandardMaterial>();
    buildCharacter(
      this.root,
      color,
      (hex) => {
        let material = materials.get(hex);
        if (!material) {
          material = new StandardMaterial(hex, this.scene);
          material.diffuseColor = Color3.FromHexString(hex);
          material.specularColor = Color3.Black();
          materials.set(hex, material);
        }
        return material;
      },
      character,
    );
    this.engine.resize();
    this.scene.executeWhenReady(() => this.scene.render());
  }
  dispose() {
    this.resize.disconnect();
    this.scene.dispose();
    this.engine.dispose();
  }
}
