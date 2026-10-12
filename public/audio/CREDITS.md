# Audio sources and preparation

The shipped library uses CC0 1.0 recordings and samples. The previous eleven single-file sounds have been retired. Runtime playback uses local files and Web Audio, with no oscillator fallback or third-party streaming.

## Source inventory

| Source                                                                                                                                                                                      | Author                                                  | Files used                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [Impact Sounds](https://kenney.nl/assets/impact-sounds)                                                                                                                                     | Kenney                                                  | Concrete and grass footsteps; medium and heavy punches; heavy metal, wood, and soft impacts; soft landings; light metal drops |
| [RPG Audio](https://kenney.nl/assets/rpg-audio)                                                                                                                                             | Kenney                                                  | Knife slices and cloth movement for swings; knife draws for melee handling                                                    |
| [Interface Sounds](https://kenney.nl/assets/interface-sounds)                                                                                                                               | Kenney                                                  | Confirmation, click, close, and open cues for pickup, menus, death, and respawn                                               |
| [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library)                                                                                            | Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew Nanney | Walther PPQ X_39P.wav and Carl Gustav M45 G_31P.wav takes from the Prepared SFX Library archive                               |
| [Helicopter Sounds](https://opengameart.org/content/helicopter-sounds)                                                                                                                      | aquinn                                                  | helicopter_0.mp3, separate 5–9, 14–18, and 24–28 second excerpts                                                              |
| [Propeller plane](https://freesound.org/people/Breviceps/sounds/515293/)                                                                                                                    | Breviceps                                               | Public HQ MP3 preview, separate 8–11, 16–19, and 20–23 second excerpts                                                        |
| [Tire squeal](https://bigsoundbank.com/tire-squeal-s0500.html)                                                                                                                              | Joseph SARDIN                                           | 0500.mp3, separate squeals at 0.35, 7.05, and 17.9 seconds                                                                    |
| [Car engine #2](https://bigsoundbank.com/car-engine-2-s0291.html), [Motor car #1](https://bigsoundbank.com/motor-car-1-s0290.html)                                                          | Joseph SARDIN                                           | 0291.mp3 and 0290.mp3, sedan loops                                                                                            |
| [AC Cobra engine](https://bigsoundbank.com/ac-cobra-engine-s0534.html)                                                                                                                      | Joseph SARDIN                                           | 0534.mp3, separate steady engine sections for sport loops                                                                     |
| [Truck engine](https://bigsoundbank.com/truck-engine-s1145.html), [Big diesel engine](https://bigsoundbank.com/big-diesel-engine-s0967.html)                                                | Joseph SARDIN                                           | 1145.mp3 and 0967.mp3, van loops                                                                                              |
| [Car door #4](https://bigsoundbank.com/car-door-4-s1526.html), [Car door #3](https://bigsoundbank.com/car-door-3-s1524.html), [Car door #2](https://bigsoundbank.com/car-door-2-s1276.html) | Joseph SARDIN                                           | 1526.mp3, 1524.mp3, and 1276.mp3, short door closures                                                                         |
| [Gun loading #1](https://bigsoundbank.com/gun-loading-1-s1988.html), [Gun loading #2](https://bigsoundbank.com/gun-loading-2-s1989.html)                                                    | Joseph SARDIN                                           | 1988.mp3 and 1989.mp3, pistol and SMG handling                                                                                |
| [Gun reload sounds](https://opengameart.org/content/gun-reload-sounds)                                                                                                                      | SpringySpringo                                          | assaultriflereload1_0.wav, SMG handling                                                                                       |
| [Explosions](https://opengameart.org/content/explosions-4)                                                                                                                                  | EZduzziteh                                              | explosion2.ogg, explosion3.ogg, and explosions4.ogg                                                                           |
| [Wind](https://opengameart.org/content/wind)                                                                                                                                                | IgnasD                                                  | Wind.ogg, Wind2.ogg, and Wind3.ogg                                                                                            |
| [Gasoline fire #2](https://bigsoundbank.com/gasoline-fire-2-s1341.html)                                                                                                                     | Joseph SARDIN                                           | 1341.mp3, separate 3–7, 9–13, and 17–21 second excerpts                                                                       |
| [Big water leak](https://bigsoundbank.com/big-water-leak-s0702.html)                                                                                                                        | Joseph SARDIN                                           | 0702.mp3, separate pressurized pipe-leak excerpts for broken hydrants                                                         |
| [Beach: Small waves](https://bigsoundbank.com/beach-small-waves-s0265.html)                                                                                                                 | Joseph SARDIN                                           | 0265.mp3, separate coastal excerpts                                                                                           |
| [Taurus G2c Dry Trigger Pull](https://freesound.org/people/NoonerBear/sounds/589848/)                                                                                                       | NoonerBear                                              | HQ MP3 preview, separate trigger pulls at 0.04, 1.8, and 3.7 seconds                                                          |
| [Gun Handling](https://freesound.org/people/danhelbling/sounds/272394/)                                                                                                                     | danhelbling                                             | HQ MP3 preview, separate handling events at 0.95, 2.7, and 4.85 seconds                                                       |
| [Parachute Opening 2 Options](https://freesound.org/people/2create/sounds/620310/), [Parachute Opening](https://freesound.org/people/EugeneEverett/sounds/596522/)                          | 2create, EugeneEverett                                  | Two coat-based deployment takes and one rope-and-pants deployment take                                                        |
| [Flag in the wind #1](https://bigsoundbank.com/flag-in-the-wind-1-s1632.html), [Flag in the wind #2](https://bigsoundbank.com/flag-in-the-wind-2-s1633.html)                                | Joseph SARDIN                                           | 1632.mp3 and 1633.mp3, separate hand-moved fabric excerpts for canopy flutter                                                 |

License: [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/). Source pages and the Kenney archives identify their CC0 licenses. Credits retain provenance even though attribution is optional. Research checked these pages on 2026-10-11. The CC-BY footsteps pack was excluded; the former racing-engine pack was excluded because its alternate files differ only in pitch.

The [source catalog](sources.json) records the checked license text, page, author, and filenames for all 29 source pages and 90 originals or archive members. The source hashes identify the downloaded files. Freesound files use the publicly downloadable HQ previews, which retain the recording's CC0 license.

Some sounds are foley substitutions: coats and rope simulate parachute deployment, fabric movement simulates canopy flutter, knife draws simulate melee handling, a pipe leak simulates hydrant spray, and car doors simulate boarding all vehicle types. Death and respawn use interface cues rather than voice recordings. These are identified in the [sound inventory](../../docs/audio.md).

## Reproduce the assets

Download the linked originals into a source directory. Download and extract the three Kenney packs under `impact-sounds/`, `rpg-audio/`, and `interface-sounds/`. Extract the firearm archive under `firearms/`, retaining its `Prepared SFX Library/` directory. Extract wind.zip under `wind/`, retaining its inner `wind/` directory.

Use these filenames for individual downloads:

| Download                                                 | Local filename                                             |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| 0291.mp3 / 0290.mp3 / 0534.mp3                           | engine-sedan.mp3 / engine-sedan-alt.mp3 / engine-sport.mp3 |
| 1145.mp3 / 0967.mp3                                      | engine-van.mp3 / engine-van-alt.mp3                        |
| helicopter_0.mp3 / propeller plane HQ preview / 0500.mp3 | helicopter.mp3 / plane.mp3 / skid.mp3                      |
| 1526.mp3 / 1524.mp3 / 1276.mp3                           | door1.mp3 / door2.mp3 / door3.mp3                          |
| 1988.mp3 / 1989.mp3 / assaultriflereload1_0.wav          | reload1.mp3 / reload2.mp3 / reload-rifle.wav               |
| 1341.mp3 / 0702.mp3 / 0265.mp3                           | fire.mp3 / water-leak.mp3 / coast.mp3                      |
| explosion2.ogg / explosion3.ogg / explosions4.ogg        | explosion2.ogg / explosion3.ogg / explosion4.ogg           |

Additional direct downloads for the follow-up recordings:

| Download                                                                                | Local filename      |
| --------------------------------------------------------------------------------------- | ------------------- |
| [Taurus trigger HQ MP3](https://cdn.freesound.org/previews/589/589848_3670066-hq.mp3)   | dry-fire-taurus.mp3 |
| [Gun handling HQ MP3](https://cdn.freesound.org/previews/272/272394_4783367-hq.mp3)     | gun-handling.mp3    |
| [Coat deployment HQ MP3](https://cdn.freesound.org/previews/620/620310_621042-hq.mp3)   | parachute-coat.mp3  |
| [Rope deployment HQ MP3](https://cdn.freesound.org/previews/596/596522_10974703-hq.mp3) | parachute-rope.mp3  |
| [Pipe leak MP3](https://bigsoundbank.com/UPLOAD/mp3/0702.mp3)                           | water-leak.mp3      |
| [Fabric flutter #1 MP3](https://bigsoundbank.com/UPLOAD/mp3/1632.mp3)                   | canopy1.mp3         |
| [Fabric flutter #2 MP3](https://bigsoundbank.com/UPLOAD/mp3/1633.mp3)                   | canopy2.mp3         |

The [clip recipes](../../scripts/audio-clips.json) specify every source filename and trim. `source-hashes.json` records SHA-256 of the actual source files, including archive members. Compare these hashes when reproducing this revision.

```sh
bun run audio:prepare --source-dir /path/to/originals
```

The manual script uses the installed development-only FFmpeg, converts to mono 44.1 kHz 16-bit PCM, removes DC and leading silence, applies short edge fades, and crossfades loop seams. Gain targets an RMS level with a hard peak ceiling of 0.5, leaving at least 6 dB of sample headroom. It writes the WAV files, hashes, and sound-bank manifest. The game never runs this script or downloads originals.

Open `/audio.html` for the listening page, which uses the same `GameAudio` engine as gameplay. N toggles sound in the game.

Traffic horns use Joseph SARDIN’s [Recent car horn #2](https://bigsoundbank.com/recent-car-horn-2-s0258.html) and [Recent car horn #1](https://bigsoundbank.com/recent-car-horn-1-s0257.html), both CC0. Source files are `horn-0258.mp3` and `horn-0257.mp3`, downloaded from the corresponding `/UPLOAD/mp3/` URLs on BigSoundBank. License text verified on 2026-10-12. Recipes, original hashes and page evidence are included in the normal audio manifests.
