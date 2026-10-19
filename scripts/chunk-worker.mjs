import { parentPort } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
const { decodeChunk, transferChunk } = await import("../client/world/chunk-decoder.ts");
parentPort.on("message", (request) => {
  const reply = decodeChunk(request);
  parentPort.postMessage(reply, transferChunk(reply));
});
