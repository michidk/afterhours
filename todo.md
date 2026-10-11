# AFTERHOURS todo

Audit baseline: `c2da9ed`, pulled from `origin/main` before reviewing the previous gameplay request. Agent maintenance rules are in [AGENTS.md](AGENTS.md). Unchecked items are missing, incomplete, or awaiting the requested visual or handling review.

Interpret the dictated "chatpack" as a jetpack, "Chetsky" as jet skis, and "M gees" as machine guns. The requested three-minute lifetime is interpreted as applying to corpses as well as exploded vehicles.

## Remaining gameplay work

- [x] Keep corpses for 180 seconds and fade them before removal. `TUNING.corpseSeconds` is separate from the 30-second `npcRecoverySeconds` in [shared/catalog.ts](shared/catalog.ts). Verified player respawn, NPC recovery, retained corpses, and wreck cleanup in [destruction regressions](tests/destruction.test.ts).
- [x] Show chosen overhead names with projected DOM labels, independent of hidden rider meshes. [Nameplate regressions](tests/nameplates.test.ts) cover passengers, reconnect/roster changes, offscreen removal, and plain-text names. A real headless browser join and disconnect check verified the visible name and removal; passenger live check is included in [browser verification](scripts/browser-gameplay-check.mjs).
- [x] Gate engine audio and powered rotor/propeller animation on shared `propulsionRunning`. Pushed idle vehicles remain silent; abandoned helicopters can windmill silently. [Engine regressions](tests/engine-audio.test.ts) failed before the fix and pass for push, boarding, shutdown, and wreck cases. Audible listening remains part of the final playtest.
- [ ] Refine and playtest helicopter and plane movement. Existing flight includes takeoff, obstacle clearance, lift, stalls, and abandoned-aircraft crashes, but the requested handling polish still needs an explicit review of acceleration, turning, braking, climbing, and descending for each model.
- [ ] Put model-dependent movement parameters in the shared vehicle catalog and provide multiple variants of each vehicle kind. Sedan, sport, and van tuning and two helicopter models already exist. Plane thrust, lift threshold, damping, and turn response in [shared/physics/plane.ts](shared/physics/plane.ts), and most helicopter response values in [shared/physics/helicopter.ts](shared/physics/helicopter.ts), are hardcoded. There is only one plane model. Keep authority and prediction on the same algorithms and verify that variants handle differently.
- [ ] Finish presentation and integrated verification of ammunition pickups. [server/inventory.ts](server/inventory.ts) replenishes compatible owned weapons independently of weapon slots and keeps surplus in the pickup. Finite magazines, reserves, reloading, and ammo-preserving weapon drops work.
- [ ] Finish grenade rendering and integrated verification. Server-owned throwing, physical travel/bounces, a three-second fuse, shared explosions, finite charges, and pickups are covered by [weapon regressions](tests/weapons.test.ts).
- [ ] Finish knife rendering and integrated verification. The catalog and server implement distinct close melee behavior and pickups.
- [ ] Finish machine-gun rendering and integrated verification. [shared/catalog.ts](shared/catalog.ts) has distinct damage, rate of fire, range, magazine, and reload parameters beyond the existing SMG.
- [ ] Finish flamethrower rendering, flame effects, and integrated verification. [server/combat.ts](server/combat.ts) implements finite fuel, cone damage, wall/fixture occlusion, and pickups.

Combat implementation progress: [weapon regressions](tests/weapons.test.ts) verify new catalog weapons, finite ammo/fuel/grenade charges, compatible ammo with full inventory and retained surplus, shared blasts with exact-once occupant damage, projectile bounces/fuse, and supplies derived from the immutable saved city. Tagged jetpack pickup/drop preserves fuel independently of weapon slots. Weapon and pickup presentation, effects, and integrated browser verification are still pending; keep the related items open until those checks finish.

- [ ] Add a usable jetpack with pickup, equip, movement, visual feedback, and multiplayer state. It is absent from the shared entity and input contracts.
- [ ] Add animated, usable water and the shared water boundaries needed by watercraft. The ocean in [client/scene.ts](client/scene.ts) is a static box, and island bounds currently block travel beyond land. Hydrant spray is implemented, but does not provide navigable water.
- [ ] Add boats, jet skis, and speedboats, with distinct variants, model parameters, boarding, and shared authoritative and predicted movement. [shared/world.ts](shared/world.ts) has no watercraft entity kinds.
- [ ] Add AI that uses watercraft and cruises along navigable water routes. [server/ai.ts](server/ai.ts) currently supports street traffic and pedestrians only.
- [ ] Remodel and visually review parachutes. [client/scene.ts](client/scene.ts) currently uses a half-sphere canopy and four suspension lines. Automatic deployment, steering, and rooftop descent already work; the requested nicer appearance remains an art task.

## Audio replacement

- [x] Research and replace the eleven old clips with 108 CC0 clips across 33 sound banks. Each bank has alternate takes, no immediate sample repeat, and bounded pitch, gain, and tone variation. Add missing footsteps, handling, boarding, parachute, fire, water, coast, and life-state cues. See [inventory and future sounds](docs/audio.md), [source credits](public/audio/CREDITS.md), and the listening page at `/audio.html`.
- [x] Verify every clip's manifest coverage, distinct waveform, headroom, fades, and loop seam. Headless Chrome decoded all 108 files, played all 33 banks, measured a nonzero unclipped mix, and confirmed mute, resume, and cleanup. Listening-page screenshots covered 1280 and 390 px widths.
- [ ] Listen on real speakers or headphones and refine recording choices and the mix. Wall occlusion, layered RPM recordings, dedicated aircraft doors and parachute snaps, voices, and more footstep surfaces remain documented limits. Sound needs for the pending weapons, jetpack, watercraft, and weather are listed in [audio research](docs/audio.md).

## Carried over from the old plan

- [x] Publish CI for formatting, import boundaries, types, tests, and build. [Workflow](.github/workflows/ci.yml) was pushed with managed authentication; [run 38177211233](https://github.com/michidk/afterhours/actions/runs/38177211233) passed on `332d07c`.

`PLAN.md` is retired. Its completed foundation items remain documented in README and the linked documents and tests; its unfinished CI item is preserved above.

## Implemented parts of the request

- Temporary destruction covers palms, trees, benches, lamps, signals, and hydrants, with server-owned Rapier debris, a 30-second prop lifetime, fading, and restoration at the original position once clear. Hydrants spray until restoration. The saved map remains unchanged. Exploded vehicle wrecks last 180 seconds. See [destruction implementation and timers](docs/destruction.md), [server regressions](tests/destruction.test.ts), and [renderer regressions](tests/destruction-render.test.ts).
- Chosen player names are validated on join and appear in chat and the connected-player list. See [sessions](server/session.ts) and [player list](client/ui/player-list.ts). Overhead names remain open above.
- Client prediction already solves local static and dynamic contacts, replays unacknowledged inputs, and reconciles against server snapshots. Damage and ownership remain authoritative. See [shared movement](shared/physics/movement.ts), [prediction](client/network/prediction.ts), and [prediction regressions](tests/prediction.test.ts).
- Cars have sedan, sport, and van variants with different physical parameters. Sparrow and Atlas helicopters differ in speed, mass, size, and seats. Fists, bats, pistols, and SMGs have distinct weapon stats, finite firearm ammo, reloads, drops, and exclusive weapon pickups. See [catalog](shared/catalog.ts), [inventory](server/inventory.ts), and [combat regressions](tests/combat.test.ts).
- Airborne aircraft exits and walking off rooftops automatically deploy a steerable parachute. Landing clears it on streets or roofs, and both authority and prediction use the same descent behavior. See [character altitude](shared/physics/movement.ts) and [parachute regressions](tests/parachute.test.ts).

## Audit verification

Source, existing tests, and recorded project evidence were reviewed at the baseline above. A direct `GameAudio.update` check with stub audio nodes reproduced engine loops for pushed, unoccupied cars, grounded helicopters, and planes. This confirms routing, not audible playback.

`bun run test` passed all 104 tests. `bun run build` and `bun run check` passed, including formatting, import boundaries, and types. Local Markdown links and removal of `PLAN.md` were checked. The existing suite verifies the implemented destruction, inventory, collision prediction, and parachute behavior; a passing suite does not cover the open features above.

Live browser appearance, subjective vehicle handling, and listening checks have not been repeated for this audit. Keep those checks open where requested above.

## Audio verification result

The audio and combat regressions pass, as do `bun run build` and `bun run check`. The full suite reports 107 passing tests and one failing debug transport test. The failure at `tests/debug.test.ts:168` also reproduces in an untouched checkout of `3f500a0`; its fixed 250 ms snapshot wait is sensitive to this environment. A second run failed at its fixed-duration movement assertion instead. Keep that existing transport-test issue open rather than treating audio verification as a full-suite pass.

Headless Chrome evidence is recorded in [audio browser check](docs/audio-browser-check.json). A live game session confirmed pickup, authoritative pistol shots, reload, and N muting and resuming loops with no failed clips. After merging `332d07c`, all 14 targeted audio, combat, and destruction tests pass, along with build and check. No real-device listening or subjective approval is claimed.
