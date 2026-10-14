import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { CityScene } from "../scene.ts";
import type { City } from "../../shared/world.ts";
import { terrainMesh } from "../../shared/terrain.ts";
import { earClip } from "../../shared/polygon.ts";

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

/**
 * Lakes at their surface level and rivers as ribbons on their channels, in one
 * mesh. The terrain hides whatever lies below its banks.
 */
export function buildInlandWater(
  host: Pick<CityScene, "scene" | "mat">,
  water: NonNullable<City["water"]>,
) {
  const positions: number[] = [],
    indices: number[] = [];
  const vertex = (x: number, y: number, z: number) => positions.push(x, y, z) / 3 - 1;
  // Wind every triangle like the terrain mesh (counter-clockwise in x/z) so it faces up.
  const tri = (a: number, b: number, c: number) => {
    const p = (i: number) => ({ x: positions[i * 3], z: positions[i * 3 + 2] });
    const [pa, pb, pc] = [p(a), p(b), p(c)];
    const ccw = (pb.x - pa.x) * (pc.z - pa.z) - (pb.z - pa.z) * (pc.x - pa.x) > 0;
    indices.push(...(ccw ? [a, b, c] : [a, c, b]));
  };
  for (const lake of water.lakes) {
    const ring: { x: number; z: number }[] = [];
    for (let i = 0; i < lake.outline.length; i += 2)
      ring.push({ x: lake.outline[i], z: lake.outline[i + 1] });
    const ids = ring.map((p) => vertex(p.x, lake.level, p.z));
    for (const [a, b, c] of earClip(ring)) tri(ids[a], ids[b], ids[c]);
  }
  for (const river of water.rivers) {
    const p = river.points,
      n = p.length / 4;
    let previous: [number, number] | undefined;
    for (let i = 0; i < n; i++) {
      const j = Math.min(n - 1, i + 1),
        k = Math.max(0, i - 1),
        dx = p[j * 4] - p[k * 4],
        dz = p[j * 4 + 1] - p[k * 4 + 1],
        length = Math.hypot(dx, dz) || 1,
        half = p[i * 4 + 3] / 2;
      const nx = -dz / length,
        nz = dx / length;
      const left = vertex(p[i * 4] + nx * half, p[i * 4 + 2], p[i * 4 + 1] + nz * half),
        right = vertex(p[i * 4] - nx * half, p[i * 4 + 2], p[i * 4 + 1] - nz * half);
      if (previous) {
        tri(previous[0], previous[1], right);
        tri(previous[0], right, left);
      }
      previous = [left, right];
    }
  }
  if (!indices.length) return undefined;
  const mesh = new Mesh("inland water", host.scene),
    normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  Object.assign(data, { positions, indices, normals });
  data.applyToMesh(mesh);
  mesh.material = host.mat("#478e9c");
  mesh.receiveShadows = true;
  mesh.freezeWorldMatrix();
  return mesh;
}
