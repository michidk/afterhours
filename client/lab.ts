// Handling lab in the browser: runs a crates/physics scenario in the shared wasm and replays
// the trace. `/lab.html?scenario=corner-15&model=van` (or `&json={...}` for a custom one).
// The ground drawing mirrors `build` in crates/physics/src/lab.rs.
import init, {
  lab_presets,
  run_lab,
} from "../crates/physics/pkg/afterhours_physics.js";
import { VEHICLES } from "../shared/catalog.ts";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import "@babylonjs/core/Shaders/default.vertex";
import "@babylonjs/core/Shaders/default.fragment";

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  speed: number;
  lateral: number;
  q: [number, number, number, number];
}
interface Ground {
  kind: "flat" | "slope" | "wall" | "curb" | "obstacle" | "bumps";
  degrees?: number;
  distance?: number;
  height?: number;
  offset?: number;
  start?: number;
  spacing?: number;
  count?: number;
}
interface Scenario {
  ground?: Ground;
  model?: string;
  [key: string]: unknown;
}
const SIZES: Record<string, { w: number; l: number; h: number; color: string }> = {
  sedan: { w: 2, l: 4.3, h: 1.4, color: VEHICLES.sedan.color },
  sport: { w: 1.9, l: 4.1, h: 1.3, color: VEHICLES.sport.color },
  van: { w: 2.2, l: 5, h: 1.8, color: VEHICLES.van.color },
};
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

const engine = new Engine($<HTMLCanvasElement>("view"), true),
  scene = new Scene(engine);
scene.clearColor = Color4.FromHexString("#7fa6c2ff");
const camera = new ArcRotateCamera("cam", -Math.PI / 2, 1.2, 14, Vector3.Zero(), scene);
camera.attachControl(engine.getRenderingCanvas(), true);
camera.wheelPrecision = 20;
new HemisphericLight("sun", new Vector3(-0.4, 1, -0.6), scene);
const paint = (color: string) => {
  const m = new StandardMaterial(color, scene);
  m.diffuseColor = Color3.FromHexString(color);
  return m;
};

const car = new TransformNode("car", scene);
car.rotationQuaternion = Quaternion.Identity();
const body = MeshBuilder.CreateBox("body", { width: 1, height: 1, depth: 1 }, scene);
body.parent = car;
const wheels = [-1, 1].flatMap((side) =>
  [1.3, -1.25].map((z) => {
    const w = MeshBuilder.CreateCylinder(
      "wheel",
      { diameter: 0.68, height: 0.3 },
      scene,
    );
    w.rotation.z = Math.PI / 2;
    w.parent = car;
    w.metadata = { side, z };
    w.material = paint("#111111");
    return w;
  }),
);
const fit = (model: string) => {
  const s = SIZES[model] ?? SIZES.sedan;
  body.scaling.set(s.w, s.h, s.l);
  body.material = paint(s.color);
  for (const w of wheels)
    w.position.set(
      (w.metadata.side * s.w) / 2,
      -s.h / 2 + 0.34,
      (w.metadata.z * s.l) / 4.3,
    );
};

let ground: Mesh | undefined;
const solids: Mesh[] = [];
function buildGround(g: Ground = { kind: "flat" }) {
  ground?.dispose();
  for (const s of solids.splice(0)) s.dispose();
  const rise = g.kind === "slope" ? Math.tan(((g.degrees ?? 0) * Math.PI) / 180) : 0,
    [x, near, far] = [200, -60, 1800];
  ground = new Mesh("ground", scene);
  const data = new VertexData();
  data.positions = [
    -x,
    rise * near,
    near,
    x,
    rise * near,
    near,
    -x,
    rise * far,
    far,
    x,
    rise * far,
    far,
  ];
  data.indices = [0, 2, 1, 1, 2, 3];
  data.uvs = [0, 0, 40, 0, 0, (far - near) / 10, 40, (far - near) / 10];
  data.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  data.applyToMesh(ground);
  const grid = new DynamicTexture("grid", 64, scene);
  const ctx = grid.getContext();
  ctx.fillStyle = "#4a5560";
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = "#c9d4de";
  ctx.fillRect(0, 0, 64, 6);
  ctx.fillRect(0, 0, 6, 64);
  grid.update();
  const mat = new StandardMaterial("ground", scene);
  mat.diffuseTexture = grid;
  mat.specularColor = Color3.Black();
  mat.backFaceCulling = false;
  ground.material = mat;
  const box = (
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
  ) => {
    const b = MeshBuilder.CreateBox(
      "solid",
      { width: hx * 2, height: hy * 2, depth: hz * 2 },
      scene,
    );
    b.position.set(cx, cy, cz);
    b.material = paint("#d9a441");
    solids.push(b);
  };
  const d = g.distance ?? 0,
    h = g.height ?? 0;
  if (g.kind === "wall") box(0, 2, d, 200, 2, 0.5);
  if (g.kind === "curb") box(0, h / 2, d, 200, h / 2, 0.5);
  if (g.kind === "obstacle") box(g.offset ?? 0, 0.7, d, 1, 0.7, 2.15);
  if (g.kind === "bumps")
    for (let i = 0; i < (g.count ?? 0); i++)
      box(0, h / 2, (g.start ?? 0) + (g.spacing ?? 0) * i, 200, h / 2, 0.15);
}

let trace: Sample[] = [],
  startedAt = 0;
function play(scenario: Scenario, about = "") {
  const report = JSON.parse(run_lab(JSON.stringify(scenario)));
  trace = report.trace;
  buildGround(scenario.ground);
  fit(scenario.model ?? "sedan");
  $("about").textContent = about;
  $("metrics").textContent = Object.entries(report.metrics)
    .map(([k, v]) => `${k}: ${typeof v === "number" ? v.toFixed(2) : v}`)
    .join("\n");
  $("metrics").style.whiteSpace = "pre";
  startedAt = performance.now();
}

await init();
const presets = (JSON.parse(lab_presets()) as [string, string, string][]).map(
  ([name, about, json]) => ({ name, about, scenario: JSON.parse(json) as Scenario }),
);
const pick = $<HTMLSelectElement>("scenario"),
  model = $<HTMLSelectElement>("model");
for (const p of presets) pick.add(new Option(p.name));
pick.value = params.get("scenario") ?? presets[0].name;
model.value = params.get("model") ?? "sedan";
function replay() {
  const custom = params.get("json"),
    preset = presets.find((p) => p.name === pick.value) ?? presets[0];
  const scenario: Scenario = custom
    ? JSON.parse(custom)
    : { ...preset.scenario, model: model.value };
  if (custom && !scenario.model) scenario.model = model.value;
  play(scenario, custom ? "custom scenario" : preset.about);
}
pick.onchange = model.onchange = () => {
  params.delete("json");
  replay();
};
$("replay").onclick = replay;
replay();

engine.runRenderLoop(() => {
  // Real time, looping with a one second pause so the end state is readable.
  const end = trace.at(-1)?.t ?? 0,
    clock = ((performance.now() - startedAt) / 1000) % (end + 1),
    i =
      Math.min(trace.findIndex((s) => s.t >= clock) + 1 || trace.length, trace.length) -
      1,
    s = trace[Math.max(i, 0)];
  if (s) {
    car.position.set(s.x, s.y, s.z);
    car.rotationQuaternion!.set(s.q[0], s.q[1], s.q[2], s.q[3]);
    camera.target.copyFrom(car.position);
    $("live").textContent =
      `t ${s.t.toFixed(1)} s\nspeed ${s.speed.toFixed(1)} m/s (${(s.speed * 3.6).toFixed(0)} km/h)\nslide ${s.lateral.toFixed(2)} m/s`;
  }
  scene.render();
});
addEventListener("resize", () => engine.resize());
