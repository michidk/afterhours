import type { DebugCommand, DebugState } from "../shared/debug.ts";
import { VEHICLES } from "../shared/catalog.ts";
import { idle, type Entity } from "../shared/world.ts";
import type { Simulation } from "./simulation.ts";
import {
  groundLevel,
  isWater,
  surfaceLevel,
  watercraft,
  WORLD_LIMIT,
} from "../shared/water.ts";
import { vehicle } from "../shared/physics/collision.ts";
import { vehicleSeats } from "../shared/seats.ts";

export function debugState(sim: Simulation, player: Entity, full = true): DebugState {
  return {
    playerId: player.id,
    time: sim.time,
    day: sim.day,
    dayRate: sim.dayRate,
    citySeed: sim.city.seed,
    traffic: sim.traffic.diagnostics,
    entities: full ? structuredClone([...sim.entities.values()]) : [],
    input: { ...(sim.inputs.get(player.id) || idle()) },
    destruction: {
      brokenProps: full ? [...sim.destruction.broken] : [],
      nearby: full
        ? [...sim.destruction.fixtures.values()].filter(
            (p) => Math.hypot(p.x - player.x, p.z - player.z) < 60,
          )
        : [],
      debris: full ? structuredClone(sim.destruction.snapshot(player, 120)) : [],
      maxBodies: sim.destruction.maxBodies,
    },
  };
}

export function executeDebug(sim: Simulation, player: Entity, command: DebugCommand) {
  if (command.kind === "observe") {
    const entity = command.id ? sim.entities.get(command.id) : undefined;
    return {
      ...debugState(sim, player, false),
      inspection: entity
        ? {
            id: entity.id,
            data: JSON.stringify(
              {
                entity,
                input: sim.inputs.get(entity.id),
                vehicle: entity.model ? VEHICLES[entity.model] : undefined,
                citizen: sim.ai.citizens.inspect(entity),
                route: sim.ai.routes.get(entity.id),
                waterRoute: sim.ai.waterRoutes.get(entity.id),
              },
              null,
              2,
            ),
          }
        : null,
    };
  }
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
  if (command.kind === "teleport")
    relocate(sim, player, command, { exact: true, search: !!command.near });
  if (command.kind === "gotoPlayer") {
    const anchor = body(sim, otherPlayer(sim, player, command.id));
    relocate(sim, player, anchor, { start: reach(anchor) + 3 });
  }
  if (command.kind === "bringPlayer") {
    const anchor = body(sim, player);
    relocate(sim, otherPlayer(sim, player, command.id), anchor, {
      start: reach(anchor) + 3,
    });
  }
  if (command.kind === "spawn") {
    if (sim.entities.size >= 600) throw Error("Entity limit reached");
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

/** A human other than the requester; the session also requires a live connection. */
function otherPlayer(sim: Simulation, player: Entity, id: string) {
  const other = sim.entities.get(id);
  if (!other || other.kind !== "player" || other.ai) throw Error("Unknown player");
  if (other.id === player.id) throw Error("Choose another player");
  return other;
}

/** Where a player physically is: their vehicle while seated. */
function body(sim: Simulation, player: Entity) {
  return (player.vehicle && sim.entities.get(player.vehicle)) || player;
}

/** Horizontal half-extent used for clearance: a vehicle footprint, or a person. */
function reach(e: Entity) {
  if (!e.model) return 0.4;
  const model = VEHICLES[e.model];
  return Math.max(model.width, model.length / 2);
}

/** True when a person or vehicle can stand at x, z without overlapping anything. */
function siteFits(
  sim: Simulation,
  mover: Entity,
  x: number,
  z: number,
  ignore: Set<string>,
  dry: boolean,
) {
  const radius = vehicle(mover) ? reach(mover) + 1 : 0.6;
  if (sim.blocked(x, z, radius)) return false;
  if (watercraft(mover.kind)) {
    // The whole hull must float, as when spawning a boat.
    for (const dx of [-1, 0, 1])
      for (const dz of [-1, 0, 1])
        if (!isWater(x + dx * radius, z + dz * radius, sim.city)) return false;
  } else if ((vehicle(mover) || dry) && isWater(x, z, sim.city)) return false;
  const y = groundLevel(x, z, sim.city);
  for (const e of sim.entities.values()) {
    if (ignore.has(e.id) || e.vehicle || Math.abs(e.y - y) > 3) continue;
    const gap = vehicle(mover)
      ? radius + (vehicle(e) ? reach(e) : 1)
      : vehicle(e)
        ? reach(e) + 1
        : 2;
    if (Math.hypot(e.x - x, e.z - z) < gap) return false;
  }
  return true;
}

/** The exact point when allowed and clear, else the nearest clear ring site within 40 m. */
function findSite(
  sim: Simulation,
  mover: Entity,
  target: { x: number; z: number },
  ignore: Set<string>,
  { exact = false, search = true, start = 3 },
) {
  if (exact && siteFits(sim, mover, target.x, target.z, ignore, false))
    return { x: target.x, z: target.z };
  if (!search) return undefined;
  for (let radius = start; radius < 40; radius += 3)
    for (let i = 0; i < 16; i++) {
      const x = target.x + Math.sin((i * Math.PI) / 8) * radius,
        z = target.z + Math.cos((i * Math.PI) / 8) * radius;
      if (Math.max(Math.abs(x), Math.abs(z)) > WORLD_LIMIT - 4) continue;
      // Searched sites prefer dry land, so nobody arrives swimming beside a quay.
      if (siteFits(sim, mover, x, z, ignore, true)) return { x, z };
    }
  return undefined;
}

/**
 * Admin relocation. A seated driver takes the vehicle and everyone aboard along when the
 * vehicle fits at the destination; otherwise, and always for passengers, the player
 * leaves the seat and arrives on foot. Bodies land on the ground or water surface at
 * rest with idle controls, so no momentum carries across the jump.
 */
export function relocate(
  sim: Simulation,
  player: Entity,
  target: { x: number; z: number },
  options: { exact?: boolean; search?: boolean; start?: number },
) {
  if (player.down) throw Error(`${player.name || "Player"} is knocked down`);
  const seated = player.vehicle ? sim.entities.get(player.vehicle) : undefined;
  if (seated && seated.driver === player.id && !seated.wreck) {
    const aboard = new Set([
      seated.id,
      ...vehicleSeats(seated).filter((id): id is string => id !== null),
    ]);
    const site = findSite(sim, seated, target, aboard, options);
    if (site) {
      seated.x = site.x;
      seated.z = site.z;
      seated.y = (watercraft(seated.kind) ? surfaceLevel : groundLevel)(
        site.x,
        site.z,
        sim.city,
      );
      seated.vx = seated.vz = seated.vy = 0;
      seated.angularVelocity = 0;
      seated.drive = undefined;
      if (seated.kind === "helicopter" || seated.kind === "plane") {
        // Match a freshly spawned aircraft parked on the ground.
        seated.flight = seated.kind === "helicopter" ? "grounded" : undefined;
        seated.takeoffDelay = seated.targetAltitude = undefined;
        seated.landingX = seated.landingZ = undefined;
      }
      for (const id of aboard) {
        const occupant = sim.entities.get(id);
        if (!occupant || occupant === seated) continue;
        occupant.x = seated.x;
        occupant.z = seated.z;
        occupant.y = seated.y;
        occupant.vx = occupant.vz = occupant.vy = 0;
      }
      sim.inputs.set(player.id, idle());
      return;
    }
  }
  const site = findSite(sim, player, target, new Set([player.id]), options);
  if (!site) throw Error("Teleport destination is obstructed");
  // Leaving the seat as a departing player does also releases driver ownership.
  if (seated) sim.disconnect(player.id);
  player.x = site.x;
  player.z = site.z;
  player.y = groundLevel(site.x, site.z, sim.city);
  player.vx = player.vz = player.vy = 0;
  player.parachute = undefined;
  if (player.jetpack) player.jetpack.active = false;
  // Arrivals beside someone face them.
  if (site.x !== target.x || site.z !== target.z)
    player.angle = Math.atan2(target.x - site.x, target.z - site.z);
  sim.inputs.set(player.id, idle());
}
