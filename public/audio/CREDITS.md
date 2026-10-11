# CC0 audio credits and preparation

All audio shipped here is edited from recordings released under **CC0 1.0** by the sources below. No oscillator/synthesized placeholder fallback is used. Clips are hosted by AFTERHOURS, not streamed from third-party sites during play.

| Output              | Source / author                                                                                                                                           | Original file and edits                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| engine.wav          | [Racing car engine sound loops](https://opengameart.org/content/racing-car-engine-sound-loops), domasx2, public-domain source recording                   | loop_0.wav; mono, normalized, crossfaded loop. The author's update confirms the earlier sample was replaced with a public-domain recording.  |
| helicopter.wav      | [Helicopter Sounds](https://opengameart.org/content/helicopter-sounds), aquinn                                                                            | helicopter_0.mp3; 0.2-3.2 seconds, normalized, crossfaded loop.                                                                              |
| plane.wav           | [Propeller plane](https://freesound.org/people/Breviceps/sounds/515293/), Breviceps                                                                       | Public HQ MP3 preview, 12-16 seconds; mono, normalized, crossfaded loop.                                                                     |
| skid.wav            | [Tire squeal](https://bigsoundbank.com/tire-squeal-s0500.html), Joseph SARDIN                                                                             | 0500.mp3, 4-5.5 seconds; normalized, crossfaded loop.                                                                                        |
| pistol.wav, smg.wav | [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library), Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew Nanney | Prepared SFX Library: 1911/A_34P.wav (1-1.8 seconds), Carl Gustav M45/G_20P.wav (first 0.4 seconds); silence trimmed, normalized, tail fade. |
| punch.wav, bat.wav  | [37 hits/punches](https://opengameart.org/node/2558), Independent.nu, submitted by qubodup                                                                | hits/hit01.mp3.flac and hits/hit04.mp3.flac; short trimmed impacts, normalized, tail fade.                                                   |
| impact.wav          | [Metal Impact Sounds](https://opengameart.org/content/metal-impact-sounds), Brian MacIntosh / BMacZero                                                    | thud2.wav; normalized, trimmed, tail fade.                                                                                                   |
| explosion.wav       | [Explosions](https://opengameart.org/content/explosions-4), EZduzziteh                                                                                    | explosion1_0.ogg; first 2.5 seconds, normalized, tail fade.                                                                                  |
| reload.wav          | [Gun reload sounds](https://opengameart.org/content/gun-reload-sounds), SpringySpringo                                                                    | gunreload1.wav; first 1.4 seconds, silence trimmed, normalized, tail fade.                                                                   |

License: [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/). These credits preserve provenance even though the selected licenses do not require attribution. CC-BY and CC-BY-SA alternatives found during research were not included.

## Reproduce

The edited WAV files are checked in; running the game never needs FFmpeg or original downloads. To prepare replacements, download the originals from these pages into a source directory, with names `engine.wav`, `helicopter.mp3`, `plane.mp3`, `skid.mp3`, `impact.wav`, `explosion.ogg`, and `reload.wav`. Extract only the four listed firearm/punch files into `selected/` using their base filenames. `source-hashes.json` records SHA-256 of originals/archives used in this revision.

```sh
bun run audio:prepare --source-dir /path/to/originals
```

The manual script uses the development-only `ffmpeg-static` dependency, converts to mono 44.1 kHz PCM, adjusts loudness, and crossfades loop boundaries. Runtime uses Web Audio buffer sources, speed-based playback rate, smooth gains, stereo panning/distance attenuation, six vehicle loops plus a local skid loop, and at most 32 one-shot voices. M mutes the master mix. Playback starts only after a join/pointer gesture; failed clips are reported without blocking gameplay.
