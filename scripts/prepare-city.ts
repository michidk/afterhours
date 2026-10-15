// Regenerates the city artifact and bakes its static meshes with the current
// generator, replacing whatever is on disk. The server runs this before it loads
// the city, so generator changes always land on the next boot.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const seed = process.env.CITY_SEED || "713",
  city = process.env.CITY_PATH || "data/city.json",
  meshes = process.env.CITY_MESH_PATH || "data/city-meshes.msgpack";
if (!/^-?\d+$/.test(seed)) throw Error(`CITY_SEED must be an integer, got ${seed}`);

const run = (script: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL(script, import.meta.url)), ...args],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`${script} exited with code ${code}`)),
    );
  });

const started = performance.now();
await run("./generate-city.ts", ["--seed", seed, "--out", city]);
await run("./bake-city-meshes.ts", ["--city", city, "--out", meshes]);
console.log(
  `City ${seed} prepared in ${((performance.now() - started) / 1000).toFixed(1)} s`,
);
