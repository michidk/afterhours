import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { wrap } from "../../shared/physics/vehicle.ts";
import type { Entity } from "../../shared/world.ts";
import type { Material } from "@babylonjs/core/Materials/material";
import {
  DEFAULT_CHARACTER,
  PHYSIQUES,
  type Character,
} from "../../shared/character.ts";

export function buildCharacter(
  root: TransformNode,
  color: string,
  mat: (color: string) => Material,
  character: Character = DEFAULT_CHARACTER,
) {
  const scene = root.getScene();
  const upper = new TransformNode("upper body", scene);
  upper.parent = root;
  const width = PHYSIQUES[character.physique].width;
  function box(
    name: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: string,
  ) {
    const mesh = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
    mesh.position.set(x, y, z);
    mesh.material = mat(color);
    mesh.parent = upper;
    return mesh;
  }
  const skin = character.skin,
    ink = "#302e2b",
    pants = "#3e4b4e";
  box("body", 0, 1.09, 0, 0.62 * width, 0.68, 0.38, color);
  box("neck", 0, 1.48, 0, 0.19, 0.18, 0.21, skin);
  box("head", 0, 1.72, 0, 0.38, 0.42, 0.36, skin);
  box("nose", 0, 1.69, 0.2, 0.075, 0.095, 0.09, skin);
  for (const side of [-1, 1]) {
    box("eye", side * 0.09, 1.76, 0.184, 0.035, 0.035, 0.015, ink);
    box("ear", side * 0.205, 1.7, 0, 0.07, 0.12, 0.1, skin);
    const leg = box(
      "leg",
      side * 0.17 * width,
      0.43,
      0,
      0.25 * width,
      0.72,
      0.28,
      character.legs === "shorts" ? skin : pants,
    );
    leg.parent = root;
    if (character.legs === "shorts") {
      const shorts = box("shorts", 0, 0.22, 0, 0.27 * width, 0.31, 0.3, pants);
      shorts.parent = leg;
    }
    if (character.legs === "cargo") {
      const pocket = box(
        "cargo pocket",
        side * 0.12 * width,
        0.08,
        0.02,
        0.09,
        0.19,
        0.25,
        "#66705a",
      );
      pocket.parent = leg;
    }
    const shoe = box("shoe", 0, -0.34, 0.07, 0.27 * width, 0.16, 0.43, "#ddd9c9");
    shoe.parent = leg;
    const arm = box(
      "arm",
      side * 0.43 * width,
      1.1,
      0,
      0.2 * width,
      0.55,
      0.27,
      character.top === "vest" ? skin : color,
    );
    const hand = box(
      "hand",
      side * 0.43 * width,
      0.77,
      0,
      0.17 * width,
      0.18,
      0.22,
      skin,
    );
    const shoulder = new TransformNode("arm pivot", scene);
    shoulder.parent = upper;
    shoulder.position.set(side * 0.43 * width, 1.38, 0);
    for (const part of [arm, hand]) {
      part.parent = shoulder;
      part.position.subtractInPlace(shoulder.position);
    }
    if (character.top === "jacket") {
      box("jacket lapel", side * 0.09, 1.26, 0.205, 0.09, 0.34, 0.04, "#ded8bf");
      box("jacket pocket", side * 0.18 * width, 0.98, 0.205, 0.14, 0.13, 0.035, ink);
    }
  }
  if (character.top === "vest") box("vest zip", 0, 1.09, 0.195, 0.03, 0.64, 0.025, ink);
  if (character.top === "tee")
    box("tee collar", 0, 1.425, 0.04, 0.25, 0.055, 0.32, "#e4dfca");
  if (character.hair === "crop") {
    box("hair", 0, 1.945, -0.02, 0.4, 0.14, 0.38, ink);
    box("hair back", 0, 1.81, -0.17, 0.4, 0.2, 0.08, ink);
  } else if (character.hair === "curls") {
    for (const x of [-0.15, 0, 0.15])
      for (const z of [-0.13, 0.03, 0.15]) {
        const curl = MeshBuilder.CreateSphere(
          "curl",
          { diameter: 0.23, segments: 4 },
          scene,
        );
        curl.position.set(x, 1.96, z);
        curl.material = mat(ink);
        curl.parent = upper;
      }
  } else if (character.hair === "cap") {
    box("cap", 0, 1.935, 0, 0.43, 0.17, 0.4, "#344842");
    box("cap brim", 0, 1.87, 0.25, 0.44, 0.045, 0.28, "#344842");
  }
  return upper;
}

export function poseCharacter(root: TransformNode, e: Entity) {
  const upper = root
    .getChildTransformNodes(true)
    .find((node) => node.name === "upper body");
  if (!upper) return;
  const aiming = e.aim !== undefined && !e.down && !e.parachute && !e.vehicle;
  upper.rotation.y = aiming ? wrap(e.aim! - e.angle) : 0;
  const holding =
    !e.down &&
    !e.parachute &&
    !e.vehicle &&
    (aiming || (e.weapon && e.weapon !== "fists"));
  for (const arm of upper.getChildTransformNodes(true))
    if (arm.name === "arm pivot") arm.rotation.x = holding ? -Math.PI / 2 : 0;
}
