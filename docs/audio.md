# Sound inventory

The library contains 149 edited CC0 clips across 53 sound banks. Every bank has at least two takes. Sources, author credits, and reproduction instructions are in [audio credits](../public/audio/CREDITS.md).

## Shipped sounds

| Bank         | Takes | Trigger                                       | Variation or behavior                                                                                                                           |
| ------------ | ----: | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| engineSedan  |     2 | Active sedan                                  | Separate car recordings; speed controls pitch                                                                                                   |
| engineSport  |     2 | Active sport car                              | Separate steady AC Cobra excerpts; speed controls pitch                                                                                         |
| engineVan    |     2 | Active van                                    | Separate truck and diesel recordings; speed controls pitch                                                                                      |
| horn         |     2 | AI traffic blocked for eight seconds          | Two car recordings; repeats every six seconds; audible within 50 m                                                                              |
| helicopter   |     3 | Active helicopter                             | Different recording sections; lower pitch during takeoff                                                                                        |
| plane        |     3 | Active plane                                  | Different flyby sections; speed controls pitch                                                                                                  |
| skid         |     3 | Nearby skidding car                           | Different tyre squeals; speed controls intensity                                                                                                |
| pistol       |     3 | Authoritative pistol shot                     | Different Walther PPQ shots; ±0.6 semitones                                                                                                     |
| smg          |     3 | Authoritative SMG shot                        | Different M45 shots; ±0.6 semitones                                                                                                             |
| reloadPistol |     2 | Confirmed pistol reload starts                | Different gun-loading recordings; ±0.35 semitones                                                                                               |
| reloadSmg    |     2 | Confirmed SMG reload starts                   | Different rifle and gun-loading recordings; ±0.35 semitones                                                                                     |
| dryFire      |     3 | Empty gun with no reserve                     | Recorded Taurus trigger pulls; limited by weapon cooldown                                                                                       |
| swing        |     3 | Authoritative melee attempt, including misses | Air and cloth foley; ±1.5 semitones                                                                                                             |
| punch        |     5 | Fist connects with a character                | Medium punch takes; ±1.4 semitones                                                                                                              |
| bat          |     5 | Bat connects with a character                 | Heavy punch takes; ±1.2 semitones                                                                                                               |
| impact       |     5 | Vehicle crash, metal prop hit or break        | Metal impacts; ±1.8 semitones                                                                                                                   |
| impactWood   |     5 | Tree, palm, or bench hit or break             | Wood impacts; ±1.5 semitones                                                                                                                    |
| impactBody   |     5 | Bullet hits a character; local health falls   | Soft impacts; ±1.2 semitones                                                                                                                    |
| explosion    |     3 | Authoritative vehicle explosion               | Separate recordings; audible within 85 m                                                                                                        |
| footConcrete |     5 | Grounded character walks outside a park       | Distance-based steps; ±1 semitone                                                                                                               |
| footGrass    |     5 | Grounded character walks in a park            | Distance-based steps; ±1 semitone                                                                                                               |
| landing      |     3 | Confirmed parachute closes on landing         | Soft contact foley; ±1 semitone                                                                                                                 |
| door         |     3 | Confirmed vehicle entry or exit               | Actual car door closures for every vehicle type                                                                                                 |
| pickup       |     3 | Local inventory receives an item              | Quiet confirmation cues                                                                                                                         |
| drop         |     3 | Local inventory loses an item while alive     | Light metal contact foley                                                                                                                       |
| equip        |     3 | Local melee weapon or fists selection         | Knife-draw handling foley                                                                                                                       |
| equipGun     |     3 | Local pistol or SMG selection                 | Recorded gun handling; ±0.6 semitones                                                                                                           |
| parachute    |     3 | Confirmed parachute opens                     | Purpose-built deployment foley from two creators                                                                                                |
| death        |     3 | Local health reaches zero                     | Quiet interface cue; no voice recording                                                                                                         |
| respawn      |     3 | Local health recovers from zero               | Quiet interface cue; inventory reset stays silent                                                                                               |
| ui           |     3 | Map or help toggles                           | Quiet click samples                                                                                                                             |
| fire         |     3 | Nearby vehicle burns                          | Gasoline fire excerpts; fades on extinguish or explosion                                                                                        |
| wind         |     3 | Local parachute descent                       | Wind recordings; descent speed controls intensity                                                                                               |
| jetpack      |     3 | Active powered jetpack movement               | Reuses wind takes; spatial attenuation within 28 m                                                                                              |
| canopy       |     3 | Local parachute descent                       | Quiet fabric flutter; stops when the canopy closes                                                                                              |
| water        |     3 | Server reports broken hydrant debris          | Pressurized pipe-leak excerpts; nearest two hydrants, removed on restoration                                                                    |
| coast        |     3 | Player near or in sea or lake water           | Full volume while swimming; within 35 m of water (counting height above it) fades from a quarter to silence; silent elsewhere (`surfIntensity`) |

## Engine behavior

`client/audio/banks.ts` owns the banks and their pitch, gain, range, cooldown, and voice limits. `GameAudio` loads and decodes each unique file once after a user gesture. A missing file reduces that bank's available pool; an unavailable bank stays silent and appears in diagnostics. Gameplay continues when Web Audio is unavailable.

Selection excludes the previous take whenever another decoded take exists. Each play varies pitch in semitones, gain by up to 12%, and a low-pass cutoff between 14.5 and 18 kHz. Engine audio follows powered drivers and traffic AI; pushed, unoccupied vehicles stay silent. Helicopter audio runs only during powered takeoff, cruising, or landing. Grounded helicopters, abandoned windmilling rotors, and wrecks stay silent. Each vehicle keeps its chosen take for the loop's lifetime. Random loop offsets prevent nearby engines from synchronizing. Playback rate, gain, and panning change smoothly. Drifting uses two independently selected and detuned tyre takes: a brighter squeal and a quieter filtered road-scrub layer. Sideways velocity, road speed, and the number of slipping wheels continuously shape their gain, pitch, and tone; release tails prevent chatter when grip returns.

Three-dimensional distance attenuates each spatial sound, and nothing plays at or beyond its bank's `range`. Gain falls as (1 - distance / range)^2, so a sound is practically silent well before its range: engines, tyres, fire and foley fade out within about 30 m (ranges 20 to 42 m), helicopters, planes and horns within about 45 m (50 to 60 m), gunfire within about 55 m (60 to 65 m) and car explosions within about 75 m (85 m). `tests/audio.test.ts` fails if any bank becomes audible beyond its tier. A range of zero marks a cue for the listener alone (interface, inventory, own life state, own parachute and coast ambience) and is never played for a source more than three metres from the listener, so another player's equip, pickup or respawn can never be heard. Vehicles beyond the longest loop range (60 m) are not mixed at all. Engines used to carry 55 to 80 m, so two or three cars at a junction produced a dozen overlapping layers. Vehicle and ambient loops also lose high frequencies with distance. Stereo panning follows the camera's horizontal right vector, including development cameras. Vehicle loops use bounded Doppler from rendered relative radial velocity; occupants hear their own motor without Doppler. Distance stays anchored to the player. There is no wall occlusion.

The mixer limits one-shots to 32 and caps voices per bank. Quiet cues stop consuming new voices at 24, leaving room for combat. Cooldowns suppress repeated contacts at the same location without muting simultaneous shooters elsewhere. At most six active nearby vehicles produce sound. Two vehicles within 30 m get full layers, with the player's vehicle taking priority and always keeping its detailed mix; distant motors use a single loop. All vehicle and ambient sources share a 32-active-loop cap, with short release tails before disconnection. Wind, canopy flutter, coast, hydrants, jetpacks and flamethrowers share that budget. A master compressor reduces stacked transients. N smoothly mutes the master mix and stops loops; unmuting resumes current sources without replaying missed actions. Disconnects clear loops and snapshot history.

## Vehicle mixer and listening demos

`client/audio/vehicles.ts` estimates load from local driver input or remote acceleration. Smoothed revs and hysteretic cosmetic gears drive overlapping idle/middle/high bands plus an unloaded layer. Sources retain their take while band weights change, including at zero gain, to avoid restarting recordings at every throttle change. Estimated shifts briefly dip pitch and gain. Vehicle health softens the motor tone. These estimates never feed gameplay or alter snapshots. Only confirmed car power transitions play ignition/shutdown cues; first visibility and reconnects do not replay them.

The upgrade adds 33 clips in 16 banks: `sedanIdle/High/Coast`, `sportIdle/High/Coast`, `vanIdle/High/Coast` (two takes each); `tyreSqueal` (three); `tyreOnset`, `boatMotor`, `jetskiMotor`, `wake`, `engineStart` and `engineStop` (two each). The existing car banks provide middle bands and simpler distant motors. The old `skid` clips now supply quiet filtered scrub underneath the longer dedicated tyre screeches.

The listening page offers three 16-second scenarios for each vehicle: idle/acceleration/coast, sustained slip/recovery (powered turns for other kinds), and a spatial drive-by. Stop, changing selections, leaving the page or hiding the tab cancels playback. The demos create isolated audio inputs and do not connect to or modify server gameplay.

New sources are Dorian CLAIR's three CC0 tyre screeches, XiiiSamples' idling car, wjauch's Sea-Doo and nomadas' outboard boat. Existing petrol/diesel recordings provide additional band excerpts. These are field-recording textures, not calibrated recordings of measured RPM/load. Coasting uses quieter idle/steady excerpts; aircraft use a second filtered take from their existing bank rather than separately isolated turbine/rotor recordings. Shared car ignition cues remain a temporary family proxy. Boat originals include water and some distant voices; only short engine-dominant sections are used. This mix needs speaker/headphone listening before subjective acceptance.

Paid candidates remain [Pole Position's Skids & Screeches](https://pole.se/product/skids-screeches-tarmac-library/) and individual car libraries. They were not purchased or incorporated. [Sonniss bundles](https://sonniss.com/gdc-bundle-license/) permit game use but restrict standalone redistribution, so their raw assets should not go in this public repository without suitable permission. Shipped additions remain CC0, with provenance, recipes and source hashes.

Combat sounds come from server events. Inventory, boarding, reload, parachute, and life-state cues compare consecutive confirmed snapshots. Joining and reconnecting do not replay past transitions. Footsteps use rendered travel distance as cosmetic feedback and never decide a gameplay result. Sprinting changes cadence rather than requiring another recording bank.

## Research decisions and remaining sounds

The existing single clips had no alternate takes. Swing, prop-break, handling, footsteps, fire, water, and parachute actions were silent or shared unrelated impacts. The former racing-car loop pack described its alternates as pitch-only copies. The replacement uses separate recordings or different recorded events, with runtime property variation in addition to sample selection. The selected handgun and SMG source takes avoid the full-scale peaks in other prepared firearm files.

The follow-up source audit checked all 31 pages used by the current library. [Machine-readable provenance](../public/audio/sources.json) maps every downloaded original or archive member to its author, CC0 declaration, and source page. Tests require that this inventory exactly covers the source hashes.

The new recordings replace nine clips for dry fire, parachute deployment, and hydrant water. Six more clips add firearm handling and canopy flutter. Deployment recordings are designed foley made with coats, pants, and ropes, rather than recordings from a real jump. The canopy loops use hand-moved fabric recorded as flag flutter. Hydrants use a large leaking pipe.

Research excluded the CC-BY close-combat bat pack. CC0 sports-bat recordings contact balls, floors, or metal, so the existing heavy body-impact takes remain more suitable for character contact. A gun-handling upload marked CC0 also claimed material from Hollywoodedge, so it was excluded in favor of danhelbling's handling recording. No suitable dedicated CC0 cockpit-door recording was found; boarding retains the documented car-door proxy.

Kenney's CC0 packs cover the short actions without another runtime dependency. Longer licensed recordings cover engines, aircraft, water, fire, and coast. The CC-BY footsteps pack was considered and excluded to keep a single asset license.

| Additional sound                                           | When it becomes necessary                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Sand, gravel, and distinct roof footsteps                  | When those surface materials have explicit contact classification; current footsteps distinguish parks from other ground |
| Calibrated car RPM/load layers and model-specific ignition | Current bands and gears are cosmetic estimates; ignition uses shared car excerpts                                        |
| Aircraft doors, rotor startup and shutdown                 | When replacing car-door boarding proxies and adding separate rotor start or stop cues                                    |
| Pedestrian speech, pain, and panic calls                   | When characters have a defined voice direction and voice budget; current damage uses impact feedback                     |
| Birds, insects, and district ambience                      | When districts have authored ambient zones and time-of-day schedules; current ambience covers coast and parachute wind   |
| Horns and reverse alarms                                   | When gameplay supports those actions; do not play warning sounds without a corresponding vehicle signal                  |
| Swimming, splashes, rain, thunder, and wind on trees       | When water movement or weather exists                                                                                    |
| Building glass, interiors, footsteps on stairs, and doors  | When those objects can interact or be destroyed; current building facades are static                                     |
| Grenades                                                   | Dedicated pin-pull and bounce foley; explosions currently reuse the explosion bank                                       |
| Knives and machine guns                                    | Dedicated swings, contact, shot, reload, and dry-fire banks beyond the current melee and SMG proxies                     |
| Flamethrowers                                              | Ignition, flame roar, and extinguish beyond the current fire-loop proxy                                                  |
| Jetpacks                                                   | Ignition, idle, thrust, and shutdown beyond the current finite-range wind proxy                                          |
| Watercraft hull contacts, boarding and more motor families | Boats share outboard recordings, jet skis have a dedicated motor, and wake uses recorded water                           |
| Police sirens, missions, alerts, and music                 | When those game systems exist; they are not inferred from traffic or the city clock                                      |

Field-recorded loops are edited excerpts, not multi-layer studio engine recordings. Some source textures and foley proxies may need art direction after listening. Pitch variation stays within each bank's range to preserve the action's identity. The current attenuation and compressor do not guarantee a pleasing mix on every audio device.

## Verification

`bun run test` checks every shipped WAV, exact manifest coverage, alternate-file uniqueness, peak headroom, audible energy, clip fades, and loop seams. It also checks randomized selection, partial-bank availability, confirmed transitions, missed swings, and rate-limited empty triggers. `bun run build` builds both the game and listening page.

The browser check decodes the real assets, plays the same engine, exercises loop lifecycle and mute, and checks playback diagnostics. A live game session confirmed pickup, authoritative pistol shots, reload, and N muting and resuming vehicle loops. Headless browser rendering can prove that audio produces a valid signal; it cannot replace listening on real speakers or headphones.

The integrated gameplay suite passes all 153 tests, formatting, types, boundaries, and the production build in [CI](https://github.com/michidk/afterhours/actions/runs/38181999709). Before the horn additions, the user confirmed real-device listening on 2026-10-11: "I listened; no adjustments needed." No recording or mix changes were requested. This acceptance is separate from the automated signal checks and does not certify every audio device.
The two traffic-horn recordings were also decoded and played through the sound-library UI in the shared T3 browser on 2026-10-12, with no console errors. Their real-speaker mix has not been reviewed.
