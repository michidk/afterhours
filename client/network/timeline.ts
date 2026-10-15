import type { Entity } from "../../shared/world.ts";
import { interpolate } from "./prediction.ts";

/** Advance one render clock continuously instead of resetting it on packet arrival. */
export class SnapshotTimeline {
  private history: { time: number; received: number; entities: Map<string, Entity> }[] =
    [];
  delay = 0.1;
  private clock: number | undefined;
  private lastFrame: number | undefined;
  /** Server time currently on screen for interpolated bodies. */
  get renderTime() {
    return this.clock;
  }
  reset() {
    this.history = [];
    this.delay = 0.1;
    this.clock = this.lastFrame = undefined;
  }
  push(time: number, entities: Entity[], received: number) {
    const previous = this.history.at(-1);
    if (previous && time < previous.time) return;
    if (previous && time > previous.time) {
      const elapsed = Math.max(0, (received - previous.received) / 1000);
      const window = received - this.history[0].received;
      const playback =
        window >= 500
          ? Math.max(0.1, Math.min(1, ((time - this.history[0].time) * 1000) / window))
          : 1;
      const gaps = this.history
        .slice(1)
        .map((entry, i) =>
          Math.max(
            0,
            (entry.received - this.history[i].received) / 1000 -
              (entry.time - this.history[i].time) / playback,
          ),
        );
      gaps.push(Math.max(0, elapsed - (time - previous.time) / playback));
      gaps.sort((a, b) => a - b);
      const target = Math.min(0.25, 0.1 + (gaps[Math.floor(gaps.length * 0.95)] ?? 0));
      this.delay =
        target > this.delay ? target : Math.max(target, this.delay - elapsed * 0.005);
    }
    this.history.push({
      time,
      received,
      entities: new Map(entities.map((e) => [e.id, e])),
    });
    if (this.history.length > 30) this.history.shift();
  }
  sample(now: number): Entity[] {
    const latest = this.history.at(-1);
    if (!latest) return [];
    const oldest = this.history[0],
      elapsed = latest.received - oldest.received,
      // Use a delivery window so individual late packets do not set playback speed.
      playback =
        elapsed >= 500
          ? Math.max(0.1, Math.min(1, ((latest.time - oldest.time) * 1000) / elapsed))
          : 1;
    const desired =
      latest.time + ((now - latest.received) / 1000) * playback - this.delay;
    const dt = Math.max(0, (now - (this.lastFrame ?? now)) / 1000);
    this.lastFrame = now;
    if (this.clock === undefined) this.clock = desired;
    else if (dt > 0.25) this.clock = Math.max(this.clock, desired);
    else {
      const error = desired - this.clock;
      const rate = playback * (1 + Math.max(-0.5, Math.min(0.1, error * 4)));
      this.clock += dt * rate;
    }
    this.clock = Math.min(this.clock, latest.time + 0.1);
    let before = this.history[0],
      after = latest;
    for (const entry of this.history) {
      if (entry.time <= this.clock) before = entry;
      if (entry.time >= this.clock) {
        after = entry;
        break;
      }
    }
    const duration = after.time - before.time;
    const fraction =
      duration > 0
        ? Math.max(0, Math.min(1, (this.clock - before.time) / duration))
        : 1;
    const result: Entity[] = [];
    for (const e of after.entities.values()) {
      const old = before.entities.get(e.id);
      const pose = old ? interpolate(old, e, fraction, duration) : { ...e };
      if (before === after && this.clock > after.time) {
        const extra = Math.min(0.1, this.clock - after.time);
        pose.x += pose.vx * extra;
        pose.z += pose.vz * extra;
        pose.y += pose.vy * extra;
        pose.angle += (pose.angularVelocity || 0) * extra;
      }
      result.push(pose);
    }
    return result;
  }
}
