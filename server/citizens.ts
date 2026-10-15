import type { City, Entity } from "../shared/world.ts";
import { buildingBox, rayDistance } from "../shared/physics/collision.ts";

export type Personality = "calm" | "restless" | "timid" | "aggressive";
type FootReaction =
  | { kind: "flee"; x: number; z: number; until: number }
  | { kind: "fight"; target: Entity; until: number };
type Reaction =
  | { kind: "routine" }
  | FootReaction
  | { kind: "run"; x: number; z: number; until: number }
  | { kind: "drive"; until: number }
  | { kind: "exit"; next: FootReaction; until: number; retryAt: number };
interface Citizen {
  personality: Personality;
  reaction: Reaction;
  nextImpulse: number;
  nextIncident: number;
  random: number;
}
export interface Intent {
  x: number;
  z: number;
  sprint: boolean;
  attack?: number;
}

export class Citizens {
  private states = new WeakMap<Entity, Citizen>();
  private reports = new WeakMap<Entity, number>();
  private formerDrivers = new WeakMap<Entity, Entity>();

  inspect(e: Entity) {
    const state = this.states.get(e);
    if (!state) return undefined;
    const reaction = state.reaction;
    const describe = (r: FootReaction) =>
      r.kind === "fight"
        ? { kind: r.kind, target: r.target.id, until: r.until }
        : { ...r };
    return {
      ...state,
      reaction:
        reaction.kind === "fight"
          ? describe(reaction)
          : reaction.kind === "exit"
            ? { ...reaction, next: describe(reaction.next) }
            : { ...reaction },
    };
  }

  state(e: Entity): Citizen {
    let state = this.states.get(e);
    if (!state) {
      let seed = 2166136261;
      for (const char of e.id) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
      const personalities: Personality[] = ["calm", "restless", "timid", "aggressive"];
      state = {
        personality: personalities[(seed >>> 0) % personalities.length],
        reaction: { kind: "routine" },
        nextImpulse: 30 + ((seed >>> 0) % 90),
        nextIncident: 0,
        random: seed >>> 0,
      };
      this.states.set(e, state);
    }
    return state;
  }

  private random(state: Citizen) {
    state.random = (Math.imul(state.random, 1664525) + 1013904223) >>> 0;
    return state.random / 4294967296;
  }

  reset(e: Entity, time: number) {
    const state = this.state(e);
    state.reaction = { kind: "routine" };
    state.nextImpulse = time + 30 + this.random(state) * 90;
  }

  private visible(a: Entity, b: Entity, city: City) {
    const distance = Math.hypot(b.x - a.x, b.z - a.z);
    return (
      Math.abs(a.y - b.y) < 2 &&
      (!distance ||
        !city.buildings.some(
          (wall) =>
            wall.h + 1.8 > a.y + 1 &&
            rayDistance(
              a.x,
              a.z,
              (b.x - a.x) / distance,
              (b.z - a.z) / distance,
              buildingBox(wall),
              distance,
            ) < distance,
        ))
    );
  }

  notice(
    victim: Entity,
    source: Entity | undefined,
    time: number,
    entities: Map<string, Entity>,
    city: City,
  ) {
    if (time < (this.reports.get(victim) ?? 0)) return;
    this.reports.set(victim, time + 2);
    const culprit = source?.driver ? entities.get(source.driver) : source;
    for (const e of entities.values()) {
      if (
        !e.ai ||
        e.health <= 0 ||
        e.wreck ||
        e.vehicle ||
        (e !== victim && (e === culprit || e === source))
      )
        continue;
      if (
        e !== victim &&
        (e.kind !== "pedestrian" ||
          Math.hypot(e.x - victim.x, e.z - victim.z) > 22 ||
          !this.visible(e, victim, city))
      )
        continue;
      if (e.kind !== "car" && e.kind !== "pedestrian") continue;
      const state = this.state(e);
      if (time < state.nextIncident || state.reaction.kind !== "routine") continue;
      state.nextIncident = time + 20;
      state.nextImpulse = time + 60;
      const next: FootReaction =
        state.personality === "aggressive" && culprit && culprit !== e
          ? { kind: "fight", target: culprit, until: time + 15 }
          : { kind: "flee", x: victim.x, z: victim.z, until: time + 10 };
      if (e.kind === "pedestrian") state.reaction = next;
      else if (state.personality === "restless")
        state.reaction = { kind: "drive", until: time + 14 };
      else if (state.personality !== "calm")
        state.reaction = { kind: "exit", next, until: time + 12, retryAt: time };
    }
  }

  transferDriver(car: Entity, person: Entity, time: number) {
    const state = this.state(car);
    if (state.reaction.kind !== "exit") return;
    this.states.set(person, {
      ...state,
      reaction: { ...state.reaction.next, until: time + 15 },
    });
    this.formerDrivers.set(car, person);
    this.states.delete(car);
  }

  reaction(e: Entity, time: number) {
    const state = this.state(e);
    if (state.reaction.kind !== "routine" && time >= state.reaction.until)
      state.reaction = { kind: "routine" };
    return state.reaction;
  }

  intent(
    e: Entity,
    nearby: Entity[],
    entities: Map<string, Entity>,
    time: number,
    city: City,
  ): Intent | undefined {
    const state = this.state(e);
    let reaction = this.reaction(e, time);
    if (reaction.kind === "routine" && time >= state.nextImpulse) {
      state.nextImpulse = time + 60 + this.random(state) * 90;
      const roll = this.random(state);
      if (roll < 0.015 && state.personality === "aggressive") {
        const target = nearby.find(
          (other) =>
            other !== e &&
            other.kind === "pedestrian" &&
            other.ai &&
            other.health > 0 &&
            !other.down &&
            !other.vehicle &&
            Math.hypot(other.x - e.x, other.z - e.z) < 5 &&
            this.visible(e, other, city),
        );
        if (target) state.reaction = { kind: "fight", target, until: time + 6 };
      } else if (roll < (state.personality === "restless" ? 0.06 : 0.025)) {
        const angle = this.random(state) * Math.PI * 2;
        state.reaction = {
          kind: "run",
          x: Math.sin(angle),
          z: Math.cos(angle),
          until: time + 3,
        };
      }
      reaction = state.reaction;
    }
    // Predict closest approach, so a crossing pedestrian dodges before contact.
    let soonest = Infinity;
    let dodge: Intent | undefined;
    for (const car of nearby) {
      if (car.kind !== "car" || car.wreck || Math.abs(car.y - e.y) > 2) continue;
      const speed = Math.hypot(car.vx, car.vz);
      if (speed < 3) continue;
      const dx = e.x - car.x,
        dz = e.z - car.z;
      const vx = car.vx - e.vx,
        vz = car.vz - e.vz;
      const relativeSpeed2 = vx * vx + vz * vz;
      const t = relativeSpeed2 ? (dx * vx + dz * vz) / relativeSpeed2 : -1;
      if (t < 0 || t > 1.5 || t >= soonest || Math.hypot(dx - vx * t, dz - vz * t) > 3)
        continue;
      const side = dx * car.vz - dz * car.vx;
      const sign = side < 0 ? -1 : 1;
      dodge = { x: (sign * car.vz) / speed, z: (-sign * car.vx) / speed, sprint: true };
      soonest = t;
    }
    if (dodge) return dodge;
    if (reaction.kind === "run") return { x: reaction.x, z: reaction.z, sprint: true };
    if (reaction.kind === "flee") {
      const x = e.x - reaction.x,
        z = e.z - reaction.z;
      return { x: x || (!z ? 1 : 0), z, sprint: true };
    }
    if (reaction.kind === "fight") {
      const target = this.formerDrivers.get(reaction.target) ?? reaction.target;
      if (
        !entities.has(target.id) ||
        target.health <= 0 ||
        target.down ||
        Math.hypot(target.x - e.x, target.z - e.z) > 35
      ) {
        state.reaction = { kind: "routine" };
        return;
      }
      const pose = target.vehicle ? entities.get(target.vehicle) : target;
      if (!pose) return;
      const x = pose.x - e.x,
        z = pose.z - e.z;
      const close = Math.hypot(x, z) < 1.8 && this.visible(e, pose, city);
      return {
        x: close ? 0 : x,
        z: close ? 0 : z,
        sprint: true,
        ...(close ? { attack: Math.atan2(x, z) } : {}),
      };
    }
  }
}
