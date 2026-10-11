import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  SOUND_BANKS,
  SoundPicker,
  transitionSounds,
  engineSound,
  type Sound,
} from "../client/audio/banks.ts";
import { random, type Entity } from "../shared/world.ts";

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
  const recipes = JSON.parse(await readFile("scripts/audio-clips.json", "utf8"));
  const hashes = JSON.parse(await readFile("public/audio/source-hashes.json", "utf8"));
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
