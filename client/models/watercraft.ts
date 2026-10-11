import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { CityScene } from "../scene.ts";
import type { Entity } from "../../shared/world.ts";
import { VEHICLES } from "../../shared/catalog.ts";

export function buildWatercraft(host: CityScene, e: Entity, root: TransformNode) {
  const model = e.model && VEHICLES[e.model];
  if (!model) return;
  const hull = MeshBuilder.CreateSphere(
    "watercraft hull",
    { diameter: 1, segments: 10 },
    host.scene,
  );
  hull.scaling.set(model.width, 0.9, model.length);
  hull.position.y = 0.05;
  hull.material = host.mat(e.color);
  hull.parent = root;
  host.shadows.addShadowCaster(hull);
  host.box(
    "watercraft deck",
    0,
    0.38,
    0,
    model.width * 0.8,
    0.1,
    model.length * 0.75,
    "#f0e4ce",
    root,
  );
  if (e.kind === "jetski") {
    host.box("saddle", 0, 0.7, -0.3, 0.48, 0.45, 1.2, "#27383e", root, true);
    host.box("handlebar", 0, 0.95, 0.6, 0.85, 0.09, 0.09, "#263237", root);
    host.box("fairing", 0, 0.6, 0.8, 0.65, 0.35, 0.7, e.color, root);
  } else {
    host.box(
      "windscreen",
      0,
      0.9,
      model.length * 0.12,
      model.width * 0.65,
      0.6,
      0.1,
      "#35555e",
      root,
    );
    for (const side of [-1, 1]) {
      host.box(
        "gunwale",
        side * model.width * 0.43,
        0.7,
        0,
        0.13,
        0.45,
        model.length * 0.75,
        e.color,
        root,
      );
      host.box(
        "seat",
        side * model.width * 0.22,
        0.67,
        -0.35,
        model.width * 0.27,
        0.35,
        0.8,
        "#eee6d6",
        root,
        true,
      );
    }
    host.box(
      "outboard",
      0,
      0.25,
      -model.length * 0.47,
      0.55,
      0.9,
      0.6,
      "#263237",
      root,
      true,
    );
    const propeller = host.box(
      "water propeller",
      0,
      -0.15,
      -model.length * 0.53,
      0.5,
      0.08,
      0.12,
      "#73858c",
      root,
    );
    propeller.rotation.y = Math.PI / 2;
    if (e.kind === "boat")
      host.box(
        "cabin",
        0,
        1.15,
        -0.8,
        model.width * 0.65,
        0.9,
        model.length * 0.25,
        e.color,
        root,
        true,
      );
  }
  if (e.ai) {
    host.cylinder("AI skipper", 0, 1.15, 0, 0.6, 0.5, "#e8b63f", root);
    host.cylinder("AI skipper head", 0, 1.65, 0, 0.3, 0.35, "#c79e7b", root);
  }
}
