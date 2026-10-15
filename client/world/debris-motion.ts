import type { DebrisState, Rotation, Vec3 } from "../../shared/destruction.ts";

/** Cosmetic rigid-body motion for debris between and ahead of server samples. */
export type DebrisPose = Pick<
  DebrisState,
  "position" | "rotation" | "velocity" | "angularVelocity"
>;
export type Extents = { w: number; h: number; d: number };
/** Matches the server's debris world: gravity, linear and angular damping. */
const GRAVITY = 18,
  DAMPING = 0.6,
  SPIN_DAMPING = 0.8,
  STEP = 1 / 60;

export const clonePose = (pose: DebrisPose): DebrisPose => ({
  position: { ...pose.position },
  rotation: { ...pose.rotation },
  velocity: { ...pose.velocity },
  angularVelocity: { ...pose.angularVelocity },
});

/** Half the box's vertical extent at this orientation: how high its centre rests. */
export function restingHeight(q: Rotation, e: Extents) {
  const r10 = 2 * (q.x * q.y + q.w * q.z),
    r11 = 1 - 2 * (q.x * q.x + q.z * q.z),
    r12 = 2 * (q.y * q.z - q.w * q.x);
  return (Math.abs(r10) * e.w + Math.abs(r11) * e.h + Math.abs(r12) * e.d) / 2;
}

/** Integrate a world-frame angular velocity into a rotation. */
export function spin(q: Rotation, w: Vec3, h: number): Rotation {
  const x = q.x + 0.5 * h * (w.x * q.w + w.y * q.z - w.z * q.y),
    y = q.y + 0.5 * h * (w.y * q.w + w.z * q.x - w.x * q.z),
    z = q.z + 0.5 * h * (w.z * q.w + w.x * q.y - w.y * q.x),
    s = q.w - 0.5 * h * (w.x * q.x + w.y * q.y + w.z * q.z),
    length = Math.hypot(x, y, z, s) || 1;
  return { x: x / length, y: y / length, z: z / length, w: s / length };
}

/**
 * Ballistic flight with ground contact. Good enough to carry a pose a few hundred
 * milliseconds ahead of the last server sample; the server's Rapier world stays the
 * authority and its next sample corrects any difference smoothly.
 */
export function advanceDebris(
  pose: DebrisPose,
  seconds: number,
  ground: (x: number, z: number) => number,
  extents: Extents,
) {
  if (!(seconds > 0)) return pose;
  const steps = Math.min(60, Math.max(1, Math.ceil(seconds / STEP))),
    h = seconds / steps,
    p = pose.position,
    v = pose.velocity,
    w = pose.angularVelocity;
  for (let i = 0; i < steps; i++) {
    v.y -= GRAVITY * h;
    const damp = Math.exp(-DAMPING * h);
    v.x *= damp;
    v.y *= damp;
    v.z *= damp;
    p.x += v.x * h;
    p.y += v.y * h;
    p.z += v.z * h;
    pose.rotation = spin(pose.rotation, w, h);
    const spinDamp = Math.exp(-SPIN_DAMPING * h);
    w.x *= spinDamp;
    w.y *= spinDamp;
    w.z *= spinDamp;
    const floor = ground(p.x, p.z) + restingHeight(pose.rotation, extents);
    if (p.y < floor) {
      p.y = floor;
      if (v.y < 0) v.y = v.y < -3 ? -v.y * 0.15 : 0;
      const friction = Math.exp(-5 * h),
        roll = Math.exp(-4 * h);
      v.x *= friction;
      v.z *= friction;
      w.x *= roll;
      w.y *= roll;
      w.z *= roll;
    }
  }
  return pose;
}

/**
 * Exponential decay rate of a visual correction, per second. Small errors settle
 * gently and large ones catch up faster (Fiedler's two-rate smoothing).
 */
export const correctionRate = (error: number) =>
  3 + 7 * Math.max(0, Math.min(1, (error - 0.25) / 0.75));
