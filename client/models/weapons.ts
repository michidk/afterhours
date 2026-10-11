import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { CityScene } from "../scene.ts";
import type { WeaponKind } from "../../shared/catalog.ts";

const SHAPES = {
  bat: { w: 0.12, h: 0.14, d: 1.25, color: "#9d7351" },
  pistol: { w: 0.15, h: 0.14, d: 0.35, color: "#263237" },
  smg: { w: 0.18, h: 0.22, d: 0.6, color: "#263237" },
  knife: { w: 0.05, h: 0.12, d: 0.6, color: "#c6d2d5" },
  machinegun: { w: 0.23, h: 0.25, d: 1.2, color: "#344542" },
  flamethrower: { w: 0.22, h: 0.3, d: 1.05, color: "#ad793e" },
  grenade: { w: 0.25, h: 0.35, d: 0.25, color: "#64794b" },
} satisfies Record<
  Exclude<WeaponKind, "fists">,
  { w: number; h: number; d: number; color: string }
>;

export function buildWeapon(
  host: CityScene,
  root: TransformNode,
  kind: WeaponKind,
  held = false,
) {
  if (kind === "fists") return;
  const spec = SHAPES[kind],
    name = held ? "held:" + kind : "pickup weapon",
    x = held ? 0.45 : 0,
    y = held ? 1 : 0.7,
    z = held ? 0.55 : 0;
  const mesh =
    kind === "grenade"
      ? MeshBuilder.CreateSphere(name, { diameter: 0.3, segments: 6 }, host.scene)
      : host.box(name, x, y, z, spec.w, spec.h, spec.d, spec.color, root);
  mesh.position.set(x, y, z);
  mesh.parent = root;
  mesh.material = host.mat(spec.color);
  if (kind === "machinegun" || kind === "smg" || kind === "pistol")
    host.box(name, x, y - 0.15, z - 0.1, 0.13, 0.3, 0.12, "#263237", root);
  if (kind === "flamethrower")
    host.cylinder(name, x, y - 0.13, z - 0.25, 0.4, 0.35, "#b94f36", root);
  if (kind === "knife" || kind === "grenade")
    host.box(name, x, y, z - 0.2, 0.09, 0.13, 0.22, "#263237", root);
}
