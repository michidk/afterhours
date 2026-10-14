import { Session } from "node:inspector/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { predictionWorkload } from "./prediction-workload.ts";

const profiler = process.argv.includes("--cpu-profile") ? new Session() : undefined;
if (profiler) {
  profiler.connect();
  await profiler.post("Profiler.enable");
  await profiler.post("Profiler.start");
}
try {
  const runs = Array.from({ length: profiler ? 1 : 5 }, () => predictionWorkload());
  console.log(JSON.stringify({ runs }, null, 2));
} finally {
  if (profiler) {
    const { profile } = await profiler.post("Profiler.stop");
    await mkdir("test-results", { recursive: true });
    await writeFile("test-results/prediction.cpuprofile", JSON.stringify(profile));
    profiler.disconnect();
  }
}
