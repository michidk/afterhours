import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Regenerate the city and its meshes with the current generator before loading
 * them, replacing the files on disk. Generation runs in its own process because
 * mesh baking uses the client renderer, which the server must not import.
 * `CITY_REGENERATE=0` skips it and serves the files as they are.
 */
export async function regenerateCity() {
  if (process.env.CITY_REGENERATE === "0") return;
  const script = fileURLToPath(new URL("../scripts/prepare-city.ts", import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(Error(`City generation failed with code ${code}; see the log above`)),
    );
  });
}
