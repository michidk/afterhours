import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import type { Scene } from "@babylonjs/core/scene";
import type { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import type { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { environmentAt } from "./environment.ts";

const color = (values: number[]) => new Color3(values[0], values[1], values[2]);
export class EnvironmentLighting {
  windows: StandardMaterial;
  lamps: Vector3[] = [];
  signs: StandardMaterial[] = [];
  private pool: StandardMaterial;
  private sky: ShaderMaterial;
  private skyMesh: Mesh;
  private localLights: PointLight[];
  private selectionClock = 1;
  state = environmentAt(16.5);
  hour = 16.5;
  constructor(
    readonly scene: Scene,
    readonly sun: DirectionalLight,
    readonly ambient: HemisphericLight,
    readonly streetGlow: StandardMaterial,
  ) {
    this.windows = new StandardMaterial("occupied windows", scene);
    this.windows.diffuseColor = Color3.FromHexString("#587c80");
    this.windows.specularColor = Color3.Black();
    this.windows.maxSimultaneousLights = 6;
    this.pool = new StandardMaterial("street light pools", scene);
    this.pool.disableLighting = true;
    this.pool.emissiveColor = Color3.FromHexString("#ffd79b");
    this.pool.alpha = 0;
    this.pool.disableDepthWrite = true;
    const texture = new DynamicTexture(
      "lamp falloff",
      { width: 64, height: 64 },
      scene,
      false,
    );
    const ctx = texture.getContext();
    const gradient = ctx.createRadialGradient(32, 32, 1, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,255,255,0.9)");
    gradient.addColorStop(0.35, "rgba(255,255,255,0.45)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    texture.hasAlpha = true;
    texture.update();
    this.pool.diffuseTexture = texture;
    this.pool.useAlphaFromDiffuseTexture = true;
    this.localLights = Array.from({ length: 4 }, (_, i) => {
      const light = new PointLight(`nearby street lamp ${i}`, Vector3.Zero(), scene);
      light.diffuse = Color3.FromHexString("#ffd098");
      light.specular = Color3.Black();
      light.range = 17;
      light.intensity = 0;
      return light;
    });
    this.sky = new ShaderMaterial(
      "city sky",
      scene,
      {
        vertexSource: `precision highp float;
        attribute vec3 position; uniform mat4 worldViewProjection;
        varying vec3 vDirection;
        void main(){vDirection=position;gl_Position=worldViewProjection*vec4(position,1.0);}`,
        fragmentSource: `precision highp float;
        varying vec3 vDirection; uniform vec3 zenith; uniform vec3 horizon;
        uniform vec3 sunDirection; uniform vec3 sunlight; uniform float daylight; uniform float night;
        float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        void main(){vec3 ray=normalize(vDirection);
          vec3 sky=mix(horizon,zenith,smoothstep(-0.05,0.75,ray.y));
          float sun=smoothstep(0.9990,0.9997,dot(ray,sunDirection));
          float moon=smoothstep(0.9992,0.9997,dot(ray,-sunDirection));
          vec2 stars=floor(ray.xz/(max(0.15,ray.y)+1.0)*450.0);
          float star=step(0.9987,hash(stars))*smoothstep(0.1,0.5,ray.y)*night;
          sky+=sun*sunlight*daylight+moon*vec3(0.65,0.74,0.85)*night+star*0.65;
          gl_FragColor=vec4(sky,1.0);}`,
      },
      {
        attributes: ["position"],
        uniforms: [
          "worldViewProjection",
          "zenith",
          "horizon",
          "sunDirection",
          "sunlight",
          "daylight",
          "night",
        ],
      },
    );
    this.sky.backFaceCulling = false;
    this.sky.disableDepthWrite = true;
    this.skyMesh = MeshBuilder.CreateSphere(
      "sky dome",
      { diameter: 5000, segments: 16 },
      scene,
    );
    this.skyMesh.material = this.sky;
    this.skyMesh.isPickable = false;
    this.skyMesh.infiniteDistance = true;
    this.skyMesh.alwaysSelectAsActiveMesh = true;
    this.update(16.5, Vector3.Zero(), 0);
  }
  addLamp(position: Vector3) {
    this.lamps.push(position);
    const pool = MeshBuilder.CreateGround(
      "street light pool",
      { width: 20, height: 20 },
      this.scene,
    );
    pool.position.set(position.x, 0.27, position.z);
    pool.material = this.pool;
    pool.isPickable = false;
  }
  update(hour: number, focus: Vector3, dt: number) {
    this.hour = hour;
    const state = (this.state = environmentAt(hour));
    this.sun.direction = new Vector3(...state.lightDirection).scale(-1);
    this.sun.position = focus.add(new Vector3(...state.lightDirection).scale(120));
    this.sun.diffuse = color(
      state.daylight > 0.05 ? state.sunlight : [0.63, 0.73, 0.96],
    );
    this.sun.intensity = state.directIntensity;
    this.ambient.diffuse = color(state.ambient);
    this.ambient.groundColor = color(state.ground);
    this.ambient.intensity = state.ambientIntensity;
    const fog = color(state.horizon);
    this.scene.clearColor = new Color4(fog.r, fog.g, fog.b, 1);
    this.scene.fogColor = fog;
    this.scene.fogDensity = state.fogDensity;
    this.streetGlow.emissiveColor = Color3.FromHexString("#ffe0a0").scale(
      state.night * 1.1 + 0.05,
    );
    this.windows.emissiveColor = Color3.FromHexString("#ffd299").scale(
      state.windowGlow,
    );
    this.windows.diffuseColor = Color3.Lerp(
      Color3.FromHexString("#587c80"),
      Color3.FromHexString("#eab982"),
      state.night * 0.65,
    );
    this.pool.alpha = state.night * 0.3;
    for (const sign of this.signs) sign.emissiveColor.setAll(0.13 + state.night * 0.48);
    this.selectionClock += dt;
    if (this.selectionClock >= 0.3) {
      this.selectionClock = 0;
      const nearest = [...this.lamps]
        .sort(
          (a, b) =>
            Math.hypot(a.x - focus.x, a.z - focus.z) -
            Math.hypot(b.x - focus.x, b.z - focus.z),
        )
        .slice(0, 4);
      for (let i = 0; i < this.localLights.length; i++) {
        const position = nearest[i];
        if (position) this.localLights[i].position.copyFrom(position);
      }
    }
    for (const light of this.localLights) light.intensity = state.lampIntensity;
    this.sky.setColor3("zenith", color(state.zenith));
    this.sky.setColor3("horizon", fog);
    this.sky.setVector3("sunDirection", new Vector3(...state.sunDirection));
    this.sky.setColor3("sunlight", color(state.sunlight));
    this.sky.setFloat("daylight", state.daylight);
    this.sky.setFloat("night", state.night);
  }
  get diagnostics() {
    return {
      ...this.state,
      hour: this.hour,
      sun: this.sun.direction.asArray(),
      lampCount: this.lamps.length,
      localLights: this.localLights.length,
    };
  }
}
