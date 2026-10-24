import type { Entity } from "../../shared/world.ts";
import { wrap } from "../../shared/physics/vehicle.ts";

/** Seconds a snapshot's jump takes to ease out. */
const EASE = 0.1;
/** The most the newest snapshot is carried on by; past that it is stale, not late. */
const MAX_AGE = 0.3;

/**
 * The craft the player flies is not predicted. Interpolating it plays it a whole interpolation
 * delay behind the newest snapshot (100 ms on a good link, 250 on a jittery one), which is lag on
 * top of the round trip. This draws the newest snapshot carried on to the present by its velocity
 * and turn rate, and eases out the small jump each new snapshot makes.
 */
export class Piloted {
  private id: string | undefined;
  private seen: Entity | undefined;
  private offset = { x: 0, y: 0, z: 0, angle: 0 };
  private last: { x: number; y: number; z: number; angle: number } | undefined;
  private at = 0;
  /**
   * `latest` is the newest snapshot's copy of the craft, `receivedAt` when it arrived (ms) and
   * `oneWay` the link's one-way delay (ms), since the snapshot was already that old on arrival.
   */
  render(latest: Entity, receivedAt: number, now: number, oneWay: number): Entity {
    const dt = Math.min(0.1, Math.max(0, (now - this.at) / 1000));
    this.at = now;
    const age = Math.min(MAX_AGE, Math.max(0, (now - receivedAt + oneWay) / 1000)),
      pose = {
        x: latest.x + latest.vx * age,
        y: latest.y + latest.vy * age,
        z: latest.z + latest.vz * age,
        angle: latest.angle + (latest.angularVelocity ?? 0) * age,
      };
    if (this.id !== latest.id) {
      this.id = latest.id;
      this.offset = { x: 0, y: 0, z: 0, angle: 0 };
      this.last = undefined;
    } else if (this.seen !== latest && this.last) {
      // A new snapshot: keep the picture where it was and let the difference ease out. The
      // difference is taken at the previous frame's time, which `last` was drawn for (the snapshot may be newer than that frame, so the age can be negative); against
      // the pose now it would hold a whole frame of ordinary motion, stalling every snapshot.
      const before = Math.min(MAX_AGE, age - dt);
      this.offset = {
        x: this.last.x - (latest.x + latest.vx * before),
        y: this.last.y - (latest.y + latest.vy * before),
        z: this.last.z - (latest.z + latest.vz * before),
        angle: wrap(
          this.last.angle - (latest.angle + (latest.angularVelocity ?? 0) * before),
        ),
      };
      if (Math.hypot(this.offset.x, this.offset.z) > 25)
        this.offset = { x: 0, y: 0, z: 0, angle: 0 };
    }
    this.seen = latest;
    const keep = Math.exp(-dt / EASE);
    this.offset = {
      x: this.offset.x * keep,
      y: this.offset.y * keep,
      z: this.offset.z * keep,
      angle: this.offset.angle * keep,
    };
    const drawn = {
      x: pose.x + this.offset.x,
      y: pose.y + this.offset.y,
      z: pose.z + this.offset.z,
      angle: pose.angle + this.offset.angle,
    };
    this.last = drawn;
    return { ...latest, ...drawn };
  }
}
