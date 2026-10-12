import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { CityScene } from "../scene.ts";
import type { RoadSurface } from "../../shared/world.ts";
import { earClip } from "../../shared/polygon.ts";

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
    mesh.material = material;
    mesh.receiveShadows = true;
    mesh.freezeWorldMatrix();
    return mesh;
  }
}

/**
 * Streets of a generated city: asphalt bands and junction rings, raised sidewalk
 * slabs with curb faces, and painted markings, all carrying road-profile heights.
 */
export function buildSurface(host: Pick<CityScene, "scene">, surface: RoadSurface) {
  const asphalt = new Batch(),
    sidewalk = new Batch(),
    markings = new Batch();
  const ASPHALT = Color3.FromHexString("#575c5d"),
    CURB = Color3.FromHexString("#b9b29c"),
    WALK = Color3.FromHexString("#c9c2ac"),
    WHITE = Color3.FromHexString("#e8e4d6"),
    YELLOW = Color3.FromHexString("#d9b84a");
  const LIFT = 0.1,
    HEIGHT = 0.15;
  for (const polygon of surface.asphalt) asphalt.polygon(polygon, LIFT, ASPHALT);
  for (const polygon of surface.sidewalks) {
    sidewalk.polygon(polygon, LIFT + HEIGHT, WALK);
    const n = polygon.length / 3;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a0 = sidewalk.vertex(
          polygon[i * 3],
          polygon[i * 3 + 1] - 0.3,
          polygon[i * 3 + 2],
          CURB,
        ),
        b0 = sidewalk.vertex(
          polygon[j * 3],
          polygon[j * 3 + 1] - 0.3,
          polygon[j * 3 + 2],
          CURB,
        ),
        b1 = sidewalk.vertex(
          polygon[j * 3],
          polygon[j * 3 + 1] + LIFT + HEIGHT,
          polygon[j * 3 + 2],
          CURB,
        ),
        a1 = sidewalk.vertex(
          polygon[i * 3],
          polygon[i * 3 + 1] + LIFT + HEIGHT,
          polygon[i * 3 + 2],
          CURB,
        );
      sidewalk.tri(a0, a1, b1);
      sidewalk.tri(a0, b1, b0);
    }
  }
  for (const m of surface.markings)
    markings.polygon(m.polygon, LIFT + 0.02, m.color === "yellow" ? YELLOW : WHITE);
  return [
    asphalt.flush("street surface", host),
    sidewalk.flush("sidewalks", host),
    markings.flush("street markings", host),
  ].filter((m): m is Mesh => !!m);
}
