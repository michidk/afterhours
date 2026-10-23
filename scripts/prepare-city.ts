// Regenerates the city artifact (native Rust generator) and bakes its static meshes with
// the current generator, replacing whatever is on disk. The server runs this before it loads
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

// The generator is the native Rust binary (crates/mapgen). Deployments set CITY_GENERATOR to a
// built binary; development compiles and runs it through cargo.
// CITY_WORLD=test builds the hand-made test world instead (docs/test-world.md).
const testWorld = process.env.CITY_WORLD === "test";
const generator = process.env.CITY_GENERATOR;
const native = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const [command, ...prefix] = generator
      ? [generator]
      : [
          "cargo",
          "run",
          "--release",
          "-q",
          "-p",
          "afterhours-mapgen",
          "--bin",
          testWorld ? "generate-test-world" : "generate-city",
          "--",
        ];
    const child = spawn(command, [...prefix, ...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`city generator exited with code ${code}`)),
    );
  });

const started = performance.now();
await native(testWorld ? ["--out", city] : ["--seed", seed, "--out", city]);
await run("./bake-city-meshes.ts", ["--city", city, "--out", meshes]);
console.log(
  `City ${seed} prepared in ${((performance.now() - started) / 1000).toFixed(1)} s`,
);
