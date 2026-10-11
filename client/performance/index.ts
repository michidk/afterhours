type Frame = { interval: number; update: number; render: number; ui: number };
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
