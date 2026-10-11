import { buildRoad } from "./models/road.ts";
import { buildBuilding } from "./models/buildings/index.ts";
import "@babylonjs/core/Shaders/default.vertex";
import "@babylonjs/core/Shaders/default.fragment";
import "@babylonjs/core/Shaders/shadowMap.vertex";
import "@babylonjs/core/Shaders/shadowMap.fragment";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import {
  LIMIT,
  random,
  signal,
  type City,
  type Entity,
  type WorldEvent,
} from "../shared/world.ts";
import type { Pickup } from "../shared/protocol.ts";
import { VEHICLES, WEAPONS, TUNING, isWeaponKind } from "../shared/catalog.ts";
import { followCamera } from "./camera/index.ts";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import "@babylonjs/core/Culling/ray";
import { Effects } from "./effects/index.ts";
import { DebugCamera } from "./camera/debug.ts";
import { EnvironmentLighting } from "./lighting/index.ts";
import { idle, type Input } from "../shared/world.ts";
import { RAMP, rampSlope, carGrounded } from "../shared/physics/ramps.ts";
import { rampMesh } from "./models/ramp.ts";
import { TyreTracks } from "./effects/tyre-tracks.ts";
import { CAR_WHEEL_MOUNTS } from "./models/car-wheels.ts";
import type { GeometryOptions } from "./world/render.ts";
import { destructibles } from "../shared/destruction.ts";
import { DestructionRenderer } from "./world/destruction.ts";
import { propulsionRunning } from "../shared/propulsion.ts";
import { buildParachute } from "./models/parachute.ts";
import { buildWeapon } from "./models/weapons.ts";
import { WaterRenderer } from "./world/water.ts";
import { buildWatercraft } from "./models/watercraft.ts";
import { watercraft } from "../shared/water.ts";
import type { GrenadeState } from "../shared/grenades.ts";
export class CityScene {
  pickupNodes = new Map<string, TransformNode>();
  grenadeNodes = new Map<string, TransformNode>();
  private grenades: GrenadeState[] = [];
  private grenadeReceived = 0;
  water: WaterRenderer;
  engine: Engine;
  scene: Scene;
  camera: FreeCamera;
  sun: DirectionalLight;
  ambient: HemisphericLight;
  shadows: ShadowGenerator;
  shadowCandidates: Mesh[] = [];
  shadowTimer = 0;
  city: City;
  nodes = new Map<string, TransformNode>();
  private parts = new Map<string, Mesh[]>();
  materials = new Map<string, StandardMaterial>();
  lights: { mesh: Mesh; axis: "x" | "z" }[] = [];
  streetGlow: StandardMaterial;
  lighting: EnvironmentLighting;
  debugCamera = new DebugCamera();
  destruction: DestructionRenderer;
  effects: Effects;
  private tyreTracks = new TyreTracks();
  effectClock = 0;
  target = new Vector3(4, 0, 12);
  day = 16.5;
  dayRate = 0;
  time = 0;
  constructor(canvas: HTMLCanvasElement, city: City, streamed = false) {
    this.engine = new Engine(canvas, true, {
      stencil: true,
      preserveDrawingBuffer: false,
    });
    this.engine.setHardwareScalingLevel(Math.max(1, devicePixelRatio / 1.6));
    this.scene = new Scene(this.engine);
    this.scene.skipPointerMovePicking = true;
    this.scene.skipPointerDownPicking = true;
    this.scene.skipPointerUpPicking = true;
    this.scene.clearColor = Color4.FromHexString("#b8d0cfff");
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = 0.003;
    this.scene.fogColor = Color3.FromHexString("#b8d0cf");
    this.camera = new FreeCamera("camera", new Vector3(15, 68, -47), this.scene);
    this.camera.fov = 0.72;
    this.camera.minZ = 0.5;
    this.camera.maxZ = 3200;
    this.camera.setTarget(this.target);
    this.ambient = new HemisphericLight("sky", new Vector3(0, 1, 0), this.scene);
    this.ambient.intensity = 0.7;
    this.ambient.groundColor = Color3.FromHexString("#617c7b");
    this.sun = new DirectionalLight("sun", new Vector3(-0.65, -1, 0.4), this.scene);
    this.sun.position = new Vector3(65, 100, -45);
    this.sun.intensity = 1.9;
    this.sun.diffuse = Color3.FromHexString("#ffe4b9");
    this.shadows = new ShadowGenerator(1024, this.sun);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.bias = 0.002;
    this.shadows.normalBias = 0.03;
    this.sun.shadowMinZ = 1;
    this.sun.shadowMaxZ = 220;
    this.streetGlow = this.mat("#ffe5a1", true);
    this.lighting = new EnvironmentLighting(
      this.scene,
      this.sun,
      this.ambient,
      this.streetGlow,
    );
    this.city = city;
    this.destruction = new DestructionRenderer(this);
    this.build(this.city, { roads: !streamed, airport: !streamed });
    this.batchStatic();
    this.water = new WaterRenderer(this);
    if (!streamed) this.destruction.syncStatic(destructibles(city));
    this.effects = new Effects(
      this.scene,
      (color, glow) => this.mat(color, glow),
      this.city,
    );
    this.shadowCandidates = [
      ...(this.shadows.getShadowMap()?.renderList || []),
    ] as Mesh[];
    window.addEventListener("resize", () => this.engine.resize());
  }
  mat(color: string, glow = false) {
    const key = color + glow;
    if (this.materials.has(key)) return this.materials.get(key)!;
    const m = new StandardMaterial(key, this.scene);
    m.diffuseColor = Color3.FromHexString(color);
    m.specularColor = new Color3(0.08, 0.08, 0.08);
    m.maxSimultaneousLights = 6;
    if (glow) m.emissiveColor = m.diffuseColor.scale(0.8);
    this.materials.set(key, m);
    return m;
  }
  box(
    name: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: string,
    parent?: TransformNode,
    shadow = false,
  ) {
    const m = MeshBuilder.CreateBox(
      name,
      { width: w, height: h, depth: d },
      this.scene,
    );
    m.position.set(x, y, z);
    m.material = this.mat(color);
    if (parent) m.parent = parent;
    m.receiveShadows = true;
    if (shadow) this.shadows.addShadowCaster(m);
    return m;
  }
  cylinder(
    name: string,
    x: number,
    y: number,
    z: number,
    height: number,
    diameter: number,
    color: string,
    parent?: TransformNode,
  ) {
    const m = MeshBuilder.CreateCylinder(
      name,
      { height, diameter, tessellation: 8 },
      this.scene,
    );
    m.position.set(x, y, z);
    m.material = this.mat(color);
    if (parent) m.parent = parent;
    this.shadows.addShadowCaster(m);
    return m;
  }
  sign(text: string, x: number, y: number, z: number, color: string, width = 9) {
    const texture = new DynamicTexture(
      "sign",
      { width: 512, height: 128 },
      this.scene,
      false,
    );
    texture.drawText(text, null, 91, "bold 66px sans-serif", "#fff5db", color, true);
    const m = new StandardMaterial("lettering", this.scene);
    m.diffuseTexture = texture;
    m.emissiveColor = new Color3(0.14, 0.14, 0.14);
    m.specularColor = Color3.Black();
    m.maxSimultaneousLights = 6;
    this.lighting.signs.push(m);
    const mesh = MeshBuilder.CreatePlane(
      "shop sign",
      { width, height: width / 4, sideOrientation: Mesh.DOUBLESIDE },
      this.scene,
    );
    mesh.position.set(x, y, z);
    mesh.material = m;
    return mesh;
  }
  palm(x: number, z: number, h: number) {
    this.cylinder("palm trunk", x, h / 2, z, h, 0.38, "#88775b");
    for (let j = 0; j < 7; j++) {
      const a = (j * Math.PI * 2) / 7;
      const leaf = MeshBuilder.CreateSphere(
        "palm frond",
        { diameter: 1, segments: 3 },
        this.scene,
      );
      leaf.scaling.set(1.1, 0.25, 4.1);
      leaf.position.set(x + Math.sin(a) * 1.9, h - 0.2, z + Math.cos(a) * 1.9);
      leaf.rotation.set(-0.22, a, 0);
      leaf.material = this.mat(j % 2 ? "#53784a" : "#72944e");
      this.shadows.addShadowCaster(leaf);
    }
  }
  build(city: City, options: GeometryOptions = {}) {
    const r = random(city.seed + (options.index ?? 0) * 997);
    if (options.base !== false) {
      this.box("island", 0, -0.65, 0, LIMIT * 2, 1, LIMIT * 2, "#a9b29a");
      this.box("ocean", 0, -1.2, 0, 6000, 0.2, 6000, "#669f9f");
      for (const side of [-1, 1]) {
        this.box(
          "coastal walk",
          0,
          0.03,
          side * (LIMIT - 7),
          LIMIT * 2 - 4,
          0.12,
          10,
          "#d1c3a5",
        );
        this.box(
          "coastal walk",
          side * (LIMIT - 7),
          0.03,
          0,
          10,
          0.12,
          LIMIT * 2 - 4,
          "#d1c3a5",
        );
        this.box(
          "sand shoreline",
          0,
          -0.12,
          side * (LIMIT - 2),
          LIMIT * 2,
          0.12,
          4,
          "#ddcda6",
        );
        this.box(
          "sand shoreline",
          side * (LIMIT - 2),
          -0.12,
          0,
          4,
          0.12,
          LIMIT * 2,
          "#ddcda6",
        );
      }
      this.box(
        "sunset beach sand",
        -LIMIT + 24,
        -0.02,
        0,
        38,
        0.12,
        LIMIT * 2 - 8,
        "#ddcda6",
      );
    }
    for (const surface of city.surfaces || []) {
      const colors = {
        plaza: "#c3b89f",
        parking: "#79817a",
        service: "#686e68",
        court: "#a1ad8b",
        quay: "#94978b",
      };
      const elevation =
        surface.kind === "parking" || surface.kind === "service" ? 0.12 : 0.04;
      this.box(
        surface.kind,
        surface.x,
        elevation,
        surface.z,
        surface.w,
        0.06,
        surface.d,
        colors[surface.kind],
      );
      if (surface.kind === "parking")
        for (let dx = -surface.w / 2 + 3; dx < surface.w / 2; dx += 3)
          this.box(
            "parking bay",
            surface.x + dx,
            0.16,
            surface.z,
            0.12,
            0.025,
            surface.d - 1,
            "#ddd3b5",
          );
      if (surface.kind === "service") {
        const alongX = surface.w > surface.d;
        const length = alongX ? surface.w : surface.d;
        for (let t = -length / 2 + 5; t < length / 2; t += 9)
          this.box(
            "service lane dash",
            surface.x + (alongX ? t : 0),
            0.16,
            surface.z + (alongX ? 0 : t),
            alongX ? 3 : 0.12,
            0.025,
            alongX ? 0.12 : 3,
            "#c5bc9f",
          );
      }
    }
    if (options.airport !== false) {
      const a = city.airport;
      this.box("airfield apron", a.x, 0.03, a.z, a.w, 0.06, a.d, "#a3ab9b");
      this.box("runway", a.x, 0.08, a.z, 22, 0.06, a.d - 8, "#4d585a");
      for (let i = -a.d / 2 + 12; i <= a.d / 2 - 12; i += 10)
        this.box("runway markings", a.x, 0.13, a.z + i, 0.4, 0.04, 3, "#f4e7c3");
      for (const side of [-1, 1])
        for (let i = -a.d / 2 + 8; i <= a.d / 2 - 8; i += 12)
          this.cylinder(
            "runway light",
            a.x + side * 11,
            0.2,
            a.z + i,
            0.12,
            0.25,
            "#f1ca6a",
          ).material = this.streetGlow;
    }
    for (const landmark of city.landmarks)
      this.sign(landmark.name, landmark.x, 5, landmark.z - 13, "#467b72", 12);
    if (options.roads !== false) for (const road of city.roads) buildRoad(this, road);
    city.buildings.forEach((b, i) => buildBuilding(this, b, options.index ?? i, r));
    for (const p of city.parks) {
      const pw = p.w ?? 38,
        pd = p.d ?? 38;
      this.box(
        "park",
        p.x,
        0.24,
        p.z,
        pw,
        0.3,
        pd,
        p.kind === "civic" ? "#c7bda6" : p.kind === "woodland" ? "#7e946d" : "#82936c",
      );

      this.box("park path", p.x, 0.42, p.z, 3, 0.1, pd, "#c9baa0");
      this.box("cross path", p.x, 0.42, p.z, pw, 0.1, 3, "#c9baa0");
      if (p.kind === "woodland") continue;
      this.cylinder("fountain", p.x, 1, p.z, 1.2, 7, "#c4c4b0");
      this.cylinder("fountain water", p.x, 1.65, p.z, 0.1, 5.8, "#71bdbe");
    }
    for (const ramp of city.ramps) {
      const m = rampMesh(this.scene, ramp.x, ramp.z);
      m.material = this.mat("#b59263");
      m.receiveShadows = true;
      this.shadows.addShadowCaster(m);
      for (let i = -1; i <= 1; i++)
        this.box(
          "ramp stripe",
          ramp.x + i * 1.4,
          0.3 + RAMP.height / 2 + 0.02,
          ramp.z,
          0.3,
          0.025,
          Math.hypot(RAMP.length, RAMP.height) - 0.2,
          "#eac66d",
        ).rotation.x = -Math.atan(rampSlope);
    }
  }
  aimPoint(x: number, y: number) {
    const ray = this.scene.createPickingRay(x, y, null, this.camera);
    const distance = ray.intersectsPlane(new Plane(0, 1, 0, -0.3));
    return distance === null
      ? undefined
      : ray.origin.add(ray.direction.scale(distance));
  }
  updatePickups(items: Pickup[]) {
    const ids = new Set(items.map((e) => e.id));
    for (const [id, n] of this.pickupNodes)
      if (!ids.has(id)) {
        n.dispose();
        this.pickupNodes.delete(id);
      }
    for (const item of items)
      if (!this.pickupNodes.has(item.id)) {
        const root = new TransformNode(item.id, this.scene);
        root.position.set(item.x, item.y, item.z);
        const pad = this.cylinder("pickup", 0, 0.2, 0, 0.15, 1.6, "#e4bc65", root);
        pad.material = this.mat("#e4bc65", true);
        if (item.kind === "weapon") buildWeapon(this, root, item.item.kind);
        else if (item.kind === "ammo") {
          this.box("ammo crate", 0, 0.65, 0, 0.7, 0.45, 0.6, "#64794b", root);
          this.box("ammo stripe", 0, 0.65, 0.31, 0.45, 0.1, 0.02, "#e4bc65", root);
        } else {
          for (const x of [-0.23, 0.23])
            this.cylinder("jetpack supply", x, 0.8, 0, 0.8, 0.32, "#73858c", root);
        }
        this.pickupNodes.set(item.id, root);
      }
  }
  updateGrenades(items: GrenadeState[]) {
    this.grenades = items;
    this.grenadeReceived = performance.now();
    const ids = new Set(items.map((g) => g.id));
    for (const [id, node] of this.grenadeNodes)
      if (!ids.has(id)) {
        node.dispose();
        this.grenadeNodes.delete(id);
      }
    for (const g of items)
      if (!this.grenadeNodes.has(g.id)) {
        const root = new TransformNode(g.id, this.scene);
        const mesh = MeshBuilder.CreateSphere(
          "thrown grenade",
          { diameter: g.radius * 2, segments: 6 },
          this.scene,
        );
        mesh.parent = root;
        mesh.material = this.mat("#64794b");
        this.grenadeNodes.set(g.id, root);
      }
  }
  batchStatic(meshes = this.scene.meshes) {
    const dynamic = new Set(this.lights.map((l) => l.mesh));
    const groups = new Map<string, Mesh[]>();
    const casters = new Set(this.shadows.getShadowMap()?.renderList || []);
    for (const mesh of [...meshes]) {
      if (
        !(mesh instanceof Mesh) ||
        dynamic.has(mesh) ||
        !mesh.material ||
        mesh.name === "sky dome" ||
        mesh.name === "animated water"
      )
        continue;
      const key =
        mesh.material.uniqueId +
        ":" +
        Math.floor(mesh.position.x / 64) +
        ":" +
        Math.floor(mesh.position.z / 64) +
        ":" +
        casters.has(mesh);
      const group = groups.get(key) || [];
      group.push(mesh);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const cast = casters.has(group[0]);
      for (const mesh of group) this.shadows.removeShadowCaster(mesh);
      const merged = Mesh.MergeMeshes(group, true, true, undefined, false, false);
      if (merged) {
        merged.receiveShadows = true;
        merged.freezeWorldMatrix();
        if (cast) this.shadows.addShadowCaster(merged);
      }
    }
  }
  makeEntity(e: Entity) {
    const root = new TransformNode(e.id, this.scene);
    const human = e.kind === "player" || e.kind === "pedestrian";
    if (human) {
      this.cylinder("body", 0, 1, 0, 0.8, 0.65, e.color, root);
      this.cylinder("head", 0, 1.65, 0, 0.4, 0.4, "#c79e7b", root);
      this.box("hair", 0, 1.87, 0, 0.43, 0.14, 0.4, "#473e35", root);
      for (const s of [-1, 1]) {
        this.box("leg", s * 0.17, 0.35, 0, 0.23, 0.65, 0.25, "#354955", root, true);
        this.box("shoe", s * 0.17, 0.06, 0.08, 0.25, 0.15, 0.4, "#e7e3d2", root);
        this.box("arm", s * 0.42, 1, 0, 0.18, 0.65, 0.22, e.color, root, true);
      }
      if (e.kind === "player") {
        buildParachute(this, root);
        for (const side of [-1, 1]) {
          this.cylinder(
            "jetpack tank",
            side * 0.23,
            1.1,
            -0.38,
            0.8,
            0.28,
            "#73858c",
            root,
          ).setEnabled(false);
          this.cylinder(
            "jetpack nozzle",
            side * 0.23,
            0.65,
            -0.38,
            0.16,
            0.19,
            "#263237",
            root,
          ).setEnabled(false);
          const flame = this.cylinder(
            "jetpack exhaust",
            side * 0.23,
            0.37,
            -0.38,
            0.5,
            0.13,
            "#ffb544",
            root,
          );
          flame.material = this.mat("#ffb544", true);
          flame.setEnabled(false);
        }
        for (const kind of Object.keys(WEAPONS))
          if (isWeaponKind(kind)) buildWeapon(this, root, kind, true);
        for (const child of root.getChildMeshes())
          if (child.name.startsWith("held:")) child.setEnabled(false);

        const ring = MeshBuilder.CreateTorus(
          "player ring",
          { diameter: 1.35, thickness: 0.055, tessellation: 24 },
          this.scene,
        );
        ring.position.y = 0.04;
        ring.material = this.mat("#f0c977", true);
        ring.parent = root;
        ring.renderingGroupId = 1;
      }
    } else if (e.kind === "car") {
      this.box("chassis", 0, 0.55, 0, 1.95, 0.6, 4.3, e.color, root, true);
      this.box("hood", 0, 0.93, 1.35, 1.85, 0.22, 1.4, e.color, root, true);
      this.box("glass", 0, 1.15, -0.2, 1.62, 0.7, 1.9, "#304a52", root, true);
      this.box("roof", 0, 1.56, -0.3, 1.66, 0.16, 1.2, e.color, root, true);
      this.box("rear", 0, 0.91, -1.6, 1.88, 0.25, 1, e.color, root);
      for (const mount of CAR_WHEEL_MOUNTS) {
        const wheel = this.cylinder(
          "wheel",
          mount.x,
          0.48,
          mount.z,
          0.25,
          0.76,
          "#273334",
          root,
        );
        wheel.rotation.z = Math.PI / 2;
      }
      for (const side of [-1, 1]) {
        this.box(
          "headlight",
          side * 0.65,
          0.72,
          2.16,
          0.45,
          0.23,
          0.06,
          "#fff1b5",
          root,
        ).material = this.streetGlow;
        this.box(
          "taillight",
          side * 0.68,
          0.74,
          -2.16,
          0.4,
          0.18,
          0.06,
          "#c95343",
          root,
        );
        this.box("pillar", side * 0.81, 1.2, -0.25, 0.1, 0.7, 0.15, e.color, root);
      }
      this.box("bumper", 0, 0.4, 2.2, 1.85, 0.17, 0.1, "#c5c8bd", root);
    } else if (e.kind === "helicopter") {
      const body = MeshBuilder.CreateSphere(
        "fuselage",
        { diameter: 2, segments: 8 },
        this.scene,
      );
      body.scaling.set(1, 0.9, 1.7);
      body.position.y = 1.4;
      body.parent = root;
      body.material = this.mat(e.color);
      this.shadows.addShadowCaster(body);
      this.box("cockpit", 0, 1.65, 1.1, 1.4, 0.8, 1.1, "#35555e", root);
      this.box("tail", 0, 1.4, -3, 0.35, 0.35, 4, e.color, root, true);
      this.box("tail fin", 0, 2, -4.5, 0.2, 1.4, 1, e.color, root);
      this.box("rotor", 0, 2.7, 0, 9, 0.1, 0.3, "#334343", root, true);
      this.box("rotor cross", 0, 2.71, 0, 0.3, 0.1, 9, "#334343", root, true);
      for (const side of [-1, 1])
        this.box("skid", side * 1, 0.3, 0, 0.16, 0.2, 3.8, "#364449", root);
    } else if (watercraft(e.kind)) {
      buildWatercraft(this, e, root);
    } else if (e.kind === "plane") {
      this.box("fuselage", 0, 1, 0, 1.3, 1, 7, e.color, root, true);
      this.box("cockpit", 0, 1.6, 1, 1, 0.45, 1.5, "#35555e", root);
      this.box("wings", 0, 1, 0.2, 10, 0.18, 1.8, e.color, root, true);
      this.box("tail wings", 0, 1, -2.8, 4, 0.18, 1, e.color, root);
      this.box("tail fin", 0, 1.8, -2.8, 0.18, 1.5, 1, e.color, root);
      this.box("propeller", 0, 1, 3.6, 3, 0.15, 0.1, "#334343", root);
      const model = VEHICLES[e.model || "plane"];
      root.scaling.set(model.width / 10, 1, model.length / 7);
    }
    if (e.kind === "car") {
      const model = VEHICLES[e.model || "sedan"];
      root.scaling.set(
        model.width / 2,
        e.model === "van" ? 1.35 : e.model === "sport" ? 0.8 : 1,
        model.length / 4.3,
      );
      if (e.model === "van")
        this.box("cargo", 0, 1.5, -0.6, 1.9, 1.5, 2.8, e.color, root, true);
      if (e.model === "sport")
        this.box("spoiler", 0, 1.1, -1.85, 2, 0.13, 0.4, "#26363b", root, true);
    }
    if (e.model === "utility") {
      root.scaling.set(1.2, 1.15, 1.18);
      this.box("cargo cabin", 0, 1.3, -0.5, 2, 1.5, 2.4, e.color, root, true);
    }
    root.position.set(e.x, e.y + 0.3, e.z);
    this.nodes.set(e.id, root);
    const parts = root.getChildMeshes() as Mesh[];
    this.parts.set(e.id, parts);
    this.shadowCandidates.push(...parts);
    return root;
  }
  update(
    entities: Entity[],
    me: string | undefined,
    dt: number,
    input: Input = idle(),
  ) {
    this.day = (this.day + this.dayRate * dt) % 24;
    this.water.update(this.time, dt);
    const extrapolation = Math.min(
      TUNING.snapshot,
      Math.max(0, (performance.now() - this.grenadeReceived) / 1000),
    );
    for (const g of this.grenades) {
      const node = this.grenadeNodes.get(g.id);
      node?.position.set(
        g.x + g.vx * extrapolation,
        g.y + g.vy * extrapolation,
        g.z + g.vz * extrapolation,
      );
    }
    const ids = new Set(entities.map((e) => e.id));
    for (const [id, n] of this.nodes)
      if (!ids.has(id)) {
        n.dispose();
        this.nodes.delete(id);
        this.parts.delete(id);
      }
    for (const e of entities) {
      const n = this.nodes.get(e.id) || this.makeEntity(e);
      n.setEnabled(
        !e.vehicle &&
          (e.health > 0 || e.wreck !== undefined) &&
          Math.hypot(e.x - this.target.x, e.z - this.target.z) < 95,
      );
      // Networking already provides a continuous pose. Smoothing it a second
      // time adds delay and makes turns trail behind authoritative traffic.
      n.position.set(e.x, e.y + 0.3, e.z);
      n.rotation.y = e.angle;
      n.rotation.z = e.down ? Math.PI / 2 : 0;
      n.rotation.x = 0;
      if (e.kind === "car" && e.y > 0.03 && carGrounded(e, this.city)) {
        n.rotation.x = -Math.atan(rampSlope * Math.cos(e.angle));
        n.rotation.z = Math.atan(rampSlope * Math.sin(e.angle));
      }
      const parts = this.parts.get(e.id)!;
      for (const child of parts)
        if (child.name.startsWith("held:"))
          child.setEnabled(!e.parachute && child.name === "held:" + e.weapon);
        else if (child.name.startsWith("parachute")) child.setEnabled(!!e.parachute);
        else if (child.name.startsWith("jetpack"))
          child.setEnabled(
            !!e.jetpack &&
              !e.parachute &&
              (child.name !== "jetpack exhaust" ||
                (!!e.jetpack.active && e.jetpack.fuel > 0 && e.vy > 0.1)),
          );

      for (const child of parts) {
        child.visibility =
          e.wreck === undefined
            ? 1
            : Math.max(0, Math.min(1, e.wreck / TUNING.debrisFadeSeconds));
        if (e.wreck) child.material = this.mat("#30312e");
        if (child.name === "wheel" && child.position.z > 0)
          child.rotation.y = e.steering || 0;
      }
      if (e.kind === "helicopter") {
        n.rotation.z +=
          (Math.sin(n.rotation.y) * e.vz - Math.cos(n.rotation.y) * e.vx) * 0.012;
        n.rotation.x = Math.min(0.18, Math.hypot(e.vx, e.vz) * 0.012);
        for (const child of parts)
          if (child.name.startsWith("rotor"))
            child.rotation.y +=
              dt *
              (propulsionRunning(e) ? 38 : e.flight === "falling" && !e.wreck ? 8 : 0);
      }
      if (e.kind === "plane") {
        n.rotation.z = -(e.angularVelocity || 0) * 0.2;
        n.rotation.x = -Math.max(-0.2, Math.min(0.2, e.vy * 0.03));
        for (const child of parts)
          if (child.name === "propeller")
            child.rotation.z += dt * (propulsionRunning(e) ? 60 : 0);
      }
      if (watercraft(e.kind)) {
        n.rotation.x = Math.sin(this.time * 2 + e.x * 0.1) * 0.025;
        n.rotation.z =
          -(e.angularVelocity || 0) * 0.12 +
          Math.sin(this.time * 1.5 + e.z * 0.1) * 0.025;
        for (const child of parts) {
          if (child.name.startsWith("AI skipper")) child.setEnabled(!!e.ai);
          if (child.name === "water propeller")
            child.rotation.z += propulsionRunning(e) ? dt * 60 : 0;
        }
      }
      if (e.kind === "player" || e.kind === "pedestrian") {
        if (e.parachute) {
          n.rotation.x = -e.vz * 0.025;
          n.rotation.z += e.vx * 0.025;
        }
        for (const child of parts)
          if (child.name === "leg")
            child.rotation.x =
              (e.parachute
                ? 0
                : Math.sin(this.time * 12 + (child.position.x > 0 ? 0 : Math.PI))) *
              Math.min(0.6, Math.hypot(e.vx, e.vz) * 0.1);
      }
    }
    this.effectClock += dt;
    if (this.effectClock > 0.12) {
      this.effectClock = 0;
      for (const e of entities) {
        if (Math.hypot(e.x - this.target.x, e.z - this.target.z) > 90) continue;
        if (watercraft(e.kind) && Math.hypot(e.vx, e.vz) > 2 && !e.wreck) {
          this.effect({
            kind: "wake",
            x: e.x - Math.sin(e.angle) * 3,
            y: e.y,
            z: e.z - Math.cos(e.angle) * 3,
          });
        }
        if (e.burning !== undefined) {
          this.effect({
            kind: "fire",
            x: e.x + (Math.random() - 0.5) * 1.5,
            y: e.y + 0.6,
            z: e.z + (Math.random() - 0.5) * 2,
          });
          this.effect({ kind: "blackSmoke", x: e.x, y: e.y + 1.5, z: e.z });
        } else if (
          e.health < (e.maxHealth || 100) * 0.55 &&
          !e.wreck &&
          e.kind === "car"
        )
          this.effect({ kind: "blackSmoke", x: e.x, y: e.y + 1, z: e.z });
      }
    }
    this.tyreTracks.sample(
      entities.filter((e) => Math.hypot(e.x - this.target.x, e.z - this.target.z) < 95),
      (mark) => this.effects.trails.add(mark),
    );
    this.effects.update(dt, this.target);
    this.destruction.update();
    const p = entities.find((e) => e.id === me);
    if (p && !this.debugCamera.active) {
      const n = this.nodes.get(p.vehicle || p.id);
      if (n) this.target = Vector3.Lerp(this.target, n.position, 1 - Math.exp(-dt * 5));
    }
    const body = entities.find((e) => e.id === p?.vehicle) || p;
    if (this.debugCamera.active) {
      this.debugCamera.update(input, dt);
      const position = this.debugCamera.position,
        target = this.debugCamera.target;
      this.camera.position.set(position.x, position.y, position.z);
      this.camera.setTarget(new Vector3(target.x, target.y, target.z));
      this.camera.fov = this.debugCamera.fov;
      this.camera.minZ =
        this.debugCamera.mode === "free"
          ? Math.max(0.05, Math.min(2, this.debugCamera.distance * 0.002))
          : Math.max(0.05, Math.min(1, position.y / 100));
      this.camera.maxZ = Math.max(
        LIMIT * 4,
        Math.hypot(
          position.x - target.x,
          position.y - target.y,
          position.z - target.z,
        ) + 650,
      );
      this.target = new Vector3(
        target.x,
        this.debugCamera.mode === "free" ? target.y : 0,
        target.z,
      );
    } else {
      this.camera.fov = 0.72;
      this.camera.minZ = 0.5;
      this.camera.maxZ = 650;
      followCamera(
        this.camera,
        this.target,
        p?.y || 0,
        Math.hypot(body?.vx || 0, body?.vz || 0),
        dt,
      );
    }
    this.shadowTimer += dt;
    if (this.shadowTimer > 0.3) {
      this.shadowTimer = 0;
      this.shadowCandidates = this.shadowCandidates.filter((m) => !m.isDisposed());
      const shadowMap = this.shadows.getShadowMap();
      if (shadowMap)
        shadowMap.renderList = this.shadowCandidates.filter((m) => {
          const c = m.getBoundingInfo().boundingSphere.centerWorld;
          return (
            m.isEnabled() && Math.hypot(c.x - this.target.x, c.z - this.target.z) < 70
          );
        });
    }
    this.lighting.update(this.day, this.target, dt);
    if (this.debugCamera.mode === "free")
      this.scene.fogDensity /= Math.max(1, this.debugCamera.distance / 53);
    for (const l of this.lights)
      l.mesh.material = this.mat(
        signal(this.time, l.axis) === "green"
          ? "#85dca0"
          : signal(this.time, l.axis) === "amber"
            ? "#efbc5d"
            : "#e36353",
        true,
      );
  }
  effect(e: WorldEvent) {
    this.effects.effect(e);
  }
}
