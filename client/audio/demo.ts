import { idle, type Entity, type Input } from "../../shared/world.ts";

export type VehicleDemo =
  "sedan" | "sport" | "van" | "boat" | "jetski" | "speedboat" | "helicopter" | "plane";
export type DemoScenario = "drive" | "drift" | "pass";
export const DEMO_DURATION = 16;
export function demoFrame(
  vehicle: VehicleDemo,
  scenario: DemoScenario,
  time: number,
): { entity: Entity; listener: Entity; input: Input; phase: string } {
  const car = ["sedan", "sport", "van"].includes(vehicle);
  const kind = car ? "car" : (vehicle as Entity["kind"]);
  const listener: Entity = {
    id: "demo-listener",
    kind: "player",
    x: 0,
    y: 0,
    z: 0,
    angle: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    color: "#fff",
    health: 100,
  };
  const input = idle();
  const t = Math.max(0, Math.min(DEMO_DURATION, time));
  let speed = t < 2 ? 0 : t < 9 ? (t - 2) * 4 : Math.max(0, 28 - (t - 9) * 4);
  let phase = t < 2 ? "Idle" : t < 9 ? "Accelerating" : "Coasting";
  input.up = t >= 2 && t < 9;
  let x = 0,
    z = 0,
    lateral = 0,
    skidding = false;
  if (scenario === "pass") {
    speed = 16;
    x = -112 + t * 16;
    z = 8;
    input.up = true;
    phase = x < 0 ? "Approaching" : "Moving away";
  } else {
    listener.vehicle = "demo-vehicle";
    listener.vz = speed;
  }
  if (scenario === "drift" && t >= 5 && t < 12) {
    speed = 18;
    lateral = 2 + Math.sin(((t - 5) / 7) * Math.PI) * 7;
    skidding = car;
    input.brake = car;
    input.up = true;
    phase = car ? "Tyres sliding" : "Powered turn";
  } else if (scenario === "drift" && t >= 12) phase = "Grip recovery / coast";
  const powered = t < 15.5;
  const entity: Entity = {
    ...listener,
    id: "demo-vehicle",
    kind,
    vehicle: undefined,
    model: car ? (vehicle as "sedan" | "sport" | "van") : undefined,
    driver: powered ? listener.id : undefined,
    x,
    z,
    vx: scenario === "pass" ? speed : lateral,
    vz: scenario === "pass" ? 0 : speed,
    angle: scenario === "pass" ? Math.PI / 2 : 0,
    health: 100,
    maxHealth: 100,
    skidding,
    wheelSkids: [false, false, skidding, skidding],
    flight: powered ? (t < 2 ? "takingOff" : "cruising") : "grounded",
  };
  return { entity, listener, input, phase: powered ? phase : "Engine off" };
}
