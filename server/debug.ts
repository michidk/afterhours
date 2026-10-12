import type { DebugCommand, DebugState } from "../shared/debug.ts";
import { VEHICLES } from "../shared/catalog.ts";
import { idle, type Entity } from "../shared/world.ts";
import type { Simulation } from "./simulation.ts";
import { groundLevel, isWater, watercraft } from "../shared/water.ts";

export function debugState(sim: Simulation, player: Entity): DebugState {
  return {
    playerId: player.id,
    time: sim.time,
    day: sim.day,
    dayRate: sim.dayRate,
    citySeed: sim.city.seed,
    traffic: sim.traffic.diagnostics,
    entities: structuredClone([...sim.entities.values()]),
    input: { ...(sim.inputs.get(player.id) || idle()) },
    destruction: {
      brokenProps: [...sim.destruction.broken],
      nearby: [...sim.destruction.fixtures.values()].filter(
        (p) => Math.hypot(p.x - player.x, p.z - player.z) < 60,
      ),
      debris: structuredClone(sim.destruction.snapshot(player, 120)),
      maxBodies: sim.destruction.maxBodies,
    },
  };
}

export function executeDebug(sim: Simulation, player: Entity, command: DebugCommand) {
  if (command.kind === "destroyProp") {
    const p = sim.destruction.fixtures.get(command.id);
    if (!p) throw Error("Unknown destructible prop");
    if (Math.hypot(p.x - player.x, p.z - player.z) > 60)
      throw Error("Prop is too far away");
    if (
      !sim.damageProp(p.id, 1000, {
        x: Math.sin(player.angle) * 5,
        y: 2,
        z: Math.cos(player.angle) * 5,
      })
    )
      throw Error("Prop is already broken or debris capacity is reached");
  }
  if (command.kind === "time") {
    sim.day = command.hour % 24;
    if (command.rate !== undefined) sim.dayRate = command.rate;
  }
  if (command.kind === "teleport") {
    if (player.vehicle || player.parachute || player.down)
      throw Error("Teleport requires a standing player on foot");
    if (
      sim.blocked(command.x, command.z) ||
      [...sim.entities.values()].some(
        (e) =>
          e.id !== player.id &&
          !e.vehicle &&
          e.y < 2 &&
          Math.hypot(e.x - command.x, e.z - command.z) < 2,
      )
    )
      throw Error("Teleport destination is obstructed");
    player.x = command.x;
    player.z = command.z;
    player.y = groundLevel(player.x, player.z, sim.city);
    player.vx = player.vz = player.vy = 0;
    sim.inputs.set(player.id, idle());
  }
  if (command.kind === "spawn") {
    if (sim.entities.size >= 300) throw Error("Entity limit reached");
    const model = VEHICLES[command.model];
    const clearance = Math.max(model.width, model.length / 2) + 1;
    let found = false;
    for (let radius = clearance + 2; radius < 40 && !found; radius += 3)
      for (let i = 0; i < 16; i++) {
        const x = player.x + Math.sin((i * Math.PI) / 8) * radius;
        const z = player.z + Math.cos((i * Math.PI) / 8) * radius;
        if (
          sim.blocked(x, z, clearance) ||
          (watercraft(model.kind)
            ? [-1, 0, 1].some((dx) =>
                [-1, 0, 1].some(
                  (dz) => !isWater(x + dx * clearance, z + dz * clearance, sim.city),
                ),
              )
            : model.kind === "car" && isWater(x, z, sim.city)) ||
          [...sim.entities.values()].some(
            (e) => !e.vehicle && Math.hypot(e.x - x, e.z - z) < clearance + 2,
          )
        )
          continue;
        sim.spawn(model.kind, x, z, undefined, command.model);
        found = true;
        break;
      }
    if (!found) throw Error("No clear spawn site nearby");
  }
  return debugState(sim, player);
}
