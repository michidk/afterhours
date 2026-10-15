import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import { VEHICLES } from "../../shared/catalog.ts";
import type { Entity } from "../../shared/world.ts";
import { groundAttitude } from "./car-suspension.ts";

/**
 * Soft contact shadows under vehicles. The sun's shadow map falls sideways, fades at
 * night and ends 70 m out; this one sits straight below, so a jump reads at once: it
 * stays on the ground, spreads and fades as the car rises.
 */
export const BLOB = {
  /** Opacity on the ground. */
  opacity: 0.5,
  /** Above asphalt (0.10), its paint and tyre marks (0.14), below kerbs. */
  lift: 0.16,
  /** Height at which the shadow has faded out, by kind. */
  fade: { car: 14, helicopter: 45, plane: 45 } as Record<string, number>,
  /** Growth of the shadow per metre of height. */
  spread: 0.035,
  /** Only the nearest bodies get one. */
  radius: 80,
  limit: 48,
};
const RING = 20;

/** A rounded rectangle, opaque in its core and transparent at its rim. */
function shadowMesh(scene: Scene) {
  const positions = [0, 0, 0],
    colors = [0, 0, 0, 1],
    indices: number[] = [];
  for (const [scale, alpha] of [
    [0.36, 0.95],
    [0.62, 0],
  ])
    for (let i = 0; i < RING; i++) {
      const t = (i / RING) * Math.PI * 2,
        c = Math.cos(t),
        s = Math.sin(t);
      // Superellipse: boxy like a car body, with soft corners.
      positions.push(
        Math.sign(c) * Math.abs(c) ** 0.5 * scale,
        0,
        Math.sign(s) * Math.abs(s) ** 0.5 * scale,
      );
      colors.push(0, 0, 0, alpha);
    }
  for (let i = 0; i < RING; i++) {
    const a = 1 + i,
      b = 1 + ((i + 1) % RING);
    indices.push(0, b, a, a, b, b + RING, a, b + RING, a + RING);
  }
  const mesh = new Mesh("blob shadow", scene),
    data = new VertexData();
  data.positions = positions;
  data.colors = colors;
  data.indices = indices;
  data.normals = positions.map((_, i) => (i % 3 === 1 ? 1 : 0));
  data.applyToMesh(mesh);
  mesh.hasVertexAlpha = true;
  mesh.isPickable = false;
  mesh.setEnabled(false);
  const material = new StandardMaterial("blob shadow", scene);
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveColor = Color3.Black();
  material.disableLighting = true;
  material.disableDepthWrite = true;
  material.backFaceCulling = false;
  material.zOffset = -2;
  mesh.material = material;
  return mesh;
}

export class BlobShadows {
  private base: Mesh;
  private meshes = new Map<string, Mesh>();
  constructor(
    scene: Scene,
    /** Height of what a vehicle stands on, ramps included. */
    private ground: (x: number, z: number) => number,
  ) {
    this.base = shadowMesh(scene);
  }
  get size() {
    return this.meshes.size;
  }
  update(entities: Entity[], focus: { x: number; z: number }) {
    const casting = entities
      .filter(
        (e) =>
          BLOB.fade[e.kind] !== undefined &&
          !e.wreck &&
          Math.hypot(e.x - focus.x, e.z - focus.z) < BLOB.radius,
      )
      .sort(
        (a, b) =>
          Math.hypot(a.x - focus.x, a.z - focus.z) -
          Math.hypot(b.x - focus.x, b.z - focus.z),
      )
      .slice(0, BLOB.limit);
    const wanted = new Set<string>();
    for (const e of casting) {
      const floor = this.ground(e.x, e.z),
        height = Math.max(0, e.y - floor),
        fade = 1 - height / BLOB.fade[e.kind];
      if (fade <= 0) continue;
      wanted.add(e.id);
      let mesh = this.meshes.get(e.id);
      if (!mesh) {
        mesh = this.base.clone("blob shadow " + e.id);
        mesh.setEnabled(true);
        this.meshes.set(e.id, mesh);
      }
      const model = e.model ? VEHICLES[e.model] : undefined,
        grow = 1 + height * BLOB.spread,
        slope = groundAttitude(e, this.ground);
      mesh.position.set(e.x, floor + BLOB.lift, e.z);
      mesh.rotation.set(-slope.pitch, e.angle, -slope.roll);
      mesh.scaling.set(
        (model?.width ?? 2) * 1.15 * grow,
        1,
        (model?.length ?? 4.3) * 1.1 * grow,
      );
      mesh.visibility = BLOB.opacity * fade;
    }
    for (const [id, mesh] of this.meshes)
      if (!wanted.has(id)) {
        mesh.dispose();
        this.meshes.delete(id);
      }
  }
  dispose() {
    for (const mesh of this.meshes.values()) mesh.dispose();
    this.meshes.clear();
    this.base.dispose();
  }
}
