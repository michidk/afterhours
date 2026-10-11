import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { Simulation } from "./simulation.ts";
import { idle, type Input } from "../shared/world.ts";
const production = process.argv.includes("--production"),
  port = Number(process.env.PORT || 5173);
const sim = new Simulation();
const vite = production
  ? null
  : await (
      await import("vite")
    ).createServer({ server: { middlewareMode: true }, appType: "spa" });
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ ok: true, players: sim.inputs.size, tick: sim.time }),
    );
    return;
  }
  if (vite) {
    vite.middlewares(req, res);
    return;
  }
  try {
    const path = resolve("dist", "." + (req.url?.split("?")[0] || "/"));
    if (
      !path.startsWith(resolve("dist") + "/") &&
      !path.startsWith(resolve("dist") + "\\") &&
      path !== resolve("dist")
    ) {
      res.writeHead(403).end();
      return;
    }
    const file = extname(path) ? path : resolve("dist/index.html");
    res.setHeader(
      "Content-Type",
      (
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".png": "image/png",
        } as Record<string, string>
      )[extname(file)] || "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end("Not found");
  }
});
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });
const clients = new Map<
  WebSocket,
  {
    id?: string;
    count: number;
    window: number;
    last: number;
    lastInput: number;
  }
>();
const send = (ws: WebSocket, data: unknown) => {
  if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1_000_000)
    ws.send(JSON.stringify(data));
};
const debug = process.env.ALLOW_DEBUG === "1" || !production;
wss.on("connection", (ws, req) => {
  const origin = req.headers.origin;
  let validOrigin = true;
  try {
    validOrigin = !origin || new URL(origin).host === req.headers.host;
  } catch {
    validOrigin = false;
  }
  if (!validOrigin) {
    ws.close(1008, "Origin rejected");
    return;
  }
  if (clients.size >= 64) {
    ws.close(1013, "City is full");
    return;
  }
  const client = {
    id: undefined as string | undefined,
    count: 0,
    window: Date.now(),
    last: Date.now(),
    lastInput: Date.now(),
  };
  clients.set(ws, client);
  ws.on("message", (raw) => {
    try {
      const now = Date.now();
      if (now - client.window > 1000) {
        client.count = 0;
        client.window = now;
      }
      if (++client.count > 90) return;
      const m = JSON.parse(raw.toString());
      client.last = now;
      if (m.type === "join" && !client.id) {
        const name =
            String(m.name || "Stranger")
              .replace(/[<>\x00-\x1f]/g, "")
              .trim()
              .slice(0, 18) || "Stranger",
          color = /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : "#edaa48";
        const p = sim.join(name, color);
        client.id = p.id;
        send(ws, { type: "welcome", id: p.id, city: sim.city, debug });
        return;
      }
      if (!client.id) return;
      if (m.type === "input") {
        client.lastInput = now;
        const input = idle();
        for (const key of Object.keys(input) as (keyof Input)[])
          input[key] = m[key] === true;
        sim.inputs.set(client.id, input);
      }
      if (m.type === "interact") sim.interact(client.id);
      if (m.type === "chat" && typeof m.text === "string") {
        const text = m.text.trim().slice(0, 160);
        if (text)
          for (const peer of clients.keys())
            send(peer, {
              type: "chat",
              name: sim.entities.get(client.id)?.name,
              text,
            });
      }
      if (m.type === "debug" && debug) {
        const p = sim.entities.get(client.id)!;
        if (
          ["car", "helicopter", "plane"].includes(m.kind) &&
          sim.entities.size < 300
        ) {
          for (let radius = 5; radius < 25; radius += 3) {
            const point = Array.from({ length: 12 }, (_, i) => ({
              x: p.x + Math.sin((i * Math.PI) / 6) * radius,
              z: p.z + Math.cos((i * Math.PI) / 6) * radius,
            })).find(
              (pos) =>
                !sim.blocked(pos.x, pos.z, 3) &&
                ![...sim.entities.values()].some(
                  (e) => Math.hypot(e.x - pos.x, e.z - pos.z) < 4,
                ),
            );
            if (point) {
              sim.spawn(m.kind, point.x, point.z);
              break;
            }
          }
        }
        if (m.kind === "pistol" || m.kind === "bat") p.weapon = m.kind;
        if (m.kind === "heal") {
          p.health = 100;
          p.down = 0;
        }
        if (m.kind === "day") sim.day = 12;
        if (m.kind === "night") sim.day = 0;
      }
    } catch {
      /* Ignore malformed untrusted messages. */
    }
  });
  ws.on("close", () => {
    if (client.id) sim.leave(client.id);
    clients.delete(ws);
  });
});
let ticks = 0;
setInterval(() => {
  for (const [ws, c] of clients) {
    if (Date.now() - c.last > 30000) {
      ws.close(1001, "Idle connection");
      continue;
    }
    if (c.id && Date.now() - c.lastInput > 500) sim.inputs.set(c.id, idle());
  }
  sim.tick(1 / 30);
  if (++ticks % 2 === 0) {
    const snapshot = {
      type: "state",
      time: sim.time,
      day: sim.day,
      entities: [...sim.entities.values()],
      events: sim.events,
      players: sim.inputs.size,
    };
    for (const [ws, c] of clients) if (c.id) send(ws, snapshot);
  }
}, 1000 / 30);
server.listen(port, "0.0.0.0", () =>
  console.log(
    `AFTERHOURS http://localhost:${port} — debug ${debug ? "enabled" : "disabled"}`,
  ),
);
