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
    this.scene.clearColor = Color4.FromHexString("#dfa68fff");
    const camera = new FreeCamera("portrait", new Vector3(2.6, 1.8, 6.5), this.scene);
    camera.setTarget(new Vector3(0, 1, 0));
    camera.fov = 0.46;
    const light = new HemisphericLight(
      "portrait light",
      new Vector3(-1, 2, 3),
      this.scene,
    );
    light.intensity = 0.95;
    light.groundColor = Color3.FromHexString("#52627d");
    const sun = new DirectionalLight(
      "garage light",
      new Vector3(-2, -3, -2),
      this.scene,
    );
    sun.position.set(4, 7, 5);
    sun.intensity = 1.2;
    sun.diffuse = Color3.FromHexString("#ffe4bb");
    this.shadows = new ShadowGenerator(1024, sun);
    this.shadows.usePercentageCloserFiltering = true;
    const stageMaterial = (name: string, color: string) => {
      const material = new StandardMaterial(name, this.scene);
      material.diffuseColor = Color3.FromHexString(color);
      material.specularColor = Color3.Black();
      return material;
    };
    const concrete = stageMaterial("rooftop concrete", "#6e7782"),
      trim = stageMaterial("railing", "#263b4d"),
      paint = stageMaterial("roof markings", "#c9b990");
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
    box("rooftop", 0, -0.09, 0, 40, 0.12, 30, concrete);
    box("parapet", 0, 0.12, -4, 40, 0.24, 0.3, trim);
    box("rail", 0, 0.72, -4, 40, 0.045, 0.045, trim);
    for (let x = -18; x <= 18; x += 2.5)
      box("rail post", x, 0.49, -4, 0.035, 0.5, 0.035, trim);
    for (const x of [-2.1, 2.7])
      box("roof seam", x, -0.025, 1.1, 0.025, 0.01, 12, paint);
    const windows = stageMaterial("distant windows", "#dfb49b");
    windows.emissiveColor = Color3.FromHexString("#654d3b");
    // Fixed skyline keeps the menu stable when changing outfits.
    for (let i = 0; i < 28; i++) {
      const height = 2 + ((i * 17) % 11) * 0.36;
      const facade = stageMaterial(`skyline ${i}`, i % 2 ? "#737584" : "#8d8190");
      facade.emissiveColor = Color3.FromHexString("#302737");
      const x = (i - 14) * 2.4;
      const z = -17 - (i % 3) * 3;
      box("city tower", x, height / 2 - 2, z, 1.8, height, 2, facade);
      for (let y = -0.8; y < height - 2.3; y += 0.6)
        box("window band", x, y, z + 1.01, 1.35, 0.12, 0.015, windows);
      if (i % 4 === 0) box("roof plant", x, height - 1.8, z, 0.8, 0.4, 0.8, trim);
    }
    const sunset = stageMaterial("setting sun", "#ffdab0");
    sunset.disableLighting = true;
    sunset.emissiveColor = Color3.FromHexString("#ffdab0");
    const disk = MeshBuilder.CreateSphere(
      "sun",
      { diameter: 5, segments: 32 },
      this.scene,
    );
    disk.position.set(-7, 5, -26);
    disk.material = sunset;
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
