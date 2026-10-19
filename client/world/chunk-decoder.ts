import { cityChunkSchema, type CityChunk } from "../../shared/city-stream.ts";

export type ChunkRequest = { id: number; text: string };
export type ChunkReply =
  { id: number; chunk: CityChunk } | { id: number; error: string };

export function decodeChunk({ id, text }: ChunkRequest): ChunkReply {
  try {
    return { id, chunk: cityChunkSchema.parse(JSON.parse(text)) };
  } catch (error) {
    return { id, error: String(error) };
  }
}

/** Transfer mesh memory so receiving a neighborhood cannot pause inputs to clone it. */
export function transferChunk(reply: ChunkReply) {
  const buffers: ArrayBuffer[] = [];
  if ("error" in reply || !reply.chunk.geometry) return buffers;
  const geometry = reply.chunk.geometry;
  for (const group of [
    ...Object.values(geometry.features),
    ...Object.values(geometry.fixtures),
    geometry.airport ?? [],
  ])
    for (const mesh of group) {
      for (const field of ["positions", "normals", "uvs", "colors"] as const) {
        const values = mesh[field];
        if (!values) continue;
        const buffer = new Float32Array(values);
        mesh[field] = buffer;
        buffers.push(buffer.buffer);
      }
      const indices = new Uint32Array(mesh.indices);
      mesh.indices = indices;
      buffers.push(indices.buffer);
    }
  return buffers;
}

/** Browser and live-test workers use the same validation and request ordering. */
export class ChunkDecoder {
  private serial = 0;
  private error: Error | undefined;
  private pending = new Map<
    number,
    { resolve: (chunk: CityChunk) => void; reject: (error: Error) => void }
  >();
  constructor(private send: (request: ChunkRequest) => void) {}
  decode = (text: string): Promise<CityChunk> => {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const id = this.serial++;
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ id, text });
      } catch (error) {
        this.fail(new Error(String(error)));
      }
    });
  };
  receive(reply: ChunkReply) {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if ("error" in reply) pending.reject(new Error(reply.error));
    else pending.resolve(reply.chunk);
  }
  fail(error: Error) {
    this.error = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
