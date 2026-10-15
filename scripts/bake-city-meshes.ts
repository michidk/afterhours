import { airportsOf } from "../shared/world.ts";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { encode } from "@msgpack/msgpack";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { SceneryCulling } from "../client/world/culling.ts";
import { CityScene } from "../client/scene.ts";
import { EnvironmentLighting } from "../client/lighting/index.ts";
import { DestructionRenderer } from "../client/world/destruction.ts";
import { CityStore } from "../server/city-stream.ts";
import { loadCity } from "../server/city-loader.ts";
import { STATIC_FIELDS, emptyCity, chunkBounds } from "../shared/city-stream.ts";
import { chunkOrigin, unpackSurface } from "../shared/city-pack.ts";
import { buildSurface } from "../client/models/surface.ts";
import { destructibles } from "../shared/destruction.ts";
import { meshGroupSchema, type MeshGroup } from "../shared/city-mesh.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const source = option("--city", "data/city.json");
const output = resolve(option("--out", "data/city-meshes.msgpack"));
if (!source || !output) throw Error("--city and --out require paths");
const city = await loadCity(source);
const store = new CityStore(city);
const engine = new NullEngine();
const scene = new Scene(engine);
const casters = new Set<Mesh>();
const host = Object.assign(Object.create(CityScene.prototype), {
  scene,
  culling: new SceneryCulling(scene),
  materials: new Map(),
  target: Vector3.Zero(),
  shadowCandidates: [],
  lights: [],
  staticFixtures: new Map(),
  shadows: {
    addShadowCaster: (mesh: Mesh) => casters.add(mesh),
    removeShadowCaster: (mesh: Mesh) => casters.delete(mesh),
    getShadowMap: () => ({ renderList: [...casters] }),
  },
}) as CityScene;
host.streetGlow = host.mat("#ffe5a1", true);
const windows = host.mat("#587c80");
const pool = host.mat("#ffd79b", true);
host.lighting = Object.assign(Object.create(EnvironmentLighting.prototype), {
  scene,
  windows,
  pool,
  lamps: [],
  signs: [],
});
host.sign = (text, x, y, z, background, width = 9) => {
  const mesh = MeshBuilder.CreatePlane(
    "shop sign",
    { width, height: width / 4, sideOrientation: Mesh.DOUBLESIDE },
    scene,
  );
  mesh.position.set(x, y, z);
  const material = new StandardMaterial("lettering", scene);
  material.emissiveColor = new Color3(0.14, 0.14, 0.14);
  material.specularColor = Color3.Black();
  material.metadata = { text, background };
  mesh.material = material;
  return mesh;
};
function saved(meshes: Mesh[], relative?: Matrix): MeshGroup {
  const round = (values: ArrayLike<number> | null | undefined) =>
    values ? Array.from(values, (n) => Math.round(n * 1e6) / 1e6) : undefined;
  return meshGroupSchema.parse(
    meshes.map((mesh) => {
      const data = VertexData.ExtractFromMesh(mesh);
      let transform = mesh.computeWorldMatrix(true).clone();
      if (relative) transform = transform.multiply(relative);
      data.transform(transform);
      const material = mesh.material as StandardMaterial;
      return {
        name: mesh.name.slice(0, 100),
        positions: round(data.positions),
        normals: round(data.normals),
        indices: Array.from(data.indices ?? []),
        uvs: round(data.uvs),
        colors: round(data.colors),
        shadow: casters.has(mesh),
        material: {
          role:
            material === windows
              ? "windows"
              : material === host.streetGlow
                ? "glow"
                : material === pool
                  ? "pool"
                  : material.metadata?.text !== undefined
                    ? "sign"
                    : "plain",
          color: material.diffuseColor.toHexString(),
          emissive: material.emissiveColor.toHexString(),
          specular: material.specularColor.toHexString(),
          backFaceCulling: material.backFaceCulling,
          ...material.metadata,
        },
      };
    }),
  );
}
function build(
  part: ReturnType<typeof emptyCity>,
  options: Parameters<CityScene["build"]>[1],
) {
  host.build(part, options);
  host.batchStatic();
  const meshes = [...scene.meshes] as Mesh[];
  const result = saved(meshes);
  for (const mesh of meshes) {
    casters.delete(mesh);
    mesh.dispose();
  }
  return result;
}
try {
  const base = build(
    emptyCity({ ...store.manifest, terrain: city.terrain, water: city.water }),
    {
      roads: false,
      airport: false,
    },
  );
  const airport = build(emptyCity(store.manifest), {
    base: false,
    roads: false,
    airport: true,
  });
  const features: Record<string, MeshGroup> = {};
  for (const field of STATIC_FIELDS)
    for (const [id, value] of (city[field] ?? []).entries()) {
      const part = emptyCity(store.manifest);
      Object.assign(part, { [field]: [value] });
      features[`${field}:${id}`] = build(part, {
        base: false,
        airport: false,
        roads: field === "roads" && !city.surface,
        index: id,
      });
    }
  console.log(`Baked ${Object.keys(features).length} static features`);
  const fixtures: Record<string, MeshGroup> = {};
  const renderer = new DestructionRenderer(host);
  for (const fixture of destructibles(city)) {
    renderer.syncStatic([fixture]);
    const root = scene.getTransformNodeByName("fixture:" + fixture.id)!;
    fixtures[fixture.id] = saved(
      root.getChildMeshes() as Mesh[],
      Matrix.Invert(root.computeWorldMatrix(true)),
    );
  }
  renderer.dispose();
  const chunks: Record<string, Uint8Array> = {};
  for (const [key, chunk] of store.chunks) {
    const part = emptyCity(store.manifest);
    for (const field of STATIC_FIELDS)
      Object.assign(part, { [field]: chunk[field].map((entry) => entry.value) });
    const bounds = chunkBounds(key);
    const visibleAirport = airportsOf(city).some(
      (a) =>
        bounds.maxX >= a.x - a.w / 2 &&
        bounds.minX <= a.x + a.w / 2 &&
        bounds.maxZ >= a.z - a.d / 2 &&
        bounds.minZ <= a.z + a.d / 2,
    );
    let surface: MeshGroup | undefined;
    if (chunk.surface) {
      const meshes = buildSurface(host, unpackSurface(chunk.surface, chunkOrigin(key)));
      surface = saved(meshes);
      for (const mesh of meshes) mesh.dispose(false, true);
    }
    chunks[key] = gzipSync(
      JSON.stringify({
        ...chunk,
        geometry: {
          version: 1,
          features: Object.fromEntries([
            ...(surface ? [[`surface:${key}`, surface]] : []),
            ...STATIC_FIELDS.flatMap((field) =>
              chunk[field].map((entry) => [
                `${field}:${entry.id}`,
                features[`${field}:${entry.id}`],
              ]),
            ),
          ]),
          fixtures: Object.fromEntries(
            destructibles(part).map((f) => [f.id, fixtures[f.id]]),
          ),
          airport: visibleAirport ? airport : undefined,
        },
      }),
      { level: 9 },
    );
  }
  await mkdir(dirname(output), { recursive: true });
  const bytes = encode({
    format: "afterhours-meshes",
    version: 1,
    mapId: store.manifest.mapId,
    base: gzipSync(JSON.stringify(base), { level: 9 }),
    chunks,
  });
  await writeFile(output, bytes);
  console.log(
    `Saved ${Object.keys(chunks).length} chunks and ${Object.keys(fixtures).length} fixtures, ${(bytes.byteLength / 1e6).toFixed(1)} MB -> ${output}`,
  );
} finally {
  scene.dispose();
  engine.dispose();
}
