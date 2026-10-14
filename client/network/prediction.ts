import type { Entity, City } from "../../shared/world.ts";
import type { InputFrame } from "../../shared/protocol.ts";
import {
  predictStep,
  predictionWorld,
  constrainRenderPose,
  wrap,
} from "../../shared/physics/index.ts";
import { TUNING } from "../../shared/catalog.ts";

const MAX_PREDICTION_STEPS = Math.floor(TUNING.predictionSeconds / TUNING.tick);
const MAX_PENDING_INPUTS = Math.ceil(2 / TUNING.tick);
export class Prediction {
  pending: InputFrame[] = [];
  body: Entity | undefined;
  ownership = "";
  corrections = 0;
  lastCorrection = { distance: 0, angle: 0 };
  offset = { x: 0, z: 0, y: 0, angle: 0 };
  lastRender = 0;
  private smoothedAt = 0;
  private lastReconcile = 0;
  private lastInput: InputFrame | undefined;
  private inputInterval = TUNING.tick * 1000;
  private displayed: Pick<Entity, "x" | "y" | "z" | "angle"> | undefined;
  private authoritative: Entity | undefined;
  private presentationMode: "predicted" | "authoritative" | undefined;
  private missingMap = false;
  private nearby: Entity[] = [];
  private shadows: Entity[] = [];
  private contacts = new Set<string>();
  private suspended = false;
  private discardedThrough = -1;
  constructor(
    readonly city: City,
    private worldReady = (_point: { x: number; z: number }) => true,
  ) {}
  reset() {
    this.pending = [];
    this.body = undefined;
    this.ownership = "";
    this.offset = { x: 0, z: 0, y: 0, angle: 0 };
    this.lastInput = undefined;
    this.inputInterval = TUNING.tick * 1000;
    this.displayed = undefined;
    this.authoritative = undefined;
    this.presentationMode = undefined;
    this.missingMap = false;
    this.nearby = [];
    this.shadows = [];
    this.contacts.clear();
    this.suspended = false;
    this.discardedThrough = -1;
    this.lastRender = 0;
    this.smoothedAt = 0;
    this.lastReconcile = 0;
    this.lastCorrection = { distance: 0, angle: 0 };
  }
  get status() {
    if (!this.body) return "waiting for authority";
    if (this.missingMap || !this.worldReady(this.body)) return "waiting for map";
    return this.suspended || this.pending.length > MAX_PREDICTION_STEPS
      ? "waiting for acknowledgements"
      : "predicting";
  }
  reconcile(player: Entity, entities: Entity[], ack: number, now = this.lastRender) {
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
    this.decayOffset(now);
    const previous = this.sample(now)?.body;
    const gap = Math.min(2, Math.max(0, (now - this.lastReconcile) / 1000));
    this.lastReconcile = now;
    const acknowledged = this.pending.find((frame) => frame.seq === ack);
    this.pending = this.pending.filter((frame) => frame.seq > ack);
    this.authoritative = structuredClone(authoritative);
    this.body = structuredClone(authoritative);
    this.nearby = entities;
    this.shadows = predictionWorld(this.body, entities);
    this.contacts = new Set([this.body.id]);
    this.suspended = ack < this.discardedThrough;
    if (this.worldReady(this.body)) {
      // Replay a complete prefix, never a suffix or an unbounded backlog.
      const replay = this.suspended ? [] : this.pending.slice(0, MAX_PREDICTION_STEPS);
      this.lastInput = this.suspended
        ? undefined
        : (replay.at(-1) ?? acknowledged ?? this.lastInput);
      for (const frame of replay) {
        if (!this.worldReady(this.body)) break;
        predictStep(
          this.body,
          frame.input,
          this.city,
          entities,
          TUNING.tick,
          this.shadows,
          this.contacts,
        );
      }
    }
    this.missingMap = !this.worldReady(this.body);
    if (this.missingMap) {
      this.pending = [];
      this.lastInput = undefined;
      this.body = structuredClone(authoritative);
      this.shadows = predictionWorld(this.body, entities);
      this.contacts = new Set([this.body.id]);
    }
    if (previous) {
      const next = this.sample(now)!.body,
        dx = previous.x - next.x,
        dz = previous.z - next.z,
        dy = previous.y - next.y;
      this.lastCorrection = {
        distance: Math.hypot(dx, dz, dy),
        angle: Math.abs(wrap(previous.angle - next.angle)),
      };
      if (this.lastCorrection.distance > 0.3) this.corrections++;
      const correctionLimit = Math.max(
        3,
        Math.hypot(previous.vx, previous.vy, previous.vz) * (0.5 + gap),
        Math.hypot(this.body.vx, this.body.vy, this.body.vz) * (0.5 + gap),
      );
      if (this.lastCorrection.distance < correctionLimit) {
        this.offset.x += dx;
        this.offset.z += dz;
        this.offset.y += dy;
        this.offset.angle = wrap(this.offset.angle + wrap(previous.angle - next.angle));
      } else {
        this.offset = { x: 0, z: 0, y: 0, angle: 0 };
        this.displayed = undefined;
      }
    }
  }
  private decayOffset(now: number) {
    // New corrections start aging at receipt, even after a stalled render loop.
    const seconds = Math.max(0, (now - this.smoothedAt) / 1000);
    this.smoothedAt = now;
    const distance = Math.hypot(this.offset.x, this.offset.z, this.offset.y);
    // Smooth only presentation: small errors settle gently, large errors catch up faster.
    const correctionSpeed = Math.max(
      18,
      this.body ? Math.hypot(this.body.vx, this.body.vy, this.body.vz) * 2 : 0,
    );
    const decay = Math.max(
      Math.exp(-seconds * (6 + 12 * Math.min(1, distance))),
      distance ? 1 - (correctionSpeed * seconds) / distance : 0,
    );
    const angleDecay = Math.exp(
      -seconds * (6 + 12 * Math.min(1, Math.abs(this.offset.angle))),
    );
    const speed = this.body ? Math.hypot(this.body.vx, this.body.vy, this.body.vz) : 0;
    const ahead =
      this.body && speed > 0.1
        ? (this.offset.x * this.body.vx +
            this.offset.y * this.body.vy +
            this.offset.z * this.body.vz) /
          speed
        : 0;
    // Let authority catch a leading visual pose without reversing its travel.
    const retained = Math.max(0, ahead * (1 - decay) - speed * seconds * 0.5);
    this.offset.x *= decay;
    this.offset.z *= decay;
    this.offset.y *= decay;
    if (this.body && retained > 0) {
      this.offset.x += (this.body.vx / speed) * retained;
      this.offset.y += (this.body.vy / speed) * retained;
      this.offset.z += (this.body.vz / speed) * retained;
    }
    this.offset.angle *= angleDecay;
    if (Math.hypot(this.offset.x, this.offset.z, this.offset.y) < 0.001)
      this.offset.x = this.offset.z = this.offset.y = 0;
    if (Math.abs(this.offset.angle) < 0.00001) this.offset.angle = 0;
  }
  render(now: number) {
    this.decayOffset(now);
    this.lastRender = now;
    const sample = this.sample(now);
    if (!sample) return undefined;
    const { body: pose, neighbours, contacts, mode } = sample;
    if (this.displayed && this.presentationMode !== mode) {
      this.offset = {
        x: this.displayed.x - pose.x,
        y: this.displayed.y - pose.y,
        z: this.displayed.z - pose.z,
        angle: wrap(this.displayed.angle - pose.angle),
      };
    }
    this.presentationMode = mode;
    pose.x += this.offset.x;
    pose.z += this.offset.z;
    pose.y += this.offset.y;
    pose.angle = wrap(pose.angle + this.offset.angle);
    const speed = Math.hypot(pose.vx, pose.vy, pose.vz);
    const leading =
      this.offset.x * pose.vx + this.offset.y * pose.vy + this.offset.z * pose.vz;
    if (this.displayed && speed > 0.1 && (leading > 0 || mode === "authoritative")) {
      const rewind =
        ((this.displayed.x - pose.x) * pose.vx +
          (this.displayed.y - pose.y) * pose.vy +
          (this.displayed.z - pose.z) * pose.vz) /
        speed;
      if (rewind > 0) {
        const dx = (pose.vx / speed) * rewind,
          dy = (pose.vy / speed) * rewind,
          dz = (pose.vz / speed) * rewind;
        this.offset.x += dx;
        this.offset.y += dy;
        this.offset.z += dz;
        pose.x += dx;
        pose.y += dy;
        pose.z += dz;
      }
    }
    // A visual correction must not pull the controlled body through an obstacle.
    if (
      Math.hypot(this.offset.x, this.offset.z) > 0.001 ||
      Math.abs(this.offset.angle) > 0.001
    )
      constrainRenderPose(pose, this.city, neighbours);
    this.displayed = { x: pose.x, y: pose.y, z: pose.z, angle: pose.angle };
    return { body: pose, neighbours, contacts };
  }
  private sample(now: number) {
    if (this.body && !this.missingMap && this.worldReady(this.body)) {
      const predicted = this.extrapolate(this.body, now);
      if (this.worldReady(predicted.body))
        return { ...predicted, mode: "predicted" as const };
    }
    if (!this.authoritative) return undefined;
    // Missing collision data disables physics, not presentation smoothing.
    return {
      body: structuredClone(this.authoritative),
      neighbours: structuredClone(this.nearby),
      contacts: new Set<string>(),
      mode: "authoritative" as const,
    };
  }
  private extrapolate(body: Entity, now: number) {
    const pose = {
      ...body,
      wheelSkids: body.wheelSkids?.slice(),
      jetpack: body.jetpack && { ...body.jetpack },
    };
    const neighbours = structuredClone(this.shadows);
    const contacts = new Set(this.contacts);
    // Fill the gap between 30 Hz inputs at display refresh rate. This copy never
    // changes the replay state or decides gameplay outcomes. The rendered pose sits
    // one tick ahead of the last command's timestamp. Scale wall time by the
    // paced input interval when the server is slow; allowing a second tick keeps
    // it continuous when a late wakeup produces that command up to a tick late,
    // instead of holding the pose and then lurching when the command arrives.
    if (this.lastInput && !this.suspended) {
      const partial = Math.min(
        TUNING.tick * 2,
        Math.max(0, (now - this.lastInput.timestamp) / this.inputInterval) *
          TUNING.tick,
      );
      if (partial > 0)
        predictStep(
          pose,
          this.lastInput.input,
          this.city,
          this.nearby,
          partial,
          neighbours,
          contacts,
        );
    }
    return { body: pose, neighbours, contacts };
  }
  input(frame: InputFrame, nearby: Entity[]) {
    if (!this.body) return;
    if (this.missingMap || !this.worldReady(this.body)) {
      this.pending = [];
      this.lastInput = undefined;
      return;
    }
    this.nearby = nearby;
    this.pending.push(frame);
    if (this.pending.length > MAX_PENDING_INPUTS)
      this.discardedThrough = this.pending.shift()!.seq;
    if (this.suspended || this.pending.length > MAX_PREDICTION_STEPS) return;
    if (this.lastInput && frame.timestamp > this.lastInput.timestamp)
      this.inputInterval +=
        (Math.max(
          TUNING.tick * 500,
          Math.min(TUNING.tick * 2000, frame.timestamp - this.lastInput.timestamp),
        ) -
          this.inputInterval) *
        0.2;
    this.lastInput = frame;
    if (this.body)
      predictStep(
        this.body,
        frame.input,
        this.city,
        nearby,
        TUNING.tick,
        this.shadows,
        this.contacts,
      );
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
    aim:
      b.aim === undefined
        ? undefined
        : (a.aim ?? a.angle) + wrap(b.aim - (a.aim ?? a.angle)) * fraction,
  };
}
