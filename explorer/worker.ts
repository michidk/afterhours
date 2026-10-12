import { generateMap } from "../mapgen/pipeline.ts";
import type { GeneratedMap, MapOptions } from "../mapgen/types.ts";

export type WorkerRequest = { id: number; options: MapOptions };
export type WorkerResponse =
  | { id: number; map: GeneratedMap }
  | { id: number; error: string }
  | { id: number; progress: string };

const ctx = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};
ctx.onmessage = (event) => {
  const { id, options } = event.data;
  try {
    const map = generateMap(options, (stage) =>
      ctx.postMessage({ id, progress: stage }),
    );
    const transfer = [map.terrain.data.buffer, map.shaped.data.buffer, map.flow.buffer];
    ctx.postMessage({ id, map }, transfer);
  } catch (error) {
    ctx.postMessage({
      id,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
};
