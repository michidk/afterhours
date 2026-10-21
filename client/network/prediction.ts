import init, { Physics } from "../../crates/physics/pkg/afterhours_physics.js";
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

/** Mirrors `VehicleSpec::SEDAN` and the walk speeds in crates/server/src/game.rs. */
const SEDAN = [1000, 2, 4.3, 1.4, 9750, 7000, 0.55, 0.34] as const;
const WALK_SPEED = 4.5,
  SPRINT = 1.6;
export const PRESENTATION = { smoothing: 0.1 };

let ready: Promise<unknown> | undefined;
/** Loads the wasm physics once; the server runs the same crate natively. */
export function loadPhysics() {
  return (ready ??= typeof process !== "undefined" && process.versions?.node
    ? import("node:fs/promises").then(({ readFile }) =>
        readFile(new URL("../../crates/physics/pkg/afterhours_physics_bg.wasm", import.meta.url)).then(
          (bytes) => init(bytes),
        ),
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
  private id = 0;
  private facing = 0;
  private lastRender = 0;
  constructor(map: Pick<City, "terrain">) {
    // shortcut: only terrain, water and the world floor collide here; buildings, parks
    // and props are server-only until the atlas carries them.
    if (map.terrain) {
      const { positions, indices } = terrainMesh(map.terrain);
      this.world.add_trimesh(Float32Array.from(positions), Uint32Array.from(indices));
    } else this.world.add_box(0, -0.1, 0, LIMIT, 0.1, LIMIT, 0);
    this.world.add_box(0, WATER_LEVEL - 0.4, 0, WORLD_LIMIT, 0.1, WORLD_LIMIT, 0);
  }
  reset() {
    this.pending = [];
    this.body = undefined;
    this.offset = { x: 0, y: 0, z: 0, angle: 0 };
    this.remove();
  }
  private remove() {
    if (this.kind === "vehicle") this.world.remove_vehicle(this.id);
    else if (this.kind === "character") this.world.remove_character(this.id);
    this.kind = undefined;
  }
  /** Authoritative state for the local body plus its raw physics row. */
  reconcile(entity: Entity, you: number[], ack: number | undefined) {
    const kind = entity.vehicle ? "vehicle" : "character";
    if (kind !== this.kind) {
      this.remove();
      this.kind = kind;
      this.id =
        kind === "vehicle"
          ? this.world.spawn_vehicle(
              ...SEDAN,
              entity.x,
              entity.y,
              entity.z,
              entity.angle,
            )
          : this.world.spawn_character(entity.x, entity.y, entity.z);
    }
    try {
      this.world.restore(Float32Array.from(you));
    } catch {
      return;
    }
    if (ack !== undefined) this.pending = this.pending.filter((p) => p.tick > ack);
    for (const p of this.pending) this.step(p.input);
    const before = this.body,
      after = this.read(entity);
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
    this.step(input);
    this.body = this.read(this.body);
  }
  private step(input: Input) {
    const x = inputX(input),
      y = inputY(input);
    if (this.kind === "vehicle") this.world.set_drive(this.id, y, x, input.brake);
    else {
      const speed = WALK_SPEED * (input.sprint ? SPRINT : 1);
      this.world.set_move(this.id, x, y, speed, input.ascend);
      if (x || y) this.facing = Math.atan2(x, y);
    }
    this.world.step();
  }
  private read(base: Entity): Entity {
    const s = this.world.states();
    if (this.kind === "vehicle") {
      const [x, y, z, qx, qy, qz, qw, vx, vy, vz] = s.subarray(1, 11);
      return {
        ...base,
        x,
        y,
        z,
        vx,
        vy,
        vz,
        angle: Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qz * qz)),
        pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (qw * qx - qy * qz)))),
        roll: Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qx * qx + qz * qz)),
      };
    }
    const [x, y, z, vy] = s.subarray(1, 5);
    return { ...base, x, y, z, vy, angle: this.facing };
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
    const b = this.body;
    return { ...b, x: b.x + o.x, y: b.y + o.y, z: b.z + o.z, angle: b.angle + o.angle };
  }
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
