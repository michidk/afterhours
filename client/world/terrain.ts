import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { CityScene } from "../scene.ts";
import type { City } from "../../shared/world.ts";
import { terrainHeight, terrainMesh } from "../../shared/terrain.ts";
import { earClip } from "../../shared/polygon.ts";
import { WATER_LEVEL } from "../../shared/water.ts";

const SAND = [0.78, 0.72, 0.53],
  WET_SAND = [0.62, 0.58, 0.42],
  GRASS = [0.49, 0.61, 0.39],
  ROCK = [0.48, 0.51, 0.43];
const mix = (a: number[], b: number[], t: number) =>
  a.map((v, i) => v + (b[i] - v) * t);
const ease = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/**
 * Vertex colour by height above the waterline. Colours blend smoothly across the
 * triangles, so a gradient (wet sand, dry sand, grass) gives a soft beach where a
 * single height threshold would draw a sawtooth along the cell edges.
 */
function groundColour(h: number) {
  const above = h - WATER_LEVEL;
  const beach = mix(WET_SAND, SAND, ease(-0.2, 0.5, above));
  return mix(mix(beach, GRASS, ease(0.5, 1.8, above)), ROCK, ease(90, 110, h));
}

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
  for (const h of terrain.heights) colors.push(...groundColour(h), 1);
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
  host: Pick<CityScene, "scene" | "mat" | "city">,
  water: NonNullable<City["water"]>,
) {
  const positions: number[] = [],
    indices: number[] = [],
    uvs: number[] = [];
  const vertex = (x: number, y: number, z: number, bank = 2, along = 0) => {
    uvs.push(bank, along);
    return positions.push(x, y, z) / 3 - 1;
  };
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
    // Sample the channel between source stations so terrain triangles cannot cut
    // dry wedges through a sloping river's centre.
    const p: number[] = [];
    const source = river.points;
    for (let i = 0; i < source.length; i += 4) {
      const next = Math.min(i + 4, source.length - 4);
      const steps =
        next === i
          ? 1
          : Math.max(
              1,
              Math.ceil(
                Math.hypot(source[next] - source[i], source[next + 1] - source[i + 1]) /
                  1,
              ),
            );
      for (let j = 0; j < steps; j++) {
        const t = j / steps;
        const x = source[i] + (source[next] - source[i]) * t;
        const z = source[i + 1] + (source[next + 1] - source[i + 1]) * t;
        const y = source[i + 2] + (source[next + 2] - source[i + 2]) * t;
        p.push(
          x,
          z,
          Math.max(y, terrainHeight(x, z, host.city) + 0.12),
          source[i + 3] + (source[next + 3] - source[i + 3]) * t,
        );
      }
    }
    const n = p.length / 4;
    let previous: [number, number] | undefined;
    let along = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.min(n - 1, i + 1),
        k = Math.max(0, i - 1),
        dx = p[j * 4] - p[k * 4],
        dz = p[j * 4 + 1] - p[k * 4 + 1],
        length = Math.hypot(dx, dz) || 1,
        half = p[i * 4 + 3] / 2;
      const nx = -dz / length,
        nz = dx / length;
      if (i)
        along += Math.hypot(
          p[i * 4] - p[(i - 1) * 4],
          p[i * 4 + 1] - p[(i - 1) * 4 + 1],
        );
      const left = vertex(
          p[i * 4] + nx * half,
          p[i * 4 + 2],
          p[i * 4 + 1] + nz * half,
          -1,
          along,
        ),
        right = vertex(
          p[i * 4] - nx * half,
          p[i * 4 + 2],
          p[i * 4 + 1] - nz * half,
          1,
          along,
        );
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
  Object.assign(data, { positions, indices, normals, uvs });
  data.applyToMesh(mesh);
  mesh.material = host.mat("#478e9c");
  mesh.receiveShadows = true;
  mesh.freezeWorldMatrix();
  return mesh;
}
