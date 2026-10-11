import {
  chunksAround,
  cityChunkSchema,
  emptyCity,
  STATIC_FIELDS,
  type CityChunk,
  type MapManifest,
} from "../../shared/city-stream.ts";

/** Memory-only neighborhood cache shared by rendering and provisional collisions. */
export class CityStream {
  readonly city;
  readonly chunks = new Map<string, CityChunk>();
  private wanted = new Set<string>();
  private pending = new Map<string, AbortController>();
  private retries = new Map<string, number>();
  error = "";
  constructor(
    readonly map: MapManifest,
    private changed: (chunks: CityChunk[]) => void,
    private download: typeof fetch = (...args) => fetch(...args),
  ) {
    this.city = emptyCity(map);
  }

  setView(
    player: { x: number; z: number } | undefined,
    camera: { x: number; z: number },
    radius = 160,
  ) {
    const wanted = new Set(chunksAround(camera.x, camera.z, radius));
    if (player) for (const key of chunksAround(player.x, player.z, 96)) wanted.add(key);
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
    const order = [...wanted].sort((a, b) => {
      const distance = (key: string) => {
        const [x, z] = key.split(",").map(Number);
        return Math.hypot(
          (x + 0.5) * this.map.chunkSize - (player?.x ?? camera.x),
          (z + 0.5) * this.map.chunkSize - (player?.z ?? camera.z),
        );
      };
      return distance(a) - distance(b);
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
  ready(point: { x: number; z: number }, radius = 48) {
    return chunksAround(point.x, point.z, radius).every((key) => this.chunks.has(key));
  }
  async prepare(center = { x: 11, z: 25 }) {
    const deadline = Date.now() + 30000;
    do {
      this.setView(center, center, 160);
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
    this.changed(chunks);
  }
  get diagnostics() {
    return {
      mapId: this.map.mapId,
      resident: this.chunks.size,
      wanted: this.wanted.size,
      pending: this.pending.size,
      error: this.error,
    };
  }
}
