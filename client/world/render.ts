import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import {
  STATIC_FIELDS,
  emptyCity,
  chunkBounds,
  type CityChunk,
  type MapManifest,
} from "../../shared/city-stream.ts";
import type { City } from "../../shared/world.ts";
import type { CityScene } from "../scene.ts";
import { destructibles } from "../../shared/destruction.ts";
export type GeometryOptions = {
  base?: boolean;
  roads?: boolean;
  airport?: boolean;
  bounds?: ReturnType<typeof chunkBounds>;
  index?: number;
};
type Group = { dispose(): void };

/** Reference-count by stable feature IDs so objects crossing chunk seams are drawn once. */
export class CityRenderer {
  private features = new Map<string, Group>();
  private airport?: Group;
  constructor(
    private host: CityScene,
    private map: MapManifest,
  ) {}
  sync(chunks: CityChunk[]) {
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
          this.group(city, {
            base: false,
            roads: entry.field === "roads" && !this.map.surface,
            airport: false,
            index: entry.id,
          }),
        );
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
      this.airport = this.group(emptyCity(this.map), {
        base: false,
        roads: false,
        airport: true,
      });
    if (!airportVisible && this.airport) {
      this.airport.dispose();
      this.airport = undefined;
    }
  }
  private group(city: City, options: GeometryOptions): Group {
    const h = this.host,
      meshStart = h.scene.meshes.length,
      lampStart = h.lighting.lamps.length,
      signStart = h.lighting.signs.length;
    // Babylon defers onNewMeshAdded notifications. Capture synchronously so
    // batching and disposal own every mesh created by this group.
    h.build(city, options);
    h.batchStatic(h.scene.meshes.slice(meshStart));
    const meshes = h.scene.meshes.slice(meshStart) as Mesh[],
      meshSet = new Set(meshes),
      lamps = h.lighting.lamps.slice(lampStart),
      signs = h.lighting.signs.slice(signStart),
      casters = new Set(h.shadows.getShadowMap()?.renderList ?? []);
    h.shadowCandidates.push(...meshes.filter((mesh) => casters.has(mesh)));
    return {
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
