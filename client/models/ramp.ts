import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Color3 } from "@babylonjs/core/Maths/math.color";
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
  const positions = faces.flatMap((face) =>
      [...face].reverse().flatMap((i) => points[i]),
    ),
    colors = faces.flatMap((_, i) => {
      const c = Color3.FromHexString(i < 2 ? "#414c50" : "#8f9993");
      return Array.from({ length: 3 }, () => [c.r, c.g, c.b, 1]).flat();
    });
  // Paint sits just above the physical slope; all details share one mesh.
  const paint = (
    corners: [[number, number], [number, number], [number, number], [number, number]],
    color: string,
  ) => {
    const c = Color3.FromHexString(color);
    for (const i of [2, 1, 0, 3, 2, 0]) {
      const [px, pz] = corners[i];
      positions.push(px, ((pz + d) / RAMP.length) * h + 0.008, pz);
      colors.push(c.r, c.g, c.b, 1);
    }
  };
  for (const side of [-1, 1]) {
    const left = side < 0 ? -w : w - 0.16;
    paint(
      [
        [left, -d],
        [left, d],
        [left + 0.16, d],
        [left + 0.16, -d],
      ],
      "#9da9a7",
    );
  }
  paint(
    [
      [-w, d - 0.18],
      [-w, d],
      [w, d],
      [w, d - 0.18],
    ],
    "#9da9a7",
  );
  for (const z of [-1.8, 0, 1.8]) {
    paint(
      [
        [-w + 0.16, z + 0.8],
        [-w + 0.16, z + 0.835],
        [w - 0.16, z + 0.835],
        [w - 0.16, z + 0.8],
      ],
      "#283235",
    );
    for (const side of [-1, 1]) {
      const left = side < 0 ? -1.65 : 0,
        right = side < 0 ? 0 : 1.65,
        lz = side < 0 ? z - 0.65 : z + 0.25,
        rz = side < 0 ? z + 0.25 : z - 0.65;
      paint(
        [
          [left, lz],
          [left, lz + 0.3],
          [right, rz + 0.3],
          [right, rz],
        ],
        "#e9ba52",
      );
    }
  }
  const indices = Array.from({ length: positions.length / 3 }, (_, i) => i),
    normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const mesh = new Mesh("jump ramp", scene),
    data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.colors = colors;
  data.applyToMesh(mesh);
  mesh.position.set(x, 0.3, z);
  return mesh;
}
