import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { z } from "zod";
import { SOUND_BANKS } from "../client/audio/banks.ts";

const index = process.argv.indexOf("--source-dir");
if (index < 0 || !process.argv[index + 1])
  throw Error(
    "Pass --source-dir containing the originals described in public/audio/CREDITS.md",
  );
if (!ffmpeg) throw Error("FFmpeg is unavailable on this platform");
const source = resolve(process.argv[index + 1]);
const clips = z
  .array(
    z.object({
      name: z.string().regex(/^[a-z0-9-]+$/),
      file: z.string().min(1),
      start: z.number().nonnegative().default(0),
      duration: z.number().positive().optional(),
      loop: z.boolean().default(false),
    }),
  )
  .parse(JSON.parse(await readFile("scripts/audio-clips.json", "utf8")));
const expected = new Set(Object.values(SOUND_BANKS).flatMap((bank) => bank.files));
if (
  expected.size !== clips.length ||
  clips.some((clip) => !expected.has(clip.name)) ||
  new Set(clips.map((clip) => clip.name)).size !== clips.length
)
  throw Error("Clip recipes must match the sound banks exactly");
await mkdir("public/audio", { recursive: true });
const hashes: Record<string, string> = {};
for (const clip of clips) {
  const file = join(source, clip.file);
  hashes[clip.file] ??= createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  const args = ["-v", "error", "-ss", String(clip.start), "-i", file];
  if (clip.duration) args.push("-t", String(clip.duration));
  args.push(
    "-af",
    "highpass=f=35" +
      (clip.loop
        ? ""
        : ",silenceremove=start_periods=1:start_duration=0.001:start_threshold=-48dB"),
    "-ac",
    "1",
    "-ar",
    "44100",
    "-f",
    "f32le",
    "-",
  );
  const raw = execFileSync(ffmpeg, args, { maxBuffer: 20e6 });
  const frames = raw.length / 4;
  if (frames < 882) throw Error(clip.name + " has no usable audio");
  const samples = Array.from({ length: frames }, (_, i) => raw.readFloatLE(i * 4));
  if (clip.loop) {
    const fade = Math.min(4410, Math.floor(frames / 4));
    for (let i = 0; i < fade; i++) {
      const alpha = i / fade;
      samples[frames - fade + i] =
        samples[frames - fade + i] * (1 - alpha) + samples[i] * alpha;
    }
    samples.splice(0, fade);
  } else {
    const attack = Math.min(88, Math.floor(frames / 4)),
      tail = Math.min(882, Math.floor(frames / 4));
    for (let i = 0; i < attack; i++) samples[i] *= i / attack;
    for (let i = 0; i < tail; i++) samples[samples.length - 1 - i] *= i / tail;
  }
  let peak = 0,
    square = 0;
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample));
    square += sample * sample;
  }
  if (!Number.isFinite(peak) || peak < 0.00001)
    throw Error(clip.name + " is silent or invalid");
  const rms = Math.sqrt(square / samples.length);
  const gain = Math.min(0.5 / peak, (clip.loop ? 0.1 : 0.16) / rms);
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++)
    pcm.writeInt16LE(Math.round(samples[i] * gain * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(88200, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  await writeFile(
    resolve("public/audio/" + clip.name + ".wav"),
    Buffer.concat([header, pcm]),
  );
  console.log("Prepared " + clip.name + " (" + (pcm.length / 88200).toFixed(2) + "s)");
}
await writeFile(
  "public/audio/source-hashes.json",
  JSON.stringify(hashes, null, 2) + "\n",
);
await writeFile(
  "public/audio/manifest.json",
  JSON.stringify(SOUND_BANKS, null, 2) + "\n",
);
