import type { WorldEvent, Entity } from "../../shared/world.ts";
const FILES = [
  "engine",
  "helicopter",
  "plane",
  "skid",
  "pistol",
  "smg",
  "punch",
  "bat",
  "impact",
  "explosion",
  "reload",
] as const;
type Sound = (typeof FILES)[number];
type Voice = { source: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode };
export class GameAudio {
  private context: AudioContext | undefined;
  private master: GainNode | undefined;
  private buffers = new Map<Sound, AudioBuffer>();
  private raw = new Map<Sound, ArrayBuffer>();
  private loops = new Map<string, Voice>();
  private loading: Promise<void> | undefined;
  private decoding: Promise<void> | undefined;
  private oneShots = 0;
  private clock = 0;
  private reloadUntil = 0;
  private failures: string[] = [];
  muted = false;
  get diagnostics() {
    return {
      loaded: [...this.buffers.keys()],
      failed: this.failures,
      loops: this.loops.size,
      oneShots: this.oneShots,
      state: this.context?.state,
    };
  }
  preload() {
    return (this.loading ??= Promise.all(
      FILES.map(async (name) => {
        try {
          const response = await fetch("/audio/" + name + ".wav");
          if (!response.ok) throw Error(String(response.status));
          this.raw.set(name, await response.arrayBuffer());
        } catch {
          this.failures.push(name);
          console.warn("Could not load sound:", name);
        }
      }),
    ).then(() => {}));
  }
  unlock() {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.muted ? 0 : 0.65;
      const compressor = this.context.createDynamicsCompressor();
      compressor.threshold.value = -12;
      compressor.ratio.value = 4;
      this.master.connect(compressor).connect(this.context.destination);
    }
    void this.context.resume();
    this.decoding ??= this.preload().then(async () => {
      await Promise.all(
        [...this.raw].map(async ([name, data]) => {
          try {
            this.buffers.set(name, await this.context!.decodeAudioData(data));
          } catch {
            this.failures.push(name);
            console.warn("Could not decode sound:", name);
          }
        }),
      );
      this.raw.clear();
    });
  }
  toggle() {
    this.muted = !this.muted;
    if (this.master && this.context)
      this.master.gain.setTargetAtTime(
        this.muted ? 0 : 0.65,
        this.context.currentTime,
        0.03,
      );
  }
  private voice(sound: Sound, loop = false): Voice | undefined {
    const ctx = this.context,
      buffer = this.buffers.get(sound);
    if (!ctx || !buffer || !this.master) return;
    const source = ctx.createBufferSource(),
      gain = ctx.createGain(),
      pan = ctx.createStereoPanner();
    source.buffer = buffer;
    source.loop = loop;
    gain.gain.value = 0;
    source.connect(gain).connect(pan).connect(this.master);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      pan.disconnect();
    };
    return { source, gain, pan };
  }
  private play(sound: Sound, volume: number, pan = 0) {
    if (this.muted || this.oneShots >= 32) return;
    const voice = this.voice(sound);
    if (!voice) return;
    voice.gain.gain.value = volume;
    voice.pan.pan.value = Math.max(-1, Math.min(1, pan));
    voice.source.playbackRate.value = 0.96 + Math.random() * 0.08;
    this.oneShots++;
    const ended = voice.source.onended;
    voice.source.onended = (event) => {
      this.oneShots--;
      if (typeof ended === "function") ended.call(voice.source, event);
    };
    voice.source.start();
  }
  event(e: WorldEvent, listener?: Entity) {
    if (!listener || !this.context) return;
    const distance = Math.hypot(e.x - listener.x, e.z - listener.z);
    if (distance > 70) return;
    const sound: Sound | undefined =
      e.sound ||
      (e.kind === "shot"
        ? "pistol"
        : e.kind === "explosion"
          ? "explosion"
          : e.kind === "hit"
            ? "impact"
            : undefined);
    if (!sound) return;
    this.play(
      sound,
      (sound === "explosion" ? 0.85 : 0.65) * (1 - distance / 70) ** 2,
      (e.x - listener.x) / 25,
    );
  }
  update(entities: Entity[], listener: Entity | undefined, dt: number) {
    if (!this.context) return;
    this.clock += dt;
    if (this.clock < 1 / 30) return;
    this.clock = 0;
    const wanted = new Set<string>(),
      ctx = this.context;
    const vehicles = listener
      ? entities
          .filter(
            (e) =>
              ["car", "helicopter", "plane"].includes(e.kind) &&
              !e.wreck &&
              (e.driver || e.ai || Math.hypot(e.vx, e.vz) > 0.4) &&
              Math.hypot(e.x - listener.x, e.z - listener.z) < 55,
          )
          .sort((a, b) =>
            a.id === listener.vehicle
              ? -1
              : b.id === listener.vehicle
                ? 1
                : Math.hypot(a.x - listener.x, a.z - listener.z) -
                  Math.hypot(b.x - listener.x, b.z - listener.z),
          )
          .slice(0, 6)
      : [];
    for (const e of vehicles) {
      wanted.add(e.id);
      let voice = this.loops.get(e.id);
      if (!voice) {
        voice = this.voice(
          e.kind === "helicopter"
            ? "helicopter"
            : e.kind === "plane"
              ? "plane"
              : "engine",
          true,
        );
        if (!voice) continue;
        voice.source.start(0, Math.random() * voice.source.buffer!.duration);
        this.loops.set(e.id, voice);
      }
      const speed = Math.hypot(e.vx, e.vz),
        distance = Math.hypot(e.x - listener!.x, e.z - listener!.z);
      const rate =
        e.kind === "car"
          ? (e.model === "van" ? 0.75 : e.model === "sport" ? 1.1 : 0.9) + speed * 0.025
          : e.kind === "helicopter"
            ? e.flight === "takingOff"
              ? 0.8
              : 1
            : 0.85 + speed * 0.018;
      voice.source.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.15);
      voice.gain.gain.setTargetAtTime(
        (e.kind === "car" ? 0.23 : 0.4) * (1 - distance / 55) ** 2,
        ctx.currentTime,
        0.1,
      );
      voice.pan.pan.setTargetAtTime(
        Math.max(-0.85, Math.min(0.85, (e.x - listener!.x) / 25)),
        ctx.currentTime,
        0.1,
      );
      if (e.id === listener?.vehicle && e.kind === "car" && e.skidding) {
        const id = "skid:" + e.id;
        wanted.add(id);
        let squeal = this.loops.get(id);
        if (!squeal) {
          squeal = this.voice("skid", true);
          if (squeal) {
            squeal.source.start();
            this.loops.set(id, squeal);
          }
        }
        squeal?.gain.gain.setTargetAtTime(
          Math.min(0.3, speed * 0.02),
          ctx.currentTime,
          0.06,
        );
      }
    }
    for (const [id, voice] of this.loops)
      if (!wanted.has(id)) {
        voice.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
        voice.source.stop(ctx.currentTime + 0.15);
        this.loops.delete(id);
      }
    if (listener?.reloadUntil && listener.reloadUntil !== this.reloadUntil)
      this.play("reload", 0.45);
    this.reloadUntil = listener?.reloadUntil || 0;
  }
}
