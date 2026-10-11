import type { Entity, City } from "../../shared/world.ts";
import type { InputFrame } from "../../shared/protocol.ts";
import {
  predictStep,
  predictionWorld,
  constrainRenderPose,
  wrap,
} from "../../shared/physics/index.ts";
import { TUNING } from "../../shared/catalog.ts";
export class Prediction {
  pending: InputFrame[] = [];
  body: Entity | undefined;
  ownership = "";
  corrections = 0;
  offset = { x: 0, z: 0, y: 0, angle: 0 };
  lastRender = 0;
  private lastInput: InputFrame | undefined;
  private nearby: Entity[] = [];
  private shadows: Entity[] = [];
  constructor(readonly city: City) {}
  reset() {
    this.pending = [];
    this.body = undefined;
    this.ownership = "";
    this.offset = { x: 0, z: 0, y: 0, angle: 0 };
    this.lastInput = undefined;
    this.nearby = [];
    this.shadows = [];
  }
  reconcile(player: Entity, entities: Entity[], ack: number) {
    const authoritative = entities.find((e) => e.id === (player.vehicle || player.id));
    if (!authoritative) return;
    // Passengers follow the interpolated vehicle; their controls never predict it.
    if (player.vehicle && authoritative.driver !== player.id) {
      this.reset();
      return;
    }
    if (this.ownership !== authoritative.id) {
      this.reset();
      this.ownership = authoritative.id;
    }
    const previous = this.body;
    this.pending = this.pending.filter((frame) => frame.seq > ack);
    this.body = structuredClone(authoritative);
    this.nearby = entities;
    this.shadows = predictionWorld(this.body, entities);
    for (const frame of this.pending)
      predictStep(
        this.body,
        frame.input,
        this.city,
        entities,
        TUNING.tick,
        this.shadows,
      );
    if (previous) {
      const dx = previous.x - this.body.x,
        dz = previous.z - this.body.z,
        dy = previous.y - this.body.y;
      if (Math.hypot(dx, dz) > 0.3) this.corrections++;
      if (Math.hypot(dx, dz, dy) < 3) {
        this.offset.x += dx;
        this.offset.z += dz;
        this.offset.y += dy;
        this.offset.angle = wrap(
          this.offset.angle + wrap(previous.angle - this.body.angle),
        );
        if (Math.hypot(this.offset.x, this.offset.z, this.offset.y) >= 3)
          this.offset = { x: 0, z: 0, y: 0, angle: 0 };
      } else this.offset = { x: 0, z: 0, y: 0, angle: 0 };
    }
  }
  render(now: number) {
    const decay = Math.exp(-Math.min(0.1, (now - this.lastRender) / 1000) * 12);
    this.lastRender = now;
    this.offset.x *= decay;
    this.offset.z *= decay;
    this.offset.y *= decay;
    this.offset.angle *= decay;
    if (!this.body) return undefined;
    const pose = { ...this.body, wheelSkids: this.body.wheelSkids?.slice() };
    // Fill the gap between 30 Hz inputs at display refresh rate. This copy never
    // changes the replay state or decides gameplay outcomes.
    if (this.lastInput) {
      const partial = Math.min(
        TUNING.tick,
        Math.max(0, (now - this.lastInput.timestamp) / 1000),
      );
      if (partial > 0)
        predictStep(
          pose,
          this.lastInput.input,
          this.city,
          this.nearby,
          partial,
          structuredClone(this.shadows),
        );
    }
    pose.x += this.offset.x;
    pose.z += this.offset.z;
    pose.y += this.offset.y;
    pose.angle = wrap(pose.angle + this.offset.angle);
    // A visual correction must not pull the controlled body through an obstacle.
    if (
      Math.hypot(this.offset.x, this.offset.z) > 0.001 ||
      Math.abs(this.offset.angle) > 0.001
    )
      constrainRenderPose(pose, this.city, this.shadows);
    return pose;
  }
  input(frame: InputFrame, nearby: Entity[]) {
    if (!this.body) return;
    this.lastInput = frame;
    this.nearby = nearby;
    this.pending.push(frame);
    if (this.pending.length > 90) this.pending.shift();
    if (this.body)
      predictStep(this.body, frame.input, this.city, nearby, TUNING.tick, this.shadows);
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
  };
}
