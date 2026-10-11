import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import { RAMP } from "../../shared/physics/ramps.ts";

/** A solid wedge with the exact footprint/slope used by shared physics. */
export function rampMesh(scene: Scene, x: number, z: number) {
  const w = RAMP.width / 2,
    d = RAMP.length / 2,
    h = RAMP.height;
  const points = [
    [-w, 0, -d],
    [w, 0, -d],
    [-w, 0, d],
    [w, 0, d],
    [-w, h, d],
    [w, h, d],
  ];
  const faces = [
    [0, 4, 5],
    [0, 5, 1],
    [2, 3, 5],
    [2, 5, 4],
    [0, 2, 4],
    [1, 5, 3],
    [0, 1, 3],
    [0, 3, 2],
  ];
  const positions = faces.flatMap((face) => face.flatMap((i) => points[i])),
    indices = Array.from({ length: positions.length / 3 }, (_, i) => i),
    normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const mesh = new Mesh("jump ramp", scene),
    data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.applyToMesh(mesh);
  mesh.position.set(x, 0.3, z);
  return mesh;
}
