# Sound inventory

The library replaces all eleven previous WAVs with 108 edited CC0 clips across 33 sound banks. Every bank has at least two takes. Sources, author credits, and reproduction instructions are in [audio credits](../public/audio/CREDITS.md). `/audio.html` is an explicit listening page and uses the gameplay engine.

## Shipped sounds

| Bank         | Takes | Trigger                                       | Variation or behavior                                           |
| ------------ | ----: | --------------------------------------------- | --------------------------------------------------------------- |
| engineSedan  |     2 | Active sedan                                  | Separate car recordings; speed controls pitch                   |
| engineSport  |     2 | Active sport car                              | Separate steady AC Cobra excerpts; speed controls pitch         |
| engineVan    |     2 | Active van                                    | Separate truck and diesel recordings; speed controls pitch      |
| helicopter   |     3 | Active helicopter                             | Different recording sections; lower pitch during takeoff        |
| plane        |     3 | Active plane                                  | Different flyby sections; speed controls pitch                  |
| skid         |     3 | Nearby skidding car                           | Different tyre squeals; speed controls intensity                |
| pistol       |     3 | Authoritative pistol shot                     | Different Walther PPQ shots; ±0.6 semitones                     |
| smg          |     3 | Authoritative SMG shot                        | Different M45 shots; ±0.6 semitones                             |
| reloadPistol |     2 | Confirmed pistol reload starts                | Different gun-loading recordings; ±0.35 semitones               |
| reloadSmg    |     2 | Confirmed SMG reload starts                   | Different rifle and gun-loading recordings; ±0.35 semitones     |
| dryFire      |     3 | Empty gun with no reserve                     | Mechanical foley; limited by weapon cooldown                    |
| swing        |     3 | Authoritative melee attempt, including misses | Air and cloth foley; ±1.5 semitones                             |
| punch        |     5 | Fist connects with a character                | Medium punch takes; ±1.4 semitones                              |
| bat          |     5 | Bat connects with a character                 | Heavy punch takes; ±1.2 semitones                               |
| impact       |     5 | Vehicle crash, metal prop hit or break        | Metal impacts; ±1.8 semitones                                   |
| impactWood   |     5 | Tree, palm, or bench hit or break             | Wood impacts; ±1.5 semitones                                    |
| impactBody   |     5 | Bullet hits a character; local health falls   | Soft impacts; ±1.2 semitones                                    |
| explosion    |     3 | Authoritative vehicle explosion               | Separate recordings; audible within 110 m                       |
| footConcrete |     5 | Grounded character walks outside a park       | Distance-based steps; ±1 semitone                               |
| footGrass    |     5 | Grounded character walks in a park            | Distance-based steps; ±1 semitone                               |
| landing      |     3 | Confirmed parachute closes on landing         | Soft contact foley; ±1 semitone                                 |
| door         |     3 | Confirmed vehicle entry or exit               | Actual car door closures for every vehicle type                 |
| pickup       |     3 | Local inventory receives an item              | Quiet confirmation cues                                         |
| drop         |     3 | Local inventory loses an item while alive     | Light metal contact foley                                       |
| equip        |     3 | Local equipped weapon changes                 | Knife-draw handling foley                                       |
| parachute    |     3 | Confirmed parachute opens                     | Cloth foley                                                     |
| death        |     3 | Local health reaches zero                     | Quiet interface cue; no voice recording                         |
| respawn      |     3 | Local health recovers from zero               | Quiet interface cue; inventory reset stays silent               |
| ui           |     3 | Map or help toggles                           | Quiet click samples                                             |
| fire         |     3 | Nearby vehicle burns                          | Gasoline fire excerpts; fades on extinguish or explosion        |
| wind         |     3 | Local parachute descent                       | Wind recordings; descent speed controls intensity               |
| water        |     3 | Server reports broken hydrant debris          | Fountain excerpts; nearest two hydrants, removed on restoration |
| coast        |     3 | Player approaches island edge                 | Waves fade in beyond 690 m on either axis                       |

## Engine behavior

`client/audio/banks.ts` owns the banks and their pitch, gain, range, cooldown, and voice limits. `GameAudio` loads and decodes each unique file once after a user gesture. A missing file reduces that bank's available pool; an unavailable bank stays silent and appears in diagnostics. Gameplay continues when Web Audio is unavailable.

Selection excludes the previous take whenever another decoded take exists. Each play varies pitch in semitones, gain by up to 12%, and a low-pass cutoff between 14.5 and 18 kHz. Engine audio follows drivers and traffic AI; pushed, unoccupied cars and planes stay silent. Helicopter audio follows rotor animation, including quieter, slower unpiloted rotor motion during a fall. Grounded helicopters and wrecks stay silent. Each vehicle keeps its chosen take for the loop's lifetime. Random loop offsets prevent nearby engines from synchronizing. Playback rate, gain, and panning change smoothly.

Three-dimensional distance attenuates each spatial sound. Vehicle and ambient loops also lose high frequencies with distance. Stereo panning follows the world X axis, matching the fixed follow camera. It does not track development-camera orientation. There is no wall occlusion or Doppler effect.

The mixer limits one-shots to 32 and caps voices per bank. Quiet cues stop consuming new voices at 24, leaving room for combat. Cooldowns suppress repeated contacts at the same location without muting simultaneous shooters elsewhere. At most six active nearby vehicles produce engine, skid, and fire loops. Wind, coast, and the nearest two broken hydrants add at most four more loops. A master compressor reduces stacked transients. N smoothly mutes the master mix and stops loops; unmuting resumes current loop sources without replaying missed actions. Disconnects clear loops and snapshot history.

Combat sounds come from server events. Inventory, boarding, reload, parachute, and life-state cues compare consecutive confirmed snapshots. Joining and reconnecting do not replay past transitions. Footsteps use rendered travel distance as cosmetic feedback and never decide a gameplay result. Sprinting changes cadence rather than requiring another recording bank.

## Research decisions and remaining sounds

The existing single clips had no alternate takes. Swing, prop-break, handling, footsteps, fire, water, and parachute actions were silent or shared unrelated impacts. The former racing-car loop pack described its alternates as pitch-only copies. The replacement uses separate recordings or different recorded events, with runtime property variation in addition to sample selection. The selected handgun and SMG source takes avoid the full-scale peaks in other prepared firearm files.

Kenney's CC0 packs cover the short actions without another runtime dependency. Longer licensed recordings cover engines, aircraft, water, fire, and coast. The CC-BY footsteps pack was considered and excluded to keep a single asset license.

| Additional sound                                          | When it becomes necessary                                                                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Sand, gravel, and distinct roof footsteps                 | When those surface materials have explicit contact classification; current footsteps distinguish parks from other ground     |
| Car engine start, shutdown, idle, and loaded RPM layers   | When vehicle ignition and RPM become modeled state; current loops derive pitch from speed                                    |
| Aircraft doors, rotor startup and shutdown, canopy snap   | When replacing the documented boarding and cloth proxies with dedicated recordings                                           |
| Pedestrian speech, pain, and panic calls                  | When characters have a defined voice direction and voice budget; current damage uses impact feedback                         |
| Birds, insects, and district ambience                     | When districts have authored ambient zones and time-of-day schedules; current ambience covers coast and parachute wind       |
| Horns and reverse alarms                                  | When gameplay supports those actions; do not play warning sounds without a corresponding vehicle signal                      |
| Swimming, splashes, rain, thunder, and wind on trees      | When water movement or weather exists                                                                                        |
| Building glass, interiors, footsteps on stairs, and doors | When those objects can interact or be destroyed; current building facades are static                                         |
| Grenades                                                  | Pin pull, throw, surface bounces, and explosion when grenade gameplay lands; reuse impact and explosion banks where suitable |
| Knives and machine guns                                   | Dedicated swings, contact, shot, reload, and dry-fire banks when those weapons arrive                                        |
| Flamethrowers                                             | Ignition, flame roar, and extinguish when fuel and damage are authoritative                                                  |
| Jetpacks                                                  | Ignition, idle, thrust, and shutdown when jetpack state exists                                                               |
| Boats, jet skis, and speedboats                           | Model-specific motors, wake and spray, hull contacts, and boarding when navigable water exists                               |
| Police sirens, missions, alerts, and music                | When those game systems exist; they are not inferred from traffic or the city clock                                          |

Field-recorded loops are edited excerpts, not multi-layer studio engine recordings. Some source textures and foley proxies may need art direction after listening. Pitch variation stays within each bank's range to preserve the action's identity. The current attenuation and compressor do not guarantee a pleasing mix on every audio device.

## Verification

`bun run test` checks every shipped WAV, exact manifest coverage, alternate-file uniqueness, peak headroom, audible energy, clip fades, and loop seams. It also checks randomized selection, partial-bank availability, confirmed transitions, missed swings, and rate-limited empty triggers. `bun run build` builds both the game and listening page.

The browser check decodes the real assets, plays the same engine, exercises loop lifecycle and mute, and checks playback diagnostics. A live game session confirmed pickup, authoritative pistol shots, reload, and N muting and resuming vehicle loops. Headless browser rendering can prove that audio produces a valid signal; it cannot replace listening on real speakers or headphones.

The full suite currently reports 107 passing tests and one existing debug transport failure. The same failure reproduces on the unchanged `3f500a0` baseline. The targeted audio and combat tests pass; build, formatting, types, and import boundaries pass. [Headless browser evidence](audio-browser-check.json) records the decoding and mixer checks.
