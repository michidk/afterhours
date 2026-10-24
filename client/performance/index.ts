import type { GameNetwork } from "../network/index.ts";

type NetworkSample = ReturnType<GameNetwork["stats"]>;

export async function profileNetwork<T>(
  capture: () => Promise<T>,
  read: () => NetworkSample | undefined,
) {
  const samples: NetworkSample[] = [];
  const sample = () => {
    const stats = read();
    if (stats) samples.push(stats);
  };
  sample();
  const timer = setInterval(sample, 100);
  try {
    const result = await capture();
    sample();
    const first = samples[0],
      last = samples.at(-1);
    const range = (values: (number | undefined)[]) => {
      const present = values.filter((value) => value !== undefined);
      return present.length
        ? { p95: p95(present), max: Math.max(...present) }
        : undefined;
    };
    return {
      ...result,
      network: {
        samples: samples.length,
        rttMs: range(samples.map((s) => s.rtt)),
        snapshotAgeMs: range(samples.map((s) => s.snapshotAge)),
        snapshotIntervalMs: range(samples.map((s) => s.snapshotInterval)),
        ackAgeMs: range(samples.map((s) => s.ackAge)),
        pendingInputs: range(samples.map((s) => s.pending)),
        serverQueue: range(samples.map((s) => s.queued)),
        visualOffsetMetres: range(samples.map((s) => s.offset)),
        corrections: first && last ? last.corrections - first.corrections : 0,
        resyncs: first && last ? last.resyncs - first.resyncs : 0,
        serverElapsedSeconds:
          first && last ? last.serverTime - first.serverTime : undefined,
        predictionStates: [...new Set(samples.map((s) => s.prediction))],
        disconnectedSamples: samples.filter((s) => !s.connected).length,
      },
    };
  } finally {
    clearInterval(timer);
  }
}

type Parts = { net: number; scene: number; rest: number };
type Frame = {
  interval: number;
  update: number;
  render: number;
  ui: number;
  /** Where the update stage went: prediction and draw list, scene update, everything else. */
  parts?: Parts;
};
function p95(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? 0;
}
function summarize(frames: Frame[]) {
  const milliseconds = frames.reduce((sum, f) => sum + f.interval, 0);
  return {
    samples: frames.length,
    fps: milliseconds ? (frames.length * 1000) / milliseconds : 0,
    frameP95Ms: p95(frames.map((f) => f.interval)),
    frameMaxMs: Math.max(0, ...frames.map((f) => f.interval)),
    stagesP95Ms: {
      update: p95(frames.map((f) => f.update)),
      render: p95(frames.map((f) => f.render)),
      ui: p95(frames.filter((f) => f.ui > 0).map((f) => f.ui)),
    },
    updatePartsP95Ms: {
      net: p95(frames.map((f) => f.parts?.net ?? 0)),
      scene: p95(frames.map((f) => f.parts?.scene ?? 0)),
      rest: p95(frames.map((f) => f.parts?.rest ?? 0)),
    },
  };
}
/** Development diagnostics only; full-duration samples supplement the rolling view. */
export class FrameProfiler {
  private recent: Frame[] = [];
  private capture: Frame[] | undefined;
  private interrupted = false;
  private hiddenSince: number | undefined;
  private hiddenMilliseconds = 0;
  record(frame: Frame) {
    this.recent.push(frame);
    if (this.recent.length > 600) this.recent.shift();
    if (this.capture && this.capture.length < 60000) this.capture.push(frame);
  }
  get stats() {
    return summarize(this.recent);
  }
  async profile(seconds = 60) {
    if (this.capture) throw Error("A client profile is already running");
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120)
      throw Error("Profile duration must be 1-120 seconds");
    if (document.hidden) throw Error("Keep the game tab visible while profiling");
    this.capture = [];
    this.interrupted = false;
    this.hiddenSince = undefined;
    this.hiddenMilliseconds = 0;
    const started = performance.now();
    const visibility = () => {
      if (document.hidden) {
        this.interrupted = true;
        this.hiddenSince ??= performance.now();
      } else if (this.hiddenSince !== undefined) {
        this.hiddenMilliseconds += performance.now() - this.hiddenSince;
        this.hiddenSince = undefined;
      }
    };
    document.addEventListener("visibilitychange", visibility);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    document.removeEventListener("visibilitychange", visibility);
    const frames = this.capture;
    this.capture = undefined;
    const finished = performance.now();
    if (this.hiddenSince !== undefined)
      this.hiddenMilliseconds += finished - this.hiddenSince;
    const durationSeconds = (finished - started) / 1000;
    return {
      durationSeconds,
      valid: !this.interrupted && frames.length > 0,
      invalidReasons: [
        ...(this.interrupted ? ["tab-hidden"] : []),
        ...(frames.length === 0 ? ["no-frames"] : []),
      ],
      hiddenSeconds: this.hiddenMilliseconds / 1000,
      ...summarize(frames),
      // Include pauses at the end of a capture, even if no final frame arrives.
      fps: frames.length / durationSeconds,
    };
  }
}

/** Always-on frame timing for the Networking panel: the last five seconds of frame intervals. */
export class FrameWindow {
  private frames: { at: number; ms: number }[] = [];
  record(now: number, ms: number) {
    this.frames.push({ at: now, ms });
    while (this.frames[0] && this.frames[0].at < now - 5000) this.frames.shift();
  }
  get stats() {
    const ms = this.frames.map((f) => f.ms).sort((a, b) => a - b);
    return {
      fps: ms.length ? 1000 / ms[ms.length >> 1] : 0,
      p95Ms: ms[Math.floor(ms.length * 0.95)] ?? 0,
      worstMs: ms.at(-1) ?? 0,
    };
  }
}

/**
 * Lowers the render resolution while frames stay slow. A machine that draws 15 fps waits a frame
 * for every key press and shows each snapshot late, however good the link: the only lever left
 * is fewer pixels. The level is the engine's hardware scaling (1 = one pixel per CSS pixel, higher
 * = fewer pixels). It steps up when the median frame of the last two seconds is over `slowMs`
 * (under about 26 fps, which a 30 Hz display never reaches) and steps back after a cooldown at
 * vsync speed; a step back that is slow again within 10 s doubles the cooldown (up to 160 s).
 */
export class RenderScale {
  level: number;
  private frames: { at: number; ms: number }[] = [];
  private changed = 0;
  private cooldown = 20_000;
  private raisedAt = -Infinity;
  constructor(
    readonly base: number,
    readonly max = base * 2,
    private slowMs = 38,
    private step = 1.25,
  ) {
    this.level = base;
  }
  /** One drawn frame; returns the new level when it changed. */
  frame(now: number, ms: number): number | undefined {
    // A stall this long is a hidden tab or a paused debugger, not the machine's speed.
    if (ms > 2000) {
      this.frames = [];
      return;
    }
    this.frames.push({ at: now, ms });
    while (this.frames[0] && this.frames[0].at < now - 2000) this.frames.shift();
    if (this.frames.length < 3 || now - this.changed < 2000) return;
    const sorted = this.frames.map((f) => f.ms).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (median > this.slowMs && this.level < this.max) {
      // Slow again soon after stepping back: the lower resolution was the right one.
      if (now - this.raisedAt < 10_000)
        this.cooldown = Math.min(this.cooldown * 2, 160_000);
      return this.move(now, Math.min(this.max, this.level * this.step));
    }
    if (median <= 20 && this.level > this.base && now - this.changed >= this.cooldown) {
      this.raisedAt = now;
      return this.move(now, Math.max(this.base, this.level / this.step));
    }
  }
  private move(now: number, level: number) {
    this.level = level;
    this.changed = now;
    this.frames = [];
    return level;
  }
}
