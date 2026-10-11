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
  ROADS,
  generateCity,
  random,
  signal,
  type City,
  type Entity,
} from "../shared/world.ts";
export class CityScene {
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
  materials = new Map<string, StandardMaterial>();
  lights: { mesh: Mesh; axis: "x" | "z" }[] = [];
  streetGlow: StandardMaterial;
  effects: { mesh: Mesh; life: number }[] = [];
  target = new Vector3(4, 0, 12);
  day = 16.5;
  time = 0;
  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, {
      stencil: true,
      preserveDrawingBuffer: true,
    });
    this.engine.setHardwareScalingLevel(Math.max(1, devicePixelRatio / 1.6));
    this.scene = new Scene(this.engine);
    this.scene.clearColor = Color4.FromHexString("#b8d0cfff");
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = 0.003;
    this.scene.fogColor = Color3.FromHexString("#b8d0cf");
    this.camera = new FreeCamera(
      "camera",
      new Vector3(15, 68, -47),
      this.scene,
    );
    this.camera.fov = 0.72;
    this.camera.minZ = 0.5;
    this.camera.maxZ = 650;
    this.camera.setTarget(this.target);
    this.ambient = new HemisphericLight(
      "sky",
      new Vector3(0, 1, 0),
      this.scene,
    );
    this.ambient.intensity = 0.7;
    this.ambient.groundColor = Color3.FromHexString("#617c7b");
    this.sun = new DirectionalLight(
      "sun",
      new Vector3(-0.65, -1, 0.4),
      this.scene,
    );
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
    this.city = generateCity();
    this.build(this.city);
    this.batchStatic();
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
  sign(
    text: string,
    x: number,
    y: number,
    z: number,
    color: string,
    width = 9,
  ) {
    const texture = new DynamicTexture(
      "sign",
      { width: 512, height: 128 },
      this.scene,
      false,
    );
    texture.drawText(
      text,
      null,
      91,
      "bold 66px sans-serif",
      "#fff5db",
      color,
      true,
    );
    const m = new StandardMaterial("lettering", this.scene);
    m.diffuseTexture = texture;
    m.emissiveColor = new Color3(0.14, 0.14, 0.14);
    m.specularColor = Color3.Black();
    const mesh = MeshBuilder.CreatePlane(
      "shop sign",
      { width, height: width / 4, sideOrientation: Mesh.DOUBLESIDE },
      this.scene,
    );
    mesh.position.set(x, y, z);
    mesh.material = m;
  }
  palm(x: number, z: number, r: () => number) {
    const h = 5 + r() * 3;
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
  build(city: City) {
    const r = random(city.seed);
    this.box("island", 0, -0.65, 0, 460, 1, 460, "#a9b29a");
    this.box("ocean", 0, -1.2, 0, 1800, 0.2, 1800, "#669f9f");
    for (const road of ROADS) {
      this.box("asphalt", road, -0.04, 0, 18, 0.08, 436, "#555b5c");
      this.box("asphalt", 0, -0.035, road, 436, 0.08, 18, "#555b5c");
      for (const side of [-1, 1]) {
        this.box("sidewalk", road + side * 11, 0.1, 0, 4, 0.3, 430, "#c9c2ac");
        this.box("sidewalk", 0, 0.1, road + side * 11, 430, 0.3, 4, "#c9c2ac");
      }
      for (let p = -210; p < 210; p += 7) {
        if (ROADS.some((v) => Math.abs(v - p) < 12)) continue;
        this.box("lane", road, 0.025, p, 0.14, 0.025, 3, "#e0d9bd");
        this.box("lane", p, 0.026, road, 3, 0.025, 0.14, "#e0d9bd");
      }
    }
    for (const x of ROADS)
      for (const z of ROADS) {
        this.box("intersection", x, 0.28, z, 25, 0.06, 25, "#555b5c");
        for (const side of [-1, 1])
          for (let i = -3; i <= 3; i++) {
            this.box(
              "crosswalk",
              x + i * 2,
              0.32,
              z + side * 9,
              1,
              0.025,
              3,
              "#dfdbc8",
            );
            this.box(
              "crosswalk",
              x + side * 9,
              0.32,
              z + i * 2,
              3,
              0.025,
              1,
              "#dfdbc8",
            );
          }
        for (const side of [-1, 1]) {
          this.cylinder(
            "signal pole",
            x + side * 11,
            2.1,
            z - side * 11,
            4.2,
            0.18,
            "#364747",
          );
          this.box(
            "signal housing",
            x + side * 11,
            4,
            z - side * 11,
            0.65,
            1.5,
            0.6,
            "#263739",
          );
          const mesh = this.box(
            "signal",
            x + side * 11,
            4.2,
            z - side * 11 - 0.32,
            0.34,
            0.34,
            0.05,
            "#88ca9e",
          );
          this.lights.push({ mesh, axis: side === 1 ? "z" : "x" });
        }
      }
    city.buildings.forEach((b, i) => {
      this.box(
        "building",
        b.x,
        b.h / 2 + 0.25,
        b.z,
        b.w,
        b.h,
        b.d,
        b.color,
        undefined,
        true,
      );
      this.box(
        "roof rim",
        b.x,
        b.h + 0.45,
        b.z,
        b.w + 0.5,
        0.5,
        b.d + 0.5,
        "#e0d5bd",
        undefined,
        true,
      );
      this.box(
        "roof",
        b.x,
        b.h + 0.72,
        b.z,
        b.w - 1.1,
        0.12,
        b.d - 1.1,
        "#9e9d90",
      );
      this.box(
        "air conditioner",
        b.x + 3,
        b.h + 1.2,
        b.z,
        2.2,
        1.1,
        3,
        "#acb0a7",
        undefined,
        true,
      );
      for (let y = 3; y < b.h - 1; y += 3.3)
        for (let x = -b.w / 2 + 2; x < b.w / 2 - 1; x += 3.5) {
          this.box(
            "window",
            b.x + x,
            y,
            b.z - b.d / 2 - 0.025,
            1.5,
            1.8,
            0.06,
            "#4c7779",
          );
          this.box(
            "window frame",
            b.x + x,
            y - 0.95,
            b.z - b.d / 2 - 0.09,
            1.8,
            0.14,
            0.22,
            "#ece0c6",
          );
        }
      for (let y = 3; y < b.h - 1; y += 3.3)
        for (let z = -b.d / 2 + 2; z < b.d / 2 - 1; z += 3.5)
          this.box(
            "side window",
            b.x - b.w / 2 - 0.03,
            y,
            b.z + z,
            0.06,
            1.8,
            1.5,
            "#4c7779",
          );
      if (b.h < 18) {
        const colors = ["#b85d49", "#548f7b", "#cc9f54"];
        this.box(
          "storefront",
          b.x,
          1.6,
          b.z - b.d / 2 - 0.05,
          b.w - 2,
          2.5,
          0.1,
          "#385c5d",
        );
        for (let j = 0; j < 8; j++)
          this.box(
            "striped awning",
            b.x - b.w / 2 + 1 + (j * (b.w - 2)) / 8,
            3.4,
            b.z - b.d / 2 - 0.7,
            (b.w - 2) / 8,
            0.22,
            1.7,
            j % 2 ? "#eaddc3" : colors[i % 3],
            undefined,
            true,
          );
        this.sign(
          [
            "24/7 MARKET",
            "PALOMA",
            "PIZZA",
            "AUTO CLUB",
            "CAFÉ SOL",
            "RECORDS",
          ][i % 6],
          b.x,
          4.6,
          b.z - b.d / 2 - 0.09,
          colors[i % 3],
          Math.min(10, b.w - 2),
        );
      }
    });
    for (const p of city.parks) {
      this.box("park", p.x, 0.24, p.z, 38, 0.3, 38, "#82936c");
      for (let i = 0; i < 10; i++)
        this.palm(p.x + (r() - 0.5) * 32, p.z + (r() - 0.5) * 32, r);
      this.box("park path", p.x, 0.42, p.z, 3, 0.1, 38, "#c9baa0");
      this.cylinder("fountain", p.x, 1, p.z, 1.2, 7, "#c4c4b0");
      this.cylinder("fountain water", p.x, 1.65, p.z, 0.1, 5.8, "#71bdbe");
    }
    for (const road of ROADS)
      for (let p = -175; p < 200; p += 32) {
        if (ROADS.some((v) => Math.abs(v - p) < 15)) continue;
        this.palm(road + 11, p, r);
        this.cylinder("streetlamp", road - 11, 3, p, 6, 0.16, "#46534e");
        this.box("lamp arm", road - 10.4, 6, p, 1.5, 0.15, 0.15, "#46534e");
        const lamp = this.box(
          "lamp",
          road - 9.7,
          5.9,
          p,
          0.65,
          0.2,
          0.45,
          "#ffe5a1",
        );
        lamp.material = this.streetGlow;
        this.box(
          "bench",
          road + 11,
          0.7,
          p + 5,
          1.1,
          0.2,
          2,
          "#97785a",
          undefined,
          true,
        );
        this.box(
          "bench back",
          road + 11.5,
          1.1,
          p + 5,
          0.15,
          0.8,
          2,
          "#97785a",
        );
        this.cylinder("bin", road - 11, 0.5, p + 4, 1, 0.65, "#59675b");
      }
    for (const ramp of city.ramps) {
      const m = this.box(
        "jump ramp",
        ramp.x,
        0.8,
        ramp.z,
        5,
        0.25,
        7,
        "#b59263",
        undefined,
        true,
      );
      m.rotation.x = -0.22;
      for (let i = -1; i <= 1; i++)
        this.box(
          "ramp stripe",
          ramp.x + i * 1.4,
          0.9,
          ramp.z,
          0.3,
          0.1,
          6,
          "#eac66d",
        ).rotation.x = -0.22;
    }
    for (const item of city.pickups) {
      const m = this.cylinder(
        "weapon pickup",
        item.x,
        0.25,
        item.z,
        0.2,
        1.7,
        "#e4bc65",
      );
      m.material = this.mat("#e4bc65", true);
      this.box(
        "pickup weapon",
        item.x,
        0.7,
        item.z,
        0.2,
        0.25,
        item.weapon === "bat" ? 1.3 : 0.8,
        "#27363b",
      );
    }
  }
  batchStatic() {
    const dynamic = new Set(this.lights.map((l) => l.mesh));
    const groups = new Map<string, Mesh[]>();
    const casters = new Set(this.shadows.getShadowMap()?.renderList || []);
    for (const mesh of [...this.scene.meshes]) {
      if (!(mesh instanceof Mesh) || dynamic.has(mesh) || !mesh.material)
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
      const merged = Mesh.MergeMeshes(
        group,
        true,
        true,
        undefined,
        false,
        false,
      );
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
        this.box(
          "leg",
          s * 0.17,
          0.35,
          0,
          0.23,
          0.65,
          0.25,
          "#354955",
          root,
          true,
        );
        this.box(
          "shoe",
          s * 0.17,
          0.06,
          0.08,
          0.25,
          0.15,
          0.4,
          "#e7e3d2",
          root,
        );
        this.box("arm", s * 0.42, 1, 0, 0.18, 0.65, 0.22, e.color, root, true);
      }
      if (e.kind === "player") {
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
      for (const side of [-1, 1]) {
        for (const z of [-1.25, 1.3]) {
          const wheel = this.cylinder(
            "wheel",
            side * 1,
            0.48,
            z,
            0.25,
            0.76,
            "#273334",
            root,
          );
          wheel.rotation.z = Math.PI / 2;
        }
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
        this.box(
          "pillar",
          side * 0.81,
          1.2,
          -0.25,
          0.1,
          0.7,
          0.15,
          e.color,
          root,
        );
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
    } else {
      this.box("fuselage", 0, 1, 0, 1.3, 1, 7, e.color, root, true);
      this.box("cockpit", 0, 1.6, 1, 1, 0.45, 1.5, "#35555e", root);
      this.box("wings", 0, 1, 0.2, 10, 0.18, 1.8, e.color, root, true);
      this.box("tail wings", 0, 1, -2.8, 4, 0.18, 1, e.color, root);
      this.box("tail fin", 0, 1.8, -2.8, 0.18, 1.5, 1, e.color, root);
      this.box("propeller", 0, 1, 3.6, 3, 0.15, 0.1, "#334343", root);
    }
    this.nodes.set(e.id, root);
    this.shadowCandidates.push(...(root.getChildMeshes() as Mesh[]));
    return root;
  }
  update(entities: Entity[], me: string | undefined, dt: number) {
    const ids = new Set(entities.map((e) => e.id));
    for (const [id, n] of this.nodes)
      if (!ids.has(id)) {
        n.dispose();
        this.nodes.delete(id);
      }
    for (const e of entities) {
      const n = this.nodes.get(e.id) || this.makeEntity(e);
      n.setEnabled(
        !e.vehicle && Math.hypot(e.x - this.target.x, e.z - this.target.z) < 95,
      );
      const t = 1 - Math.exp(-dt * 18);
      n.position.x += (e.x - n.position.x) * t;
      n.position.z += (e.z - n.position.z) * t;
      n.position.y += (e.y + 0.3 - n.position.y) * t;
      let d = e.angle - n.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      n.rotation.y += d * t;
      n.rotation.z = e.down ? Math.PI / 2 : 0;
      if (e.kind === "helicopter") {
        for (const child of n.getChildMeshes())
          if (child.name.startsWith("rotor"))
            child.rotation.y += dt * (e.driver ? 30 : 1);
      }
      if (e.kind === "player" || e.kind === "pedestrian") {
        for (const child of n.getChildMeshes())
          if (child.name === "leg")
            child.rotation.x =
              Math.sin(this.time * 12 + (child.position.x > 0 ? 0 : Math.PI)) *
              Math.min(0.6, Math.hypot(e.vx, e.vz) * 0.1);
      }
    }
    const p = entities.find((e) => e.id === me);
    if (p) {
      const n = this.nodes.get(p.vehicle || p.id);
      if (n)
        this.target = Vector3.Lerp(
          this.target,
          n.position,
          1 - Math.exp(-dt * 5),
        );
    }
    const altitude = p?.y || 0;
    const destination = this.target.add(
      new Vector3(0, 46 + altitude * 0.25, -26),
    );
    this.camera.position = Vector3.Lerp(
      this.camera.position,
      destination,
      1 - Math.exp(-dt * 4),
    );
    this.camera.setTarget(this.target.add(new Vector3(0, 0, 4)));
    this.shadowTimer += dt;
    if (this.shadowTimer > 0.3) {
      this.shadowTimer = 0;
      this.shadowCandidates = this.shadowCandidates.filter(
        (m) => !m.isDisposed(),
      );
      const shadowMap = this.shadows.getShadowMap();
      if (shadowMap)
        shadowMap.renderList = this.shadowCandidates.filter((m) => {
          const c = m.getBoundingInfo().boundingSphere.centerWorld;
          return (
            m.isEnabled() &&
            Math.hypot(c.x - this.target.x, c.z - this.target.z) < 70
          );
        });
    }
    const daylight = Math.max(
      0.05,
      Math.sin(((this.day - 6) / 24) * Math.PI * 2),
    );
    this.sun.intensity = daylight * 0.85;
    this.ambient.intensity = 0.4 + daylight * 0.25;
    this.streetGlow.emissiveColor = Color3.FromHexString("#ffe5a1").scale(
      1 - daylight * 0.6,
    );
    const sky = Color3.Lerp(
      Color3.FromHexString("#172b42"),
      Color3.FromHexString("#bfd1c8"),
      daylight,
    );
    this.scene.clearColor = new Color4(sky.r, sky.g, sky.b, 1);
    this.scene.fogColor = sky;
    for (const l of this.lights)
      l.mesh.material = this.mat(
        signal(this.time, l.axis) === "green"
          ? "#85dca0"
          : signal(this.time, l.axis) === "amber"
            ? "#efbc5d"
            : "#e36353",
        true,
      );
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.life -= dt;
      fx.mesh.position.y += dt;
      fx.mesh.scaling.scaleInPlace(1 + dt);
      fx.mesh.visibility = Math.max(0, fx.life);
      if (fx.life <= 0) {
        fx.mesh.dispose();
        this.effects.splice(i, 1);
      }
    }
  }
  effect(e: { kind: string; x: number; y: number; z: number }) {
    if (this.effects.length > 100) return;
    const m = MeshBuilder.CreateSphere(
      "particle",
      { diameter: e.kind === "smoke" ? 0.65 : 0.35, segments: 3 },
      this.scene,
    );
    m.position.set(e.x, e.y + 0.5, e.z);
    m.material = this.mat(
      e.kind === "smoke" ? "#c3c4b3" : "#ffce72",
      e.kind !== "smoke",
    );
    this.effects.push({ mesh: m, life: e.kind === "smoke" ? 0.8 : 0.25 });
  }
}
