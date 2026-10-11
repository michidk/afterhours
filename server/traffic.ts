import { Navigation } from "../shared/navigation.ts";
import { occupiedSeats } from "../shared/seats.ts";
import { VEHICLES, type VehicleModel } from "../shared/catalog.ts";
import type { Entity } from "../shared/world.ts";
import type { Simulation } from "./simulation.ts";

export const TRAFFIC = {
  sampleSeconds: 1,
  jamSeconds: 30,
  progressMeters: 3,
  stoppedSpeed: 1,
  neighborMeters: 12,
  minimumCars: 2,
  despawnSeconds: 5,
  respawnDelaySeconds: 10,
  respawnSeconds: 5,
  spawnPlayerDistance: 65,
  spawnCarDistance: 12,
} as const;

interface Progress {
  x: number;
  z: number;
  since: number;
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

/** Low-frequency authoritative gridlock cleanup, separate from driving recovery. */
export class TrafficManager {
  private spawnSites?: ReturnType<typeof makeSpawnSites>;
  private progress = new Map<string, Progress>();
  private replacements: Replacement[] = [];
  private nextSample = 0;
  private nextDespawn = 0;
  private nextRespawn = 0;
  private cursor = 0;
  private jammedCars = 0;
  private jamCount = 0;
  private despawned = 0;
  private respawned = 0;

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
    const cars = all.filter((e) => e.kind === "car" && !e.vehicle && e.y < 0.5);
    const present = new Set(cars.map((e) => e.id));
    for (const id of this.progress.keys())
      if (!present.has(id)) this.progress.delete(id);
    const stalled = cars.filter((e) => {
      let progress = this.progress.get(e.id);
      if (
        !progress ||
        Math.hypot(e.x - progress.x, e.z - progress.z) >= TRAFFIC.progressMeters
      ) {
        progress = { x: e.x, z: e.z, since: sim.time };
        this.progress.set(e.id, progress);
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
    let changed = false;
    if (sim.time >= this.nextDespawn) {
      const candidates = jammed.filter(
        (e) =>
          e.ai &&
          sim.ai.routes.has(e.id) &&
          !e.driver &&
          occupiedSeats(e) === 0 &&
          e.burning === undefined &&
          !e.wreck &&
          !all.some((p) => p.vehicle === e.id),
      );
      // Relieve the densest part first; never remove a whole queue in one tick.
      const density = (car: Entity) =>
        jammed.filter(
          (other) =>
            Math.hypot(other.x - car.x, other.z - car.z) <= TRAFFIC.neighborMeters,
        ).length;
      const densities = new Map(candidates.map((car) => [car.id, density(car)]));
      candidates.sort(
        (a, b) =>
          densities.get(b.id)! - densities.get(a.id)! ||
          this.progress.get(a.id)!.since - this.progress.get(b.id)!.since ||
          a.id.localeCompare(b.id),
      );
      const car = candidates[0];
      if (car) {
        this.scheduleReplacement(car, sim.time);
        sim.entities.delete(car.id);
        sim.ai.routes.delete(car.id);
        sim.inputs.delete(car.id);
        this.progress.delete(car.id);
        this.despawned++;
        this.nextDespawn = sim.time + TRAFFIC.despawnSeconds;
        changed = true;
      }
    }
    if (this.replenish(sim)) changed = true;
    return changed;
  }

  private replenish(sim: Simulation) {
    const replacement = this.replacements[0];
    if (
      !replacement ||
      sim.time < replacement.due ||
      sim.time < this.nextRespawn ||
      sim.entities.size >= 300
    )
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
            e.y < 2 &&
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
      despawned: this.despawned,
      respawned: this.respawned,
      pendingRespawns: this.replacements.length,
    };
  }
}
