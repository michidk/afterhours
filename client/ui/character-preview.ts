import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
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
  private shadows: ShadowGenerator;
  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true);
    this.scene = new Scene(this.engine);
    this.scene.clearColor = Color4.FromHexString("#263a40ff");
    const camera = new FreeCamera("portrait", new Vector3(2.8, 2.0, 5.8), this.scene);
    camera.setTarget(new Vector3(0, 1, 0));
    camera.fov = 0.46;
    const light = new HemisphericLight(
      "portrait light",
      new Vector3(-1, 2, 3),
      this.scene,
    );
    light.intensity = 0.8;
    light.groundColor = Color3.FromHexString("#4d6165");
    const sun = new DirectionalLight(
      "garage light",
      new Vector3(-1, -2, -1),
      this.scene,
    );
    sun.position.set(4, 7, 5);
    sun.intensity = 1.1;
    sun.diffuse = Color3.FromHexString("#ffe4bb");
    this.shadows = new ShadowGenerator(1024, sun);
    this.shadows.usePercentageCloserFiltering = true;
    const stageMaterial = (name: string, color: string) => {
      const material = new StandardMaterial(name, this.scene);
      material.diffuseColor = Color3.FromHexString(color);
      material.specularColor = Color3.Black();
      return material;
    };
    const concrete = stageMaterial("concrete", "#536265"),
      wall = stageMaterial("painted wall", "#304d54"),
      metal = stageMaterial("shutter", "#243b42"),
      trim = stageMaterial("door frame", "#1b3036"),
      paint = stageMaterial("parking paint", "#a8986c");
    const box = (
      name: string,
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      material: StandardMaterial,
    ) => {
      const mesh = MeshBuilder.CreateBox(
        name,
        { width: w, height: h, depth: d },
        this.scene,
      );
      mesh.position.set(x, y, z);
      mesh.material = material;
      mesh.receiveShadows = true;
    };
    box("garage floor", 0, -0.09, 0, 30, 0.12, 30, concrete);
    box("garage wall", 0, 3, -2, 30, 6, 0.3, wall);
    box("shutter frame", 0.3, 1.8, -1.8, 4.5, 3.6, 0.12, trim);
    box("roller shutter", 0.3, 1.74, -1.68, 4.2, 3.45, 0.08, metal);
    for (let y = 0.12; y < 3.5; y += 0.19)
      box("shutter slat", 0.3, y, -1.62, 4.2, 0.025, 0.035, trim);
    box("side door", -3.1, 1.2, -1.8, 1.2, 2.4, 0.12, trim);
    box("door handle", -2.7, 1.15, -1.69, 0.05, 0.16, 0.05, paint);
    for (const x of [-2.1, 2.7])
      box("parking stripe", x, -0.025, 1.1, 0.06, 0.01, 4.5, paint);
    box("lamp housing", 0.3, 3.72, -1.65, 1.6, 0.12, 0.2, trim);
    const lamp = stageMaterial("lamp", "#fff0ce");
    lamp.emissiveColor = Color3.FromHexString("#fff0ce");
    box("garage lamp", 0.3, 3.69, -1.52, 1.4, 0.055, 0.06, lamp);
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
    const shadowMap = this.shadows.getShadowMap();
    if (shadowMap) shadowMap.renderList = this.root.getChildMeshes();
    this.engine.resize();
    this.scene.executeWhenReady(() => this.scene.render());
  }
  dispose() {
    this.resize.disconnect();
    this.scene.dispose();
    this.engine.dispose();
  }
}
