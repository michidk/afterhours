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
        .concat(JSON.stringify({ sample_every: 3, ...s })),
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
const WALKS: Record<string, object> = {
  "walk 2 s": { script: [{ seconds: 2, throttle: 1 }] },
  "sprint 2 s": { script: [{ seconds: 2, throttle: 1, sprint: true }] },
  "walk then stop": { script: [{ seconds: 1, throttle: 1 }, { seconds: 1 }] },
  "diagonal walk": { script: [{ seconds: 2, throttle: 1, steer: 1 }] },
};
const speedAt = (rows: Row[], t: number) =>
  rows.reduce((a, r) => (Math.abs(r.t - t) < Math.abs(a.t - t) ? r : a)).speed;
console.log("\nwalker                  speed@0.1s  speed@1s  speed@1.1s  distance");
for (const [name, s] of Object.entries(WALKS)) {
  const scenario = { ...s, model: "walker", sample_every: 1 };
  for (const [who, rows] of [
    ["rust", rust(scenario)],
    ["main", legacy(scenario as never).trace as Row[]],
  ] as const) {
    const end = rows.at(-1)!;
    console.log(
      `${(who === "rust" ? name : "").padEnd(20)}${who}  ${f(speedAt(rows, 0.1), 2).padStart(8)} ${f(speedAt(rows, 1), 2).padStart(9)} ${f(speedAt(rows, 1.1), 2).padStart(10)} ${f(Math.hypot(end.x, end.z), 1).padStart(10)}`,
    );
  }
}
const CRAFT = [
  "scout",
  "utility",
  "plane",
  "aerobatic",
  "boat",
  "launch",
  "jetski",
  "racer",
  "speedboat",
  "offshore",
];
const flies = (m: string) => ["scout", "utility", "plane", "aerobatic"].includes(m);
const craftRust = (s: object): Row[] =>
  JSON.parse(
    execFileSync(process.env.CRAFT_LAB ?? "craft-lab", [JSON.stringify(s)], {
      maxBuffer: 1 << 28,
    }).toString(),
  ).trace;
const run = (model: string, pace: number) => {
  const h = flies(model) ? 40 : 0;
  const up = model.includes("plane") || model === "aerobatic";
  return {
    "accelerate 15 s": { height: up ? 0 : h, script: [{ seconds: 15, throttle: 1 }] },
    "turn at pace": {
      height: h,
      start_speed: pace,
      script: [{ seconds: 4, throttle: 1, steer: 1 }],
    },
    "coast 10 s": { height: h, start_speed: pace, script: [{ seconds: 10 }] },
    "brake 5 s": {
      height: h,
      start_speed: pace,
      script: [{ seconds: 5, throttle: -1, brake: true }],
    },
    "climb 4 s": {
      height: h,
      start_speed: pace,
      script: [{ seconds: 4, throttle: 1, ascend: true }],
    },
  };
};
console.log("\ncraft            scenario         top   end  yaw/s slide  y-end  vy");
for (const model of CRAFT) {
  const pace =
    { scout: 10, utility: 10, plane: 35, aerobatic: 40 }[model as never] ?? 8;
  for (const [name, s] of Object.entries(run(model, pace))) {
    if (!flies(model) && name === "climb 4 s") continue;
    const scenario = { ...s, model };
    for (const [who, rows] of [
      ["rust", craftRust(scenario)],
      ["main", legacy(scenario as never).trace as Row[]],
    ] as const) {
      const d = digest(rows),
        end = rows.at(-1) as Row & { y: number; vy: number };
      console.log(
        `${(who === "rust" ? model : "").padEnd(10)}${(who === "rust" ? name : "").padEnd(16)} ${who}  ${f(d.top).padStart(5)} ${f(d.end).padStart(5)} ${f(d.yaw, 2).padStart(5)} ${f(d.slide).padStart(5)} ${f(end.y).padStart(6)} ${f(end.vy).padStart(5)}`,
      );
    }
  }
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
