import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import ffmpeg from "ffmpeg-static";
// Offline asset editing only. See public/audio/CREDITS.md for source downloads.
const index = process.argv.indexOf("--source-dir");
if (index < 0 || !process.argv[index + 1])
  throw Error(
    "Pass --source-dir containing original recordings and selected/ extracts",
  );
if (!ffmpeg) throw Error("FFmpeg is unavailable on this platform");
const source = resolve(process.argv[index + 1]);
await mkdir("public/audio", { recursive: true });
const clips = [
  { name: "engine", file: "engine.wav", loop: true },
  { name: "helicopter", file: "helicopter.mp3", start: 0.2, duration: 3, loop: true },
  { name: "plane", file: "plane.mp3", start: 12, duration: 4, loop: true },
  { name: "skid", file: "skid.mp3", start: 4, duration: 1.5, loop: true },
  { name: "pistol", file: "selected/A_34P.wav", start: 1, duration: 0.8 },
  { name: "smg", file: "selected/G_20P.wav", duration: 0.4 },
  { name: "punch", file: "selected/hit01.mp3.flac", duration: 0.45 },
  { name: "bat", file: "selected/hit04.mp3.flac", duration: 0.5 },
  { name: "impact", file: "impact.wav", duration: 0.55 },
  { name: "explosion", file: "explosion.ogg", duration: 2.5 },
  { name: "reload", file: "reload.wav", duration: 1.4 },
];
for (const clip of clips) {
  const args = [
    "-v",
    "error",
    "-ss",
    String(clip.start || 0),
    "-i",
    join(source, clip.file),
  ];
  if (clip.duration) args.push("-t", String(clip.duration));
  args.push(
    "-af",
    (clip.loop
      ? ""
      : "silenceremove=start_periods=1:start_duration=0.001:start_threshold=-42dB,") +
      "loudnorm=I=-18:TP=-3:LRA=7",
    "-ac",
    "1",
    "-ar",
    "44100",
    "-f",
    "s16le",
    "-",
  );
  let pcm = execFileSync(ffmpeg, args, { maxBuffer: 20e6 });
  if (pcm.length < 2000) throw Error(clip.name + " has no usable audio");
  if (clip.loop) {
    const fade = Math.min(4410, Math.floor(pcm.length / 8));
    const frames = pcm.length / 2;
    const output = Buffer.alloc(pcm.length - fade * 2);
    pcm.copy(output, 0, fade * 2);
    for (let i = 0; i < fade; i++) {
      const alpha = i / fade;
      output.writeInt16LE(
        Math.round(
          pcm.readInt16LE((frames - fade + i) * 2) * (1 - alpha) +
            pcm.readInt16LE(i * 2) * alpha,
        ),
        (frames - 2 * fade + i) * 2,
      );
    }
    pcm = output;
  } else {
    const fade = Math.min(882, pcm.length / 2);
    for (let i = 0; i < fade; i++) {
      const offset = pcm.length - 2 * (fade - i);
      pcm.writeInt16LE(Math.round(pcm.readInt16LE(offset) * (1 - i / fade)), offset);
    }
  }
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
  console.log(
    "Prepared " + clip.name + ".wav (" + (pcm.length / 88200).toFixed(2) + "s)",
  );
}
