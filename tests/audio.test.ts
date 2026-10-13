import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { GameAudio } from "../client/audio/index.ts";
import {
  SOUND_BANKS,
  LOOP_HEARING_RANGE,
  SoundPicker,
  transitionSounds,
  engineSound,
  type Sound,
} from "../client/audio/banks.ts";
import { random, type Entity, type WorldEvent } from "../shared/world.ts";

function isSound(name: string): name is Sound {
  return Object.hasOwn(SOUND_BANKS, name);
}
function player(): Entity {
  return {
    id: "player",
    kind: "player",
    x: 0,
    y: 0,
    z: 0,
    angle: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    health: 100,
    color: "#ffffff",
    weapon: "fists",
    inventory: [{ id: "fists", kind: "fists", ammo: 0, reserve: 0 }],
  };
}
test("every sound bank has distinct, unclipped PCM assets with smooth edges", async () => {
  const files = new Set(Object.values(SOUND_BANKS).flatMap((bank) => bank.files));
  assert.deepEqual(
    (await readdir("public/audio")).filter((file) => file.endsWith(".wav")).sort(),
    [...files].map((file) => file + ".wav").sort(),
  );
  assert.deepEqual(
    JSON.parse(await readFile("public/audio/manifest.json", "utf8")),
    SOUND_BANKS,
  );
  const recipes = [
    ...JSON.parse(await readFile("scripts/audio-clips.json", "utf8")),
    ...JSON.parse(await readFile("scripts/vehicle-audio-clips.json", "utf8")),
  ];
  const hashes = JSON.parse(await readFile("public/audio/source-hashes.json", "utf8"));
  const provenance = JSON.parse(await readFile("public/audio/sources.json", "utf8"));
  const sourceFiles: string[] = [];
  for (const source of provenance.sources) {
    assert.equal(source.license, "CC0-1.0", source.page);
    assert.match(source.page, /^https:\/\//);
    assert.ok(source.author && source.licenseEvidence, source.page);
    sourceFiles.push(...source.files);
  }
  assert.deepEqual(sourceFiles.sort(), Object.keys(hashes).sort());
  for (const recipe of recipes) assert.match(hashes[recipe.file], /^[a-f0-9]{64}$/);
  for (const [name, bank] of Object.entries(SOUND_BANKS)) {
    assert.ok(bank.files.length >= 2, name + " needs alternate takes");
    const distinct = new Set<string>();
    for (const file of bank.files) {
      const wav = await readFile(`public/audio/${file}.wav`);
      distinct.add(createHash("sha256").update(wav).digest("hex"));
      assert.equal(wav.toString("ascii", 0, 4), "RIFF");
      assert.equal(wav.readUInt32LE(24), 44100);
      assert.equal(wav.readUInt16LE(22), 1);
      assert.equal(wav.readUInt16LE(34), 16);
      assert.equal(wav.readUInt32LE(40), wav.length - 44);
      assert.ok(wav.length > 1808, file + " must contain more than 20 ms");
      let peak = 0,
        square = 0;
      const jumps: number[] = [];
      for (let i = 44; i < wav.length; i += 2) {
        const sample = wav.readInt16LE(i);
        peak = Math.max(peak, Math.abs(sample));
        square += sample * sample;
        if (i > 44) jumps.push(Math.abs(sample - wav.readInt16LE(i - 2)));
      }
      assert.ok(
        peak > 1000 && peak <= 16384,
        file + " must be audible with at least 6 dB headroom",
      );
      assert.ok(
        Math.sqrt(square / ((wav.length - 44) / 2)) > 100,
        file + " must not be mostly silent",
      );
      if (bank.loop) {
        jumps.sort((a, b) => a - b);
        const seam = Math.abs(wav.readInt16LE(44) - wav.readInt16LE(wav.length - 2));
        assert.ok(
          seam < Math.max(500, jumps[Math.floor(jumps.length * 0.999)]),
          `${file} seam ${seam} must not exceed normal waveform transitions`,
        );
      } else {
        assert.equal(wav.readInt16LE(44), 0, file + " must fade in");
        assert.equal(wav.readInt16LE(wav.length - 2), 0, file + " must fade out");
      }
    }
    assert.equal(
      distinct.size,
      bank.files.length,
      name + " must not ship duplicate takes",
    );
  }
});
test("sound selection avoids immediate repeats and varies properties within each bank's limits", () => {
  const picker = new SoundPicker(random(713));
  for (const key of Object.keys(SOUND_BANKS)) {
    if (!isSound(key)) continue;
    const sound = key,
      bank = SOUND_BANKS[sound],
      seen = new Set<string>(),
      rates = new Set<number>();
    let previous: string | undefined;
    for (let i = 0; i < 100; i++) {
      const take = picker.pick(sound);
      assert.ok(take);
      assert.notEqual(take.file, previous);
      assert.ok(bank.files.includes(take.file));
      assert.ok(
        take.rate >= 2 ** (-bank.pitch / 12) && take.rate <= 2 ** (bank.pitch / 12),
      );
      assert.ok(
        take.gain >= 1 - bank.gainVariation && take.gain <= 1 + bank.gainVariation,
      );
      assert.ok(take.cutoff >= 14500 && take.cutoff <= 18000);
      seen.add(take.file);
      rates.add(take.rate);
      previous = take.file;
    }
    assert.equal(seen.size, bank.files.length);
    assert.equal(rates.size, 100);
  }
  assert.equal(picker.pick("pistol", []), undefined);
  assert.equal(picker.pick("pistol", ["pistol-1"])?.file, "pistol-1");
  assert.equal(picker.pick("pistol", ["pistol-1"])?.file, "pistol-1");
});
test("confirmed snapshots produce action cues once and keep private cues local", () => {
  const before = player(),
    after = structuredClone(before);
  assert.deepEqual(transitionSounds(before, after, true), []);
  after.vehicle = "car";
  assert.deepEqual(transitionSounds(before, after, true), ["door"]);
  before.vehicle = "car";
  after.vehicle = undefined;
  after.parachute = true;
  assert.deepEqual(transitionSounds(before, after, true), ["door", "parachute"]);
  before.vehicle = undefined;
  before.parachute = true;
  after.parachute = undefined;
  assert.deepEqual(transitionSounds(before, after, true), ["landing"]);
  before.parachute = undefined;
  after.reloadUntil = 8;
  after.weapon = "smg";
  assert.deepEqual(transitionSounds(before, after, false), ["reloadSmg"]);
  assert.deepEqual(transitionSounds(after, structuredClone(after), true), []);
  after.reloadUntil = undefined;
  after.inventory!.push({ id: "gun", kind: "smg", ammo: 24, reserve: 96 });
  assert.deepEqual(transitionSounds(before, after, true), ["pickup"]);
  assert.deepEqual(transitionSounds(before, after, false), []);
  assert.deepEqual(transitionSounds(after, before, true), ["drop"]);
  const dead = { ...before, health: 0 };
  assert.deepEqual(transitionSounds(before, dead, true), ["death"]);
  assert.deepEqual(transitionSounds(dead, after, true), ["respawn"]);
  assert.deepEqual(transitionSounds(before, { ...before, health: 80 }, true), [
    "impactBody",
  ]);
});

test("engine playback follows operation rather than pushed vehicle speed", () => {
  const moving = { ...player(), kind: "car" as const, vx: 8 };
  assert.equal(engineSound(moving), undefined);
  assert.equal(engineSound({ ...moving, driver: "pilot" }), "engineSedan");
  assert.equal(engineSound({ ...moving, ai: true, model: "sport" }), "engineSport");
  assert.equal(engineSound({ ...moving, driver: "pilot", model: "van" }), "engineVan");
  assert.equal(engineSound({ ...moving, driver: "pilot", wreck: 180 }), undefined);
  const helicopter = { ...moving, kind: "helicopter" as const };
  assert.equal(engineSound(helicopter), undefined);
  assert.equal(
    engineSound({ ...helicopter, driver: "pilot", flight: "grounded" }),
    undefined,
  );
  assert.equal(
    engineSound({ ...helicopter, driver: "pilot", flight: "takingOff" }),
    "helicopter",
  );
  assert.equal(engineSound({ ...helicopter, flight: "falling" }), undefined);
  assert.equal(engineSound({ ...helicopter, flight: "grounded" }), undefined);
  const plane = { ...moving, kind: "plane" as const };
  assert.equal(engineSound(plane), undefined);
  assert.equal(engineSound({ ...plane, driver: "pilot" }), "plane");
  assert.equal(engineSound({ ...plane, flight: "falling" }), undefined);
});

test("confirmed firearm equips use gun handling and keep other handling local", () => {
  const before = player();
  before.inventory!.push(
    { id: "pistol", kind: "pistol", ammo: 12, reserve: 48 },
    { id: "smg", kind: "smg", ammo: 24, reserve: 96 },
    { id: "bat", kind: "bat", ammo: 0, reserve: 0 },
  );
  for (const weapon of ["pistol", "smg"])
    assert.deepEqual(transitionSounds(before, { ...before, weapon }, true), [
      "equipGun",
    ]);
  assert.deepEqual(transitionSounds(before, { ...before, weapon: "bat" }, true), [
    "equip",
  ]);
  const armed = { ...before, weapon: "pistol" };
  assert.deepEqual(transitionSounds(armed, before, true), ["equip"]);
  assert.deepEqual(transitionSounds(before, armed, false), []);
  assert.deepEqual(transitionSounds(armed, structuredClone(armed), true), []);
});

// Hearing distance policy: amplitude is master gain (0.65) x volume x (1 - d / range)^2,
// and 0.01 (-40 dBFS) is where a sound stops being worth mixing.
const MASTER = 0.65,
  FLOOR = 0.01;
const audibleDistance = (sound: Sound) => {
  const bank = SOUND_BANKS[sound];
  return bank.range * (1 - Math.sqrt(Math.min(1, FLOOR / (MASTER * bank.volume))));
};
test("nothing carries far: ambient sounds fade within 32 m, loud ones within their tier", () => {
  const tiers: Partial<Record<Sound, number>> = {
    helicopter: 48,
    plane: 48,
    horn: 48,
    pistol: 55,
    smg: 55,
    explosion: 75,
  };
  for (const [name, bank] of Object.entries(SOUND_BANKS)) {
    if (!isSound(name) || !bank.range) continue;
    const reach = audibleDistance(name);
    assert.ok(
      reach <= (tiers[name] ?? 32),
      `${name} is still audible at ${reach.toFixed(0)} m, limit ${tiers[name] ?? 32} m`,
    );
    assert.ok(bank.range <= 85, `${name} range ${bank.range} m`);
  }
});

function mockedAudio() {
  const started: string[] = [],
    parameter = { setTargetAtTime() {}, value: 0 };
  const audio = new GameAudio();
  Object.assign(audio, {
    context: { currentTime: 0, state: "running" },
    master: {},
    voice: (sound: string) => ({
      sound,
      rate: 1,
      variation: 1,
      cutoff: 16000,
      filter: { frequency: parameter },
      gain: { gain: parameter },
      pan: { pan: parameter },
      source: {
        buffer: { duration: 1 },
        start() {
          started.push(sound);
        },
        stop() {},
        playbackRate: parameter,
      },
    }),
  });
  return { audio, started };
}
const listener = (): Entity => ({ ...player(), id: "me" });
const at = (x: number, extra: Partial<WorldEvent> = {}): WorldEvent => ({
  kind: "hit",
  x,
  y: 0,
  z: 0,
  ...extra,
});

test("one-shot sounds play only inside their range and never from another body when listener-only", () => {
  const near = mockedAudio();
  near.audio.event(at(20, { sound: "pistol" }), listener());
  assert.deepEqual(near.started, ["pistol"], "a shot 20 m away is heard");
  const events: [string, WorldEvent[]][] = [
    ["pistol", [at(SOUND_BANKS.pistol.range, { sound: "pistol" })]],
    ["horn", [at(SOUND_BANKS.horn.range, { sound: "horn" })]],
    ["impact", [at(SOUND_BANKS.impact.range, { sound: "impact" })]],
    ["punch", [at(SOUND_BANKS.punch.range, { sound: "punch" })]],
    ["explosion", [at(SOUND_BANKS.explosion.range, { kind: "explosion" })]],
    ["explosion far", [at(500, { kind: "explosion" })]],
  ];
  for (const [name, list] of events) {
    const quiet = mockedAudio();
    for (const event of list) quiet.audio.event(event, listener());
    assert.deepEqual(quiet.started, [], `${name} at or beyond its range stays silent`);
  }
  // Interface and inventory cues have no range; they must not carry from a remote source.
  const cue = (audio: GameAudio, sound: Sound, x: number) =>
    (
      audio as unknown as {
        spatial(
          sound: Sound,
          source: { x: number; y: number; z: number },
          l: Entity,
        ): void;
      }
    ).spatial(sound, { x, y: 0, z: 0 }, listener());
  for (const sound of [
    "pickup",
    "drop",
    "equip",
    "equipGun",
    "death",
    "respawn",
  ] as const) {
    assert.equal(SOUND_BANKS[sound].range, 0, `${sound} is a listener-only cue`);
    const remote = mockedAudio();
    cue(remote.audio, sound, 40);
    assert.deepEqual(remote.started, [], `${sound} from another body is silent`);
    const own = mockedAudio();
    cue(own.audio, sound, 0);
    assert.deepEqual(own.started, [sound], `${sound} for the listener still plays`);
  }
});

test("a vehicle is mixed only inside the loop hearing range", () => {
  const car = (x: number): Entity => ({
    ...player(),
    id: "car",
    kind: "car",
    ai: true,
    x,
    vz: 6,
  });
  const quiet = mockedAudio();
  quiet.audio.update([car(SOUND_BANKS.engineSedan.range + 4)], listener(), 1);
  assert.deepEqual(quiet.started, [], "a car just out of range makes no sound");
  const far = mockedAudio();
  far.audio.update([car(70)], listener(), 1);
  assert.deepEqual(far.started, [], "a car 70 m away makes no sound");
  const close = mockedAudio();
  close.audio.update([car(15)], listener(), 1);
  assert.ok(close.started.length > 0, "a car 15 m away is heard");
  assert.ok(LOOP_HEARING_RANGE <= 60, "no loop is mixed beyond 60 m");
});
