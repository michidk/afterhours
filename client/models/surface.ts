import { SCENE_LIGHT_COUNT } from "../lighting/index.ts";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { CityScene } from "../scene.ts";
import { KERB_HEIGHT, STREET_LIFT, type RoadSurface } from "../../shared/world.ts";
import { earClip } from "../../shared/polygon.ts";
import { terrainHeight } from "../../shared/terrain.ts";

/** Batched triangle soup with vertex colours; one mesh per surface layer. */
class Batch {
  positions: number[] = [];
  indices: number[] = [];
  colors: number[] = [];
  vertex(x: number, y: number, z: number, c: Color3) {
    this.positions.push(x, y, z);
    this.colors.push(c.r, c.g, c.b, 1);
    return this.positions.length / 3 - 1;
  }
  /** Babylon's front faces are clockwise, so triangles are emitted reversed. */
  tri(a: number, b: number, c: number) {
    this.indices.push(a, c, b);
  }
  polygon(flat: number[], lift: number, c: Color3) {
    const points = [];
    for (let i = 0; i < flat.length; i += 3)
      points.push({ x: flat[i], z: flat[i + 2] });
    const ids = points.map((p, i) => this.vertex(p.x, flat[i * 3 + 1] + lift, p.z, c));
    for (const [a, b, d] of earClip(points)) this.tri(ids[a], ids[b], ids[d]);
    return ids;
  }
  flush(name: string, host: Pick<CityScene, "scene">) {
    if (!this.indices.length) return undefined;
    const mesh = new Mesh(name, host.scene),
      data = new VertexData(),
      normals: number[] = [];
    VertexData.ComputeNormals(this.positions, this.indices, normals);
    data.positions = this.positions;
    data.indices = this.indices;
    data.normals = normals;
    data.colors = this.colors;
    data.applyToMesh(mesh);
    const material = new StandardMaterial(`${name} material`, host.scene);
    material.specularColor = new Color3(0.05, 0.05, 0.05);
    material.backFaceCulling = false;
    material.maxSimultaneousLights = SCENE_LIGHT_COUNT;
    mesh.material = material;
    mesh.receiveShadows = true;
    mesh.freezeWorldMatrix();
    return mesh;
  }
}

/**
 * Streets of a generated city: asphalt bands and junction rings, raised sidewalk
 * slabs with curb faces, and painted markings, all carrying road-profile heights.
 * The coarse terrain grid can fall away faster than a street edge between its
 * points, so every exposed edge stands on a concrete wall reaching below the ground.
 */
export function buildSurface(
  host: Pick<CityScene, "scene" | "city">,
  surface: RoadSurface,
) {
  const asphalt = new Batch(),
    sidewalk = new Batch(),
    markings = new Batch();
  const ASPHALT = Color3.FromHexString("#575c5d"),
    CURB = Color3.FromHexString("#b9b29c"),
    CONCRETE = Color3.FromHexString("#8e8b83"),
    WALK = Color3.FromHexString("#c9c2ac"),
    WHITE = Color3.FromHexString("#e8e4d6"),
    YELLOW = Color3.FromHexString("#d9b84a");
  const LIFT = STREET_LIFT,
    HEIGHT = KERB_HEIGHT;
  const edges = (polygons: number[][]) => {
    const count = new Map<string, number>();
    for (const polygon of polygons)
      for (const key of edgeKeys(polygon)) count.set(key, (count.get(key) ?? 0) + 1);
    return count;
  };
  const walks = edges(surface.sidewalks),
    paved = edges(surface.asphalt);
  /** A vertical quad between two polygon corners from `top` down to `bottom` metres. */
  const wall = (
    p: number[],
    i: number,
    j: number,
    top: (y: number) => number,
    bottom: (y: number) => number,
    c: Color3,
  ) => {
    const ids = [
      sidewalk.vertex(p[i * 3], bottom(p[i * 3 + 1]), p[i * 3 + 2], c),
      sidewalk.vertex(p[i * 3], top(p[i * 3 + 1]), p[i * 3 + 2], c),
      sidewalk.vertex(p[j * 3], top(p[j * 3 + 1]), p[j * 3 + 2], c),
      sidewalk.vertex(p[j * 3], bottom(p[j * 3 + 1]), p[j * 3 + 2], c),
    ];
    sidewalk.tri(ids[0], ids[1], ids[2]);
    sidewalk.tri(ids[0], ids[2], ids[3]);
  };
  /** Concrete under an exposed edge, from just below its surface into the ground. */
  const foundation = (p: number[], i: number, j: number, top: number) => {
    const ax = p[i * 3],
      az = p[i * 3 + 2],
      bx = p[j * 3],
      bz = p[j * 3 + 2],
      steps = Math.ceil(Math.hypot(bx - ax, bz - az) / 2);
    let ground = Infinity;
    for (let k = 0; k <= steps; k++)
      ground = Math.min(
        ground,
        terrainHeight(
          ax + ((bx - ax) * k) / steps,
          az + ((bz - az) * k) / steps,
          host.city,
        ),
      );
    const low = Math.min(p[i * 3 + 1], p[j * 3 + 1]);
    wall(
      p,
      i,
      j,
      (y) => y + top,
      () => Math.min(ground, low) - 0.4,
      CONCRETE,
    );
  };
  for (const polygon of surface.asphalt) {
    asphalt.polygon(polygon, LIFT, ASPHALT);
    const keys = edgeKeys(polygon);
    keys.forEach((key, i) => {
      if (key && paved.get(key)! < 2 && !walks.has(key))
        foundation(polygon, i, (i + 1) % keys.length, LIFT - 0.01);
    });
  }
  for (const polygon of surface.sidewalks) {
    sidewalk.polygon(polygon, LIFT + HEIGHT, WALK);
    const keys = edgeKeys(polygon);
    keys.forEach((key, i) => {
      if (!key || walks.get(key)! > 1) return;
      const j = (i + 1) % keys.length;
      wall(
        polygon,
        i,
        j,
        (y) => y + LIFT + HEIGHT,
        (y) => y,
        CURB,
      );
      foundation(polygon, i, j, 0);
    });
  }
  for (const m of surface.markings)
    markings.polygon(m.polygon, LIFT + 0.02, m.color === "yellow" ? YELLOW : WHITE);
  return [
    asphalt.flush("street surface", host),
    sidewalk.flush("sidewalks", host),
    markings.flush("street markings", host),
  ].filter((m): m is Mesh => !!m);
}

/** Direction-free keys of a flat polygon's edges, so neighbours sharing one match. */
function edgeKeys(flat: number[]) {
  const n = flat.length / 3,
    point = (i: number) =>
      `${Math.round(flat[i * 3] * 50)},${Math.round(flat[i * 3 + 2] * 50)}`;
  return Array.from({ length: n }, (_, i) => {
    const a = point(i),
      b = point((i + 1) % n);
    // Repeated corners give zero-length edges, which carry no wall.
    return a === b ? "" : a < b ? `${a} ${b}` : `${b} ${a}`;
  });
}
