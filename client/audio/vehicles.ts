import type { Entity, Input } from "../../shared/world.ts";
import { engineSound, driftSoundMix, type Sound } from "./banks.ts";

const clamp = (value: number, low = 0, high = 1) =>
  Math.max(low, Math.min(high, value));
export interface VehicleAudioState {
  speed: number;
  rpm: number;
  load: number;
  gear: number;
  shift: number;
  slipping: boolean;
}
export interface VehicleLayer {
  key: string;
  sound: Sound;
  rate: number;
  gain: number;
  tone: number;
}
export interface AudioView {
  /** Horizontal camera-right basis. Distance stays anchored to the player. */
  rightX: number;
  rightZ: number;
  input?: Input;
}

/** Audible revs/gears are cosmetic estimates; they never feed simulation. */
export function vehicleAudioState(
  entity: Entity,
  previous: VehicleAudioState | undefined,
  dt: number,
  input?: Input,
): VehicleAudioState {
  const speed = Math.hypot(entity.vx, entity.vz);
  const step = clamp(dt, 1 / 240, 0.1);
  const acceleration = previous ? clamp((speed - previous.speed) / step, -12, 12) : 0;
  const desiredLoad = input
    ? input.up || (input.down && speed < 2)
      ? 1
      : 0
    : clamp(0.32 + acceleration * 0.12);
  const load =
    (previous?.load ?? desiredLoad) +
    (desiredLoad - (previous?.load ?? desiredLoad)) * (1 - Math.exp(-step * 8));
  const spacing = entity.model === "sport" ? 12 : entity.model === "van" ? 8 : 10;
  let gear = previous?.gear ?? Math.min(4, Math.floor(speed / spacing));
  // Hysteresis prevents gear hunting near a boundary, especially during drifts.
  if (speed > (gear + 1) * spacing + 1.5 && gear < 4) gear++;
  else if (speed < gear * spacing - 2.5 && gear > 0) gear--;
  const shift =
    previous && gear !== previous.gear
      ? 0.22
      : Math.max(0, (previous?.shift ?? 0) - step);
  const target =
    entity.kind === "car"
      ? clamp(
          0.12 +
            clamp((speed - gear * spacing) / spacing) * 0.7 +
            load * 0.18 -
            (shift > 0 ? 0.18 : 0),
        )
      : clamp(0.2 + (speed / (entity.kind === "plane" ? 65 : 30)) * 0.65 + load * 0.15);
  const rpm =
    (previous?.rpm ?? target) +
    (target - (previous?.rpm ?? target)) * (1 - Math.exp(-step * 10));
  return { speed, rpm, load, gear, shift, slipping: !!driftSoundMix(entity) };
}

export function vehicleLayers(
  entity: Entity,
  state: VehicleAudioState,
  detailed: boolean,
): VehicleLayer[] {
  const sound = engineSound(entity);
  const layers: VehicleLayer[] = [];
  const add = (key: string, sound: Sound, rate: number, gain: number, tone = 1) =>
    layers.push({ key, sound, rate, gain, tone });
  if (sound) {
    const damage = 1 - clamp(entity.health / (entity.maxHealth ?? 100));
    const tone = (0.55 + state.load * 0.45) * (1 - damage * 0.18);
    if (entity.kind === "car" && detailed) {
      const family =
        entity.model === "sport" ? "sport" : entity.model === "van" ? "van" : "sedan";
      const idle: Sound =
        family === "sport" ? "sportIdle" : family === "van" ? "vanIdle" : "sedanIdle";
      const high: Sound =
        family === "sport" ? "sportHigh" : family === "van" ? "vanHigh" : "sedanHigh";
      const coast: Sound =
        family === "sport"
          ? "sportCoast"
          : family === "van"
            ? "vanCoast"
            : "sedanCoast";
      // Adjacent bands overlap; the unloaded layer replaces part of the loaded mix.
      const idleWeight = clamp(1 - state.rpm / 0.45);
      const highWeight = clamp((state.rpm - 0.45) / 0.55);
      const midWeight = 1 - idleWeight - highWeight;
      const loaded = 0.45 + state.load * 0.55;
      const shiftGain = state.shift > 0 ? 0.78 : 1;
      add("idle", idle, 0.85 + state.rpm * 0.45, Math.sqrt(idleWeight) * loaded, tone);
      add(
        "mid",
        sound,
        0.8 + state.rpm * 0.5,
        Math.sqrt(midWeight) * loaded * shiftGain,
        tone,
      );
      add(
        "high",
        high,
        0.85 + state.rpm * 0.35,
        Math.sqrt(highWeight) * loaded * shiftGain,
        tone,
      );
      add(
        "coast",
        coast,
        0.85 + state.rpm * 0.35,
        Math.sqrt(1 - state.load) * (0.25 + state.rpm * 0.35),
        0.45,
      );
    } else {
      const rate =
        entity.kind === "helicopter"
          ? entity.flight === "takingOff"
            ? 0.85
            : 1
          : 0.8 + state.rpm * 0.55;
      add("motor", sound, rate, 0.65 + state.load * 0.35, tone);
      if (detailed && (entity.kind === "helicopter" || entity.kind === "plane"))
        add(
          "rotor",
          sound,
          entity.kind === "helicopter" ? 0.72 : 0.76 + state.rpm * 0.25,
          0.24,
          0.2,
        );
    }
  }
  const drift = driftSoundMix(entity);
  if (drift) {
    add("squeal", "tyreSqueal", drift.squealRate, drift.squealGain, drift.squealTone);
    if (detailed)
      add("scrub", "skid", drift.scrubRate, drift.scrubGain, drift.scrubTone);
  }
  if (
    detailed &&
    ["boat", "jetski", "speedboat"].includes(entity.kind) &&
    state.speed > 1
  )
    add(
      "wake",
      "wake",
      0.85 + clamp(state.speed / 30) * 0.2,
      clamp(state.speed / 15),
      0.8,
    );
  return layers;
}

export function spatialPan(
  source: Pick<Entity, "x" | "z">,
  listener: Pick<Entity, "x" | "z">,
  view?: AudioView,
) {
  return clamp(
    ((source.x - listener.x) * (view?.rightX ?? 1) +
      (source.z - listener.z) * (view?.rightZ ?? 0)) /
      25,
    -0.85,
    0.85,
  );
}

/** Bounded Doppler from radial velocities; occupants hear their own motor unchanged. */
export function dopplerRate(source: Entity, listener: Entity) {
  if (source.id === listener.vehicle) return 1;
  const dx = listener.x - source.x,
    dz = listener.z - source.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 1) return 1;
  const toward =
    ((source.vx - listener.vx) * dx + (source.vz - listener.vz) * dz) / distance;
  return clamp(343 / (343 - clamp(toward, -70, 70)), 0.85, 1.18);
}
