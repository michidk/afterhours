import { readdir, readFile } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
async function files(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory()
          ? files(join(path, e.name))
          : Promise.resolve(e.name.endsWith(".ts") ? [join(path, e.name)] : []),
      ),
    )
  ).flat();
}
let failures = 0;
for (const root of ["client", "server", "shared"])
  for (const file of await files(root)) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      const target = match[1],
        destination = target.startsWith(".")
          ? relative(resolve("."), resolve(file, "..", target)).split(sep)[0]
          : target;
      const forbidden =
        destination === "scripts" ||
        (root === "shared"
          ? destination === "client" ||
            destination === "server" ||
            target.startsWith("node:") ||
            target.startsWith("@babylonjs")
          : root === "client"
            ? destination === "server" || target.startsWith("node:")
            : destination === "client" || target.startsWith("@babylonjs"));
      if (forbidden) {
        console.error(`${file}: forbidden dependency ${target}`);
        failures++;
      }
    }
  }
if (failures) process.exit(1);
console.log("Architecture boundaries passed");
