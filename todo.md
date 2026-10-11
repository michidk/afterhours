# AFTERHOURS todo

Audit baseline: `c2da9ed`, pulled from `origin/main` before reviewing the previous gameplay request. Agent maintenance rules are in [AGENTS.md](AGENTS.md). Unchecked items are missing, incomplete, or awaiting the requested visual or handling review.

Interpret the dictated "chatpack" as a jetpack, "Chetsky" as jet skis, and "M gees" as machine guns. The requested three-minute lifetime is interpreted as applying to corpses as well as exploded vehicles.

## Remaining gameplay work

- [x] Keep corpses for 180 seconds and fade them before removal. `TUNING.corpseSeconds` is separate from the 30-second `npcRecoverySeconds` in [shared/catalog.ts](shared/catalog.ts). Verified player respawn, NPC recovery, retained corpses, and wreck cleanup in [destruction regressions](tests/destruction.test.ts).
- [ ] Show each other player's chosen name above their character in the world, including during shared rides. Joining and the connected-player list already preserve names, but [client/scene.ts](client/scene.ts) creates no overhead labels. Verify join, leave, reconnect, and removal when a character leaves view.
- [ ] Gate vehicle engine audio on actual engine, rotor, or propeller operation. [client/audio/index.ts](client/audio/index.ts) currently accepts any vehicle moving faster than 0.4 m/s, even without a driver. Pushing an idle car, grounded helicopter, or plane starts its engine loop. Match aircraft audio to the animation state in [client/scene.ts](client/scene.ts), and cover push, boarding, shutdown, and wreck cases with regressions.
- [ ] Refine and playtest helicopter and plane movement. Existing flight includes takeoff, obstacle clearance, lift, stalls, and abandoned-aircraft crashes, but the requested handling polish still needs an explicit review of acceleration, turning, braking, climbing, and descending for each model.
- [ ] Put model-dependent movement parameters in the shared vehicle catalog and provide multiple variants of each vehicle kind. Sedan, sport, and van tuning and two helicopter models already exist. Plane thrust, lift threshold, damping, and turn response in [shared/physics/plane.ts](shared/physics/plane.ts), and most helicopter response values in [shared/physics/helicopter.ts](shared/physics/helicopter.ts), are hardcoded. There is only one plane model. Keep authority and prediction on the same algorithms and verify that variants handle differently.
- [ ] Add ammunition pickups that replenish compatible weapons without requiring another weapon pickup. [server/inventory.ts](server/inventory.ts) currently supplies ammo only as part of weapon items. Finite magazines, reserves, reloading, and ammo-preserving weapon drops already work.
- [ ] Add grenades with throwing, physical travel, a fuse, explosions, finite inventory, and pickups.
- [ ] Add knives with their own melee behavior and pickups. The existing bat does not implement a knife.
- [ ] Add machine guns beyond the existing SMG, with distinct damage, rate of fire, range, magazine, and reload parameters. Pistols and SMGs already have different stats in [shared/catalog.ts](shared/catalog.ts).
- [ ] Add flamethrowers with finite fuel, pickups, flame effects, and authoritative damage. [server/combat.ts](server/combat.ts) currently implements melee and hitscan attacks only.
- [ ] Add a usable jetpack with pickup, equip, movement, visual feedback, and multiplayer state. It is absent from the shared entity and input contracts.
- [ ] Add animated, usable water and the shared water boundaries needed by watercraft. The ocean in [client/scene.ts](client/scene.ts) is a static box, and island bounds currently block travel beyond land. Hydrant spray is implemented, but does not provide navigable water.
- [ ] Add boats, jet skis, and speedboats, with distinct variants, model parameters, boarding, and shared authoritative and predicted movement. [shared/world.ts](shared/world.ts) has no watercraft entity kinds.
- [ ] Add AI that uses watercraft and cruises along navigable water routes. [server/ai.ts](server/ai.ts) currently supports street traffic and pedestrians only.
- [ ] Remodel and visually review parachutes. [client/scene.ts](client/scene.ts) currently uses a half-sphere canopy and four suspension lines. Automatic deployment, steering, and rooftop descent already work; the requested nicer appearance remains an art task.

## Carried over from the old plan

- [ ] Add and publish the GitHub CI workflow for formatting, import boundaries, types, tests, and build. `PLAN.md` left this open, and this checkout contains no `.github/workflows/ci.yml`. Its old credential limitation has not been rechecked. Use managed GitHub App authentication and report an actual permission failure if publication is blocked.

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
