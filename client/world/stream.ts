import {
  chunksAround,
  cityChunkSchema,
  emptyCity,
  STATIC_FIELDS,
  CITY_CHUNK_SIZE,
  type CityChunk,
  type ClientMap,
} from "../../shared/city-stream.ts";
import { spawnOrigin } from "../../shared/world.ts";
import { TUNING } from "../../shared/catalog.ts";

// Cover snapshot neighbours and their local physics queries before predicting.
export const COLLISION_RADIUS = TUNING.interestRadius + 32;
export const SCENERY_RADIUS = 512;
const PREFETCH_RADIUS = COLLISION_RADIUS + CITY_CHUNK_SIZE;

/** Memory-only neighborhood cache shared by rendering and provisional collisions. */
export class CityStream {
  readonly city;
  readonly chunks = new Map<string, CityChunk>();
  private wanted = new Set<string>();
  private visible = new Set<string>();
  private pending = new Map<string, AbortController>();
  private retries = new Map<string, number>();
  error = "";
  constructor(
    readonly map: ClientMap,
    private changed: (chunks: CityChunk[]) => void,
    private download: typeof fetch = (...args) => fetch(...args),
  ) {
    this.city = emptyCity(map);
  }

  setView(
    player: { x: number; z: number } | undefined,
    camera: { x: number; z: number },
    radius = SCENERY_RADIUS,
  ) {
    const visible = new Set(chunksAround(camera.x, camera.z, radius)),
      visibilityChanged =
        visible.size !== this.visible.size ||
        [...visible].some((key) => !this.visible.has(key)),
      required = new Set(
        player ? chunksAround(player.x, player.z, COLLISION_RADIUS) : [],
      ),
      wanted = new Set(visible);
    this.visible = visible;
    if (player)
      for (const key of chunksAround(player.x, player.z, PREFETCH_RADIUS))
        wanted.add(key);
    this.wanted = wanted;
    let changed = false;
    for (const [key, controller] of this.pending)
      if (!wanted.has(key)) controller.abort();
    for (const key of this.chunks.keys())
      if (!wanted.has(key)) {
        this.chunks.delete(key);
        changed = true;
      }
    for (const key of this.retries.keys())
      if (!wanted.has(key)) this.retries.delete(key);
    if (changed) this.publish();
    else if (visibilityChanged) this.changed(this.renderChunks());
    const order = [...wanted].sort((a, b) => {
      const distance = (key: string) => {
        const [x, z] = key.split(",").map(Number);
        return Math.hypot(
          (x + 0.5) * this.map.chunkSize - (player?.x ?? camera.x),
          (z + 0.5) * this.map.chunkSize - (player?.z ?? camera.z),
        );
      };
      const priority = (key: string) =>
        required.has(key) ? 0 : visible.has(key) ? 1 : 2;
      return priority(a) - priority(b) || distance(a) - distance(b);
    });
    for (const key of order) {
      if (this.pending.size >= 4) break;
      if (
        this.chunks.has(key) ||
        this.pending.has(key) ||
        (this.retries.get(key) ?? 0) > Date.now()
      )
        continue;
      void this.load(key);
    }
  }
  ready(point: { x: number; z: number }, radius = COLLISION_RADIUS) {
    return chunksAround(point.x, point.z, radius).every((key) => this.chunks.has(key));
  }
  async prepare(center = spawnOrigin(this.map)) {
    const deadline = Date.now() + 30000;
    do {
      this.setView(undefined, center, Math.max(SCENERY_RADIUS, COLLISION_RADIUS));
      if ([...this.wanted].every((key) => this.chunks.has(key))) return;
      if (Date.now() > deadline)
        throw Error(this.error || "Neighborhood download timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (true);
  }
  private async load(key: string) {
    const controller = new AbortController();
    this.pending.set(key, controller);
    try {
      const [x, z] = key.split(",");
      const response = await this.download(`/city/chunks/${this.map.mapId}/${x}/${z}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok)
        throw Error(
          response.status === 409
            ? "The server map changed. Refresh to reconnect."
            : `Neighborhood download failed (${response.status})`,
        );
      const chunk = cityChunkSchema.parse(await response.json());
      if (chunk.mapId !== this.map.mapId || chunk.key !== key)
        throw Error("Map chunk identity mismatch");
      if (controller.signal.aborted || !this.wanted.has(key)) return;
      this.chunks.set(key, chunk);
      this.retries.delete(key);
      this.error = "";
      this.publish();
    } catch (error) {
      if (!controller.signal.aborted) {
        this.error = String(error);
        this.retries.set(key, Date.now() + 1000);
      }
    } finally {
      if (this.pending.get(key) === controller) this.pending.delete(key);
    }
  }
  private publish() {
    const chunks = [...this.chunks.values()];
    for (const field of STATIC_FIELDS) {
      const values = new Map<number, unknown>();
      for (const chunk of chunks)
        for (const entry of chunk[field]) values.set(entry.id, entry.value);
      // Replace array identities so shared static-geometry caches invalidate.
      Object.assign(this.city, {
        [field]: [...values].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]),
      });
    }
    this.changed(this.renderChunks());
  }
  private renderChunks() {
    return [...this.chunks.values()].filter((chunk) => this.visible.has(chunk.key));
  }
  get diagnostics() {
    return {
      mapId: this.map.mapId,
      resident: this.chunks.size,
      rendered: this.renderChunks().length,
      wanted: this.wanted.size,
      pending: this.pending.size,
      error: this.error,
    };
  }
}
