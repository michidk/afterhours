// Runs the same scenarios on the Rust physics and on the original TypeScript game and prints
// derived numbers side by side:  LEGACY_DIR=../main-ref tsx scripts/compare-handling.ts
import { execFileSync } from "node:child_process";
import { run as legacy } from "./legacy-lab.ts";

interface Row {
  t: number;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  lateral: number;
}
const SCENARIOS: Record<string, object> = {
  "0-20 m/s": { script: [{ seconds: 12, throttle: 1 }] },
  "flat-out 30 s": { script: [{ seconds: 30, throttle: 1 }] },
  "brake from 20": { start_speed: 20, script: [{ seconds: 6, brake: true }] },
  "coast from 30": { start_speed: 30, script: [{ seconds: 10 }] },
  "corner at 15": {
    start_speed: 15,
    script: [{ seconds: 3, throttle: 0.3, steer: 1 }],
  },
  "lock at 38": { start_speed: 38, script: [{ seconds: 4, throttle: 1, steer: 1 }] },
  "lock at 10": { start_speed: 10, script: [{ seconds: 3, throttle: 0.5, steer: 1 }] },
};
const rust = (s: object): Row[] =>
  JSON.parse(
    execFileSync(
      "cargo",
      "run -q --release -p afterhours-physics --bin handling-lab -- --trace --json"
        .split(" ")
        .concat(JSON.stringify({ ...s, sample_every: 3 })),
      { maxBuffer: 1 << 28 },
    ).toString(),
  ).trace;
const first = (rows: Row[], f: (r: Row) => boolean) => rows.find(f)?.t;
const f = (v: number | undefined, d = 1) => (v === undefined ? "-" : v.toFixed(d));
function digest(rows: Row[]) {
  const end = rows.at(-1)!,
    stop = first(rows, (r) => r.speed < 0.3 && r.t > 0.2);
  return {
    top: Math.max(...rows.map((r) => r.speed)),
    end: end.speed,
    t20: first(rows, (r) => r.speed >= 20),
    stop,
    dist: Math.hypot(end.x - rows[0].x, end.z - rows[0].z),
    yaw: Math.abs(end.yaw - rows[0].yaw) / (end.t - rows[0].t),
    slide: Math.max(...rows.map((r) => Math.abs(r.lateral))),
  };
}
for (const model of ["sedan", "sport", "van"]) {
  console.log(`\n${model}`);
  console.log(
    "scenario".padEnd(16) + "      top   end   t→20  stop  dist  yaw/s slide",
  );
  for (const [name, s] of Object.entries(SCENARIOS)) {
    const scenario = { ...s, model };
    for (const [who, rows] of [
      ["rust", rust(scenario)],
      ["main", legacy(scenario as never).trace as Row[]],
    ] as const) {
      const d = digest(rows);
      console.log(
        `${(who === "rust" ? name : "").padEnd(16)}${who}  ${f(d.top).padStart(5)} ${f(d.end).padStart(5)} ${f(d.t20).padStart(5)} ${f(d.stop).padStart(5)} ${f(d.dist, 0).padStart(5)} ${f(d.yaw, 2).padStart(5)} ${f(d.slide).padStart(5)}`,
      );
    }
  }
}
