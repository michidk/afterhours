import type { WorldEvent, Entity } from "../../shared/world.ts";
import { propulsionRunning } from "../../shared/propulsion.ts";

export interface SoundBank {
  files: string[];
  volume: number;
  pitch: number;
  gainVariation: number;
  /**
   * Metres at which the sound has faded to silence; gain follows (1 - distance / range)^2.
   * Zero marks a cue for the listener alone (interface, inventory, own life state, own
   * parachute): it is never played for a source away from the listener.
   */
  range: number;
  cooldown: number;
  voices: number;
  loop: boolean;
}
const clips = (name: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${name}-${i + 1}`);
const bank = (
  files: string[],
  options: Partial<Omit<SoundBank, "files">> = {},
): SoundBank => ({
  files,
  volume: 0.5,
  pitch: 1,
  gainVariation: 0.12,
  range: 45,
  cooldown: 0.035,
  voices: 5,
  loop: false,
  ...options,
});
export const SOUND_BANKS = {
  horn: bank(clips("horn", 2), {
    volume: 0.35,
    pitch: 0.4,
    range: 50,
    cooldown: 0.25,
    voices: 4,
  }),
  engineSedan: bank(["engine-1", "engine-2"], {
    loop: true,
    volume: 0.2,
    pitch: 0.5,
    range: 36,
  }),
  engineSport: bank(["engine-3", "engine-4"], {
    loop: true,
    volume: 0.22,
    pitch: 0.5,
    range: 36,
  }),
  engineVan: bank(["engine-5", "engine-6"], {
    loop: true,
    volume: 0.2,
    pitch: 0.5,
    range: 36,
  }),
  helicopter: bank(clips("helicopter", 3), {
    loop: true,
    volume: 0.3,
    pitch: 0.35,
    range: 60,
  }),
  plane: bank(clips("plane", 3), { loop: true, volume: 0.28, pitch: 0.35, range: 60 }),
  skid: bank(clips("skid", 3), { loop: true, volume: 0.22, pitch: 1.5, range: 30 }),
  tyreSqueal: bank(clips("tyre-squeal", 3), {
    loop: true,
    volume: 0.3,
    pitch: 0.4,
    range: 34,
  }),
  tyreOnset: bank(clips("tyre-onset", 2), {
    volume: 0.2,
    pitch: 0.6,
    range: 30,
    cooldown: 0.8,
  }),
  sedanIdle: bank(clips("sedan-idle", 2), {
    loop: true,
    volume: 0.2,
    pitch: 0.2,
    range: 36,
  }),
  sedanHigh: bank(clips("sedan-high", 2), {
    loop: true,
    volume: 0.22,
    pitch: 0.2,
    range: 36,
  }),
  sedanCoast: bank(clips("sedan-coast", 2), {
    loop: true,
    volume: 0.16,
    pitch: 0.2,
    range: 36,
  }),
  sportIdle: bank(clips("sport-idle", 2), {
    loop: true,
    volume: 0.22,
    pitch: 0.2,
    range: 36,
  }),
  sportHigh: bank(clips("sport-high", 2), {
    loop: true,
    volume: 0.26,
    pitch: 0.2,
    range: 40,
  }),
  sportCoast: bank(clips("sport-coast", 2), {
    loop: true,
    volume: 0.18,
    pitch: 0.2,
    range: 36,
  }),
  vanIdle: bank(clips("van-idle", 2), {
    loop: true,
    volume: 0.2,
    pitch: 0.2,
    range: 36,
  }),
  vanHigh: bank(clips("van-high", 2), {
    loop: true,
    volume: 0.23,
    pitch: 0.2,
    range: 36,
  }),
  vanCoast: bank(clips("van-coast", 2), {
    loop: true,
    volume: 0.17,
    pitch: 0.2,
    range: 36,
  }),
  boatMotor: bank(clips("boat-motor", 2), {
    loop: true,
    volume: 0.22,
    pitch: 0.3,
    range: 42,
  }),
  jetskiMotor: bank(clips("jetski-motor", 2), {
    loop: true,
    volume: 0.2,
    pitch: 0.3,
    range: 40,
  }),
  wake: bank(clips("wake", 2), { loop: true, volume: 0.17, pitch: 0.5, range: 25 }),
  engineStart: bank(clips("engine-start", 2), {
    volume: 0.2,
    pitch: 0.4,
    range: 26,
    cooldown: 1,
  }),
  engineStop: bank(clips("engine-stop", 2), {
    volume: 0.16,
    pitch: 0.4,
    range: 24,
    cooldown: 1,
  }),
  fire: bank(clips("fire", 3), { loop: true, volume: 0.22, pitch: 0.5, range: 20 }),
  wind: bank(clips("wind", 3), { loop: true, volume: 0.12, pitch: 0.5, range: 0 }),
  jetpack: bank(clips("wind", 3), { loop: true, volume: 0.12, pitch: 0.5, range: 28 }),
  canopy: bank(clips("canopy", 3), { loop: true, volume: 0.08, pitch: 0.5, range: 0 }),
  water: bank(clips("water", 3), { loop: true, volume: 0.18, pitch: 0.5, range: 22 }),
  // Swimming plays it at full volume; the shore at most a quarter (surfIntensity).
  coast: bank(clips("coast", 3), { loop: true, volume: 0.6, pitch: 0.35, range: 0 }),
  pistol: bank(clips("pistol", 3), { volume: 0.55, pitch: 0.6, range: 65, voices: 8 }),
  smg: bank(clips("smg", 3), { volume: 0.45, pitch: 0.6, range: 60, voices: 8 }),
  reloadPistol: bank(clips("reload-pistol", 2), {
    volume: 0.28,
    pitch: 0.35,
    range: 15,
  }),
  reloadSmg: bank(clips("reload-smg", 2), { volume: 0.28, pitch: 0.35, range: 15 }),
  dryFire: bank(clips("dry-fire", 3), { volume: 0.25, pitch: 0.5, range: 12 }),
  swing: bank(clips("swing", 3), { volume: 0.22, pitch: 1.5, range: 12 }),
  punch: bank(clips("punch", 5), { volume: 0.42, pitch: 1.4, range: 25 }),
  bat: bank(clips("bat", 5), { volume: 0.48, pitch: 1.2, range: 30 }),
  impact: bank(clips("impact", 5), {
    volume: 0.52,
    pitch: 1.8,
    range: 38,
    cooldown: 0.08,
  }),
  impactWood: bank(clips("wood", 5), { volume: 0.5, pitch: 1.5, range: 32 }),
  impactBody: bank(clips("body", 5), { volume: 0.35, pitch: 1.2, range: 25 }),
  explosion: bank(clips("explosion", 3), {
    volume: 0.7,
    pitch: 0.6,
    range: 85,
    voices: 4,
  }),
  footConcrete: bank(clips("foot-concrete", 5), {
    volume: 0.16,
    pitch: 1,
    range: 14,
    voices: 6,
  }),
  footGrass: bank(clips("foot-grass", 5), {
    volume: 0.13,
    pitch: 1,
    range: 12,
    voices: 6,
  }),
  landing: bank(clips("landing", 3), { volume: 0.3, pitch: 1, range: 20 }),
  door: bank(clips("door", 3), { volume: 0.3, pitch: 0.6, range: 20 }),
  pickup: bank(clips("pickup", 3), { volume: 0.2, pitch: 0.4, range: 0 }),
  drop: bank(clips("drop", 3), { volume: 0.22, pitch: 0.8, range: 0 }),
  equip: bank(clips("equip", 3), { volume: 0.2, pitch: 0.6, range: 0 }),
  equipGun: bank(clips("equip-gun", 3), { volume: 0.2, pitch: 0.6, range: 0 }),
  parachute: bank(clips("parachute", 3), { volume: 0.3, pitch: 0.6, range: 20 }),
  death: bank(clips("death", 3), { volume: 0.25, pitch: 0.5, range: 0 }),
  respawn: bank(clips("respawn", 3), { volume: 0.2, pitch: 0.3, range: 0 }),
  ui: bank(clips("ui", 3), { volume: 0.12, pitch: 0.3, range: 0 }),
} satisfies Record<string, SoundBank> &
  Record<NonNullable<WorldEvent["sound"]>, SoundBank>;
export type Sound = keyof typeof SOUND_BANKS;
/** Farthest any looping sound carries; sources beyond it are never mixed at all. */
export const LOOP_HEARING_RANGE = Math.max(
  ...Object.values<SoundBank>(SOUND_BANKS).map((bank) => (bank.loop ? bank.range : 0)),
);

export interface DriftSoundMix {
  squealRate: number;
  squealGain: number;
  squealTone: number;
  scrubRate: number;
  scrubGain: number;
  scrubTone: number;
}

/** Body slip angles (degrees) where tyre noise starts and reaches full level. */
export const DRIFT_SOUND = { quietAngle: 12, span: 28, gain: 0.7 };

/** Shape tyre audio from actual sideways motion instead of road speed alone. */
export function driftSoundMix(entity: Entity): DriftSoundMix | undefined {
  if (entity.kind !== "car" || !entity.skidding) return;
  const speed = Math.hypot(entity.vx, entity.vz),
    sideways = Math.abs(
      Math.cos(entity.angle) * entity.vx - Math.sin(entity.angle) * entity.vz,
    ),
    forward = Math.abs(
      Math.sin(entity.angle) * entity.vx + Math.cos(entity.angle) * entity.vz,
    ),
    // Body slip angle: a gripped fast corner stays quiet, a real slide squeals.
    angle = (Math.atan2(sideways, Math.max(1, forward)) * 180) / Math.PI,
    slip = Math.max(
      0,
      Math.min(1, (angle - DRIFT_SOUND.quietAngle) / DRIFT_SOUND.span),
    ),
    moving = Math.max(0, Math.min(1, (speed - 3) / 9)),
    slippingWheels = entity.wheelSkids?.filter(Boolean).length ?? 2,
    contact = 0.72 + Math.min(2, slippingWheels) * 0.14,
    intensity = moving * contact * slip * slip * DRIFT_SOUND.gain;
  if (intensity < 0.02) return;
  return {
    squealRate: 0.82 + slip * 0.28 + Math.min(speed, 40) * 0.004,
    squealGain: intensity,
    squealTone: 0.48 + slip * 0.52,
    scrubRate: 0.62 + slip * 0.12 + Math.min(speed, 40) * 0.002,
    scrubGain: intensity * (0.24 + slip * 0.2),
    scrubTone: 0.2 + slip * 0.18,
  };
}

export function engineSound(entity: Entity): Sound | undefined {
  if (!propulsionRunning(entity)) return;
  if (entity.kind === "car" && (entity.driver || entity.ai))
    return entity.model === "sport"
      ? "engineSport"
      : entity.model === "van"
        ? "engineVan"
        : "engineSedan";
  if (entity.kind === "helicopter") return "helicopter";
  if (entity.kind === "plane" && entity.driver) return "plane";
  if (entity.kind === "boat" || entity.kind === "jetski" || entity.kind === "speedboat")
    return entity.kind === "jetski" ? "jetskiMotor" : "boatMotor";
}

export class SoundPicker {
  private previous = new Map<Sound, string>();
  constructor(private random: () => number = Math.random) {}
  pick(sound: Sound, available = SOUND_BANKS[sound].files) {
    const choices = available.filter((file) => file !== this.previous.get(sound));
    const pool = choices.length ? choices : available;
    const file = pool[Math.floor(this.random() * pool.length)];
    if (!file) return;
    this.previous.set(sound, file);
    const config = SOUND_BANKS[sound];
    return {
      file,
      rate: 2 ** (((this.random() * 2 - 1) * config.pitch) / 12),
      gain: 1 + (this.random() * 2 - 1) * config.gainVariation,
      cutoff: 14500 + this.random() * 3500,
    };
  }
}

export function transitionSounds(
  previous: Entity,
  current: Entity,
  local: boolean,
): Sound[] {
  const result: Sound[] = [];
  if (previous.vehicle !== current.vehicle) result.push("door");
  if (!previous.parachute && current.parachute) result.push("parachute");
  if (
    previous.parachute &&
    !current.parachute &&
    current.health > 0 &&
    !current.vehicle
  )
    result.push("landing");
  if (current.reloadUntil && previous.reloadUntil !== current.reloadUntil)
    result.push(current.weapon === "smg" ? "reloadSmg" : "reloadPistol");
  if (!local) return result;
  if (previous.health > 0 && current.health <= 0) result.push("death");
  else if (previous.health <= 0 && current.health > 0) result.push("respawn");
  else if (!previous.vehicle && current.health < previous.health)
    result.push("impactBody");
  if (current.health > 0 && previous.health > 0) {
    const before = previous.inventory ?? [],
      after = current.inventory ?? [];
    if (after.some((item) => !before.some((old) => old.id === item.id)))
      result.push("pickup");
    else if (before.some((item) => !after.some((next) => next.id === item.id)))
      result.push("drop");
    else if (previous.weapon !== current.weapon)
      result.push(
        current.weapon === "pistol" || current.weapon === "smg" ? "equipGun" : "equip",
      );
  }
  return result;
}
