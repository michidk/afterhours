import { DEFAULT_CHARACTER, PHYSIQUES, type Character } from "../shared/character.ts";
import { navigationFor } from "../shared/navigation.ts";
import { staticGeometry } from "../shared/physics/static.ts";
import {
  idle,
  LIMIT,
  type City,
  type Entity,
  inputX,
  inputY,
  type Input,
  type Kind,
  type WorldEvent,
} from "../shared/world.ts";
import {
  type Drive,
  carForces,
  carAltitude,
  carGrounded,
  rampContacts,
  clamp,
  wrap,
} from "../shared/physics/index.ts";
import {
  vehicle,
  mass,
  shape,
  contact,
  collisionPairs,
  entityBox,
  buildingBox,
  insideBuilding,
  resolveContact,
  pointVelocity,
} from "../shared/physics/index.ts";
import { CityAI } from "./ai.ts";
import { TrafficManager } from "./traffic.ts";
import { flyHelicopter, landingSite } from "../shared/physics/index.ts";
import {
  characterForces,
  characterAltitude,
  contactRange,
  speedLimit,
} from "../shared/physics/index.ts";
import {
  VEHICLES,
  WEAPONS,
  TUNING,
  DEFAULT_MODELS,
  type VehicleModel,
} from "../shared/catalog.ts";
import {
  groundLevel,
  isWater,
  waterLevel,
  WATER_LEVEL,
  WORLD_LIMIT,
  watercraft,
  resolveWorldBounds,
} from "../shared/water.ts";
import { watercraftForces } from "../shared/physics/watercraft.ts";
import { Inventory } from "./inventory.ts";
import { SpatialGrid } from "../shared/spatial.ts";
import type { Building } from "../shared/world.ts";

import { flyPlane } from "../shared/physics/plane.ts";
import { fallAircraft } from "../shared/physics/abandoned-aircraft.ts";
import { Combat } from "./combat.ts";
import { safeSpawn } from "./lifecycle.ts";
import { availableSeat, vehicleSeats } from "../shared/seats.ts";
import { Destruction } from "./destruction.ts";
import type { Vec3 } from "../shared/destruction.ts";
import { Grenades } from "./grenades.ts";
import type { PickupPayload } from "../shared/protocol.ts";
/** Crates hand out every weapon but fists in turn, each fully loaded. */
const CRATE_WEAPONS = (Object.keys(WEAPONS) as (keyof typeof WEAPONS)[]).filter(
  (kind) => kind !== "fists",
);
import type { Intent } from "./citizens.ts";
/** Damage a vehicle takes from an impact at this closing speed in m/s. */
function crashDamage(speed: number) {
  return Math.max(0, speed - TUNING.crashSafeSpeed) ** 2 * TUNING.crashDamage;
}
export class Simulation {
  city: City;
  entities = new Map<string, Entity>();
  inputs = new Map<string, Input>();
  /** AI bodies no human can reach within the prediction horizon take one 30 Hz step per tick. */
  lod = true;
  private tickCount = 0;
  private plans = new WeakMap<Entity, { intent: Intent; at: number; phase: number }>();
  /** Minimum distance in metres that always keeps full-rate physics around a human. */
  lodFloor = 60;
  /** Controllers that skip locomotion for this tick to let late commands catch up. */
  pausedInputs = new Set<string>();
  ai: CityAI;
  traffic = new TrafficManager();
  time = 0;
  day = 16.5;
  dayRate = 1 / 75;
  events: WorldEvent[] = [];
  serial = 0;
  private crates = 0;
  inventory = new Inventory();
  grenades = new Grenades();
  // Rebuilt every physics pass; caching misses only retains short-lived arrays.
  spatial = new SpatialGrid<Entity>(16, false);
  destruction: Destruction;

  constructor(city: City) {
    this.city = city;
    this.destruction = new Destruction(city);
    this.ai = new CityAI(navigationFor(city), city);
    for (let i = 0; i < 160; i++) {
      const e = this.spawn(
        "car",
        0,
        0,
        undefined,
        (["sedan", "sport", "van"] as const)[i % 3],
      );
      this.ai.assign(e, i);
    }
    for (let i = 0; i < 300; i++) {
      const e = this.spawn("pedestrian", 0, 0);
      this.ai.assign(e, i + 9);
    }
    // Starter vehicles sit near downtown. Generated cities are not centred on the
    // origin, so each site is moved to the nearest street lane there.
    const taken: { x: number; z: number }[] = [];
    const site = (dx: number, dz: number) => {
      const s = this.city.centre
        ? this.roadside(this.city.centre.x + dx, this.city.centre.z + dz, taken)
        : { x: dx, z: dz };
      taken.push(s);
      return s;
    };
    for (const [dx, dz, model] of [
      [4, 25, undefined],
      [-4, 44, "sport"],
      [68, 25, "van"],
    ] as const) {
      const s = site(dx, dz);
      this.spawn("car", s.x, s.z, undefined, model);
    }
    const heli = site(0, 36);
    this.spawn("helicopter", heli.x, heli.z);
    this.spawn(
      "plane",
      this.city.airport.x,
      this.city.airport.z - this.city.airport.d / 2 + 14,
    );
    const utility = site(-64, 30);
    this.spawn("helicopter", utility.x, utility.z, undefined, "utility");
    this.spawn(
      "plane",
      this.city.airport.x - 22,
      this.city.airport.z - this.city.airport.d / 2 + 14,
      undefined,
      "aerobatic",
    );
    for (const [i, model] of (
      ["boat", "launch", "jetski", "racer", "speedboat", "offshore"] as const
    ).entries()) {
      // Saved geometry stays immutable; craft use the fixed navigable shoreline.
      this.spawn(VEHICLES[model].kind, -LIMIT - 7, -48 + i * 16, undefined, model);
      const craft = this.spawn(VEHICLES[model].kind, 0, 0, undefined, model);
      this.ai.assignWatercraft(craft, i);
    }
    for (const p of this.city.pickups)
      this.inventory.addSource(
        p.x,
        p.z,
        p.weapon as "bat" | "pistol" | "smg",
        groundLevel(p.x, p.z, this.city),
      );
    this.addSupplies();
  }
  private addSupplies() {
    const payloads: PickupPayload[] = [
      ...(["knife", "machinegun", "flamethrower", "grenade"] as const).map((kind) => ({
        kind: "weapon" as const,
        item: this.inventory.item(kind),
      })),
      ...(["handgun", "light", "rifle", "fuel", "grenade"] as const).map(
        (ammoKind) => ({
          kind: "ammo" as const,
          ammoKind,
          amount: ammoKind === "grenade" ? 3 : 60,
        }),
      ),
      { kind: "jetpack", fuel: 30 },
    ];
    for (const payload of payloads) {
      let placed = false;
      for (const pad of this.city.pickups) {
        for (const [dx, dz] of [
          [3, 0],
          [-3, 0],
          [0, 3],
          [0, -3],
          [6, 0],
          [-6, 0],
          [0, 6],
          [0, -6],
        ]) {
          const x = pad.x + dx!,
            z = pad.z + dz!;
          if (
            this.blocked(x, z, 0) ||
            [...this.inventory.pickups.values()].some(
              (p) => Math.hypot(p.x - x, p.z - z) < 2.8,
            )
          )
            continue;
          this.inventory.addSupplySource(x, z, payload, groundLevel(x, z, this.city));
          placed = true;
          break;
        }
        if (placed) break;
      }
    }
  }
  /**
   * Nearest street lane point to a position, 3.5 m right of the centreline, moved
   * along the lane until it is clear of every point in `avoid`.
   */
  roadside(x: number, z: number, avoid: { x: number; z: number }[] = []) {
    let best = { x, z },
      along = { x: 0, z: 0 },
      bestDistance = Infinity;
    for (const r of this.city.roads) {
      const dx = r.bx - r.ax,
        dz = r.bz - r.az,
        l2 = dx * dx + dz * dz || 1;
      const t = Math.max(
        0.15,
        Math.min(0.85, ((x - r.ax) * dx + (z - r.az) * dz) / l2),
      );
      const px = r.ax + dx * t,
        pz = r.az + dz * t,
        d = Math.hypot(px - x, pz - z);
      if (d < bestDistance) {
        const l = Math.sqrt(l2);
        bestDistance = d;
        best = { x: px + (dz / l) * 3.5, z: pz - (dx / l) * 3.5 };
        along = { x: dx / l, z: dz / l };
      }
    }
    for (let step = 0; step < 12; step++) {
      if (!avoid.some((p) => Math.hypot(p.x - best.x, p.z - best.z) < 9)) break;
      const sign = step % 2 ? -1 : 1,
        distance = 10 * (Math.floor(step / 2) + 1);
      best = {
        x: best.x + along.x * distance * sign,
        z: best.z + along.z * distance * sign,
      };
    }
    return best;
  }
  spawn(kind: Kind, x: number, z: number, color?: string, model?: VehicleModel) {
    model ??=
      kind === "player" || kind === "pedestrian" ? undefined : DEFAULT_MODELS[kind];
    if (model && VEHICLES[model].kind !== kind)
      throw Error("Vehicle model does not match entity kind");
    const e: Entity = {
      id: `e${++this.serial}`,
      kind,
      x,
      z,
      y: groundLevel(x, z, this.city),
      angle: 0,
      vx: 0,
      vz: 0,
      vy: 0,
      angularVelocity: 0,
      color:
        color ||
        ["#e8b63f", "#e86551", "#55a9b8", "#f3eee0", "#80a177"][this.serial % 5],
      health: model ? VEHICLES[model].health : 100,
      maxHealth: model ? VEHICLES[model].health : 100,
      model,
    };
    if (vehicle(e)) e.seats = vehicleSeats(e);
    if (kind === "helicopter") e.flight = "grounded";
    this.entities.set(e.id, e);
    return e;
  }
  join(name: string, color: string, character: Character = DEFAULT_CHARACTER) {
    const pos = safeSpawn(this.city, [...this.entities.values()]);
    const p = this.spawn("player", pos.x, pos.z, color);
    p.name = name;
    p.character = { ...character };
    p.health = p.maxHealth = PHYSIQUES[character.physique].health;
    this.inventory.initialize(p);
    this.inputs.set(p.id, idle());
    return p;
  }
  disconnect(id: string) {
    const p = this.entities.get(id),
      v = p?.vehicle ? this.entities.get(p.vehicle) : undefined;
    this.inputs.set(id, idle());
    if (p && v && !this.exit(p, v)) {
      // A blocked grounded exit must still release ownership on disconnect.
      this.releaseSeat(p, v);
      p.x = v.x;
      p.z = v.z;
      p.y = v.y;
      p.vx = v.vx;
      p.vz = v.vz;
      p.vy = Math.min(0, v.vy);
      p.parachute =
        (v.y > groundLevel(v.x, v.z, this.city) + 0.2 &&
          (v.kind === "helicopter" || v.kind === "plane")) ||
        undefined;
    }
  }
  leave(id: string) {
    this.disconnect(id);
    this.entities.delete(id);
    this.inputs.delete(id);
  }
  blocked(x: number, z: number, r = 0.6) {
    return (
      Math.abs(x) > WORLD_LIMIT - r ||
      Math.abs(z) > WORLD_LIMIT - r ||
      staticGeometry(this.city)
        .query(x, z, r + 3)
        .some(
          (p) =>
            p.obstacle &&
            Math.abs(x - p.x) < p.w / 2 + r &&
            Math.abs(z - p.z) < p.d / 2 + r,
        ) ||
      this.city.buildings.some((b) => insideBuilding(b, x, z, r))
    );
  }
  requestLanding(v: Entity) {
    const site = landingSite(v, this.city, [...this.entities.values()]);
    if (site) {
      v.flight = "landing";
      v.landingX = site.x;
      v.landingZ = site.z;
    }
  }
  /** Street lighting hours, when cars drive with headlights on. */
  night() {
    return this.day >= 18 || this.day < 6;
  }
  private releaseSeat(p: Entity, v: Entity) {
    const wasDriver = v.driver === p.id;
    v.seats = vehicleSeats(v).map((id) => (id === p.id ? null : id));
    p.vehicle = undefined;
    p.seat = undefined;
    if (!wasDriver) return;
    v.driver = undefined;
    v.takeoffDelay = undefined;
    if (
      (v.kind === "helicopter" || v.kind === "plane") &&
      v.y > groundLevel(v.x, v.z, this.city) + 0.2
    )
      v.flight = "falling";
    else if (v.kind === "helicopter") v.flight = "grounded";
  }
  private exit(p: Entity, v: Entity) {
    const airborne =
      v.kind === "car"
        ? !carGrounded(v, this.city)
        : v.y > groundLevel(v.x, v.z, this.city) + 0.2;
    if (airborne && v.kind !== "helicopter" && v.kind !== "plane") return false;
    const model = v.model && VEHICLES[v.model];
    const distance = Math.max(
      3,
      shape(v).w + 0.9,
      airborne && model && model.kind === "helicopter" ? model.rotorRadius + 1 : 0,
    );
    for (const side of [1, -1])
      for (const offset of [0, 2, -2]) {
        const x =
            v.x + Math.cos(v.angle) * distance * side + Math.sin(v.angle) * offset,
          z = v.z - Math.sin(v.angle) * distance * side + Math.cos(v.angle) * offset;
        if (
          (airborne
            ? Math.abs(x) > WORLD_LIMIT - 0.6 ||
              Math.abs(z) > WORLD_LIMIT - 0.6 ||
              staticGeometry(this.city)
                .query(x, z, 1)
                .some(
                  (b) =>
                    v.y < b.h + (b.obstacle ? 0 : 1.8) &&
                    contact({ x, z, w: 0.42, d: 0.42, angle: 0 }, buildingBox(b)),
                )
            : this.blocked(x, z)) ||
          [...this.entities.values()].some(
            (e) =>
              e.id !== p.id &&
              e.id !== v.id &&
              !e.vehicle &&
              Math.abs(e.y - (airborne ? v.y : groundLevel(x, z, this.city))) < 2 &&
              Math.hypot(e.x - x, e.z - z) < (vehicle(e) ? 2 : 0.8),
          )
        )
          continue;
        p.x = x;
        p.z = z;
        p.y = airborne ? v.y : groundLevel(x, z, this.city);
        p.vx = airborne ? clamp(v.vx, -6, 6) : 0;
        p.vz = airborne ? clamp(v.vz, -6, 6) : 0;
        p.vy = airborne ? -1 : 0;
        p.parachute = airborne || undefined;
        this.releaseSeat(p, v);
        return true;
      }
    return false;
  }
  private exitCitizen(car: Entity) {
    const reaction = this.ai.citizens.reaction(car, this.time);
    if (
      reaction.kind !== "exit" ||
      this.time < reaction.retryAt ||
      car.driver ||
      car.wreck ||
      car.health <= 0 ||
      car.burning !== undefined ||
      Math.hypot(car.vx, car.vz) > 1
    )
      return;
    reaction.retryAt = this.time + 0.5;
    this.disembarkCitizen(car);
  }
  private disembarkCitizen(car: Entity) {
    const person = this.spawn("pedestrian", car.x, car.z, car.color);
    if (!this.exit(person, car)) {
      this.entities.delete(person.id);
      return false;
    }
    this.ai.assign(person, this.serial, false);
    this.ai.citizens.transferDriver(car, person, this.time);
    car.ai = false;
    this.ai.routes.delete(car.id);
    return true;
  }
  toggleLights(id: string) {
    const p = this.entities.get(id);
    const car = p?.vehicle ? this.entities.get(p.vehicle) : undefined;
    if (
      p?.kind === "player" &&
      !p.down &&
      car?.kind === "car" &&
      car.driver === id &&
      !car.wreck &&
      car.health > 0
    )
      car.lightsOn = !car.lightsOn;
  }
  interact(id: string) {
    const p = this.entities.get(id);
    if (!p || p.down) return;
    if (p.vehicle) {
      const v = this.entities.get(p.vehicle);
      if (!v) return;
      this.exit(p, v);
      return;
    }
    if (p.parachute) return;
    const v = [...this.entities.values()]
      .filter(
        (e) =>
          vehicle(e) &&
          availableSeat(e) >= 0 &&
          !e.wreck &&
          !e.burning &&
          e.y < groundLevel(e.x, e.z, this.city) + 0.5 &&
          Math.abs(
            e.y -
              groundLevel(e.x, e.z, this.city) -
              (p.y - groundLevel(p.x, p.z, this.city)),
          ) < (watercraft(e.kind) ? 1.3 : 0.5) &&
          Math.hypot(e.x - p.x, e.z - p.z) < 6,
      )
      .sort(
        (a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z),
      )[0];
    const pickup = this.inventory.nearest(p);
    if (
      pickup &&
      Math.hypot(pickup.x - p.x, pickup.z - p.z) <
        (v ? Math.hypot(v.x - p.x, v.z - p.z) : Infinity) &&
      this.inventory.pickup(p, this.time)
    )
      return;
    if (v) {
      const seat = availableSeat(v);
      if (seat < 0) return;
      if (seat === 0 && v.kind === "car") {
        if (v.ai && !this.disembarkCitizen(v)) return;
        for (const occupantId of vehicleSeats(v)) {
          const occupant = occupantId && this.entities.get(occupantId);
          if (occupant && occupant.ai && !this.exit(occupant, v)) return;
        }
      }
      p.vehicle = v.id;
      if (p.jetpack) p.jetpack.active = false;
      p.seat = seat;
      v.seats = vehicleSeats(v);
      v.seats[seat] = id;
      p.x = v.x;
      p.z = v.z;
      p.y = v.y;
      p.angle = v.angle;
      p.vx = p.vz = p.vy = 0;
      if (seat === 0) {
        v.driver = id;
        v.ai = false;
        // Taking the wheel starts the engine; headlights come on after dark.
        if (v.kind === "car") v.lightsOn = this.night();
        this.ai.routes.delete(v.id);
        this.ai.waterRoutes.delete(v.id);
        if (v.kind === "helicopter") {
          v.flight = "takingOff";
          v.takeoffDelay = TUNING.helicopterBoardingSeconds;
        }
      } else if (v.kind === "helicopter" && v.takeoffDelay !== undefined) {
        v.takeoffDelay = Math.max(v.takeoffDelay, 0.5);
      }
      return;
    }
    this.inventory.pickup(p, this.time);
  }
  damage(e: Entity, amount: number, source?: Entity) {
    if (e.wreck || (!vehicle(e) && e.health <= 0) || amount <= 0) return;
    e.health = Math.max(0, e.health - amount);
    this.ai.citizens.notice(e, source, this.time, this.entities, this.city);
    if (vehicle(e)) {
      if (
        e.health <= (e.maxHealth || 100) * TUNING.fireThreshold &&
        e.burning === undefined
      )
        e.burning = TUNING.fireSeconds;
    } else if (e.health <= 0) {
      const seated = e.vehicle ? this.entities.get(e.vehicle) : undefined;
      if (seated) {
        e.x = seated.x;
        e.z = seated.z;
        e.y = seated.y;
        e.angle = seated.angle;
        e.vx = seated.vx;
        e.vz = seated.vz;
        e.vy = Math.min(0, seated.vy);
        this.releaseSeat(e, seated);
      }
      if (e.jetpack) e.jetpack.active = false;
      e.parachute = undefined;
      e.down = e.kind === "player" ? 3 : TUNING.npcRecoverySeconds;
      this.destruction.corpse(e, this.time);
    }
  }
  damageProp(id: string, amount: number, velocity: Vec3) {
    const broken = this.destruction.hit(id, amount, this.time, velocity);
    if (broken) {
      const p = this.destruction.fixtures.get(id)!;
      this.events.push({
        kind: "propBreak",
        sound:
          p.kind === "palm" ||
          p.kind === "tree" ||
          p.kind === "bench" ||
          p.kind === "crate"
            ? "impactWood"
            : "impact",
        x: p.x,
        y: 0.5,
        z: p.z,
      });
    }
    return broken;
  }
  respawn(e: Entity) {
    const seated = e.vehicle ? this.entities.get(e.vehicle) : undefined;
    if (seated) this.releaseSeat(e, seated);
    e.health = e.maxHealth ?? 100;
    e.down = 0;
    e.burning = undefined;
    const pos = safeSpawn(this.city, [...this.entities.values()], e.id);
    e.x = pos.x;
    e.z = pos.z;
    if (e.ai) {
      this.ai.assign(e, this.serial++ % 36);
      this.ai.citizens.reset(e, this.time);
    }
    if (e.kind === "player") this.inventory.initialize(e);
    e.jetpack = undefined;
    e.y = 0;
    e.parachute = undefined;
    e.vx = e.vz = e.vy = 0;
  }
  repair(e: Entity) {
    if (e.wreck) return;
    e.health = e.maxHealth || 100;
    e.burning = undefined;
    e.down = 0;
  }
  private explode(e: Entity) {
    if (e.wreck) return;
    e.burning = undefined;
    e.wreck = TUNING.wreckSeconds;
    e.health = 0;
    e.ai = false;
    e.skidding = false;
    e.wheelSkids?.fill(false);
    // Everyone aboard is thrown clear alive: through a normal exit where there is
    // room, else beside the wreck. Aircraft crews keep their height and parachute.
    const excluded = new Set([e.id]);
    for (const p of [...this.entities.values()])
      if (p.vehicle === e.id) {
        if (!this.exit(p, e)) {
          this.releaseSeat(p, e);
          p.x = e.x + Math.cos(e.angle) * (shape(e).w + 0.9);
          p.z = e.z - Math.sin(e.angle) * (shape(e).w + 0.9);
          p.y = e.y;
          p.vx = clamp(e.vx, -6, 6);
          p.vz = clamp(e.vz, -6, 6);
          p.vy = Math.min(0, e.vy);
          p.parachute =
            (p.y > groundLevel(p.x, p.z, this.city) + 0.2 &&
              (e.kind === "helicopter" || e.kind === "plane")) ||
            undefined;
        }
        this.damage(p, TUNING.ejectDamage);
        excluded.add(p.id);
      }
    e.driver = undefined;
    e.seats = vehicleSeats(e).map(() => null);
    this.blast(e.x, e.y, e.z, TUNING.explosionRadius, TUNING.explosionDamage, excluded);
  }
  blast(
    x: number,
    y: number,
    z: number,
    radius: number,
    damage: number,
    excluded = new Set<string>(),
  ) {
    this.events.push({ kind: "explosion", x, y: y + 1, z });
    for (const other of this.entities.values()) {
      if (excluded.has(other.id) || other.wreck) continue;
      const pose = other.vehicle ? this.entities.get(other.vehicle) : other;
      if (!pose) continue;
      const dx = pose.x - x,
        dz = pose.z - z,
        dy = pose.y - y,
        d = Math.hypot(dx, dz, dy);
      if (d >= radius) continue;
      this.damage(other, (1 - d / radius) * damage);
      if (other.vehicle) continue;
      const impulse = (1 - d / radius) * 12,
        flat = Math.hypot(dx, dz) || 1;
      other.vx += (dx / flat) * impulse;
      other.vz += (dz / flat) * impulse;
      if (!vehicle(other)) other.down = Math.max(other.down || 0, 1.5);
    }
    this.destruction.blast(x, y, z, this.time);
  }
  combat = new Combat();
  attack(p: Entity) {
    this.combat.attack(p, this);
  }
  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }
  tick(dt: number) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120))),
      h = dt / steps;
    // Choose AI controls at 30 Hz; keep contact integration at 120 Hz.
    const intents = new Map<Entity, Intent>();
    const drives = new Map<Entity, Drive>();
    // Traffic and pedestrians nobody can see take one 30 Hz step in the first substep.
    const far = this.distantAi();
    const near =
      far.size > 0 ? [...this.entities.values()].filter((e) => !far.has(e)) : undefined;
    for (let i = 0; i < steps; i++) {
      if (i % 4 === 0) {
        intents.clear();
        drives.clear();
      }
      this.step(
        h,
        Math.min(4, steps - i) * h,
        intents,
        drives,
        i,
        steps,
        far,
        i === 0 ? undefined : near,
      );
    }
    this.pausedInputs.clear();
    this.tickCount++;
    this.traffic.update(this);
    // Publish current positions, including contact corrections and replenished traffic.
    this.spatial.clear();
    for (const e of this.entities.values())
      if (!e.vehicle) this.spatial.insert(e, e.x, e.z, 6);
    this.inventory.cleanup(this.time);
    this.destruction.update(this.time, dt, [...this.entities.values()]);
    // However a crate broke (fists, bullets, crashes or blasts), it drops a weapon.
    for (const crate of this.destruction.opened.splice(0)) {
      const kind = CRATE_WEAPONS[this.crates++ % CRATE_WEAPONS.length];
      this.inventory.spawn(
        crate.x,
        crate.z,
        this.inventory.item(kind),
        this.time,
        groundLevel(crate.x, crate.z, this.city),
      );
    }
    this.combat.record(this);
    if (this.events.length > 512) this.events.splice(0, this.events.length - 512);
  }
  /**
   * AI cars, boats and pedestrians too far from every human to touch what that human
   * controls within the prediction horizon (`contactRange`, which grows with speed and is
   * at least `lodFloor` metres). They are simulated at 30 Hz instead of 120 Hz: nothing a
   * player does can reach them within the horizon, and snapshots only carry 15 Hz poses
   * anyway. That is where nearly all of the server's per-tick cost went. Every body a
   * client might predict a contact with keeps the full rate, as does anything that is not
   * AI, so player-driven and pushed vehicles are never distant.
   */
  private distantAi() {
    const far = new Set<Entity>();
    if (!this.lod) return far;
    const humans: { x: number; z: number; speed: number }[] = [];
    for (const e of this.entities.values())
      if (e.kind === "player" && !e.ai) {
        const body = (e.vehicle && this.entities.get(e.vehicle)) || e;
        humans.push({ x: body.x, z: body.z, speed: speedLimit(body) });
      }
    for (const e of this.entities.values()) {
      if (!e.ai || e.driver || e.vehicle || e.wreck) continue;
      const own = speedLimit(e);
      let reach = false;
      for (const h of humans) {
        const range = Math.max(this.lodFloor, contactRange(h.speed, own));
        if ((e.x - h.x) ** 2 + (e.z - h.z) ** 2 < range * range) {
          reach = true;
          break;
        }
      }
      if (!reach) far.add(e);
    }
    return far;
  }
  /**
   * A pedestrian nobody can reach re-plans every fourth tick, staggered by id so the work
   * spreads evenly, and keeps walking toward its last target in between. It re-plans with the
   * time since its previous plan, so its stuck and wait timers still measure real elapsed time.
   */
  private pedestrianIntent(e: Entity, decisionDt: number, distant: boolean): Intent {
    const cached = this.plans.get(e);
    if (distant && cached) {
      if ((this.tickCount + cached.phase) % 4 !== 0) {
        // Repeating an attack every tick would be a different behaviour; only movement repeats.
        return { x: cached.intent.x, z: cached.intent.z, sprint: cached.intent.sprint };
      }
    }
    const elapsed =
      distant && cached ? Math.min(0.5, this.time - cached.at) : decisionDt;
    const intent = this.ai.pedestrian(
      e,
      this.spatial.query(e.x, e.z, 30),
      Math.max(elapsed, decisionDt),
      this.time,
      this.entities,
    );
    let phase = cached?.phase;
    if (phase === undefined) {
      phase = 0;
      for (let i = 0; i < e.id.length; i++)
        phase = (phase * 31 + e.id.charCodeAt(i)) % 4;
    }
    this.plans.set(e, { intent, at: this.time, phase });
    return intent;
  }
  private step(
    stepDt: number,
    decisionDt: number,
    intents: Map<Entity, Intent>,
    drives: Map<Entity, Drive>,
    substep: number,
    substeps: number,
    far: Set<Entity>,
    near?: Entity[],
  ) {
    this.time += stepDt;
    this.grenades.step(
      this.city,
      this.time,
      stepDt,
      (x, y, z, radius, damage) => this.blast(x, y, z, radius, damage),
      this.entities.values(),
    );
    this.day = (this.day + stepDt * this.dayRate) % 24;
    // After the first substep only bodies that are not distant take part.
    const list = near
      ? near.filter((e) => this.entities.get(e.id) === e)
      : [...this.entities.values()];
    // Only the AI decisions read the index, and they run on the first of each four substeps.
    if (substep % 4 === 0) {
      this.spatial.clear();
      for (const e of list) if (!e.vehicle) this.spatial.insert(e, e.x, e.z, 6);
    }
    for (const e of list) {
      // A distant body is integrated once per tick, so it covers the whole tick at once.
      const dt = far.has(e) ? stepDt * substeps : stepDt;
      e.cooldown = Math.max(0, (e.cooldown || 0) - dt);
      if (e.kind === "player") this.inventory.tick(e, this.time);
      if (e.wreck) {
        e.wreck -= dt;
        if (e.wreck <= 0) {
          const route = this.ai.routes.get(e.id);
          this.entities.delete(e.id);
          this.ai.routes.delete(e.id);
          this.ai.waterRoutes.delete(e.id);
          if (route) {
            this.traffic.scheduleReplacement(e, this.time);
          }
          continue;
        }
      }
      if (e.burning !== undefined) {
        e.burning -= dt;
        if (e.burning <= 0) this.explode(e);
      }
      if (e.vehicle) continue;
      if (e.down) {
        e.down = Math.max(0, e.down - dt);
        e.vx *= Math.exp(-5 * dt);
        e.vz *= Math.exp(-5 * dt);
        if (!e.down && e.health <= 0) this.respawn(e);
      }
      const controller = e.driver || e.id;
      if (!this.pausedInputs.has(controller)) {
        const input = this.inputs.get(controller) || idle();
        const previous = { x: e.x, y: e.y, z: e.z, vy: e.vy, vz: e.vz };
        if (!vehicle(e)) {
          if (!e.down) {
            const aiDirection = e.ai
              ? (intents.get(e) ?? this.pedestrianIntent(e, decisionDt, far.has(e)))
              : undefined;
            if (aiDirection) intents.set(e, aiDirection);
            characterForces(
              e,
              input,
              dt,
              aiDirection
                ? {
                    x: aiDirection.x,
                    z: aiDirection.z,
                    speed: aiDirection.sprint
                      ? 5
                      : this.ai.citizens.state(e).personality === "restless"
                        ? 2.8
                        : 2.2,
                  }
                : undefined,
              this.city,
            );
            if (aiDirection?.attack !== undefined) {
              e.angle = aiDirection.attack;
              this.attack(e);
            } else if (input.attack) this.attack(e);
          }
        } else if (e.kind === "car") {
          if (e.ai) this.exitCitizen(e);
          if (e.wreck || e.health <= 0) e.lightsOn = false;
          else if (e.ai) e.lightsOn = this.night();
          const drive = e.wreck
            ? { throttle: 0, steer: 0, brake: true }
            : e.ai
              ? (drives.get(e) ??
                this.ai.car(e, this.spatial.query(e.x, e.z, 24), this.time, decisionDt))
              : {
                  throttle: inputY(input),
                  steer: inputX(input),
                  brake: input.brake,
                };
          if (e.ai) drives.set(e, drive);
          e.drive = { ...drive };
          carForces(e, drive, dt, carGrounded(e, this.city));
        } else if (watercraft(e.kind)) {
          const drive =
            e.ai && !e.wreck
              ? (drives.get(e) ??
                this.ai.watercraft(e, this.spatial.query(e.x, e.z, 30)))
              : {
                  throttle: inputY(input),
                  steer: inputX(input),
                  brake: input.brake || !!e.wreck,
                };
          if (e.ai) drives.set(e, drive);
          e.drive = { ...drive };
          watercraftForces(e, drive, dt);
        } else if (
          !e.driver &&
          (e.y > groundLevel(e.x, e.z, this.city) + 0.2 || e.flight === "falling")
        ) {
          const impact = fallAircraft(e, this.city, dt);
          if (impact > 3) {
            this.damage(e, (impact - 3) ** 2 * TUNING.wallDamage);
            this.events.push({
              kind: "hit",
              x: e.x,
              z: e.z,
              y: e.y + 0.5,
              sound: "impact",
            });
          }
        } else if (e.kind === "helicopter" && !e.wreck) {
          if (e.driver && e.burning !== undefined && e.flight !== "landing")
            this.requestLanding(e);
          const wasLanding = e.flight === "landing";
          flyHelicopter(e, input, this.city, list, dt);
          if (wasLanding && e.flight === "grounded" && e.driver) {
            const p = this.entities.get(e.driver);
            if (p) this.exit(p, e);
          }
        } else if (e.kind === "plane") flyPlane(e, input, dt, this.city);
        const speed = Math.hypot(e.vx, e.vz),
          limit = e.model ? VEHICLES[e.model].speed : 52;
        if (vehicle(e) && speed > limit) {
          e.vx *= limit / speed;
          e.vz *= limit / speed;
        }
        e.x += e.vx * dt;
        e.z += e.vz * dt;
        if (
          (e.kind === "plane" || e.kind === "helicopter") &&
          isWater(e.x, e.z, this.city) &&
          e.y <= waterLevel(e.x, e.z, this.city) + 0.02 &&
          e.health > 0
        ) {
          this.damage(e, e.maxHealth || 100);
          this.events.push({
            kind: "hit",
            sound: "impact",
            x: e.x,
            y: waterLevel(e.x, e.z, this.city),
            z: e.z,
          });
        }
        if (e.kind === "car") carAltitude(e, previous, this.city, dt);
        if (!vehicle(e)) characterAltitude(e, this.city, dt, input);
        if (vehicle(e)) e.angle = wrap(e.angle + (e.angularVelocity || 0) * dt);
      }
    }
    // Recheck static contacts only when the prior pass or another body changed this body.
    const checked = new Map<
      Entity,
      Pick<Entity, "x" | "y" | "z" | "angle" | "vx" | "vz" | "angularVelocity">
    >();
    // Distant bodies cannot be reached by anyone, so one contact pass settles them.
    const fine = near ?? (far.size > 0 ? list.filter((e) => !far.has(e)) : list);
    for (let pass = 0; pass < 3; pass++) {
      const bodies = pass === 0 ? list : fine;
      for (const e of bodies) {
        if (e.vehicle || !this.entities.has(e.id)) continue;
        const pose = {
          x: e.x,
          y: e.y,
          z: e.z,
          angle: e.angle,
          vx: e.vx,
          vz: e.vz,
          angularVelocity: e.angularVelocity,
        };
        const previous = checked.get(e);
        if (
          previous &&
          previous.x === e.x &&
          previous.y === e.y &&
          previous.z === e.z &&
          previous.angle === e.angle &&
          previous.vx === e.vx &&
          previous.vz === e.vz &&
          previous.angularVelocity === e.angularVelocity
        )
          continue;
        checked.set(e, pose);
        for (const b of staticGeometry(this.city).query(e.x, e.z, 6)) {
          if (
            e.y >= b.h + (b.obstacle ? 0 : 1.8) - 0.02 ||
            Math.hypot(e.x - b.x, e.z - b.z) > Math.hypot(b.w, b.d) / 2 + 6
          )
            continue;
          const c = contact(entityBox(e), buildingBox(b));
          if (c) {
            if (b.destructibleId && this.destruction.broken.has(b.destructibleId))
              continue;
            if (pass === 0 && vehicle(e) && b.destructibleId) {
              const v = pointVelocity(e, c.x, c.z),
                speed = Math.max(0, v.x * c.nx + v.z * c.nz);
              if (
                speed > 2 &&
                this.damageProp(b.destructibleId, (speed - 2) * 14, {
                  x: e.vx * 0.7,
                  y: 2,
                  z: e.vz * 0.7,
                })
              ) {
                e.vx *= 0.96;
                e.vz *= 0.96;
                this.damage(e, Math.max(0, speed - 8) * 0.3);
                continue;
              }
            }
            const speed = resolveContact(e, undefined, c);
            if (pass === 0 && vehicle(e) && speed > 3) {
              this.damage(e, crashDamage(speed));
              this.events.push({ kind: "hit", x: c.x, z: c.z, y: e.y + 0.5 });
            }
          }
        }
        for (const c of rampContacts(e, this.city)) {
          const speed = resolveContact(e, undefined, c);
          if (pass === 0 && vehicle(e) && speed > 3) {
            this.damage(e, crashDamage(speed));
            this.events.push({ kind: "hit", x: c.x, z: c.z, y: e.y + 0.5 });
          }
        }
        const impact = resolveWorldBounds(e, this.city);
        if (vehicle(e) && pass === 0) this.damage(e, crashDamage(impact));
      }
      for (const [a, b] of collisionPairs(bodies)) {
        if (
          !this.entities.has(a.id) ||
          !this.entities.has(b.id) ||
          Math.abs(a.x - b.x) > 10 ||
          Math.abs(a.z - b.z) > 10
        )
          continue;
        const c = contact(entityBox(a), entityBox(b));
        if (!c) continue;
        let vehicleApproach = Infinity;
        if (vehicle(a) !== vehicle(b)) {
          // Character locomotion into a parked/departing vehicle is not a strike.
          // Use the vehicle's contact-point motion toward the character, including yaw.
          const v = vehicle(a) ? a : b;
          const velocity = pointVelocity(v, c.x, c.z);
          const direction = vehicle(a) ? 1 : -1;
          vehicleApproach = Math.max(
            0,
            direction * (velocity.x * c.nx + velocity.z * c.nz),
          );
        }
        const av = pointVelocity(a, c.x, c.z),
          bv = pointVelocity(b, c.x, c.z);
        const approachA = Math.max(0, av.x * c.nx + av.z * c.nz),
          approachB = Math.max(0, -bv.x * c.nx - bv.z * c.nz);
        const responsible =
          vehicle(a) !== vehicle(b)
            ? vehicle(a)
              ? a
              : b
            : approachA > approachB + 0.5
              ? a
              : approachB > approachA + 0.5
                ? b
                : undefined;
        const speed = Math.min(resolveContact(a, b, c), vehicleApproach);
        if (pass === 0 && speed > 3) {
          // Two vehicles use the vehicle curve; a person struck by one keeps the harsher one.
          const severity =
            vehicle(a) && vehicle(b)
              ? crashDamage(speed)
              : (speed - 3) ** 2 * TUNING.collisionDamage;
          this.damage(a, severity * Math.min(1, mass(b) / mass(a)), responsible);
          this.damage(b, severity * Math.min(1, mass(a) / mass(b)), responsible);
          if (!vehicle(a) && vehicle(b)) a.down = Math.max(a.down || 0, 0.8);
          if (!vehicle(b) && vehicle(a)) b.down = Math.max(b.down || 0, 0.8);
          this.events.push({
            kind: "hit",
            x: c.x,
            z: c.z,
            y: Math.max(a.y, b.y) + 0.5,
          });
        }
      }
    }
    // Pair impulses can displace a hull after the last static pass.
    for (const e of list) if (!e.vehicle) resolveWorldBounds(e, this.city);
    for (const p of list)
      if (p.vehicle) {
        const v = this.entities.get(p.vehicle);
        if (v) {
          p.x = v.x;
          p.z = v.z;
          p.y = v.y;
          p.angle = v.angle;
        }
      }
  }
}
