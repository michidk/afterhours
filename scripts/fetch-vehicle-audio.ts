/** Manual CC0 source acquisition; never imported by the game. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const index = process.argv.indexOf("--source-dir");
if (index < 0 || !process.argv[index + 1])
  throw Error("Pass --source-dir for the downloaded originals");
const directory = resolve(process.argv[index + 1]);
await mkdir(directory, { recursive: true });
const sources: Record<string, string> = {
  "engine-sedan.mp3": "https://bigsoundbank.com/UPLOAD/mp3/0291.mp3",
  "engine-sport.mp3": "https://bigsoundbank.com/UPLOAD/mp3/0534.mp3",
  "engine-van.mp3": "https://bigsoundbank.com/UPLOAD/mp3/1145.mp3",
  "engine-van-alt.mp3": "https://bigsoundbank.com/UPLOAD/mp3/0967.mp3",
  "tyre-2368.mp3": "https://bigsoundbank.com/UPLOAD/mp3/2368.mp3",
  "tyre-2370.mp3": "https://bigsoundbank.com/UPLOAD/mp3/2370.mp3",
  "tyre-2371.mp3": "https://bigsoundbank.com/UPLOAD/mp3/2371.mp3",
  "sedan-idle.mp3": "https://cdn.freesound.org/previews/384/384107_7109435-hq.mp3",
  "jetski.mp3": "https://cdn.freesound.org/previews/212/212441_2449158-hq.mp3",
  "boat-outboard.mp3": "https://cdn.freesound.org/previews/690/690160_938246-hq.mp3",
};
for (const [name, url] of Object.entries(sources)) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`${name}: HTTP ${response.status}`);
  await writeFile(join(directory, name), Buffer.from(await response.arrayBuffer()));
  console.log("Downloaded " + name);
}
