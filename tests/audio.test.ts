import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("recorded audio assets contain usable PCM and smooth loop boundaries", async () => {
  const names = [
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
  ];
  for (const name of names) {
    const wav = await readFile(`public/audio/${name}.wav`);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(24), 44100);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    assert.ok(wav.length > 8820, `${name} must contain more than 100 ms`);
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2)
      peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    assert.ok(peak > 1000 && peak < 32000, `${name} must be audible and unclipped`);
    if (["engine", "helicopter", "plane", "skid"].includes(name))
      assert.ok(
        Math.abs(wav.readInt16LE(44) - wav.readInt16LE(wav.length - 2)) < 3000,
        `${name} loop boundary must not click`,
      );
  }
});
