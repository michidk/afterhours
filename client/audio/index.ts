import type { WorldEvent, Entity, City } from "../../shared/world.ts";
import type { DebrisState } from "../../shared/destruction.ts";
import {
  SOUND_BANKS,
  LOOP_HEARING_RANGE,
  SoundPicker,
  transitionSounds,
  engineSound,
  type Sound,
} from "./banks.ts";
import { propulsionRunning } from "../../shared/propulsion.ts";
/** A listener-only cue plays only for a source this close to the listener, i.e. the listener. */
const LISTENER_CUE_DISTANCE = 3;
import {
  vehicleAudioState,
  vehicleLayers,
  spatialPan,
  dopplerRate,
  type AudioView,
  type VehicleAudioState,
} from "./vehicles.ts";

type Voice = {
  sound: Sound;
  source: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  filter: BiquadFilterNode;
  rate: number;
  variation: number;
  cutoff: number;
};
export class GameAudio {
  private context: AudioContext | undefined;
  private master: GainNode | undefined;
  private buffers = new Map<string, AudioBuffer>();
  private raw = new Map<string, ArrayBuffer>();
  private loops = new Map<string, Voice>();
  private oneShots = new Set<Voice>();
  private picker = new SoundPicker();
  private lastPlayed = new Map<string, number>();
  private loading: Promise<void> | undefined;
  private decoding: Promise<void> | undefined;
  private previous = new Map<string, Entity>();
  private steps = new Map<string, { x: number; z: number; distance: number }>();
  private hydrants: DebrisState[] = [];
  private clock = 0;
  private vehicles = new Map<string, VehicleAudioState>();
  private view: AudioView | undefined;
  private failures: string[] = [];
  private played = 0;
  private lastSelection:
    { sound: Sound; file: string; rate: number; gain: number } | undefined;
  muted = false;
  get diagnostics() {
    return {
      loaded: this.buffers.size,
      expected: new Set(Object.values(SOUND_BANKS).flatMap((bank) => bank.files)).size,
      failed: this.failures,
      loops: this.loops.size,
      loopSounds: [...this.loops.values()].map((voice) => voice.sound),
      oneShots: this.oneShots.size,
      played: this.played,
      lastSelection: this.lastSelection,
      state: this.context?.state,
      vehicles: [...this.vehicles].map(([id, state]) => ({
        id,
        rpm: state.rpm,
        load: state.load,
        gear: state.gear + 1,
      })),
    };
  }
  preload() {
    const files = [
      ...new Set(Object.values(SOUND_BANKS).flatMap((bank) => bank.files)),
    ];
    return (this.loading ??= Promise.all(
      Array.from({ length: Math.min(4, files.length) }, async () => {
        let name: string | undefined;
        while ((name = files.shift()) !== undefined) {
          try {
            const response = await fetch("/audio/" + name + ".wav");
            if (!response.ok) throw Error(String(response.status));
            this.raw.set(name, await response.arrayBuffer());
          } catch {
            this.failures.push(name);
            console.warn("Could not load sound:", name);
          }
        }
      }),
    ).then(() => {}));
  }
  unlock() {
    if (!this.context) {
      try {
        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = this.muted ? 0 : 0.65;
        const compressor = this.context.createDynamicsCompressor();
        compressor.threshold.value = -10;
        compressor.knee.value = 6;
        compressor.ratio.value = 12;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.15;
        this.master.connect(compressor).connect(this.context.destination);
      } catch {
        console.warn("Web Audio is unavailable; sound is disabled.");
        return;
      }
    }
    const context = this.context;
    void context
      .resume()
      .catch(() => console.warn("Sound needs another user gesture."));
    this.decoding ??= this.preload().then(async () => {
      await Promise.all(
        [...this.raw].map(async ([name, data]) => {
          try {
            this.buffers.set(name, await context.decodeAudioData(data));
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
  private voice(sound: Sound): Voice | undefined {
    const ctx = this.context;
    if (!ctx || !this.master) return;
    const selection = this.picker.pick(
      sound,
      SOUND_BANKS[sound].files.filter((file) => this.buffers.has(file)),
    );
    if (!selection) return;
    const buffer = this.buffers.get(selection.file);
    if (!buffer) return;
    const source = ctx.createBufferSource(),
      gain = ctx.createGain(),
      pan = ctx.createStereoPanner(),
      filter = ctx.createBiquadFilter();
    source.buffer = buffer;
    source.loop = SOUND_BANKS[sound].loop;
    source.playbackRate.value = selection.rate;
    gain.gain.value = 0;
    filter.type = "lowpass";
    filter.frequency.value = selection.cutoff;
    source.connect(filter).connect(gain).connect(pan).connect(this.master);
    const voice: Voice = {
      sound,
      source,
      gain,
      pan,
      filter,
      rate: selection.rate,
      variation: selection.gain,
      cutoff: selection.cutoff,
    };
    source.onended = () => {
      this.oneShots.delete(voice);
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
      pan.disconnect();
    };
    this.lastSelection = { sound, ...selection };
    this.played++;
    return voice;
  }
  private play(sound: Sound, volume = 1, pan = 0, emitter = "local") {
    const ctx = this.context,
      config = SOUND_BANKS[sound],
      key = sound + ":" + emitter;
    if (
      !ctx ||
      ctx.state !== "running" ||
      this.muted ||
      this.oneShots.size >= 32 ||
      (config.volume < 0.4 && this.oneShots.size >= 24) ||
      ctx.currentTime - (this.lastPlayed.get(key) ?? -Infinity) < config.cooldown ||
      [...this.oneShots].filter((voice) => voice.sound === sound).length >=
        config.voices
    )
      return;
    const voice = this.voice(sound);
    if (!voice) return;
    voice.gain.gain.setTargetAtTime(
      volume * config.volume * voice.variation,
      ctx.currentTime,
      0.002,
    );
    voice.pan.pan.value = Math.max(-1, Math.min(1, pan));
    this.oneShots.add(voice);
    this.lastPlayed.set(key, ctx.currentTime);
    voice.source.start();
  }
  ui() {
    this.play("ui");
  }
  async audition(sound: Sound) {
    this.unlock();
    await this.decoding;
    this.reset();
    this.lastSelection = undefined;
    if (!this.context || this.context.state !== "running" || this.muted) return;
    if (!SOUND_BANKS[sound].loop) {
      this.play(sound);
      return;
    }
    const voice = this.voice(sound);
    if (!voice) return;
    voice.gain.gain.setTargetAtTime(
      SOUND_BANKS[sound].volume * voice.variation,
      this.context.currentTime,
      0.03,
    );
    voice.source.start();
    this.loops.set("audition", voice);
  }
  async ready() {
    this.unlock();
    await this.decoding;
  }
  private spatial(
    sound: Sound,
    source: Pick<Entity, "x" | "y" | "z">,
    listener: Entity,
  ) {
    const range = SOUND_BANKS[sound].range;
    const distance = Math.hypot(
      source.x - listener.x,
      source.y - listener.y,
      source.z - listener.z,
    );
    // Out of range is silent. A listener-only cue (range 0) never carries from another body.
    if (range ? distance >= range : distance > LISTENER_CUE_DISTANCE) return;
    this.play(
      sound,
      range ? (1 - distance / range) ** 2 : 1,
      range ? spatialPan(source, listener, this.view) : 0,
      Math.floor(source.x) + "," + Math.floor(source.z),
    );
  }
  event(e: WorldEvent, listener?: Entity) {
    if (!listener) return;
    const sound =
      e.sound ??
      (e.kind === "shot"
        ? "pistol"
        : e.kind === "explosion"
          ? "explosion"
          : e.kind === "hit"
            ? "impact"
            : e.kind === "swing"
              ? "swing"
              : undefined);
    if (sound) this.spatial(sound, e, listener);
  }
  snapshot(
    entities: Entity[],
    listener: Entity | undefined,
    debris: DebrisState[] = [],
  ) {
    const next = new Map<string, Entity>();
    for (const current of entities) {
      if (current.kind !== "player" && current.kind !== "car") continue;
      const previous = this.previous.get(current.id);
      if (previous && listener && current.kind === "car") {
        if (!propulsionRunning(previous) && propulsionRunning(current))
          this.spatial("engineStart", current, listener);
        else if (
          propulsionRunning(previous) &&
          !propulsionRunning(current) &&
          current.health > 0 &&
          current.wreck === undefined
        )
          this.spatial("engineStop", current, listener);
      }
      if (previous && listener && current.kind === "player")
        for (const sound of transitionSounds(
          previous,
          current,
          current.id === listener.id,
        ))
          this.spatial(sound, current, listener);
      next.set(current.id, structuredClone(current));
    }
    this.previous = next;
    this.hydrants = debris.filter((entry) => entry.source.kind === "hydrant");
  }
  reset() {
    this.previous.clear();
    this.steps.clear();
    this.vehicles.clear();
    this.hydrants = [];
    this.lastPlayed.clear();
    this.clock = 0;
    for (const voice of this.oneShots) voice.source.stop();
    this.oneShots.clear();
    for (const voice of this.loops.values()) this.stopLoop(voice);
    this.loops.clear();
  }
  private stopLoop(voice: Voice) {
    if (!this.context) return;
    const tyreRelease = voice.sound === "skid" || voice.sound === "tyreSqueal";
    voice.gain.gain.setTargetAtTime(
      0,
      this.context.currentTime,
      tyreRelease ? 0.075 : 0.025,
    );
    voice.source.stop(this.context.currentTime + (tyreRelease ? 0.3 : 0.15));
  }
  update(
    entities: Entity[],
    listener: Entity | undefined,
    dt: number,
    city?: City,
    view?: AudioView,
  ) {
    if (!this.context) return;
    this.clock += dt;
    if (this.clock < 1 / 30) return;
    const elapsed = this.clock;
    this.clock = 0;
    this.view = view;
    const wanted = new Set<string>(),
      ctx = this.context;
    for (const [key, time] of this.lastPlayed)
      if (ctx.currentTime - time > 10) this.lastPlayed.delete(key);
    const loop = (
      id: string,
      sound: Sound,
      source: Pick<Entity, "x" | "y" | "z">,
      rate = 1,
      intensity = 1,
      tone = 1,
    ) => {
      if (!listener || this.muted || ctx.state !== "running") return;
      const config = SOUND_BANKS[sound],
        distance = Math.hypot(
          source.x - listener.x,
          source.y - listener.y,
          source.z - listener.z,
        );
      if (config.range && distance >= config.range) return;
      wanted.add(id);
      let voice = this.loops.get(id);
      if (voice && voice.sound !== sound) {
        this.stopLoop(voice);
        this.loops.delete(id);
        voice = undefined;
      }
      if (!voice) {
        if (this.loops.size >= 32) return;
        voice = this.voice(sound);
        if (!voice || !voice.source.buffer) return;
        voice.source.start(0, Math.random() * voice.source.buffer.duration);
        this.loops.set(id, voice);
      }
      voice.source.playbackRate.setTargetAtTime(
        rate * voice.rate,
        ctx.currentTime,
        0.15,
      );
      voice.gain.gain.setTargetAtTime(
        config.volume *
          voice.variation *
          intensity *
          (config.range ? (1 - distance / config.range) ** 2 : 1),
        ctx.currentTime,
        0.08,
      );
      voice.pan.pan.setTargetAtTime(
        config.range ? spatialPan(source, listener, this.view) : 0,
        ctx.currentTime,
        0.1,
      );
      voice.filter.frequency.setTargetAtTime(
        (voice.cutoff * tone) / (1 + distance * 0.03),
        ctx.currentTime,
        0.1,
      );
    };
    const nearby = listener
      ? entities
          .filter(
            (e) =>
              e.kind !== "player" &&
              e.kind !== "pedestrian" &&
              !e.wreck &&
              (engineSound(e) || e.skidding || e.burning !== undefined) &&
              Math.hypot(e.x - listener.x, e.y - listener.y, e.z - listener.z) <
                LOOP_HEARING_RANGE,
          )
          .sort(
            (a, b) =>
              Number(b.id === listener.vehicle) - Number(a.id === listener.vehicle) ||
              Math.hypot(a.x - listener.x, a.z - listener.z) -
                Math.hypot(b.x - listener.x, b.z - listener.z),
          )
          .slice(0, 6)
      : [];
    const activeVehicles = new Set(nearby.map((e) => e.id));
    for (const id of this.vehicles.keys())
      if (!activeVehicles.has(id)) this.vehicles.delete(id);
    for (const [index, e] of nearby.entries()) {
      const previous = this.vehicles.get(e.id);
      const state = vehicleAudioState(
        e,
        previous,
        elapsed,
        e.driver === listener?.id ? view?.input : undefined,
      );
      this.vehicles.set(e.id, state);
      const detailed =
        e.id === listener?.vehicle ||
        (index < 2 && Math.hypot(e.x - listener!.x, e.z - listener!.z) < 30);
      if (previous && !previous.slipping && state.slipping && listener)
        this.spatial("tyreOnset", e, listener);
      const doppler = listener ? dopplerRate(e, listener) : 1;
      for (const layer of vehicleLayers(e, state, detailed))
        loop(
          `vehicle:${e.id}:${layer.key}`,
          layer.sound,
          e,
          layer.rate * doppler,
          layer.gain,
          layer.tone,
        );
      if (e.burning !== undefined) loop("fire:" + e.id, "fire", e);
    }
    if (listener) {
      for (const e of entities) {
        if (
          e.jetpack?.active &&
          e.jetpack.fuel > 0 &&
          Math.abs(e.vy) > 0.1 &&
          !e.parachute &&
          !e.vehicle
        )
          loop("jetpack:" + e.id, "jetpack", e, 1.5, 0.7);
        if (
          e.weapon === "flamethrower" &&
          (e.cooldown || 0) > 0 &&
          !e.vehicle &&
          e.health > 0
        )
          loop("flame:" + e.id, "fire", e, 1.2, 0.7);
      }
      if (listener.parachute) {
        loop("wind", "wind", listener, 1, Math.min(1, Math.abs(listener.vy) / 4));
        loop("canopy", "canopy", listener, 1, Math.min(1, Math.abs(listener.vy) / 4));
      }
      const shore = Math.max(Math.abs(listener.x), Math.abs(listener.z));
      if (shore > 690)
        loop("coast", "coast", listener, 1, Math.min(1, (shore - 690) / 100));
      for (const entry of this.hydrants
        .slice()
        .sort(
          (a, b) =>
            Math.hypot(a.source.x - listener.x, a.source.z - listener.z) -
            Math.hypot(b.source.x - listener.x, b.source.z - listener.z),
        )
        .slice(0, 2))
        loop("water:" + entry.id, "water", { ...entry.source, y: 0.5 });
      const walkers = entities.filter(
        (e) =>
          (e.kind === "player" || e.kind === "pedestrian") &&
          !e.vehicle &&
          !e.parachute &&
          !e.down &&
          e.health > 0 &&
          Math.abs(e.vy) < 0.2 &&
          Math.hypot(e.x - listener.x, e.y - listener.y, e.z - listener.z) < 14,
      );
      const active = new Set(walkers.map((e) => e.id));
      for (const id of this.steps.keys()) if (!active.has(id)) this.steps.delete(id);
      for (const e of walkers) {
        const last = this.steps.get(e.id),
          distance = last ? Math.hypot(e.x - last.x, e.z - last.z) : 0;
        const traveled = distance < 2 ? (last?.distance ?? 0) + distance : 0;
        const stride = Math.hypot(e.vx, e.vz) > 5.5 ? 1.9 : 1.55;
        this.steps.set(e.id, {
          x: e.x,
          z: e.z,
          distance: traveled >= stride ? 0 : traveled,
        });
        if (traveled >= stride) {
          const grass = city?.parks.some(
            (park) =>
              Math.abs(e.x - park.x) < (park.w ?? 28) / 2 &&
              Math.abs(e.z - park.z) < (park.d ?? 28) / 2,
          );
          this.spatial(grass ? "footGrass" : "footConcrete", e, listener);
        }
      }
    } else this.steps.clear();
    for (const [id, voice] of this.loops)
      if (!wanted.has(id)) {
        this.stopLoop(voice);
        this.loops.delete(id);
      }
  }
}
