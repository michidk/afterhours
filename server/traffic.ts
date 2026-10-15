import { carGrounded } from "../shared/physics/ramps.ts";
import { groundLevel } from "../shared/water.ts";
import { Navigation } from "../shared/navigation.ts";
import { TUNING, VEHICLES, type VehicleModel } from "../shared/catalog.ts";
import type { Entity } from "../shared/world.ts";
import type { Simulation } from "./simulation.ts";

export const TRAFFIC = {
  sampleSeconds: 1,
  jamSeconds: 30,
  progressMeters: 3,
  stoppedSpeed: 1,
  neighborMeters: 12,
  minimumCars: 2,
  hornDelaySeconds: 8,
  hornIntervalSeconds: 6,
  respawnDelaySeconds: 10,
  respawnSeconds: 5,
  spawnPlayerDistance: 65,
  spawnCarDistance: 12,
} as const;

interface Progress {
  x: number;
  z: number;
  since: number;
  nextHorn: number;
}
interface Replacement {
  model: VehicleModel;
  color: string;
  due: number;
}
const makeSpawnSites = (navigation: Navigation) =>
  navigation.roads.flatMap((from) =>
    from.edges.flatMap((to) =>
      [0.35, 0.55, 0.75].map((fraction) => {
        const end = navigation.roads[to];
        const dx = (end.x - from.x) / Math.hypot(end.x - from.x, end.z - from.z),
          dz = (end.z - from.z) / Math.hypot(end.x - from.x, end.z - from.z);
        return {
          from: from.id,
          to,
          fraction,
          x: from.x + (end.x - from.x) * fraction + dz * 3.5,
          z: from.z + (end.z - from.z) * fraction - dx * 3.5,
        };
      }),
    ),
  );

/** Track blocked traffic and replenish only expired wrecks. */
export class TrafficManager {
  private spawnSites?: ReturnType<typeof makeSpawnSites>;
  private progress = new Map<string, Progress>();
  private replacements: Replacement[] = [];
  /** Cars their citizen drivers walked away from, cleared once no player can see them. */
  private abandoned = new Set<Entity>();
  private nextSample = 0;
  private nextRespawn = 0;
  private cursor = 0;
  private jammedCars = 0;
  private jamCount = 0;
  private honks = 0;
  private respawned = 0;

  abandon(car: Entity, time: number) {
    this.abandoned.add(car);
    this.scheduleReplacement(car, time);
  }

  scheduleReplacement(car: Entity, time: number) {
    this.replacements.push({
      model: car.model && VEHICLES[car.model].kind === "car" ? car.model : "sedan",
      color: car.color,
      due: time + TRAFFIC.respawnDelaySeconds,
    });
  }

  update(sim: Simulation): boolean {
    if (sim.time < this.nextSample) return false;
    this.nextSample = sim.time + TRAFFIC.sampleSeconds;
    const all = [...sim.entities.values()];
    const players = all.filter((e) => e.kind === "player");
    for (const car of this.abandoned) {
      if (sim.entities.get(car.id) !== car || car.driver || car.ai || car.wreck) {
        this.abandoned.delete(car);
        continue;
      }
      if (
        car.seats?.some(Boolean) ||
        players.some(
          (p) => Math.hypot(p.x - car.x, p.z - car.z) < TUNING.interestRadius,
        )
      )
        continue;
      sim.entities.delete(car.id);
      this.abandoned.delete(car);
    }
    const cars = all.filter(
      (e) =>
        e.kind === "car" &&
        e.ai &&
        !e.driver &&
        !e.vehicle &&
        carGrounded(e, sim.city) &&
        e.health > 0 &&
        e.burning === undefined &&
        !e.wreck &&
        sim.ai.routes.has(e.id),
    );
    const present = new Set(cars.map((e) => e.id));
    for (const id of this.progress.keys())
      if (!present.has(id)) this.progress.delete(id);
    const stalled = cars.filter((e) => {
      let progress = this.progress.get(e.id);
      if (
        !progress ||
        sim.ai.routes.get(e.id)?.waitingAtSignal ||
        Math.hypot(e.x - progress.x, e.z - progress.z) >= TRAFFIC.progressMeters
      ) {
        progress = {
          x: e.x,
          z: e.z,
          since: sim.time,
          nextHorn: sim.time + TRAFFIC.hornDelaySeconds,
        };
        this.progress.set(e.id, progress);
      }
      if (
        Math.hypot(e.vx, e.vz) < TRAFFIC.stoppedSpeed &&
        sim.time >= progress.nextHorn
      ) {
        sim.events.push({ kind: "horn", sound: "horn", x: e.x, y: e.y + 1, z: e.z });
        progress.nextHorn = sim.time + TRAFFIC.hornIntervalSeconds;
        this.honks++;
      }
      return (
        Math.hypot(e.vx, e.vz) < TRAFFIC.stoppedSpeed &&
        sim.time - progress.since >= TRAFFIC.jamSeconds
      );
    });

    // Connected clusters catch a queue extending beyond one local radius.
    const unvisited = new Set(stalled);
    const jammed: Entity[] = [];
    this.jamCount = 0;
    for (const first of stalled) {
      if (!unvisited.delete(first)) continue;
      const group = [first];
      for (let i = 0; i < group.length; i++)
        for (const other of unvisited)
          if (
            Math.hypot(group[i].x - other.x, group[i].z - other.z) <=
            TRAFFIC.neighborMeters
          ) {
            unvisited.delete(other);
            group.push(other);
          }
      if (group.length >= TRAFFIC.minimumCars) {
        this.jamCount++;
        jammed.push(...group);
      }
    }
    this.jammedCars = jammed.length;
    return this.replenish(sim);
  }

  private replenish(sim: Simulation) {
    const replacement = this.replacements[0];
    if (!replacement || sim.time < replacement.due || sim.time < this.nextRespawn)
      return false;
    const all = [...sim.entities.values()];
    const players = all.filter((e) => e.kind === "player");
    const radius = VEHICLES[replacement.model].length / 2 + 1;
    const spawnSites = (this.spawnSites ??= makeSpawnSites(sim.ai.navigation));
    for (let i = 0; i < spawnSites.length; i++) {
      const site = spawnSites[this.cursor++ % spawnSites.length];
      if (
        sim.blocked(site.x, site.z, radius) ||
        players.some(
          (p) => Math.hypot(p.x - site.x, p.z - site.z) < TRAFFIC.spawnPlayerDistance,
        ) ||
        all.some(
          (e) =>
            !e.vehicle &&
            Math.abs(e.y - groundLevel(site.x, site.z, sim.city)) < 2 &&
            Math.hypot(e.x - site.x, e.z - site.z) < TRAFFIC.spawnCarDistance,
        )
      )
        continue;
      const car = sim.spawn(
        "car",
        site.x,
        site.z,
        replacement.color,
        replacement.model,
      );
      sim.ai.assignCar(car, site.from, site.to, site.fraction, this.cursor);
      this.replacements.shift();
      this.respawned++;
      this.nextRespawn = sim.time + TRAFFIC.respawnSeconds;
      return true;
    }
    // Retry later instead of forcing a spawn into an occupied/visible lane.
    return false;
  }

  get diagnostics() {
    return {
      jamCount: this.jamCount,
      jammedCars: this.jammedCars,
      honks: this.honks,
      respawned: this.respawned,
      pendingRespawns: this.replacements.length,
    };
  }
}
