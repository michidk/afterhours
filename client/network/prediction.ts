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
interface Shown {
  pose: CarPose;
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
  /** Nearby cars as drawn this frame (predicted, corrections eased), with how much to trust them. */
  drawnCars = new Map<string, { pose: CarPose; weight: number }>();
  /** How fast the body moved in its last step (per second) and when that step ran. */
  private drift = { x: 0, y: 0, z: 0, angle: 0 };
  private stepAt = 0;
  /** Nearby cars simulated alongside the local body: entity id -> physics body id. */
  private neighbours = new Map<string, number>();
  private buildingColliders = new WeakSet<object>();
  private parkColliders = new WeakSet<object>();
  constructor(map: Pick<City, "terrain">) {
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
  reset() {
    this.pending = [];
    this.body = undefined;
    this.offset = { x: 0, y: 0, z: 0, angle: 0 };
    this.remove();
    for (const body of this.neighbours.values()) this.world.remove_vehicle(body);
    this.neighbours.clear();
    this.shown.clear();
    this.drawnCars.clear();
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
        car = { pose, rate: still(), offset: still(), weight: 0, live: near };
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
  input(tick: number, input: Input) {
    if (!this.kind || !this.body) return;
    this.pending.push({ tick, input });
    const before = this.body,
      carsBefore = this.neighbourPoses();
    this.step(input);
    this.body = this.read(this.body);
    const rate = 1 / TUNING.tick;
    for (const [id, pose] of this.neighbourPoses()) {
      const car = this.shown.get(id),
        was = carsBefore.get(id);
      if (!car || !was) continue;
      car.pose = pose;
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
    this.stepAt = performance.now();
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
    // faster screen sees steady motion instead of a stall and a double jump.
    const ahead = Math.min(TUNING.tick, Math.max(0, (now - this.stepAt) / 1000)),
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
          x: p.x + e.x + r.x * ahead,
          y: p.y + e.y + r.y * ahead,
          z: p.z + e.z + r.z * ahead,
          angle: p.angle + e.angle + r.angle * ahead,
        },
      });
    }
    return {
      ...b,
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
): Entity[] {
  const vehicle = frame.find((e) => e.id === playerId)?.vehicle;
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
      e.driver === playerId &&
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
