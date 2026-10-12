import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { CityScene } from "../scene.ts";
import type { City } from "../../shared/world.ts";
import { terrainMesh } from "../../shared/terrain.ts";

export function buildTerrain(
  host: Pick<CityScene, "scene" | "mat">,
  terrain: NonNullable<City["terrain"]>,
) {
  const mesh = new Mesh("island terrain", host.scene);
  const { positions, indices } = terrainMesh(terrain),
    normals: number[] = [],
    colors: number[] = [];
  // Babylon renders clockwise faces; the physics mesh uses counterclockwise faces.
  indices.reverse();
  VertexData.ComputeNormals(positions, indices, normals);
  for (const h of terrain.heights) {
    const color =
      h < -0.1 ? [0.78, 0.72, 0.53] : h > 100 ? [0.48, 0.51, 0.43] : [0.49, 0.61, 0.39];
    colors.push(...color, 1);
  }
  const data = new VertexData();
  Object.assign(data, { positions, indices, normals, colors });
  data.applyToMesh(mesh);
  // Cull terrain strips outside the camera instead of drawing the entire heightfield.
  mesh.subdivide(Math.min(64, indices.length / 3));
  mesh.cullingStrategy = Mesh.CULLINGSTRATEGY_STANDARD;
  mesh.material = host.mat("#ffffff");
  mesh.receiveShadows = true;
  return mesh;
}
