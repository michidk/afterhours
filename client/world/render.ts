import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { segmentHitsBox } from "./occluders.ts";
import {
  STATIC_FIELDS,
  emptyCity,
  chunkBounds,
  type CityChunk,
  type ClientMap,
} from "../../shared/city-stream.ts";
import { chunkOrigin, unpackSurface } from "../../shared/city-pack.ts";
import type { City } from "../../shared/world.ts";
import type { CityScene } from "../scene.ts";
import { buildSurface } from "../models/surface.ts";
import { destructibles } from "../../shared/destruction.ts";
import type { MeshGroup } from "../../shared/city-mesh.ts";
import { uploadMeshes } from "./mesh-buffers.ts";
export type GeometryOptions = {
  base?: boolean;
  roads?: boolean;
  airport?: boolean;
  bounds?: ReturnType<typeof chunkBounds>;
  index?: number;
};
type Group = { meshes: Mesh[]; dispose(): void };

/** Reference-count by stable feature IDs so objects crossing chunk seams are drawn once. */
export class CityRenderer {
  private features = new Map<string, Group>();
  /** Street polygons per chunk key; a chunk's streets never cross its seam. */
  private streets = new Map<string, Mesh[]>();
  private airport?: Group;
  constructor(
    private host: CityScene,
    private map: ClientMap,
  ) {}
  sync(chunks: CityChunk[]) {
    const saved = new Map<string, MeshGroup>();
    if (this.map.geometryVersion) {
      this.host.staticFixtures.clear();
      for (const chunk of chunks) {
        if (!chunk.geometry) throw Error("Server omitted saved chunk geometry");
        for (const [key, group] of Object.entries(chunk.geometry.features))
          saved.set(key, group);
        for (const [key, group] of Object.entries(chunk.geometry.fixtures))
          this.host.staticFixtures.set(key, group);
      }
    }
    const present = new Set(chunks.map((chunk) => chunk.key));
    for (const [key, meshes] of this.streets)
      if (!present.has(key)) {
        for (const mesh of meshes) mesh.dispose(false, !this.map.geometryVersion);
        this.streets.delete(key);
      }
    for (const chunk of chunks)
      if (!this.map.geometryVersion && chunk.surface && !this.streets.has(chunk.key))
        this.streets.set(
          chunk.key,
          buildSurface(this.host, unpackSurface(chunk.surface, chunkOrigin(chunk.key))),
        );
    const wanted = new Map<
        string,
        { field: (typeof STATIC_FIELDS)[number]; id: number; value: unknown }
      >(),
      keys = new Set(chunks.map((chunk) => chunk.key));
    for (const chunk of chunks)
      for (const field of STATIC_FIELDS)
        for (const entry of chunk[field])
          wanted.set(`${field}:${entry.id}`, { field, ...entry });
    for (const [key, group] of this.features)
      if (!wanted.has(key)) {
        group.dispose();
        this.features.delete(key);
      }
    for (const [key, entry] of wanted)
      if (!this.features.has(key)) {
        const city = emptyCity(this.map);
        Object.assign(city, { [entry.field]: [entry.value] });
        this.features.set(
          key,
          this.group(
            city,
            {
              base: false,
              roads: entry.field === "roads" && !this.map.surface,
              airport: false,
              index: entry.id,
            },
            this.map.geometryVersion ? saved.get(key) : undefined,
          ),
        );
      }
    for (const chunk of chunks)
      if (this.map.geometryVersion && !this.streets.has(chunk.key)) {
        const meshes = uploadMeshes(this.host, saved.get(`surface:${chunk.key}`) ?? []);
        for (const mesh of meshes) this.host.culling?.add(mesh);
        this.streets.set(chunk.key, meshes);
      }
    const fixtures = emptyCity(this.map);
    for (const entry of wanted.values())
      if (entry.field === "props" || entry.field === "parks" || entry.field === "roads")
        (fixtures[entry.field] as unknown[]).push(entry.value);
    this.host.destruction?.syncStatic(destructibles(fixtures));
    const a = this.map.airport,
      airportVisible = [...keys].some((key) => {
        const b = chunkBounds(key);
        return (
          b.maxX >= a.x - a.w / 2 &&
          b.minX <= a.x + a.w / 2 &&
          b.maxZ >= a.z - a.d / 2 &&
          b.minZ <= a.z + a.d / 2
        );
      });
    if (airportVisible && !this.airport)
      this.airport = this.group(
        emptyCity(this.map),
        {
          base: false,
          roads: false,
          airport: true,
        },
        this.map.geometryVersion
          ? chunks.find((chunk) => chunk.geometry?.airport)?.geometry?.airport
          : undefined,
      );
    if (!airportVisible && this.airport) {
      this.airport.dispose();
      this.airport = undefined;
    }
  }
  /** Dither out buildings crossing the camera→player line so the player stays visible. */
  fadeOccluders(camera: Vector3, target: Vector3, dt: number) {
    const dir = camera.subtract(target).normalize(),
      start = target.add(dir.scale(6)),
      blend = 1 - Math.exp(-dt * 10);
    for (const [key, group] of this.features) {
      if (!key.startsWith("buildings:")) continue;
      const hit = group.meshes.some((mesh) => {
          const box = mesh.getBoundingInfo().boundingBox;
          return segmentHitsBox(start, camera, box.minimumWorld, box.maximumWorld, 4);
        }),
        goal = hit ? 0 : 1;
      for (const mesh of group.meshes)
        mesh.visibility =
          Math.abs(goal - mesh.visibility) < 0.01
            ? goal
            : mesh.visibility + (goal - mesh.visibility) * blend;
    }
  }
  private group(city: City, options: GeometryOptions, saved?: MeshGroup): Group {
    const h = this.host,
      meshStart = h.scene.meshes.length,
      lampStart = h.lighting.lamps.length,
      signStart = h.lighting.signs.length;
    // Babylon defers onNewMeshAdded notifications. Capture synchronously so
    // batching and disposal own every mesh created by this group.
    if (this.map.geometryVersion) {
      if (!saved) throw Error("Saved mesh feature is missing");
      for (const mesh of uploadMeshes(h, saved)) h.culling?.add(mesh);
    } else {
      h.build(city, options);
      h.batchStatic(h.scene.meshes.slice(meshStart));
    }
    const meshes = h.scene.meshes.slice(meshStart) as Mesh[],
      meshSet = new Set(meshes),
      lamps = h.lighting.lamps.slice(lampStart),
      signs = h.lighting.signs.slice(signStart),
      casters = new Set(h.shadows.getShadowMap()?.renderList ?? []);
    if (!this.map.geometryVersion)
      h.shadowCandidates.push(...meshes.filter((mesh) => casters.has(mesh)));
    return {
      meshes,
      dispose() {
        for (const mesh of meshes) {
          h.shadows.removeShadowCaster(mesh);
          mesh.dispose();
        }
        h.shadowCandidates = h.shadowCandidates.filter(
          (mesh) => !meshSet.has(mesh) && !mesh.isDisposed(),
        );
        h.lights = h.lights.filter((light) => !meshSet.has(light.mesh));
        h.lighting.lamps = h.lighting.lamps.filter((lamp) => !lamps.includes(lamp));
        h.lighting.signs = h.lighting.signs.filter((sign) => !signs.includes(sign));
        for (const sign of signs) sign.dispose(false, true);
      },
    };
  }
}
