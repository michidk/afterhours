import { VEHICLES } from "../../shared/catalog.ts";
import type { Entity } from "../../shared/world.ts";

/**
 * Cosmetic body motion for cars. The simulation keeps a rigid contact point; this
 * sprung body on top of it shows the terrain and the driving forces: it settles onto
 * the four wheel contacts, squats under throttle, dives under braking, leans out of
 * turns, follows its flight path off a crest and squashes on landing. It never feeds
 * back into movement.
 */
export const SUSPENSION = {
  /** Body height over the wheels: spring, damping, travel (m) and landing impulse share. */
  heave: { stiffness: 160, damping: 10, limit: 0.22, impulse: 0.3 },
  /** Nose up/down (rad): spring, damping, limit, rad per m/s² of acceleration. */
  pitch: { stiffness: 90, damping: 12, limit: 0.4, accel: 0.006 },
  /** Right side up (rad): spring, damping, limit, rad per m/s² of cornering. */
  roll: { stiffness: 110, damping: 13, limit: 0.35, accel: 0.004 },
  /** How far the wheels hang below the body in the air (m). */
  droop: 0.14,
  /** Share of the flight path angle the nose follows in the air. */
  flight: 0.5,
  /** Springs soften in the air, so the body only drifts toward its flight attitude. */
  airborne: 0.2,
  /** Acceleration estimates are clamped so a network correction cannot flick the body. */
  maxAccel: 25,
};
type Spring = { value: number; speed: number };
export type CarBody = {
  heave: Spring;
  pitch: Spring;
  roll: Spring;
  vx: number;
  vy: number;
  vz: number;
  x: number;
  z: number;
  grounded: boolean;
  seen: number;
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
function settle(
  s: Spring,
  target: number,
  stiffness: number,
  damping: number,
  limit: number,
  dt: number,
) {
  s.speed += (stiffness * (target - s.value) - damping * s.speed) * dt;
  s.value += s.speed * dt;
  if (Math.abs(s.value) > limit) {
    s.value = clamp(s.value, -limit, limit);
    s.speed = 0;
  }
}

/** Slope of the ground across the car's wheelbase and track, not just under its centre. */
export function groundAttitude(e: Entity, height: (x: number, z: number) => number) {
  const model = VEHICLES[e.model ?? "sedan"],
    ahead = model.length * 0.3,
    side = model.width * 0.4,
    s = Math.sin(e.angle),
    c = Math.cos(e.angle);
  const front = height(e.x + s * ahead, e.z + c * ahead),
    rear = height(e.x - s * ahead, e.z - c * ahead),
    right = height(e.x + c * side, e.z - s * side),
    left = height(e.x - c * side, e.z + s * side);
  return {
    pitch: Math.atan2(front - rear, 2 * ahead),
    roll: Math.atan2(right - left, 2 * side),
  };
}

export class CarSuspension {
  private bodies = new Map<string, CarBody>();
  get size() {
    return this.bodies.size;
  }
  update(
    e: Entity,
    dt: number,
    grounded: boolean,
    height: (x: number, z: number) => number,
    now: number,
  ): CarBody {
    const ground = groundAttitude(e, height);
    let body = this.bodies.get(e.id);
    // A new car, or one that jumped (respawn, teleport), starts at rest on its ground.
    if (!body || Math.hypot(e.x - body.x, e.z - body.z) > 12) {
      body = {
        heave: { value: 0, speed: 0 },
        pitch: { value: grounded ? ground.pitch : 0, speed: 0 },
        roll: { value: grounded ? ground.roll : 0, speed: 0 },
        vx: e.vx,
        vy: e.vy,
        vz: e.vz,
        x: e.x,
        z: e.z,
        grounded,
        seen: now,
      };
      this.bodies.set(e.id, body);
    }
    body.seen = now;
    const step = Math.min(dt, 0.05);
    if (step > 0) {
      const s = Math.sin(e.angle),
        c = Math.cos(e.angle),
        limit = SUSPENSION.maxAccel,
        ax = clamp((e.vx - body.vx) / step, -limit, limit),
        az = clamp((e.vz - body.vz) / step, -limit, limit),
        along = ax * s + az * c,
        across = ax * c - az * s;
      const { heave, pitch, roll } = SUSPENSION;
      if (grounded) {
        // The ground pushing the wheels up, a landing or the foot of a hill, squats
        // the body; a crest falling away lets it rise.
        body.heave.speed -= clamp(e.vy - body.vy, -8, 12) * heave.impulse;
        settle(body.heave, 0, heave.stiffness, heave.damping, heave.limit, step);
        // Accelerating lifts the nose and braking dips it; a turn leans the body out.
        settle(
          body.pitch,
          ground.pitch + along * pitch.accel,
          pitch.stiffness,
          pitch.damping,
          Math.abs(ground.pitch) + pitch.limit,
          step,
        );
        settle(
          body.roll,
          ground.roll + across * roll.accel,
          roll.stiffness,
          roll.damping,
          Math.abs(ground.roll) + roll.limit,
          step,
        );
      } else {
        const soft = SUSPENSION.airborne,
          flight = Math.atan2(e.vy, Math.max(1, Math.hypot(e.vx, e.vz)));
        settle(
          body.heave,
          SUSPENSION.droop,
          heave.stiffness,
          heave.damping,
          heave.limit,
          step,
        );
        settle(
          body.pitch,
          flight * SUSPENSION.flight,
          pitch.stiffness * soft,
          pitch.damping * soft,
          Math.PI / 3,
          step,
        );
        settle(
          body.roll,
          0,
          roll.stiffness * soft,
          roll.damping * soft,
          Math.PI / 3,
          step,
        );
      }
    }
    body.vx = e.vx;
    body.vy = e.vy;
    body.vz = e.vz;
    body.x = e.x;
    body.z = e.z;
    body.grounded = grounded;
    return body;
  }
  /** Forget cars that left the view. */
  prune(now: number, age = 2) {
    for (const [id, body] of this.bodies)
      if (now - body.seen > age) this.bodies.delete(id);
  }
}
