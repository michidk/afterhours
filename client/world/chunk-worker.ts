import { decodeChunk, transferChunk, type ChunkRequest } from "./chunk-decoder.ts";

globalThis.onmessage = (event: MessageEvent<ChunkRequest>) => {
  const reply = decodeChunk(event.data);
  globalThis.postMessage(reply, { transfer: transferChunk(reply) });
};
