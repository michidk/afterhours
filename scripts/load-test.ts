import { reuseCityEnv } from "./city-files.ts";
import { decodeSnapshot } from "../shared/codec.ts";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { idle } from "../shared/world.ts";
import { VERSION } from "../shared/version.ts";
const port = 19574,
  players = 16,
  duration = Number(process.env.LOAD_SECONDS || 30),
  child = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts", "--production"],
    {
      env: { ...process.env, ...reuseCityEnv(), PORT: String(port), ALLOW_DEBUG: "0" },
      stdio: "pipe",
    },
  );
const sockets: WebSocket[] = [],
  timers: ReturnType<typeof setInterval>[] = [];
let bytes = 0,
  frames = 0,
  full = 0,
  delta = 0,
  largest = 0,
  started = 0;
try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("Startup timeout")), 10000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("AFTERHOURS")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on("error", reject);
  });
  for (let i = 0; i < players; i++) {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    let seq = 0;
    ws.on("message", (raw, binary) => {
      const size = (raw as Buffer).byteLength;
      bytes += size;
      largest = Math.max(largest, size);
      const m = binary ? decodeSnapshot(raw as Buffer) : JSON.parse(String(raw));
      if (m.type === "welcome") {
        timers.push(
          setInterval(() => {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(
                JSON.stringify({
                  type: "input",
                  seq: seq++,
                  timestamp: Date.now(),
                  ...idle(),
                  up: i % 4 === 0,
                  right: i % 4 === 1,
                  down: i % 4 === 2,
                  left: i % 4 === 3,
                }),
              );
          }, 1000 / 30),
        );
      }
      if (m.type === "state") {
        frames++;
        if (m.full) full++;
        else delta++;
      }
    });
    ws.send(
      JSON.stringify({
        type: "join",
        version: VERSION,
        name: "Load " + i,
        color: "#55a9b8",
      }),
    );
  }
  started = Date.now();
  await new Promise((r) => setTimeout(r, duration * 1000));
  const health = await (await fetch(`http://localhost:${port}/health`)).json();
  const report = {
    date: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    players,
    durationSeconds: (Date.now() - started) / 1000,
    bytes,
    bytesPerSecondPerPlayer: Math.round(bytes / duration / players),
    frames,
    full,
    delta,
    largestMessageBytes: largest,
    health,
  };
  await writeFile("docs/load-test.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if ((health as any).tickP95Ms > 33.33 || (health as any).late > 0)
    throw Error("Tick budget exceeded");
} finally {
  for (const timer of timers) clearInterval(timer);
  for (const ws of sockets) ws.terminate();
  child.kill();
}
