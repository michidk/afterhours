// The handling lab for the original TypeScript game (`main`): the same scenario JSON as
// `handling-lab`, run through that branch's own `predictStep` on empty flat ground.
//   LEGACY_DIR=../main-ref tsx scripts/legacy-lab.ts '{"start_speed":20,"script":[{"seconds":5,"brake":true}]}'
//   LEGACY_DIR=../main-ref tsx scripts/legacy-lab.ts corner-15
// Only flat ground exists on main (no pitch, roll or suspension), so it answers the speed,
// braking and turning scenarios. Metrics that need 3D read 0.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = resolve(process.env.LEGACY_DIR ?? "../main-ref"),
  load = (p: string) => import(pathToFileURL(resolve(dir, p)).href);
const [{ predictStep }, { generateCity }, { idle }, { VEHICLES }] = await Promise.all([
  load("shared/physics/index.ts"),
  load("scripts/city-generator.ts"),
  load("shared/world.ts"),
  load("shared/catalog.ts"),
]);

interface Step {
  seconds: number;
  throttle?: number;
  steer?: number;
  brake?: boolean;
  sprint?: boolean;
  ascend?: boolean;
  descend?: boolean;
}
interface Scenario {
  model?: string;
  height?: number;
  start_speed?: number;
  script: Step[];
  sample_every?: number;
}
const TICK = 1 / 30;

export function run(s: Scenario) {
  const city = generateCity();
  city.buildings = [];
  city.props = [];
  city.ramps = [];
  const walker = s.model === "walker";
  // Helicopters, planes and boats: the model's catalogue kind picks the physics.
  const kind: string = walker
    ? "player"
    : (VEHICLES[s.model ?? "sedan"]?.kind ?? "car");
  const craft = !walker && kind !== "car";
  // Boats start in open water off the western shore, where the generated city has sea.
  const sea = craft && ["boat", "jetski", "speedboat"].includes(kind);
  const e: any = {
    id: "car",
    kind,
    ...(walker
      ? { character: { physique: "regular" } }
      : { model: s.model ?? "sedan" }),
    ...(craft ? { flight: (s.height ?? 0) > 0.2 ? "cruising" : "grounded" } : {}),
    x: sea ? -1650 : 0,
    y: s.height ?? 0,
    z: sea ? -200 : 0,
    vx: 0,
    vy: 0,
    vz: s.start_speed ?? 0,
    angle: 0,
    health: 100,
    color: "#fff",
    ...(walker ? {} : { driver: "p" }),
  };
  const trace: any[] = [];
  let t = 0,
    index = 0;
  for (const step of s.script) {
    const input = {
      ...idle(),
      moveY: step.throttle ?? 0,
      moveX: step.steer ?? 0,
      brake: !walker && !!step.brake,
      sprint: !!step.sprint,
      ascend: !!step.ascend,
      descend: !!step.descend,
    };
    for (let i = 0; i < Math.round(step.seconds / TICK); i++) {
      predictStep(e, input, city, [], TICK);
      t += TICK;
      const sn = Math.sin(e.angle),
        cs = Math.cos(e.angle);
      const row = {
        t,
        x: e.x,
        y: e.y,
        z: e.z,
        yaw: e.angle,
        speed: Math.hypot(e.vx, e.vz),
        forward: e.vx * sn + e.vz * cs,
        lateral: e.vx * cs - e.vz * sn,
        vy: e.vy,
      };
      if (index++ % (s.sample_every ?? 5) === 0) trace.push(row);
    }
  }
  return { trace };
}

const arg = process.argv[2] ?? "";
const presets: Record<string, Scenario> = {
  idle: { script: [{ seconds: 4 }] },
  "flat-out": { script: [{ seconds: 30, throttle: 1 }] },
  "brake-from-20": { start_speed: 20, script: [{ seconds: 5, brake: true }] },
  "corner-15": { start_speed: 15, script: [{ seconds: 3, throttle: 0.3, steer: 1 }] },
  "full-lock-at-speed": {
    start_speed: 38,
    script: [{ seconds: 4, throttle: 1, steer: 1 }],
  },
};
if (arg) {
  const scenario = arg.startsWith("{") ? JSON.parse(arg) : presets[arg];
  console.log(JSON.stringify(run(scenario)));
}
