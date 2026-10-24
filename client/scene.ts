import { airportsOf } from "../shared/world.ts";
import { SceneryCulling } from "./world/culling.ts";
import { buildInlandWater, buildTerrain } from "./world/terrain.ts";
import { buildHeadlightCones, CarLights } from "./models/car-lights.ts";
import { buildCharacter, poseCharacter, poseSwimmer } from "./models/character.ts";
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
  spawnOrigin,
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
import { EnvironmentLighting, SCENE_LIGHT_COUNT } from "./lighting/index.ts";
import { idle, type Input } from "../shared/world.ts";
import { rampHeight, carGrounded } from "../shared/physics/ramps.ts";
import { CarSuspension, groundAttitude } from "./world/car-suspension.ts";
import { BlobShadows } from "./world/blob-shadows.ts";

/** Wheel centre height in a car model's local frame. */
const WHEEL_HEIGHT = 0.48;
/** How far a wheel moves up or down from its rest position on the body (m). */
const WHEEL_TRAVEL = 0.25;
import { rampMesh } from "./models/ramp.ts";
import { TyreTracks } from "./effects/tyre-tracks.ts";
import { terrainHeight } from "../shared/terrain.ts";
import { CAR_WHEEL_MOUNTS } from "./models/car-wheels.ts";
import type { GeometryOptions } from "./world/render.ts";
import { destructibles } from "../shared/destruction.ts";
import { DestructionRenderer } from "./world/destruction.ts";
import { propulsionRunning } from "../shared/propulsion.ts";
import { buildParachute } from "./models/parachute.ts";
import { buildWeapon } from "./models/weapons.ts";
import { WaterRenderer } from "./world/water.ts";
import { buildWatercraft } from "./models/watercraft.ts";
import {
  groundLevel,
  isWater,
  setWaveTime,
  surfaceLevel,
  surfaceSlope,
  watercraft,
} from "../shared/water.ts";
import type { GrenadeState } from "../shared/grenades.ts";
import type { MeshGroup } from "../shared/city-mesh.ts";
import { uploadMeshes } from "./world/mesh-buffers.ts";
/**
 * Whether an entity's own model is drawn. Seated riders are part of their vehicle
 * and a dead character is drawn as corpse debris instead; a vehicle stays in view
 * while it burns at zero health and after it explodes into a wreck.
 */
export function drawnBody(e: Entity) {
  return (
    !e.vehicle &&
    (e.health > 0 ||
      e.wreck !== undefined ||
      (e.kind !== "player" && e.kind !== "pedestrian"))
  );
}
export class CityScene {
  pickupNodes = new Map<string, TransformNode>();
  grenadeNodes = new Map<string, TransformNode>();
  private grenades: GrenadeState[] = [];
  private grenadeReceived = 0;
  water: WaterRenderer;
  engine: Engine;
  scene: Scene;
  readonly culling: SceneryCulling;
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
  private carLights: CarLights;
  debugCamera = new DebugCamera();
  destruction: DestructionRenderer;
  effects: Effects;
  private tyreTracks = new TyreTracks((x, z) => terrainHeight(x, z, this.city));
  private suspension = new CarSuspension();
  private blobShadows?: BlobShadows;
  /** What a vehicle stands on: terrain, still water and ramps. */
  private vehicleFloor = (x: number, z: number) =>
    this.city ? rampHeight(x, z, this.city) : 0;
  /** Wall-clock start of recent hit flinches and melee swings, keyed by entity. */
  private flinches = new Map<string, { at: number; angle: number }>();
  private swings = new Map<string, number>();
  effectClock = 0;
  target = new Vector3(4, 0, 12);
  day = 16.5;
  dayRate = 0;
  time = 0;
  staticFixtures = new Map<string, MeshGroup>();
  savedGeometry = false;
  constructor(
    canvas: HTMLCanvasElement,
    city: City,
    streamed = false,
    base?: MeshGroup,
  ) {
    this.engine = new Engine(canvas, true, {
      stencil: true,
      preserveDrawingBuffer: false,
    });
    this.engine.setHardwareScalingLevel(Math.max(1, devicePixelRatio / 1.6));
    this.scene = new Scene(this.engine);
    this.culling = new SceneryCulling(this.scene);
    this.carLights = new CarLights(this.scene);
    this.scene.skipPointerMovePicking = true;
    this.scene.skipPointerDownPicking = true;
    this.scene.skipPointerUpPicking = true;
    this.scene.clearColor = Color4.FromHexString("#b8d0cfff");
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = 0.003;
    this.scene.fogColor = Color3.FromHexString("#b8d0cf");
    const spawn = spawnOrigin(city);
    this.target.set(spawn.x, groundLevel(spawn.x, spawn.z, city), spawn.z);
    this.camera = new FreeCamera(
      "camera",
      this.target.add(new Vector3(0, 46, -26)),
      this.scene,
    );
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
    // Refreshing a large PCF map every frame stalls low-end and software renderers.
    // The scene moves only a little between updates, so reuse it for two frames.
    const shadowMap = this.shadows.getShadowMap();
    if (shadowMap) {
      shadowMap.refreshRate = 2;
      shadowMap.getSize().width > 512 && this.shadows.getShadowMap()?.resize(512);
      // Do not render the whole city into the first shadow pass. The nearby list is
      // populated by update() once the camera has a settled target.
      shadowMap.renderList = [];
    }
    this.streetGlow = this.mat("#ffe5a1", true);
    this.lighting = new EnvironmentLighting(
      this.scene,
      this.sun,
      this.ambient,
      this.streetGlow,
    );
    this.city = city;
    this.destruction = new DestructionRenderer(this);
    this.savedGeometry = !!base;
    if (base) {
      for (const mesh of uploadMeshes(this, base)) this.culling.add(mesh);
    } else {
      this.build(this.city, { roads: !streamed, airport: !streamed });
      this.batchStatic();
    }
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
    m.maxSimultaneousLights = SCENE_LIGHT_COUNT;
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
    m.maxSimultaneousLights = SCENE_LIGHT_COUNT;
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
  /** Ground altitude under a feature; the authored map is flat at zero downtown. */
  groundAt(x: number, z: number) {
    return this.city?.terrain ? groundLevel(x, z, this.city) : 0;
  }
  build(city: City, options: GeometryOptions = {}) {
    const r = random(city.seed + (options.index ?? 0) * 997);
    const ground = (x: number, z: number) =>
      city.terrain ? groundLevel(x, z, city) : 0;
    if (options.base !== false) {
      if (city.terrain) buildTerrain(this, city.terrain);
      if (city.water) buildInlandWater(this, city.water);
      else this.box("island", 0, -0.65, 0, LIMIT * 2, 1, LIMIT * 2, "#a9b29a");
    }
    for (const surface of city.surfaces || []) {
      const colors = {
        plaza: "#c3b89f",
        parking: "#79817a",
        service: "#686e68",
        court: "#a1ad8b",
        quay: "#94978b",
      };
      const surfaceGround = ground(surface.x, surface.z);
      const elevation =
        surface.kind === "parking" || surface.kind === "service" ? 0.12 : 0.04;
      this.box(
        surface.kind,
        surface.x,
        surfaceGround + elevation,
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
            surfaceGround + 0.16,
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
            surfaceGround + 0.16,
            surface.z + (alongX ? 0 : t),
            alongX ? 3 : 0.12,
            0.025,
            alongX ? 0.12 : 3,
            "#c5bc9f",
          );
      }
    }
    if (options.airport !== false)
      for (const a of airportsOf(city)) {
        const ay = ground(a.x, a.z);
        this.box("airfield apron", a.x, ay + 0.03, a.z, a.w, 0.06, a.d, "#a3ab9b");
        this.box("runway", a.x, ay + 0.08, a.z, 22, 0.06, a.d - 8, "#4d585a");
        for (let i = -a.d / 2 + 12; i <= a.d / 2 - 12; i += 10)
          this.box("runway markings", a.x, ay + 0.13, a.z + i, 0.4, 0.04, 3, "#f4e7c3");
        for (const side of [-1, 1]) {
          this.box(
            "runway edge stripe",
            a.x + side * 10,
            ay + 0.13,
            a.z,
            0.2,
            0.04,
            a.d - 16,
            "#f4e7c3",
          );
          for (const dx of [-7, -4, 4, 7])
            this.box(
              "runway threshold",
              a.x + dx,
              ay + 0.13,
              a.z + side * (a.d / 2 - 16),
              1.2,
              0.04,
              8,
              "#f4e7c3",
            );
        }
        for (const side of [-1, 1])
          for (let i = -a.d / 2 + 8; i <= a.d / 2 - 8; i += 12)
            this.cylinder(
              "runway light",
              a.x + side * 11,
              ay + 0.2,
              a.z + i,
              0.12,
              0.25,
              "#f1ca6a",
            ).material = this.streetGlow;
      }
    for (const landmark of city.landmarks) {
      const z = landmark.z - 13;
      const y = ground(landmark.x, z) + 5;
      this.sign(landmark.name, landmark.x, y, z, "#467b72", 12);
      for (const side of [-1, 1]) {
        const x = landmark.x + side * 5;
        const foot = ground(x, z);
        const top = y + 1.5;
        this.box(
          "landmark sign post",
          x,
          (foot + top) / 2,
          z + 0.12,
          0.22,
          top - foot,
          0.22,
          "#46534d",
        );
      }
    }
    // Generated cities stream street polygons per chunk instead (client/world/render.ts).
    if (options.roads !== false) for (const road of city.roads) buildRoad(this, road);
    city.buildings.forEach((b, i) => buildBuilding(this, b, options.index ?? i, r));
    for (const p of city.parks) {
      const pw = p.w ?? 38,
        pd = p.d ?? 38;
      const py = ground(p.x, p.z);
      this.box(
        "park",
        p.x,
        py + 0.24,
        p.z,
        pw,
        0.3,
        pd,
        p.kind === "civic" ? "#c7bda6" : p.kind === "woodland" ? "#7e946d" : "#82936c",
      );

      this.box("park path", p.x, py + 0.42, p.z, 3, 0.1, pd, "#c9baa0");
      this.box("cross path", p.x, py + 0.42, p.z, pw, 0.1, 3, "#c9baa0");
      if (p.kind === "woodland") continue;
      this.cylinder("fountain", p.x, py + 1, p.z, 1.2, 7, "#c4c4b0");
      this.cylinder("fountain water", p.x, py + 1.65, p.z, 0.1, 5.8, "#71bdbe");
    }
    for (const ramp of city.ramps) {
      const m = rampMesh(this.scene, ramp.x, ramp.z);
      m.material = this.mat("#ffffff");
      m.receiveShadows = true;
      this.shadows.addShadowCaster(m);
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
      if (group.length < 2) {
        this.culling.add(group[0]);
        continue;
      }
      const cast = casters.has(group[0]);
      for (const mesh of group) this.shadows.removeShadowCaster(mesh);
      const merged = Mesh.MergeMeshes(group, true, true, undefined, false, false);
      if (merged) {
        merged.receiveShadows = true;
        merged.freezeWorldMatrix();
        this.culling.add(merged);
        if (cast) this.shadows.addShadowCaster(merged);
      }
    }
  }
  makeEntity(e: Entity) {
    const root = new TransformNode(e.id, this.scene);
    const human = e.kind === "player" || e.kind === "pedestrian";
    if (human) {
      const upper = buildCharacter(
        root,
        e.color,
        (color) => this.mat(color),
        e.character,
      );
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
          if (isWeaponKind(kind)) buildWeapon(this, upper, kind, true);
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
          WHEEL_HEIGHT,
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
        );
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
      buildHeadlightCones(this.scene, root);
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
        e.model === "van" ? 1.1 : e.model === "sport" ? 0.8 : 1,
        model.length / 4.3,
      );
      if (e.model === "van")
        this.box("cargo", 0, 1.2, -0.65, 1.9, 1.0, 2.55, e.color, root, true);
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
    this.shadowCandidates.push(
      ...parts.filter((mesh) => mesh.name !== "headlight cone"),
    );
    return root;
  }
  update(
    entities: Entity[],
    me: string | undefined,
    dt: number,
    input: Input = idle(),
  ) {
    this.day = (this.day + this.dayRate * dt) % 24;
    // Snapshots correct the clock; between them it runs on so the swell moves smoothly.
    this.time += dt;
    setWaveTime(this.time);
    this.water.update(this.time);
    for (const node of this.pickupNodes.values())
      if (isWater(node.position.x, node.position.z, this.city))
        node.position.y = surfaceLevel(node.position.x, node.position.z, this.city);
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
        drawnBody(e) &&
          Math.hypot(e.x - this.target.x, e.z - this.target.z) <
            TUNING.entityRenderRadius,
      );
      // Networking already provides a continuous pose. Smoothing it a second
      // time adds delay and makes turns trail behind authoritative traffic.
      n.position.set(e.x, e.y + 0.3, e.z);
      n.rotation.y = e.angle;
      n.rotation.z = e.down ? Math.PI / 2 : 0;
      n.rotation.x = 0;
      // The sprung body rides above the ground under all four wheels; each wheel
      // then sits on its own ground, within the suspension's travel.
      let wheels: { grounded: boolean; heights: number[]; drop: number } | undefined;
      if (e.kind === "car") {
        const grounded = carGrounded(e, this.city),
          body = this.suspension.update(e, dt, grounded, this.vehicleFloor, this.time),
          ground = groundAttitude(e, this.vehicleFloor);
        // In a dip between the axles the centre's ground is lower than the wheels'.
        n.position.y =
          (grounded ? Math.max(e.y, ground.mean) : e.y) + 0.3 + body.heave.value;
        n.rotation.x = -body.pitch.value;
        n.rotation.z = -body.roll.value;
        wheels = { grounded, heights: ground.heights, drop: body.heave.value };
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
                (!!e.jetpack.active && e.jetpack.fuel > 0 && Math.abs(e.vy) > 0.1)),
          );

      for (const child of parts) {
        const lit = !!e.lightsOn && !e.wreck && e.health > 0;
        if (child.name === "headlight cone") child.setEnabled(lit);
        if (child.name === "headlight" || child.name === "taillight")
          child.material = this.mat(
            child.name === "headlight" ? "#fff1b5" : "#c95343",
            lit,
          );
        child.visibility =
          e.wreck === undefined
            ? 1
            : Math.max(0, Math.min(1, e.wreck / TUNING.debrisFadeSeconds));
        if (e.wreck) child.material = this.mat("#30312e");
        if (child.name === "wheel") {
          child.position.y = WHEEL_HEIGHT - (wheels?.drop ?? 0) / n.scaling.y;
          if (child.position.z > 0) child.rotation.y = e.steering || 0;
        }
      }
      if (wheels?.grounded) this.seatWheels(n, parts, wheels.heights);
      if (e.kind === "helicopter") {
        // The simulated rotor attitude: nose down to accelerate, banked into turns.
        n.rotation.x = e.pitch ?? 0;
        n.rotation.z = e.roll ?? 0;
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
        // Ride the swell at render time, pitching and rolling with its slope.
        const slope = surfaceSlope(e.x, e.z, this.city),
          sx = Math.sin(e.angle),
          cz = Math.cos(e.angle);
        n.position.y = surfaceLevel(e.x, e.z, this.city) + 0.3;
        n.rotation.x = -Math.atan(slope.x * sx + slope.z * cz);
        n.rotation.z =
          -(e.angularVelocity || 0) * 0.12 - Math.atan(slope.x * cz - slope.z * sx);
        for (const child of parts) {
          if (child.name.startsWith("AI skipper")) child.setEnabled(!!e.ai);
          if (child.name === "water propeller")
            child.rotation.z += propulsionRunning(e) ? dt * 60 : 0;
        }
      }
      if (e.kind === "player" || e.kind === "pedestrian") {
        poseCharacter(n, e);
        this.react(n, e);
        if (e.parachute) {
          n.rotation.x = -e.vz * 0.025;
          n.rotation.z += e.vx * 0.025;
        }
        const surface = surfaceLevel(e.x, e.z, this.city);
        if (
          !e.down &&
          !e.parachute &&
          isWater(e.x, e.z, this.city) &&
          e.y < surface + 0.4
        ) {
          const bed = terrainHeight(e.x, e.z, this.city),
            stroke =
              surface - bed > 1.4 ? Math.min(1, Math.hypot(e.vx, e.vz) / 1.5) : 0;
          // Tread water with the shoulders at the surface, or lie along it to swim;
          // in the shallows the feet stay on the bed.
          n.position.set(
            e.x - Math.sin(e.angle) * 0.9 * stroke,
            Math.max(bed + 0.3, surface - 1.38 + 1.09 * stroke),
            e.z - Math.cos(e.angle) * 0.9 * stroke,
          );
          n.rotation.x = stroke * 1.35;
          poseSwimmer(n, stroke, this.time);
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
      entities.filter(
        (e) =>
          Math.hypot(e.x - this.target.x, e.z - this.target.z) <
          TUNING.entityRenderRadius,
      ),
      (mark) => this.effects.trails.add(mark),
    );
    this.effects.update(dt, this.target);
    this.suspension.prune(this.time);
    this.blobShadows ??= new BlobShadows(this.scene, this.vehicleFloor);
    this.blobShadows.update(
      entities.filter((e) => drawnBody(e)),
      this.target,
    );
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
          ? Math.max(0.05, Math.min(32, this.debugCamera.distance * 0.002))
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
        shadowMap.renderList = this.shadowCandidates
          .filter((m) => {
            const c = m.getBoundingInfo().boundingSphere.centerWorld;
            return (
              m.isEnabled() && Math.hypot(c.x - this.target.x, c.z - this.target.z) < 70
            );
          })
          .slice(0, 256);
    }
    this.carLights.update(entities, this.nodes, this.target);
    this.lighting.update(this.day, this.target, dt);
    this.scene.fogEnabled = this.debugCamera.mode !== "fly";
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
    const now = performance.now() / 1000;
    if (e.kind === "hit" && e.target)
      this.flinches.set(e.target, { at: now, angle: e.angle ?? 0 });
    if (e.kind === "swing" && e.source) this.swings.set(e.source, now);
    this.effects.effect(e);
  }
  /**
   * Put each wheel of a grounded car on the ground below it: the body's pitch, roll
   * and bounce move the wheels through their travel instead of lifting them off or
   * sinking them in. Wheels are ordered front left, front right, rear left, rear right.
   */
  private seatWheels(root: TransformNode, parts: Mesh[], heights: number[]) {
    root.computeWorldMatrix(true);
    for (const wheel of parts) {
      if (wheel.name !== "wheel") continue;
      const index = (wheel.position.z > 0 ? 0 : 2) + (wheel.position.x < 0 ? 0 : 1),
        rest = heights[index] + 0.3 + WHEEL_HEIGHT * root.scaling.y,
        now = wheel.computeWorldMatrix(true).getTranslation().y,
        travel = Math.max(-WHEEL_TRAVEL, Math.min(WHEEL_TRAVEL, rest - now));
      wheel.position.y += travel / root.scaling.y;
    }
  }
  /** Melee punch thrust and a recoil lean away from the blow that just landed. */
  private react(n: TransformNode, e: Entity) {
    const now = performance.now() / 1000;
    const swing = this.swings.get(e.id);
    if (swing !== undefined) {
      const t = (now - swing) / 0.25;
      if (t >= 1) this.swings.delete(e.id);
      else {
        const arm = n
          .getChildTransformNodes(false)
          .find((node) => node.name === "arm pivot" && node.position.x > 0);
        if (arm) arm.rotation.x = -Math.PI * 0.55 * Math.sin(t * Math.PI);
      }
    }
    const flinch = this.flinches.get(e.id);
    if (!flinch) return;
    const k = 1 - (now - flinch.at) / 0.4;
    if (k <= 0) {
      this.flinches.delete(e.id);
      return;
    }
    if (e.down) return;
    const lean = 0.5 * k * k,
      relative = flinch.angle - e.angle;
    n.rotation.x += lean * Math.cos(relative);
    n.rotation.z -= lean * Math.sin(relative);
    n.position.addInPlaceFromFloats(
      Math.sin(flinch.angle) * lean * 0.3,
      0,
      Math.cos(flinch.angle) * lean * 0.3,
    );
  }
}
