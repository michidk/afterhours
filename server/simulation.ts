import { DEFAULT_CHARACTER, PHYSIQUES, type Character } from "../shared/character.ts";
import { navigationFor } from "../shared/navigation.ts";
import { staticGeometry } from "../shared/physics/static.ts";
import {
  idle,
  LIMIT,
  type City,
  type Entity,
  type Input,
  type Kind,
  type WorldEvent,
} from "../shared/world.ts";
import {
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
  entityBox,
  buildingBox,
  resolveContact,
  pointVelocity,
} from "../shared/physics/index.ts";
import { CityAI } from "./ai.ts";
import { TrafficManager } from "./traffic.ts";
import { flyHelicopter, landingSite } from "../shared/physics/index.ts";
import { characterForces, characterAltitude } from "../shared/physics/index.ts";
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
export class Simulation {
  city: City;
  entities = new Map<string, Entity>();
  inputs = new Map<string, Input>();
  ai: CityAI;
  traffic = new TrafficManager();
  time = 0;
  day = 16.5;
  dayRate = 1 / 75;
  events: WorldEvent[] = [];
  serial = 0;
  inventory = new Inventory();
  grenades = new Grenades();
  spatial = new SpatialGrid<Entity>();
  destruction: Destruction;

  constructor(city: City) {
    this.city = city;
    this.destruction = new Destruction(city);
    this.ai = new CityAI(navigationFor(city), city);
    for (let i = 0; i < 84; i++) {
      const e = this.spawn(
        "car",
        0,
        0,
        undefined,
        (["sedan", "sport", "van"] as const)[i % 3],
      );
      this.ai.assign(e, i);
    }
    for (let i = 0; i < 130; i++) {
      const e = this.spawn("pedestrian", 0, 0);
      this.ai.assign(e, i + 9);
    }
    this.spawn("car", 4, 25);
    this.spawn("car", -4, 44, undefined, "sport");
    this.spawn("car", 68, 25, undefined, "van");
    this.spawn("helicopter", 0, 36);
    this.spawn(
      "plane",
      this.city.airport.x,
      this.city.airport.z - this.city.airport.d / 2 + 14,
    );
    this.spawn("helicopter", -64, 30, undefined, "utility");
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
      this.inventory.addSource(p.x, p.z, p.weapon as "bat" | "pistol" | "smg");
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
          this.inventory.addSupplySource(x, z, payload);
          placed = true;
          break;
        }
        if (placed) break;
      }
    }
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
      this.city.buildings.some(
        (b) => Math.abs(x - b.x) < b.w / 2 + r && Math.abs(z - b.z) < b.d / 2 + r,
      )
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
    const person = this.spawn("pedestrian", car.x, car.z, car.color);
    if (!this.exit(person, car)) {
      this.entities.delete(person.id);
      return;
    }
    this.ai.assign(person, this.serial, false);
    this.ai.citizens.transferDriver(car, person, this.time);
    car.ai = false;
    this.ai.routes.delete(car.id);
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
          p.kind === "palm" || p.kind === "tree" || p.kind === "bench"
            ? "impactWood"
            : "impact",
        x: p.x,
        y: 0.5,
        z: p.z,
      });
    }
    return broken;
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
    const excluded = new Set([e.id]);
    for (const p of this.entities.values())
      if (p.vehicle === e.id) {
        this.releaseSeat(p, e);
        p.x = e.x;
        p.z = e.z;
        p.y = e.y;
        this.damage(p, 150);
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
    for (let i = 0; i < steps; i++) this.step(h);
    if (this.traffic.update(this)) {
      // Newly replenished cars must enter snapshot interest in this tick.
      this.spatial.clear();
      for (const e of this.entities.values())
        if (!e.vehicle) this.spatial.insert(e, e.x, e.z, 6);
    }
    this.inventory.cleanup(this.time);
    this.destruction.update(this.time, dt, [...this.entities.values()]);
    this.combat.record(this);
    if (this.events.length > 512) this.events.splice(0, this.events.length - 512);
  }
  private step(dt: number) {
    this.time += dt;
    this.grenades.step(
      this.city,
      this.time,
      dt,
      (x, y, z, radius, damage) => this.blast(x, y, z, radius, damage),
      this.entities.values(),
    );
    this.day = (this.day + dt * this.dayRate) % 24;
    const list = [...this.entities.values()];
    this.spatial.clear();
    for (const e of list) if (!e.vehicle) this.spatial.insert(e, e.x, e.z, 6);
    for (const e of list) {
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
        if (!e.down && e.health <= 0) {
          e.health = e.maxHealth ?? 100;
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
      }
      const previous = { ...e };
      const input = this.inputs.get(e.driver || e.id) || idle();
      if (!vehicle(e)) {
        if (!e.down) {
          const aiDirection = e.ai
            ? this.ai.pedestrian(
                e,
                this.spatial.query(e.x, e.z, 30),
                dt,
                this.time,
                this.entities,
              )
            : undefined;
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
        else if (e.ai) e.lightsOn = this.day >= 18 || this.day < 6;
        const drive = e.wreck
          ? { throttle: 0, steer: 0, brake: true }
          : e.ai
            ? this.ai.car(e, this.spatial.query(e.x, e.z, 24), this.time, dt)
            : {
                throttle: Number(input.up) - Number(input.down),
                steer: Number(input.right) - Number(input.left),
                brake: input.brake,
              };
        carForces(e, drive, dt, carGrounded(e, this.city));
      } else if (watercraft(e.kind)) {
        const drive =
          e.ai && !e.wreck
            ? this.ai.watercraft(e, this.spatial.query(e.x, e.z, 30))
            : {
                throttle: Number(input.up) - Number(input.down),
                steer: Number(input.right) - Number(input.left),
                brake: input.brake || !!e.wreck,
              };
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
        e.y <= WATER_LEVEL + 0.02 &&
        e.health > 0
      ) {
        this.damage(e, e.maxHealth || 100);
        this.events.push({
          kind: "hit",
          sound: "impact",
          x: e.x,
          y: WATER_LEVEL,
          z: e.z,
        });
      }
      if (e.kind === "car") carAltitude(e, previous, this.city, dt);
      if (!vehicle(e)) characterAltitude(e, this.city, dt, input);
      if (vehicle(e)) e.angle = wrap(e.angle + (e.angularVelocity || 0) * dt);
    }
    for (let pass = 0; pass < 3; pass++) {
      this.spatial.clear();
      for (const e of list)
        if (!e.vehicle && this.entities.has(e.id)) this.spatial.insert(e, e.x, e.z, 6);
      for (const e of list) {
        if (e.vehicle || !this.entities.has(e.id)) continue;
        for (const b of staticGeometry(this.city).query(e.x, e.z, 6)) {
          if (
            e.y >= b.h + (b.obstacle ? 0 : 1.8) - 0.02 ||
            Math.abs(e.x - b.x) > b.w / 2 + 6 ||
            Math.abs(e.z - b.z) > b.d / 2 + 6
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
              this.damage(e, (speed - 3) ** 2 * TUNING.wallDamage);
              this.events.push({ kind: "hit", x: c.x, z: c.z, y: e.y + 0.5 });
            }
          }
        }
        for (const c of rampContacts(e, this.city)) {
          const speed = resolveContact(e, undefined, c);
          if (pass === 0 && vehicle(e) && speed > 3) {
            this.damage(e, (speed - 3) ** 2 * TUNING.wallDamage);
            this.events.push({ kind: "hit", x: c.x, z: c.z, y: e.y + 0.5 });
          }
        }
        const impact = resolveWorldBounds(e, this.city);
        if (vehicle(e) && pass === 0)
          this.damage(e, Math.max(0, impact - 3) ** 2 * TUNING.wallDamage);
      }
      for (let i = 0; i < list.length; i++)
        for (const b of this.spatial.query(list[i].x, list[i].z, 10)) {
          const a = list[i];
          if (a.id >= b.id || !this.entities.has(a.id) || !this.entities.has(b.id))
            continue;
          if (
            a.vehicle ||
            b.vehicle ||
            (!vehicle(a) && a.health <= 0) ||
            (!vehicle(b) && b.health <= 0) ||
            Math.abs(a.y - b.y) > 1.8 ||
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
            const severity = (speed - 3) ** 2 * TUNING.collisionDamage;
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
