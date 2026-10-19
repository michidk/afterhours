import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { Sessions } from "./session.ts";
import { Runtime } from "./runtime.ts";
import { loadCity } from "./city-loader.ts";
import { Simulation } from "./simulation.ts";
import { CityStore } from "./city-stream.ts";
import { loadCityMeshes } from "./city-mesh-loader.ts";
import { VERSION } from "../shared/version.ts";
import { regenerateCity } from "./city-regenerate.ts";
import { readTcpQueues } from "./tcp-queues.ts";

const production = process.argv.includes("--production"),
  port = Number(process.env.PORT || 5173);
// Every boot rebuilds the city with the current generator before serving it.
await regenerateCity();
const sim = new Simulation(await loadCity());
// Build terrain colliders before accepting players, not on the first prop impact.
sim.destruction.prepare();
const cityStore = new CityStore(sim.city);
await loadCityMeshes(cityStore);
const vite = production
  ? null
  : await (
      await import("vite")
    ).createServer({ server: { middlewareMode: true }, appType: "spa" });
const server = http.createServer(async (req, res) => {
  if (cityStore.serve(req, res)) return;
  if (req.url === "/health") {
    const address = server.address();
    const kernelTransport =
      sessions.debug && address && typeof address !== "string"
        ? await readTcpQueues(address.port)
        : undefined;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        version: VERSION,
        time: sim.time,
        ...runtime.metrics(),
        ...(kernelTransport ? { kernelTransport } : {}),
      }),
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
const sessions = new Sessions(server, sim, production, cityStore.manifest);
const runtime = new Runtime(sim, sessions);
runtime.start();
server.listen(port, "0.0.0.0", () => {
  const address = server.address(),
    boundPort = typeof address === "object" && address ? address.port : port;
  console.log(
    `AFTERHOURS http://localhost:${boundPort} — debug ${sessions.debug ? "enabled" : "disabled"}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    runtime.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
