import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { ChunkDecoder, type ChunkReply } from "../client/world/chunk-decoder.ts";
import { CityStore } from "../scripts/city-store.ts";
import { emptyCity } from "../shared/city-stream.ts";

test("map workers validate chunks without blocking the input loop", async () => {
  const worker = new Worker(new URL("../scripts/chunk-worker.mjs", import.meta.url));
  const decoder = new ChunkDecoder((request) => worker.postMessage(request));
  worker.on("message", (reply: ChunkReply) => decoder.receive(reply));
  worker.on("error", (error) => decoder.fail(error));
  const city = emptyCity({ seed: 1, airport: { x: 0, z: 0, w: 100, d: 100 } });
  const chunk = new CityStore(city).chunks.get("0,0")!;
  const positions = Array.from({ length: 300000 }, () => 0);
  const mesh = {
    name: "large streamed mesh",
    positions,
    normals: positions,
    indices: [0, 1, 2],
    material: { role: "plain", color: "#fff", emissive: "#000", specular: "#000" },
    shadow: false,
  };
  const text = JSON.stringify({
    ...chunk,
    geometry: { version: 1, features: { mesh: [mesh] }, fixtures: {} },
  });
  await decoder.decode(JSON.stringify(chunk));
  let inputWakeups = 0;
  const pump = setInterval(() => inputWakeups++, 5);
  try {
    const decoded = await decoder.decode(text);
    assert.equal(decoded.geometry?.features.mesh[0].positions.length, 300000);
    assert.ok(decoded.geometry?.features.mesh[0].positions instanceof Float32Array);
    assert.deepEqual(
      decoded.geometry.features.mesh[0].indices,
      new Uint32Array([0, 1, 2]),
    );
    assert.ok(inputWakeups > 2, "input continues during mesh parsing and validation");
    await assert.rejects(decoder.decode("{}"));
    const valid = decoder.decode(JSON.stringify(chunk));
    const invalid = decoder.decode(
      text.replace('"indices":[0,1,2]', '"indices":[999999,1,2]'),
    );
    assert.equal((await valid).key, "0,0");
    await assert.rejects(invalid, /Invalid static vertex buffers/);
  } finally {
    clearInterval(pump);
    await worker.terminate();
  }
});
