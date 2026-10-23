import init, {
  Physics,
  character_feet,
  vehicle_rest,
} from "../../crates/physics/pkg/afterhours_physics.js";
import { terrainMesh } from "../../shared/terrain.ts";
import { WATER_LEVEL, WORLD_LIMIT } from "../../shared/water.ts";
import {
  inputX,
  inputY,
  LIMIT,
  type City,
  type Entity,
  type Input,
} from "../../shared/world.ts";
import { wrap } from "../../shared/physics/vehicle.ts";
import { TUNING } from "../../shared/catalog.ts";
import { PHYSIQUES } from "../../shared/character.ts";
import {
  PROP_HEALTH,
  strikeDamage,
  strikeVelocity,
  type PredictedImpacts,
} from "../../shared/destruction.ts";
import { terrainHeight } from "../../shared/terrain.ts";

/** Mirrors the three car `VehicleSpec`s in crates/physics/src/lib.rs. */
type VehicleSpec = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
const VEHICLE_SPECS: Record<string, VehicleSpec> = {
  sedan: [1000, 2, 4.3, 1.4, 9750, 1320, 0.55, 0.34, 42],
  sport: [850, 1.9, 4.1, 1.4, 12500, 1500, 0.55, 0.34, 52],
  van: [1600, 2.2, 5, 1.4, 12500, 1800, 0.55, 0.34, 30],
} as const;
const WALK_SPEED = TUNING.walk,
  SPRINT = TUNING.sprint;
export const PRESENTATION = { smoothing: 0.1 };
/** Cars within this many metres (at most `NEIGHBOURS` of them) join the predicted world. */
const NEIGHBOUR_RANGE = 40,
  NEIGHBOURS = 8;
/** Props within `PROP_RANGE` join the predicted world as colliders and leave beyond `PROP_KEEP`. */
const PROP_RANGE = 45,
  PROP_KEEP = 70;
/** The server's strike rule (`destruction.rs`): above this approach speed, 96% of it is kept. */
const STRIKE_MIN_SPEED = 2,
  STRIKE_RETENTION = 0.96;
/** A predicted break the server has not confirmed by then stands the prop up again. */
const STRIKE_CONFIRM_MS = 1200,
  STRIKE_KEEP_MS = 1500;
type Standing = { body: number; kind: keyof typeof PROP_HEALTH; x: number; z: number };
/** Cars this close are drawn from the predicted world, fading in and out over `SHOWN_FADE` s. */
const SHOWN_RANGE = 16,
  SHOWN_FADE = 0.4;
/** A car as the predicted world has it. */
export interface CarPose {
  x: number;
  y: number;
  z: number;
  angle: number;
  pitch: number;
  roll: number;
  vx: number;
  vy: number;
  vz: number;
  steering: number;
}
type Velocity = { vx: number; vy: number; vz: number };
const velocityOf = ({ vx, vy, vz }: Velocity): Velocity => ({ vx, vy, vz });
/** The velocity a fraction `f` of the way from `a` to `b`. */
const ramp = (a: Velocity, b: Velocity, f: number): Velocity => ({
  vx: a.vx + (b.vx - a.vx) * f,
  vy: a.vy + (b.vy - a.vy) * f,
  vz: a.vz + (b.vz - a.vz) * f,
});
interface Shown {
  pose: CarPose;
  /** Velocity at the step before, so the drawn one ramps over a tick instead of jumping. */
  from: Velocity;
  /** Per second, from the last step, carried on between input ticks. */
  rate: { x: number; y: number; z: number; angle: number };
  /** Snapshot correction still easing out. */
  offset: { x: number; y: number; z: number; angle: number };
  weight: number;
  live: boolean;
}
const still = () => ({ x: 0, y: 0, z: 0, angle: 0 });
/** Quaternion (x, y, z, w) for yaw about Y, then pitch about X, then roll about Z. */
export function yawPitchRoll(yaw: number, pitch: number, roll: number) {
  const [sy, cy, sp, cp, sr, cr] = [
    Math.sin(yaw / 2),
    Math.cos(yaw / 2),
    Math.sin(pitch / 2),
    Math.cos(pitch / 2),
    Math.sin(roll / 2),
    Math.cos(roll / 2),
  ];
  return [
    cy * sp * cr + sy * cp * sr,
    sy * cp * cr - cy * sp * sr,
    cy * cp * sr - sy * sp * cr,
    cy * cp * cr + sy * sp * sr,
  ];
}

let ready: Promise<unknown> | undefined;
/** Loads the wasm physics once; the server runs the same crate natively. */
export function loadPhysics() {
  return (ready ??=
    typeof process !== "undefined" && process.versions?.node
      ? import("node:fs/promises").then(({ readFile }) =>
          readFile(
            new URL(
              "../../crates/physics/pkg/afterhours_physics_bg.wasm",
              import.meta.url,
            ),
          ).then((bytes) => init(bytes)),
        )
      : init());
}

export interface PredictedInput {
  tick: number;
  input: Input;
}

/**
 * Runs the local body in the shared wasm physics: restore the server's row, replay the
 * inputs it has not applied yet, and present the result with a decaying offset so
 * corrections slide instead of snapping.
 */
export class Prediction {
  pending: PredictedInput[] = [];
  body: Entity | undefined;
  corrections = 0;
  lastCorrection = { distance: 0, angle: 0 };
  offset = { x: 0, y: 0, z: 0, angle: 0 };
  private world = new Physics();
  private kind: "character" | "vehicle" | undefined;
  private physique: keyof typeof PHYSIQUES | undefined;
  private vehicleModel: string | undefined;
  private vehicleEntity: string | undefined;
  private id = 0;
  private facing = 0;
  private lastRender = 0;
  private shown = new Map<string, Shown>();
  /** Props standing in the predicted world, by fixture id, and by physics id. */
  private props = new Map<string, Standing>();
  private propIds = new Map<number, string>();
  private propDamage = new Map<string, number>();
  /** Props the predicted car broke and when; the server confirms them with its `broken` list. */
  private strikes = new Map<string, { at: number; confirmed: boolean }>();
  /** Fixtures this prediction broke, with the strike velocity: the scene throws them at once. */
  impacts: PredictedImpacts = new Map();
  /** Nearby cars as drawn this frame (predicted, corrections eased), with how much to trust them. */
  drawnCars = new Map<string, { pose: CarPose; weight: number }>();
  /** How fast the body moved in its last step (per second) and when that step ran. */
  private drift = { x: 0, y: 0, z: 0, angle: 0 };
  private stepAt = 0;
  /** The drawn velocity ramps from the step before to the last one: the suspension springs read its change. */
  private speeds: { from: Velocity; to: Velocity } | undefined;
  /** Nearby cars simulated alongside the local body: entity id -> physics body id. */
  private neighbours = new Map<string, number>();
  private buildingColliders = new WeakSet<object>();
  private parkColliders = new WeakSet<object>();
  constructor(private map: Pick<City, "terrain">) {
    // Terrain and water are available immediately; streamed buildings and parks are
    // added once their neighborhood arrives.
    if (map.terrain) {
      const { positions, indices } = terrainMesh(map.terrain);
      this.world.add_trimesh(Float32Array.from(positions), Uint32Array.from(indices));
    } else this.world.add_box(0, -0.1, 0, LIMIT, 0.1, LIMIT, 0);
    this.world.add_box(0, WATER_LEVEL - 0.4, 0, WORLD_LIMIT, 0.1, WORLD_LIMIT, 0);
  }
  /** Add streamed server colliders to the local vehicle world once. */
  syncStatic(city: Pick<City, "buildings" | "parks">) {
    for (const building of city.buildings) {
      if (this.buildingColliders.has(building)) continue;
      const y = building.y ?? 0;
      this.world.add_box(
        building.x,
        (y + building.h) / 2,
        building.z,
        building.w / 2,
        Math.max(0, (building.h - y) / 2),
        building.d / 2,
        // Footprint frame: local x -> (cos a, sin a), a right-handed yaw of -a.
        -(building.angle ?? 0),
      );
      this.buildingColliders.add(building);
    }
    for (const park of city.parks) {
      if (this.parkColliders.has(park)) continue;
      this.world.add_box(
        park.x,
        0.2,
        park.z,
        (park.w ?? 38) / 2,
        0.2,
        (park.d ?? 38) / 2,
        0,
      );
      this.parkColliders.add(park);
    }
  }
  /**
   * The trees, palms and lamps around the local body as colliders, like the server has them, so a
   * hit is felt and shown at once instead of a round trip later. `broken` is the server's list
   * of broken fixtures; those leave the predicted world and return when it drops them.
   */
  syncProps(
    props: City["props"],
    broken: ReadonlySet<string>,
    now = performance.now(),
  ) {
    for (const [id, strike] of this.strikes) {
      strike.confirmed ||= broken.has(id);
      const age = now - strike.at;
      if (age > STRIKE_KEEP_MS || (!strike.confirmed && age > STRIKE_CONFIRM_MS)) {
        // Unconfirmed: the server did not break it, so it stands again below.
        this.strikes.delete(id);
        this.impacts.delete(id);
      }
    }
    for (const [id, prop] of this.props) if (broken.has(id)) this.dropProp(id, prop);
    const body = this.body;
    if (!body) return;
    for (const [id, prop] of this.props)
      if (Math.hypot(prop.x - body.x, prop.z - body.z) > PROP_KEEP)
        this.dropProp(id, prop);
    for (const p of props) {
      if (Math.hypot(p.x - body.x, p.z - body.z) > PROP_RANGE) continue;
      const id = `${p.kind}:${p.x.toFixed(4)},${p.z.toFixed(4)}`;
      if (this.props.has(id) || broken.has(id) || this.strikes.has(id)) continue;
      const w = (p.kind === "tree" ? 0.5 : 0.38) / 2,
        y = terrainHeight(p.x, p.z, this.map);
      const handle = this.world.add_prop(
        p.x,
        y + p.h / 2,
        p.z,
        w,
        p.h / 2,
        w,
        p.angle ?? 0,
      );
      this.props.set(id, { body: handle, kind: p.kind, x: p.x, z: p.z });
      this.propIds.set(handle, id);
    }
  }
  private dropProp(id: string, prop: Standing) {
    this.world.remove_prop(prop.body);
    this.props.delete(id);
    this.propIds.delete(prop.body);
  }
  /**
   * After a live step: the server's strike rule for the local car. Enough damage breaks the prop,
   * which keeps 96% of the car's speed and flies off. Replayed steps do not count again.
   */
  private strike(now: number) {
    const rows = this.world.impacts();
    for (let i = 0; i < rows.length; i += 6) {
      const [vehicle, handle, speed, vx, vy, vz] = rows.subarray(i, i + 6);
      if (vehicle !== this.id || speed <= STRIKE_MIN_SPEED) continue;
      const id = this.propIds.get(handle),
        prop = id === undefined ? undefined : this.props.get(id);
      if (id === undefined || !prop) continue;
      const damage = (this.propDamage.get(id) ?? 0) + strikeDamage(speed);
      this.propDamage.set(id, damage);
      if (damage < PROP_HEALTH[prop.kind]) continue;
      this.dropProp(id, prop);
      this.world.set_vehicle_velocity(
        this.id,
        vx * STRIKE_RETENTION,
        vy,
        vz * STRIKE_RETENTION,
      );
      this.impacts.set(id, strikeVelocity({ vx, vz }));
      this.strikes.set(id, { at: now, confirmed: false });
    }
  }
  reset() {
    this.pending = [];
    this.body = undefined;
    this.offset = { x: 0, y: 0, z: 0, angle: 0 };
    this.remove();
    for (const body of this.neighbours.values()) this.world.remove_vehicle(body);
    this.neighbours.clear();
    this.shown.clear();
    this.drawnCars.clear();
    this.speeds = undefined;
    for (const [id, prop] of this.props) this.dropProp(id, prop);
    this.propDamage.clear();
    this.strikes.clear();
    this.impacts.clear();
  }
  /**
   * Keeps the cars around the local body in the predicted world, as the server has them, so
   * driving into a parked or passing car stops the predicted body where the server stops it
   * instead of correcting by metres. They are reset from the snapshot on every reconcile and
   * coast between snapshots (parked ones hold their brake).
   */
  private syncNeighbours(local: Entity, cars: Entity[]) {
    const near = cars
      .filter(
        (c) =>
          c.kind === "car" &&
          c.id !== local.vehicle &&
          Math.hypot(c.x - local.x, c.z - local.z) < NEIGHBOUR_RANGE,
      )
      .sort(
        (a, b) =>
          Math.hypot(a.x - local.x, a.z - local.z) -
          Math.hypot(b.x - local.x, b.z - local.z),
      )
      .slice(0, NEIGHBOURS);
    const keep = new Set(near.map((c) => c.id));
    for (const [id, body] of this.neighbours)
      if (!keep.has(id)) {
        this.world.remove_vehicle(body);
        this.neighbours.delete(id);
      }
    for (const c of near) {
      const pitch = c.pitch ?? 0,
        roll = c.roll ?? 0,
        [x, y, z, w] = yawPitchRoll(c.angle, pitch, roll),
        centre = c.y + vehicle_rest() * Math.cos(pitch) * Math.cos(roll);
      let body = this.neighbours.get(c.id);
      if (body === undefined) {
        body = this.world.spawn_vehicle(
          ...(VEHICLE_SPECS[c.model ?? "sedan"] ?? VEHICLE_SPECS.sedan),
          c.x,
          centre,
          c.z,
          c.angle,
        );
        this.neighbours.set(c.id, body);
      }
      this.world.restore_entity(
        body,
        Float32Array.of(c.x, centre, c.z, x, y, z, w, c.vx, c.vy, c.vz, 0, 0, 0, 0, 0),
      );
      // Someone is at the wheel: coast rather than hold the parking brake.
      if (c.driver || c.ai) this.world.set_drive(body, 0, 0, false);
    }
  }
  private carPose(body: number): CarPose {
    const [x, y, z, qx, qy, qz, qw, vx, vy, vz] = this.world
      .state_of(body)
      .subarray(1, 11);
    const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (qw * qx - qy * qz)))),
      roll = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qx * qx + qz * qz));
    return {
      x,
      // Entities carry the ground under the wheels, not the body centre.
      y: y - vehicle_rest() * Math.cos(pitch) * Math.cos(roll),
      z,
      angle: Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qz * qz)),
      pitch,
      roll,
      vx,
      vy,
      vz,
      steering: this.world.steering(body),
    };
  }
  private neighbourPoses() {
    const poses = new Map<string, CarPose>();
    for (const [id, body] of this.neighbours) poses.set(id, this.carPose(body));
    return poses;
  }
  /** After a snapshot: carry each car's jump so it eases out, and mark which ones to draw. */
  private settle(
    before: Map<string, CarPose>,
    after: Map<string, CarPose>,
    local: { x: number; z: number },
  ) {
    for (const [id, pose] of after) {
      const near = Math.hypot(pose.x - local.x, pose.z - local.z) < SHOWN_RANGE;
      let car = this.shown.get(id);
      if (!car) {
        car = {
          pose,
          from: velocityOf(pose),
          rate: still(),
          offset: still(),
          weight: 0,
          live: near,
        };
        this.shown.set(id, car);
      }
      const was = before.get(id);
      if (was) {
        const o = car.offset;
        o.x += was.x - pose.x;
        o.y += was.y - pose.y;
        o.z += was.z - pose.z;
        o.angle += wrap(was.angle - pose.angle);
        if (Math.hypot(o.x, o.z) > 2) car.offset = still();
      }
      car.pose = pose;
      car.live = near;
    }
    for (const [id, car] of this.shown) if (!after.has(id)) car.live = false;
  }
  private remove() {
    if (this.kind === "vehicle") this.world.remove_vehicle(this.id);
    else if (this.kind === "character") this.world.remove_character(this.id);
    this.kind = undefined;
    this.drift = { x: 0, y: 0, z: 0, angle: 0 };
  }
  /** Authoritative state for the local body plus its raw physics row. */
  reconcile(
    entity: Entity,
    controlledVehicle: Entity | undefined,
    you: number[],
    ack: number | undefined,
    cars: Entity[] = [],
  ) {
    const kind = entity.vehicle ? "vehicle" : "character";
    this.physique = entity.character?.physique;
    const model = controlledVehicle?.model ?? entity.model;
    const vehicleChanged =
      kind === "vehicle" &&
      (this.vehicleModel !== model || this.vehicleEntity !== entity.vehicle);
    if (kind !== this.kind || vehicleChanged) {
      this.remove();
      this.kind = kind;
      this.vehicleModel = model;
      this.vehicleEntity = entity.vehicle;
      const vehicleSpec = model
        ? (VEHICLE_SPECS[model] ?? VEHICLE_SPECS.sedan)
        : VEHICLE_SPECS.sedan;
      this.id =
        kind === "vehicle"
          ? this.world.spawn_vehicle(
              ...vehicleSpec,
              entity.x,
              entity.y + vehicle_rest(),
              entity.z,
              entity.angle,
            )
          : this.world.spawn_character(entity.x, entity.y + character_feet(), entity.z);
    }
    const carsBefore = this.neighbourPoses();
    try {
      this.syncNeighbours(entity, cars);
      this.world.restore_entity(this.id, Float32Array.from(you));
    } catch {
      return;
    }
    if (ack !== undefined) this.pending = this.pending.filter((p) => p.tick > ack);
    for (const p of this.pending) this.step(p.input);
    const before = this.body,
      after = this.read(entity);
    this.settle(carsBefore, this.neighbourPoses(), after);
    if (this.speeds) this.speeds.to = velocityOf(after);
    if (before) {
      const distance = Math.hypot(after.x - before.x, after.z - before.z),
        angle = wrap(after.angle - before.angle);
      this.lastCorrection = { distance, angle };
      if (distance > 0.3) this.corrections++;
      // Carry the visible error so the next frames ease it away.
      this.offset = {
        x: this.offset.x + before.x - after.x,
        y: this.offset.y + before.y - after.y,
        z: this.offset.z + before.z - after.z,
        angle: this.offset.angle + wrap(before.angle - after.angle),
      };
      if (distance > 2) this.offset = { x: 0, y: 0, z: 0, angle: 0 };
    }
    this.body = after;
  }
  /**
   * Steps the local body one tick. `at` is the slot the input was due in (ms): the drawn body is
   * carried on from there, so a late frame that steps several slots at once still moves it by
   * exactly the elapsed time instead of stalling and then hopping.
   */
  input(tick: number, input: Input, at = performance.now()) {
    if (!this.kind || !this.body) return;
    this.pending.push({ tick, input });
    const before = this.body,
      carsBefore = this.neighbourPoses();
    this.step(input);
    if (this.kind === "vehicle") this.strike(performance.now());
    this.body = this.read(this.body);
    const rate = 1 / TUNING.tick;
    for (const [id, pose] of this.neighbourPoses()) {
      const car = this.shown.get(id),
        was = carsBefore.get(id);
      if (!car || !was) continue;
      car.pose = pose;
      car.from = velocityOf(was);
      car.rate = {
        x: (pose.x - was.x) * rate,
        y: (pose.y - was.y) * rate,
        z: (pose.z - was.z) * rate,
        angle: wrap(pose.angle - was.angle) * rate,
      };
    }
    this.drift = {
      x: (this.body.x - before.x) * rate,
      y: (this.body.y - before.y) * rate,
      z: (this.body.z - before.z) * rate,
      // A walker turns on the spot; only a vehicle's heading carries on between steps.
      angle: this.kind === "vehicle" ? wrap(this.body.angle - before.angle) * rate : 0,
    };
    // The row carries no horizontal speed for a walker; without this it keeps the snapshot's.
    if (this.kind === "character")
      this.body = { ...this.body, vx: this.drift.x, vz: this.drift.z };
    this.speeds = { from: velocityOf(before), to: velocityOf(this.body) };
    this.stepAt = at;
  }
  private step(input: Input) {
    const x = inputX(input),
      y = inputY(input);
    if (this.kind === "vehicle") this.world.set_drive(this.id, y, x, input.brake);
    else {
      const speed =
        (input.sprint || input.brake ? SPRINT : WALK_SPEED) *
        (this.physique ? PHYSIQUES[this.physique].speed : 1);
      this.world.set_move(this.id, x, y, speed, input.ascend);
      if (x || y) this.facing = Math.atan2(x, y);
    }
    this.world.step();
  }
  private read(base: Entity): Entity {
    if (this.kind === "vehicle") return { ...base, ...this.carPose(this.id) };
    const [x, y, z, vy] = this.world.state_of(this.id).subarray(1, 5);
    return { ...base, x, y: y - character_feet(), z, vy, angle: this.facing };
  }
  /** The predicted body as drawn, with the correction offset easing out. */
  render(now: number): Entity | undefined {
    if (!this.body) return undefined;
    const dt = Math.min(0.1, (now - this.lastRender) / 1000);
    this.lastRender = now;
    const keep = Math.exp(-dt / PRESENTATION.smoothing);
    const o = this.offset;
    this.offset = {
      x: o.x * keep,
      y: o.y * keep,
      z: o.z * keep,
      angle: o.angle * keep,
    };
    // The body only advances on input ticks (30 Hz); carry its last step on to this frame so a
    // faster screen sees steady motion instead of a stall and a double jump. Two ticks at most:
    // past that the input has stopped, and running on would overshoot a stop.
    const ahead = Math.min(2 * TUNING.tick, Math.max(0, (now - this.stepAt) / 1000)),
      d = this.drift,
      b = this.body;
    // The cars around it get the same treatment: drawn where the predicted world has them, which
    // is where the predicted body collides with them, not where the server had them a moment ago.
    this.drawnCars.clear();
    for (const [id, car] of this.shown) {
      const e = car.offset;
      e.x *= keep;
      e.y *= keep;
      e.z *= keep;
      e.angle *= keep;
      car.weight = Math.max(
        0,
        Math.min(1, car.weight + (car.live ? dt : -dt) / SHOWN_FADE),
      );
      if (!car.live && car.weight === 0) {
        this.shown.delete(id);
        continue;
      }
      const p = car.pose,
        r = car.rate;
      this.drawnCars.set(id, {
        weight: car.weight,
        pose: {
          ...p,
          ...ramp(car.from, p, ahead / TUNING.tick),
          x: p.x + e.x + r.x * ahead,
          y: p.y + e.y + r.y * ahead,
          z: p.z + e.z + r.z * ahead,
          angle: p.angle + e.angle + r.angle * ahead,
        },
      });
    }
    return {
      ...b,
      ...(this.speeds
        ? ramp(this.speeds.from, this.speeds.to, ahead / TUNING.tick)
        : {}),
      x: b.x + o.x + d.x * ahead,
      y: b.y + o.y + d.y * ahead,
      z: b.z + o.z + d.z * ahead,
      angle: b.angle + o.angle + d.angle * ahead,
    };
  }
}

/**
 * The sampled frame with the local body swapped for the predicted one: the player, and the car it
 * drives. Without the car the camera and the mesh follow the delayed server copy by the whole
 * interpolation delay, whatever the prediction does.
 */
export function withPredicted(
  frame: Entity[],
  me: Entity,
  playerId: string,
  cars?: ReadonlyMap<string, { pose: CarPose; weight: number }>,
  /** The car the newest snapshot says the player drives; the delayed copy shows it later. */
  driving?: string,
): Entity[] {
  const vehicle = me.vehicle;
  const { x, y, z, vx, vy, vz, angle, pitch, roll, steering } = me;
  const pose = { x, y, z, vx, vy, vz, angle, pitch, roll, steering };
  /** A nearby car between its delayed server copy and the predicted one, by `weight`. */
  const blend = (
    e: Entity,
    { pose: p, weight: w }: { pose: CarPose; weight: number },
  ) => {
    const mix = (a: number, b: number) => a + (b - a) * w;
    return {
      ...e,
      x: mix(e.x, p.x),
      y: mix(e.y, p.y),
      z: mix(e.z, p.z),
      vx: mix(e.vx, p.vx),
      vy: mix(e.vy, p.vy),
      vz: mix(e.vz, p.vz),
      angle: e.angle + wrap(p.angle - e.angle) * w,
      pitch: mix(e.pitch ?? 0, p.pitch),
      roll: mix(e.roll ?? 0, p.roll),
      steering: mix(e.steering ?? 0, p.steering),
    };
  };
  return frame.map((e) => {
    if (e.id === playerId) return { ...e, ...me };
    if (
      e.id === vehicle &&
      e.kind === "car" &&
      (e.driver === playerId || e.id === driving) &&
      pitch !== undefined
    )
      return { ...e, ...pose };
    const car = e.kind === "car" ? cars?.get(e.id) : undefined;
    return car ? blend(e, car) : e;
  });
}

export function interpolate(
  a: Entity,
  b: Entity,
  fraction: number,
  duration = 0,
): Entity {
  const t = fraction,
    t2 = t * t,
    t3 = t2 * t;
  const position = (start: number, end: number, va: number, vb: number) =>
    duration > 0 && Math.abs(end - start) < 8
      ? (2 * t3 - 3 * t2 + 1) * start +
        (t3 - 2 * t2 + t) * duration * va +
        (-2 * t3 + 3 * t2) * end +
        (t3 - t2) * duration * vb
      : start + (end - start) * t;
  return {
    ...b,
    x: position(a.x, b.x, a.vx, b.vx),
    z: position(a.z, b.z, a.vz, b.vz),
    y: position(a.y, b.y, a.vy, b.vy),
    vx: a.vx + (b.vx - a.vx) * t,
    vz: a.vz + (b.vz - a.vz) * t,
    vy: a.vy + (b.vy - a.vy) * t,
    angle: a.angle + wrap(b.angle - a.angle) * fraction,
    ...(b.pitch !== undefined || b.roll !== undefined
      ? {
          pitch: (a.pitch ?? 0) + ((b.pitch ?? 0) - (a.pitch ?? 0)) * fraction,
          roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * fraction,
        }
      : {}),
    aim:
      b.aim === undefined
        ? undefined
        : (a.aim ?? a.angle) + wrap(b.aim - (a.aim ?? a.angle)) * fraction,
  };
}
