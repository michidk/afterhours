import "@babylonjs/core/Shaders/default.vertex";
import "@babylonjs/core/Shaders/default.fragment";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3, Matrix, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { GeneratedMap, Point, RoadEdge } from "../mapgen/types.ts";
import { sample, cellSlope } from "../mapgen/field.ts";
import {
  closestOnSegment,
  dist,
  earClip,
  rotatedRect,
  signedArea,
} from "../mapgen/geom.ts";

/** Vertex-coloured triangle soup that flushes into one mesh. */
class Batch {
  positions: number[] = [];
  indices: number[] = [];
  colors: number[] = [];
  constructor(private flip: boolean) {}
  vertex(x: number, y: number, z: number, c: [number, number, number]) {
    this.positions.push(x, y, z);
    this.colors.push(c[0], c[1], c[2], 1);
    return this.positions.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    if (this.flip) this.indices.push(a, c, b);
    else this.indices.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number) {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }
  /** Fan a counter-clockwise (in x/z) ring at height y, or per-point heights. */
  fan(
    ring: Point[],
    y: number | number[],
    color: [number, number, number],
    centre?: Point,
  ) {
    // Ear clipping handles the concave lake outlines and junction rings that a
    // simple fan would bridge with stray triangles.
    void centre;
    const h = (i: number) => (typeof y === "number" ? y : y[i]);
    const ids = ring.map((p, i) => this.vertex(p.x, h(i), p.z, color));
    for (const [a, b, c] of earClip(ring)) this.tri(ids[a], ids[b], ids[c]);
  }
  /** Vertical walls around a ring from y0 up to y1, outward-facing. */
  walls(ring: Point[], y0: number, y1: number, color: [number, number, number]) {
    const pts = signedArea(ring) < 0 ? [...ring].reverse() : ring;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i],
        b = pts[(i + 1) % pts.length];
      const shade: [number, number, number] = [
        color[0] * 0.85,
        color[1] * 0.85,
        color[2] * 0.85,
      ];
      const a0 = this.vertex(a.x, y0, a.z, shade),
        b0 = this.vertex(b.x, y0, b.z, shade),
        b1 = this.vertex(b.x, y1, b.z, shade),
        a1 = this.vertex(a.x, y1, a.z, shade);
      this.quad(a0, a1, b1, b0);
    }
  }
  flush(name: string, scene: Scene, material: StandardMaterial) {
    if (!this.indices.length) return undefined;
    const mesh = new Mesh(name, scene),
      data = new VertexData(),
      normals: number[] = [];
    VertexData.ComputeNormals(this.positions, this.indices, normals);
    data.positions = this.positions;
    data.indices = this.indices;
    data.normals = normals;
    data.colors = this.colors;
    data.applyToMesh(mesh);
    mesh.material = material;
    mesh.freezeWorldMatrix();
    return mesh;
  }
}
const rgb = (hex: string): [number, number, number] => {
  const c = Color3.FromHexString(hex);
  return [c.r, c.g, c.b];
};
const ASPHALT = rgb("#575c5d"),
  SIDEWALK = rgb("#c9c2ac"),
  MARKING = rgb("#e0d9bd"),
  DECK = rgb("#6f6a63"),
  YELLOW = rgb("#d9b84a");

/** Height of a road surface point from the nearest profile sample of its edge. */
function edgeHeightAt(e: RoadEdge, p: Point) {
  let best = Infinity,
    y = e.heights[0] ?? 0;
  for (let i = 1; i < e.points.length; i++) {
    const { point, t } = closestOnSegment(p, e.points[i - 1], e.points[i]);
    const d = dist(point, p);
    if (d < best) {
      best = d;
      y = e.heights[i - 1] + (e.heights[i] - e.heights[i - 1]) * t;
    }
  }
  return y;
}

/**
 * Game-like 3D preview of a generated map: the same terrain, road polygons,
 * buildings and props the explorer draws in 2D, with a free-fly camera.
 */
export class View3D {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: FreeCamera;
  private meshes: Mesh[] = [];
  private materials = new Map<string, StandardMaterial>();
  private map?: GeneratedMap;
  private fast = false;
  constructor(private canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.62, 0.76, 0.9, 1);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogColor = new Color3(0.7, 0.8, 0.9);
    this.scene.fogDensity = 0.00045;
    const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), this.scene);
    ambient.intensity = 0.55;
    ambient.groundColor = new Color3(0.35, 0.33, 0.3);
    const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, 0.4), this.scene);
    sun.intensity = 0.9;
    this.camera = new FreeCamera("fly", new Vector3(0, 60, 0), this.scene);
    this.camera.minZ = 0.5;
    this.camera.maxZ = 6000;
    this.camera.speed = 1.6;
    this.camera.inertia = 0.75;
    this.camera.angularSensibility = 2500;
    this.camera.keysUp = [87, 38];
    this.camera.keysDown = [83, 40];
    this.camera.keysLeft = [65, 37];
    this.camera.keysRight = [68, 39];
    this.camera.keysUpward = [69];
    this.camera.keysDownward = [81];
    this.camera.attachControl(canvas, true);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Shift") this.setFast(true);
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === "Shift") this.setFast(false);
    });
    window.addEventListener("resize", () => this.engine.resize());
  }
  private setFast(fast: boolean) {
    this.fast = fast;
    this.camera.speed = fast ? 8 : 1.6;
  }
  start() {
    this.engine.resize();
    this.engine.runRenderLoop(() => this.scene.render());
  }
  stop() {
    this.engine.stopRenderLoop();
  }
  /** Place the camera above a world position, looking north. */
  goTo(x: number, z: number) {
    const ground = this.map ? Math.max(0, sample(this.map.shaped, x, z)) : 0;
    this.camera.position = new Vector3(x, ground + 70, z - 90);
    this.camera.setTarget(new Vector3(x, ground + 10, z + 60));
  }
  private mat(key: string, color = "#ffffff", alpha = 1) {
    let m = this.materials.get(key);
    if (m) return m;
    m = new StandardMaterial(key, this.scene);
    m.diffuseColor = Color3.FromHexString(color);
    m.specularColor = new Color3(0.06, 0.06, 0.06);
    m.backFaceCulling = false;
    if (alpha < 1) m.alpha = alpha;
    this.materials.set(key, m);
    return m;
  }
  setMap(map: GeneratedMap) {
    this.map = map;
    for (const m of this.meshes) m.dispose();
    this.meshes = [];
    const flip = this.detectWinding(map);
    this.buildTerrain(map, flip);
    this.buildWater(map);
    this.buildRoads(map, flip);
    this.buildBuildings(map, flip);
    this.buildTrees(map);
    this.buildLamps(map);
  }
  /** Build one upward quad and check which winding gives an upward normal. */
  private detectWinding(map: GeneratedMap) {
    const b = new Batch(false);
    const a = b.vertex(0, 0, 0, [1, 1, 1]),
      c = b.vertex(1, 0, 0, [1, 1, 1]),
      d = b.vertex(1, 0, 1, [1, 1, 1]),
      e = b.vertex(0, 0, 1, [1, 1, 1]);
    b.quad(a, c, d, e);
    const normals: number[] = [];
    VertexData.ComputeNormals(b.positions, b.indices, normals);
    void map;
    return normals[1] < 0;
  }
  private buildTerrain(map: GeneratedMap, flip: boolean) {
    const f = map.shaped,
      batch = new Batch(flip);
    const sand = rgb("#cdbf96"),
      grass = rgb("#7a9b5a"),
      dark = rgb("#5f7f48"),
      rock = rgb("#8d8674"),
      snow = rgb("#b9b2a2");
    for (let z = 0; z < f.h; z++)
      for (let x = 0; x < f.w; x++) {
        const h = f.data[z * f.w + x],
          s = cellSlope(f, x, z);
        let c: [number, number, number];
        if (h < 1.6) c = sand;
        else if (s > 0.55) c = rock;
        else if (h > 120) c = snow;
        else {
          const t = Math.min(1, h / 120);
          c = [
            grass[0] + (dark[0] - grass[0]) * t,
            grass[1] + (dark[1] - grass[1]) * t,
            grass[2] + (dark[2] - grass[2]) * t,
          ];
        }
        batch.vertex(x * f.cell - f.size / 2, h, z * f.cell - f.size / 2, c);
      }
    for (let z = 0; z < f.h - 1; z++)
      for (let x = 0; x < f.w - 1; x++) {
        const i = z * f.w + x;
        batch.quad(i, i + 1, i + f.w + 1, i + f.w);
      }
    const mesh = batch.flush("terrain", this.scene, this.mat("terrain"));
    if (mesh) this.meshes.push(mesh);
  }
  private buildWater(map: GeneratedMap) {
    const water = MeshBuilder.CreateGround(
      "water",
      { width: map.options.size * 1.6, height: map.options.size * 1.6 },
      this.scene,
    );
    water.position.y = map.seaLevel - 0.02;
    water.material = this.mat("water", "#2d6a8a", 0.82);
    this.meshes.push(water);
    for (const lake of map.lakes) {
      const b = new Batch(false);
      b.fan(lake.outline, lake.level - 0.3, rgb("#3f7f9a"));
      const m = b.flush("lake", this.scene, this.mat("lake", "#ffffff", 0.85));
      if (m) this.meshes.push(m);
    }
    const rivers = new Batch(false);
    for (const river of map.rivers)
      for (let i = 1; i < river.points.length; i++) {
        const a = river.points[i - 1],
          b = river.points[i],
          w = river.widths[i] / 2,
          dx = b.x - a.x,
          dz = b.z - a.z,
          l = Math.hypot(dx, dz) || 1,
          nx = -dz / l,
          nz = dx / l;
        const ya = sample(map.shaped, a.x, a.z) + 0.35,
          yb = sample(map.shaped, b.x, b.z) + 0.35;
        const c = rgb("#3f7f9a");
        const p0 = rivers.vertex(a.x + nx * w, ya, a.z + nz * w, c),
          p1 = rivers.vertex(a.x - nx * w, ya, a.z - nz * w, c),
          p2 = rivers.vertex(b.x - nx * w, yb, b.z - nz * w, c),
          p3 = rivers.vertex(b.x + nx * w, yb, b.z + nz * w, c);
        rivers.quad(p0, p1, p2, p3);
      }
    const rm = rivers.flush("rivers", this.scene, this.mat("lake", "#ffffff", 0.85));
    if (rm) this.meshes.push(rm);
  }
  private buildRoads(map: GeneratedMap, flip: boolean) {
    const asphalt = new Batch(flip),
      sidewalk = new Batch(flip),
      marks = new Batch(flip);
    const LIFT = 0.1,
      CURB = 0.15;
    const heightOf = (p: Point, edge?: number, node?: number) =>
      node !== undefined
        ? map.roads.nodes[node].y
        : edge !== undefined
          ? edgeHeightAt(map.roads.edges[edge], p)
          : sample(map.shaped, p.x, p.z);
    for (const band of map.geometry.bands) {
      const e = map.roads.edges[band.edge];
      const n = Math.min(band.left.length, band.right.length);
      const color = e.bridge ? DECK : ASPHALT;
      const ids: { l: number; r: number; y: number }[] = [];
      for (let i = 0; i < n; i++) {
        const l = band.left[i],
          r = band.right[i],
          c = { x: (l.x + r.x) / 2, z: (l.z + r.z) / 2 },
          y = edgeHeightAt(e, c) + LIFT;
        ids.push({
          l: asphalt.vertex(l.x, y, l.z, color),
          r: asphalt.vertex(r.x, y, r.z, color),
          y,
        });
      }
      for (let i = 1; i < ids.length; i++) {
        asphalt.quad(ids[i - 1].l, ids[i - 1].r, ids[i].r, ids[i].l);
        if (e.bridge) {
          const a = ids[i - 1],
            b = ids[i];
          const under = (id: number, y: number) => {
            const p = asphalt.positions;
            return asphalt.vertex(p[id * 3], y - 1.2, p[id * 3 + 2], DECK);
          };
          const ul = under(a.l, a.y),
            ur = under(a.r, a.y),
            vl = under(b.l, b.y),
            vr = under(b.r, b.y);
          asphalt.quad(a.l, a.r, ur, ul);
          asphalt.quad(a.l, ul, vl, b.l);
          asphalt.quad(a.r, b.r, vr, ur);
          asphalt.quad(ul, ur, vr, vl);
        }
      }
    }
    for (const j of map.geometry.junctions) {
      const y = map.roads.nodes[j.node].y + LIFT;
      asphalt.fan(j.polygon, y, ASPHALT);
    }
    // Raised sidewalk slabs with a curb face all around.
    for (const s of map.geometry.sidewalks) {
      const tops = s.polygon.map((p) => heightOf(p, s.edge, s.node) + LIFT + CURB);
      sidewalk.fan(s.polygon, tops, SIDEWALK);
      const pts = signedArea(s.polygon) < 0 ? [...s.polygon].reverse() : s.polygon;
      const h = signedArea(s.polygon) < 0 ? [...tops].reverse() : tops;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i],
          b = pts[(i + 1) % pts.length],
          ya = h[i],
          yb = h[(i + 1) % pts.length],
          c: [number, number, number] = [
            SIDEWALK[0] * 0.8,
            SIDEWALK[1] * 0.8,
            SIDEWALK[2] * 0.8,
          ];
        const a0 = sidewalk.vertex(a.x, ya - CURB - 0.3, a.z, c),
          b0 = sidewalk.vertex(b.x, yb - CURB - 0.3, b.z, c),
          b1 = sidewalk.vertex(b.x, yb, b.z, c),
          a1 = sidewalk.vertex(a.x, ya, a.z, c);
        sidewalk.quad(a0, a1, b1, b0);
      }
    }
    for (const m of map.geometry.markings) {
      const color = m.color === "yellow" ? YELLOW : MARKING;
      marks.fan(
        m.polygon,
        m.polygon.map((p) => edgeHeightAt(map.roads.edges[m.edge], p) + LIFT + 0.02),
        color,
      );
    }
    for (const [name, batch] of [
      ["roads", asphalt],
      ["sidewalks", sidewalk],
      ["markings", marks],
    ] as const) {
      const m = batch.flush(name, this.scene, this.mat(name));
      if (m) this.meshes.push(m);
    }
  }
  private buildBuildings(map: GeneratedMap, flip: boolean) {
    const batch = new Batch(flip);
    for (const b of map.buildings) {
      const ring = b.footprint ?? rotatedRect(b, b.w, b.d, b.angle);
      const c = rgb(b.color);
      batch.walls(ring, b.y - 0.5, b.y + b.h, c);
      batch.fan(ring, b.y + b.h, [c[0] * 0.7, c[1] * 0.7, c[2] * 0.7]);
      // Window bands: darker stripes every floor on tall buildings read as glass.
      if (b.h > 12) {
        const glass: [number, number, number] = [0.25, 0.32, 0.4];
        for (let y = b.y + 2.2; y < b.y + b.h - 1.5; y += 3.2) {
          const pts = signedArea(ring) < 0 ? [...ring].reverse() : ring;
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i],
              q = pts[(i + 1) % pts.length];
            const cx = (p.x + q.x) / 2,
              cz = (p.z + q.z) / 2;
            // Push the stripe 3 cm outside the wall along the outward normal.
            const dx = q.x - p.x,
              dz = q.z - p.z,
              l = Math.hypot(dx, dz) || 1,
              nx = (dz / l) * 0.03,
              nz = (-dx / l) * 0.03;
            void cx;
            void cz;
            const a0 = batch.vertex(p.x + nx, y, p.z + nz, glass),
              b0 = batch.vertex(q.x + nx, y, q.z + nz, glass),
              b1 = batch.vertex(q.x + nx, y + 1.3, q.z + nz, glass),
              a1 = batch.vertex(p.x + nx, y + 1.3, p.z + nz, glass);
            batch.quad(a0, a1, b1, b0);
          }
        }
      }
    }
    const m = batch.flush("buildings", this.scene, this.mat("buildings"));
    if (m) this.meshes.push(m);
  }
  private instances(base: Mesh, matrices: number[]) {
    if (!matrices.length) {
      base.dispose();
      return;
    }
    base.thinInstanceSetBuffer("matrix", new Float32Array(matrices), 16, true);
    base.freezeWorldMatrix();
    this.meshes.push(base);
  }
  private buildTrees(map: GeneratedMap) {
    const groundAt = (p: Point) => sample(map.shaped, p.x, p.z);
    const crownMats = {
      pine: this.mat("pine", "#2f5f3a"),
      oak: this.mat("oak", "#4f8a3e"),
      palm: this.mat("palm", "#6aa842"),
      shrub: this.mat("shrub", "#5f8a3c"),
    };
    const trunkMat = this.mat("trunk", "#7a5f45");
    const crowns: Record<string, Mesh> = {
      pine: MeshBuilder.CreateCylinder(
        "pine",
        { diameterTop: 0, diameterBottom: 1, height: 1, tessellation: 7 },
        this.scene,
      ),
      oak: MeshBuilder.CreateSphere("oak", { diameter: 1, segments: 6 }, this.scene),
      palm: MeshBuilder.CreateSphere("palm", { diameter: 1, segments: 5 }, this.scene),
      shrub: MeshBuilder.CreateSphere(
        "shrub",
        { diameter: 1, segments: 5 },
        this.scene,
      ),
    };
    for (const k of Object.keys(crowns))
      crowns[k].material = crownMats[k as keyof typeof crownMats];
    const trunk = MeshBuilder.CreateCylinder(
      "trunk",
      { diameter: 1, height: 1, tessellation: 5 },
      this.scene,
    );
    trunk.material = trunkMat;
    const crownM: Record<string, number[]> = { pine: [], oak: [], palm: [], shrub: [] },
      trunkM: number[] = [];
    const push = (
      list: number[],
      sx: number,
      sy: number,
      sz: number,
      x: number,
      y: number,
      z: number,
    ) => {
      Matrix.Compose(
        new Vector3(sx, sy, sz),
        Quaternion.Identity(),
        new Vector3(x, y, z),
      ).copyToArray(list, list.length);
    };
    for (const t of map.trees) {
      const g = groundAt(t);
      if (t.kind === "pine") {
        push(crownM.pine, t.h * 0.45, t.h * 0.8, t.h * 0.45, t.x, g + t.h * 0.6, t.z);
        push(trunkM, 0.35, t.h * 0.3, 0.35, t.x, g + t.h * 0.15, t.z);
      } else if (t.kind === "palm") {
        push(crownM.palm, 4, 1.6, 4, t.x, g + t.h, t.z);
        push(trunkM, 0.4, t.h, 0.4, t.x, g + t.h / 2, t.z);
      } else if (t.kind === "shrub") {
        push(crownM.shrub, t.h * 1.2, t.h, t.h * 1.2, t.x, g + t.h / 2, t.z);
      } else {
        push(crownM.oak, t.h * 0.75, t.h * 0.65, t.h * 0.75, t.x, g + t.h * 0.65, t.z);
        push(trunkM, 0.5, t.h * 0.45, 0.5, t.x, g + t.h * 0.22, t.z);
      }
    }
    for (const k of Object.keys(crowns)) this.instances(crowns[k], crownM[k]);
    this.instances(trunk, trunkM);
  }
  private buildLamps(map: GeneratedMap) {
    const pole = MeshBuilder.CreateBox("pole", { size: 1 }, this.scene);
    pole.material = this.mat("pole", "#3a3f44");
    const head = MeshBuilder.CreateSphere(
      "lamp",
      { diameter: 0.7, segments: 4 },
      this.scene,
    );
    const glow = this.mat("glow", "#ffe5a1");
    glow.emissiveColor = Color3.FromHexString("#ffe5a1").scale(0.8);
    head.material = glow;
    const poles: number[] = [],
      heads: number[] = [];
    for (const l of map.lamps) {
      const g = sample(map.shaped, l.x, l.z);
      Matrix.Compose(
        new Vector3(0.18, l.h, 0.18),
        Quaternion.Identity(),
        new Vector3(l.x, g + l.h / 2, l.z),
      ).copyToArray(poles, poles.length);
      Matrix.Compose(
        Vector3.One(),
        Quaternion.Identity(),
        new Vector3(l.x, g + l.h, l.z),
      ).copyToArray(heads, heads.length);
    }
    this.instances(pole, poles);
    this.instances(head, heads);
  }
}
