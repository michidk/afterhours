import { defineConfig } from "vite";

/** Separate tool build: the map explorer never joins the game bundle. */
export default defineConfig({
  root: "explorer",
  publicDir: false,
  server: { port: 5180, strictPort: true },
  build: { outDir: "../dist-explorer", emptyOutDir: true },
});
