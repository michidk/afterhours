import "./style.css";
import { LAYERS, MapView, type LayerId } from "./render.ts";
import type { WorkerRequest, WorkerResponse } from "./worker.ts";
import type { GeneratedMap } from "../mapgen/types.ts";
import { describeAt } from "../mapgen/inspect.ts";

const SIZE = 3072,
  CELL = 8;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("map"),
  status = $("status"),
  seedInput = $<HTMLInputElement>("seed"),
  regenerate = $<HTMLButtonElement>("regenerate"),
  apply = $<HTMLButtonElement>("apply");
const view = new MapView(canvas);
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let request = 0,
  current: GeneratedMap | undefined;

const layers = $("layers");
for (const layer of LAYERS) {
  const label = document.createElement("label"),
    box = document.createElement("input");
  box.type = "checkbox";
  box.checked = layer.on;
  box.onchange = () => {
    view.toggle(layer.id as LayerId, box.checked);
    view.draw();
  };
  label.append(box, layer.name);
  layers.append(label);
}

function generate(seed: number) {
  seedInput.value = String(seed);
  history.replaceState(null, "", `#${seed}`);
  status.textContent = `Generating seed ${seed}…`;
  status.classList.remove("hidden");
  regenerate.disabled = apply.disabled = true;
  const id = ++request;
  worker.postMessage({
    id,
    options: { seed, size: SIZE, cell: CELL },
  } as WorkerRequest);
}
worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const data = event.data;
  if (data.id !== request) return;
  if ("progress" in data) {
    status.textContent = `Generating… ${data.progress}`;
    return;
  }
  regenerate.disabled = apply.disabled = false;
  if ("error" in data) {
    status.textContent = `Generation failed: ${data.error}`;
    console.error(data.error);
    return;
  }
  current = data.map;
  status.classList.add("hidden");
  view.setMap(current);
  view.draw();
  if (mode3d && view3d) {
    view3d.setMap(current);
    shown3d = current;
    const c = view.centre();
    view3d.goTo(c.x, c.z);
  }
  $("timings").replaceChildren(
    ...current.timings.map((t) => {
      const row = document.createElement("tr");
      row.innerHTML = `<td>${t.stage}</td><td>${t.ms.toFixed(0)} ms</td>`;
      return row;
    }),
  );
  const total = current.timings.reduce((s, t) => s + t.ms, 0);
  const land = current.terrain.data.reduce(
    (n, h) => n + (h > current!.seaLevel ? 1 : 0),
    0,
  );
  const stats: [string, string | number][] = [
    ["total", `${total.toFixed(0)} ms`],
    ["land", `${((land * CELL * CELL) / 1e6).toFixed(2)} km²`],
    ["rivers", current.rivers.length],
    ["lakes", current.lakes.length],
    ["road nodes", current.roads.nodes.length],
    ["road edges", current.roads.edges.length],
    ["bridges", current.bridges.length],
    ["blocks", current.blocks.length],
    ["lots", current.blocks.reduce((n, b) => n + b.lots.length, 0)],
    ["buildings", current.buildings.length],
    ["parks", current.parks.length],
    ["trees", current.trees.length],
    ["lamps", current.lamps.length],
  ];
  $("stats").replaceChildren(
    ...stats.flatMap(([k, v]) => {
      const key = document.createElement("span"),
        value = document.createElement("b");
      key.textContent = k;
      value.textContent = String(v);
      return [key, value];
    }),
  );
};

const randomSeed = () => Math.floor(Math.random() * 1_000_000);
regenerate.onclick = () => generate(randomSeed());
apply.onclick = () => generate(Number(seedInput.value) || 0);
seedInput.onkeydown = (e) => {
  if (e.key === "Enter") apply.click();
};
// 3D mode: Babylon renderer loaded on first use so the 2D tool stays light.
const sceneCanvas = $<HTMLCanvasElement>("scene"),
  hint3d = $("hint3d"),
  toggle3d = $<HTMLButtonElement>("toggle3d");
let view3d: import("./view3d.ts").View3D | undefined,
  mode3d = false,
  shown3d: GeneratedMap | undefined;
async function enter3d() {
  if (!current || mode3d) return;
  toggle3d.disabled = true;
  if (!view3d) {
    const { View3D } = await import("./view3d.ts");
    view3d = new View3D(sceneCanvas);
    Object.assign((window as unknown as { explorer: object }).explorer, { view3d });
  }
  mode3d = true;
  canvas.classList.add("hidden");
  sceneCanvas.classList.remove("hidden");
  hint3d.classList.remove("hidden");
  if (shown3d !== current) {
    status.textContent = "Building 3D scene…";
    status.classList.remove("hidden");
    await new Promise((r) => setTimeout(r, 20));
    view3d.setMap(current);
    shown3d = current;
    status.classList.add("hidden");
  }
  const c = view.centre();
  view3d.goTo(c.x, c.z);
  view3d.start();
  sceneCanvas.focus();
  toggle3d.disabled = false;
  toggle3d.textContent = "Back to map";
}
function exit3d() {
  if (!mode3d) return;
  mode3d = false;
  view3d?.stop();
  sceneCanvas.classList.add("hidden");
  hint3d.classList.add("hidden");
  canvas.classList.remove("hidden");
  toggle3d.textContent = "3D view";
  view.draw();
}
toggle3d.onclick = () => (mode3d ? exit3d() : enter3d());
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "Escape" && mode3d) exit3d();
  if (mode3d) return;
  if (e.key === "r" || e.key === "R") generate(randomSeed());
  if (e.key === "v" || e.key === "V") enter3d();
  if (e.key === "f" || e.key === "F") {
    view.fit();
    view.draw();
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (!current) return;
  const p = view.toWorld(e.clientX, e.clientY);
  $("hover").textContent = describeAt(current, p.x, p.z);
});

// Console access for debugging and scripted screenshots.
Object.assign(window, { explorer: { view, map: () => current } });
const initial = Number(location.hash.slice(1));
generate(Number.isFinite(initial) && location.hash ? initial : 713);
