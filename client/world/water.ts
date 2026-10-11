import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { CityScene } from "../scene.ts";
import { LIMIT } from "../../shared/world.ts";

export function waveHeight(x: number, z: number, time: number) {
  return (
    Math.sin(x * 0.17 + time * 1.7) * 0.08 + Math.sin(z * 0.31 - time * 2.1) * 0.05
  );
}

/** Waves are cosmetic; the shared solver uses a flat water surface. */
export class WaterRenderer {
  private patches: { mesh: Mesh; positions: number[]; normals: number[] }[] = [];
  private clock = 0;
  constructor(host: CityScene) {
    const extent = LIMIT + 256,
      strip = extent - LIMIT;
    const material = host.mat("#478e9c");
    material.specularColor = new Color3(0.5, 0.65, 0.7);
    material.specularPower = 64;
    for (const side of [-1, 1])
      for (const axis of ["x", "z"]) {
        const mesh = MeshBuilder.CreateGround(
          "animated water",
          {
            width: axis === "x" ? strip : extent * 2,
            height: axis === "z" ? strip : LIMIT * 2,
            subdivisionsX: axis === "x" ? 12 : 100,
            subdivisionsY: axis === "z" ? 12 : 100,
            updatable: true,
          },
          host.scene,
        );
        mesh.position.set(
          axis === "x" ? side * (LIMIT + strip / 2) : 0,
          -1.08,
          axis === "z" ? side * (LIMIT + strip / 2) : 0,
        );
        mesh.material = material;
        mesh.receiveShadows = true;
        const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
        if (positions)
          this.patches.push({
            mesh,
            positions: Array.from(positions),
            normals: new Array(positions.length).fill(0),
          });
      }
  }
  update(time: number, dt: number) {
    this.clock += dt;
    if (this.clock < 1 / 30) return;
    this.clock = 0;
    for (const { mesh, positions, normals } of this.patches) {
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i] + mesh.position.x,
          z = positions[i + 2] + mesh.position.z;
        positions[i + 1] = waveHeight(x, z, time);
        const dx = 0.0136 * Math.cos(x * 0.17 + time * 1.7),
          dz = 0.0155 * Math.cos(z * 0.31 - time * 2.1),
          length = Math.hypot(dx, 1, dz);
        normals[i] = -dx / length;
        normals[i + 1] = 1 / length;
        normals[i + 2] = -dz / length;
      }
      mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false, false);
      mesh.updateVerticesData(VertexBuffer.NormalKind, normals, false, false);
    }
  }
  dispose() {
    for (const { mesh } of this.patches) mesh.dispose();
    this.patches = [];
  }
}
