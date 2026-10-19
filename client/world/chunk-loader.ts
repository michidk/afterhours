import { cityChunkSchema } from "../../shared/city-stream.ts";
import { ChunkDecoder, type ChunkReply } from "./chunk-decoder.ts";

export function createChunkDecoder() {
  // Unit fixtures without a browser can decode directly; live bots inject a worker.
  if (typeof Worker === "undefined")
    return async (text: string) => cityChunkSchema.parse(JSON.parse(text));
  const worker = new Worker(new URL("./chunk-worker.ts", import.meta.url), {
    type: "module",
  });
  const decoder = new ChunkDecoder((request) => worker.postMessage(request));
  worker.onmessage = (event: MessageEvent<ChunkReply>) => decoder.receive(event.data);
  worker.onerror = (event) => decoder.fail(new Error(event.message));
  return decoder.decode;
}
