import { defineConfig } from "vite";

// The Rust server (`cargo run -p afterhours-server`) owns the game; Vite only serves the client.
const server = process.env.SERVER_URL || "http://localhost:5174";
export default defineConfig({
  build: { rollupOptions: { input: { main: "index.html", lab: "lab.html" } } },
  server: {
    proxy: {
      "/ws": { target: server, ws: true },
      "/health": server,
      "/city": server,
    },
  },
});
