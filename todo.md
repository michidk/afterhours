# AFTERHOURS todo

Read [AGENTS.md](AGENTS.md) for backlog maintenance. Always update this file with related code changes and verified results. `PLAN.md` is retired.

The original audit used `c2da9ed` after pulling `origin/main`. The dictated "chatpack", "Chetsky", and "M gees" mean jetpack, jet skis, and machine guns. Corpses and vehicle wrecks use three-minute timers.

## Gameplay implementation

- [x] Temporary destructible plants, benches, lamps, signals, and hydrants. Server-owned debris lasts 30 seconds, fades, and restores fixtures at their original positions once clear. Hydrants spray until restoration. The saved city is unchanged. See [destruction](docs/destruction.md).
- [x] Three-minute corpses and wrecks with independent player recovery after three seconds and NPC recovery after 30 seconds. Water and rooftop corpses retain valid altitude. Saturation retains all corpse snapshots within a 128-body physical budget; retired airborne bodies settle instead of hanging. See [lifecycle tests](tests/destruction.test.ts).
- [x] Chosen overhead player names, including riders. Labels use plain text, follow projected seat poses, and clear on disconnect, reconnect, death, or view loss. Unit tests and headless browser join, seated-name, and disconnect checks pass. See [nameplates](tests/nameplates.test.ts).
- [x] Shared client collision prediction and server reconciliation. Prediction replays unacknowledged inputs and solves static and dynamic contacts without deciding damage or ownership. See [prediction tests](tests/prediction.test.ts).
- [x] Engine audio and powered rotor animation depend on actual propulsion, not movement from being pushed. Abandoned helicopters may windmill silently. Push, driver, shutdown, and wreck regressions pass. See [engine tests](tests/engine-audio.test.ts).
- [x] Model-dependent shared handling and multiple variants of every vehicle kind. Three cars, two helicopters, two planes, two boats, two jet skis, and two speedboats have normal saved-world placements. Aircraft tests cover acceleration, turning, braking, climb, descent, stalls, clearance, ditching, and prediction agreement. See [vehicle handling](docs/water.md).
- [x] Finite ammunition, reserves, reloads, tagged ammo supplies, retained surplus, and ammo-preserving drops. Compatible ammo can refill owned weapons even with four occupied slots. Supplies derive near existing pads at runtime and refill after 20 seconds. See [weapon tests](tests/weapons.test.ts).
- [x] Physical grenades with finite charges, a three-second server fuse, wall, roof, floor, rotated vehicle, and actor bounces. The thrower has a short collision grace period. Grenades render and disappear on detonation; blast damage hits occupants once and lethal hits release seats for recovery.
- [x] Distinct knife melee, machine-gun handling, and flamethrower fuel, cone damage, and occlusion. Every held weapon and supply has a model. Real browser firing and screenshots cover the new weapons and flame effects.
- [x] Jetpack pickup, separate equipment slot, B toggle, E thrust, Q descent, fuel, exhaust feedback, multiplayer snapshots, and shared prediction. G drops an active pack with remaining fuel. Empty packs return to parachute controls, and render extrapolation cannot spend replay fuel. Remote propulsion audio attenuates with distance. See [jetpack tests](tests/jetpack.test.ts).
- [x] Animated offshore water, shared bounds, swimming, and shore exits. Waves update mesh vertices and normals but do not change the flat authoritative water surface. See [water tests](tests/water.test.ts) and [renderer tests](tests/gameplay-render.test.ts).
- [x] Boats, jet skis, and speedboats with shared hull contacts, distinct tuning, seats, boarding, and driver-only controls. All six models agree between authority and prediction.
- [x] AI watercraft cruising bounded offshore routes. Three-minute progress tests cover all models; stealing the driver seat removes the AI route.
- [x] Panelled ram-air parachutes with alternating cells, twelve suspension lines, and a harness. Aircraft exits, rooftops, released jetpack thrust, and fuel exhaustion deploy automatically. Renderer tests and inspected browser screenshots verify the new canopy.
- [x] CI for formatting, import boundaries, types, tests, and production build. [Workflow](.github/workflows/ci.yml) is published. Tests run serially so real-time transport servers do not compete with CPU-heavy simulations.

## Integrated verification

- [ ] Complete the final transport browser pass and final full-suite rerun after review fixes. The earlier integrated suite passed 149 tests. The latest contact, corpse, renderer, engine, and codec checks passed 27 tests. Build, formatting, boundaries, and types pass.
- Browser checks run headless because the shared T3 browser has no automation host. [Rerunnable gameplay check](scripts/browser-gameplay-check.mjs) covers names, supplies, weapons, grenades, jetpack, parachute, watercraft, animated water, cruising AI, and aircraft controls. `--transport-only` repeats only transport checks.
- Protocol version is 3. Tagged supplies, thrown grenades, jetpack updates, and explicit equipment removal round-trip through the binary codec. Production debug tools remain opt-in and debug-disabled transport tests pass.
- `data/city.json` remains untouched. No automatic generation or permanent map writes were added.
- Under physics saturation, retired corpses use noninteractive ballistic settling before retaining a lying pose. They ignore walls, actors, and later impacts. Normal debris uses Rapier contacts.

## Audio replacement

- [x] Complete the follow-up CC0 source audit and integrate dedicated dry-fire, gun-handling, parachute-deployment, canopy-flutter, and pressurized-water recordings. Nine clips replace proxies and six add gun handling and canopy flutter, bringing the library to 114 clips across 35 banks. All 29 source pages explicitly identify CC0; [source provenance](public/audio/sources.json) covers all 90 downloaded originals or archive members and matches the hashes. Headless Chrome decoded every clip, played every bank, and verified confirmed equips and canopy start, mute, resume, landing, and cleanup.
- [x] Research and replace the eleven old clips with 108 CC0 clips across 33 sound banks. Each bank has alternate takes, no immediate sample repeat, and bounded pitch, gain, and tone variation. Add missing footsteps, handling, boarding, parachute, fire, water, coast, and life-state cues. See [inventory and future sounds](docs/audio.md), [source credits](public/audio/CREDITS.md), and the listening page at `/audio.html`.
- [x] Verify every clip's manifest coverage, distinct waveform, headroom, fades, and loop seam. Headless Chrome decoded all 108 files, played all 33 banks, measured a nonzero unclipped mix, and confirmed mute, resume, and cleanup. Listening-page screenshots covered 1280 and 390 px widths.
- [ ] Listen on real speakers or headphones and refine recording choices and the mix. Wall occlusion, layered RPM recordings, dedicated aircraft doors, voices, and more footstep surfaces remain documented limits. Sound needs for the pending weapons, jetpack, watercraft, and weather are listed in [audio research](docs/audio.md).
