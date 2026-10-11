import https from "node:https";
import { WebSocket } from "ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { decodeSnapshot, applyPatch } from "../shared/codec.ts";
import type { Entity } from "../shared/world.ts";
import { VERSION } from "../shared/version.ts";
import { CityStore } from "../server/city-stream.ts";
import { cityFileSchema } from "../shared/city-schema.ts";
const base = new URL(process.env.DEPLOY_URL || "https://localhost:8443"),
  local = base.hostname === "localhost";
const get = (path: string) =>
  new Promise<string>((resolve, reject) => {
    https
      .get(new URL(path, base), { rejectUnauthorized: !local }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          res.statusCode === 200
            ? resolve(body)
            : reject(Error("HTTP " + res.statusCode)),
        );
      })
      .on("error", reject);
  });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  sockets: WebSocket[] = [];
const connect = async (token?: string) => {
  const ws = new WebSocket(new URL("/ws", base).toString().replace("https:", "wss:"), {
    rejectUnauthorized: !local,
    origin: base.origin,
  });
  sockets.push(ws);
  const entities = new Map<string, Entity>(),
    messages: any[] = [];
  ws.on("message", (raw, binary) => {
    const m = binary ? decodeSnapshot(raw as Buffer) : JSON.parse(String(raw));
    messages.push(m);
    if (m.type === "state") {
      if (m.full) entities.clear();
      for (const e of m.entities) applyPatch(entities, e);
      for (const id of m.removed) entities.delete(id);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(
    JSON.stringify({
      type: "join",
      version: VERSION,
      name: "TLS test",
      color: "#55a9b8",
      token,
    }),
  );
  const wait = async (predicate: (m: any) => boolean) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const m = messages.find(predicate);
      if (m) return m;
      await pause(30);
    }
    throw Error("WSS assertion timeout");
  };
  return { ws, entities, wait, welcome: await wait((m) => m.type === "welcome") };
};
try {
  const html = await get("/");
  if (!html.includes("AFTERHOURS")) throw Error("Production HTML missing");
  const city = JSON.parse(await get("/city")),
    file = cityFileSchema.parse(JSON.parse(await readFile("data/city.json", "utf8"))),
    expected = new CityStore(file.city);
  if (city.mapId !== expected.manifest.mapId) throw Error("Artifact mismatch");
  const sample = JSON.parse(await get(`/city/chunks/${city.mapId}/0/0`));
  if (JSON.stringify(sample) !== JSON.stringify(expected.chunks.get("0,0")))
    throw Error("Streamed map chunk mismatch");
  const first = await connect();
  if (first.welcome.debug) throw Error("Production debug enabled");
  await first.wait((m) => m.type === "state");
  first.ws.send(JSON.stringify({ type: "debug", kind: "pistol" }));
  await pause(300);
  if (first.entities.get(first.welcome.id)?.weapon !== "fists")
    throw Error("Production cheat accepted");
  first.ws.send(
    JSON.stringify({
      type: "debugCommand",
      requestId: 1,
      command: { kind: "time", hour: 0, rate: 0 },
    }),
  );
  const denied = await first.wait((m) => m.type === "debugResult" && m.requestId === 1);
  if (!denied.error || denied.state) throw Error("Production debug RPC accepted");
  first.ws.close();
  await pause(200);
  const reconnect = await connect(first.welcome.token);
  if (reconnect.welcome.id !== first.welcome.id) throw Error("Reconnect session lost");
  let restartVerified = false;
  if (process.argv.includes("--restart")) {
    await promisify(execFile)("docker", ["compose", "restart", "game"]);
    for (let i = 0; i < 40; i++) {
      try {
        await get("/health");
        break;
      } catch {
        await pause(300);
      }
    }
    const restored = await connect(reconnect.welcome.token);
    if (restored.welcome.token === reconnect.welcome.token)
      throw Error("Old session survived a reset");
    restartVerified = true;
  }
  const health = JSON.parse(await get("/health"));
  const report = {
    date: new Date().toISOString(),
    url: base.origin,
    https: true,
    wss: true,
    artifactMatches: true,
    debugDisabled: true,
    debugRpcDenied: true,
    reconnectRestored: true,
    restartResetVerified: restartVerified,
    certificateValidation: local
      ? "Local Caddy CA: verification bypass only for this localhost test; browser must trust local CA"
      : "Public certificate verified",
    health,
  };
  await writeFile("docs/deployment-test.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const ws of sockets) ws.terminate();
}
