# Gameplay expansion

## Problem

Complete the backlog while retaining the server's ownership of outcomes, shared movement prediction, and the immutable saved city. New items must work through ordinary pickups and controls, not only debug tools.

## Usage

Players collect supplies with F, equip weapons with 1–4, attack with J or the mouse, reload with R, and drop with G. B enables a collected jetpack; E spends fuel to climb and WASD steers. Watercraft use the existing driver/passenger seats and WASD/Space controls. Swimmers can return ashore.

The existing simulation calls inventory collection, combat attacks, and shared movement. Grenades have a separate bounded collection, stepped by the server and included in nearby snapshots. Rendering consumes those snapshots without deciding hits, ownership, or damage.

## Shape

Extend `shared/catalog.ts`, keeping weapon and vehicle definitions together with their existing consumers. Weapon attack modes are explicit. Pickups are a tagged union of weapon, compatible ammunition, and jetpack fuel. Jetpacks are separate equipment, with fuel and enabled state replicated on the player. Shared thrust and craft solvers run in server substeps and client replay.

Keep the land edge at 816 and permit a surrounding water ring out to 1072. Water physics uses one fixed surface; visual waves do not change collisions. Watercraft hulls remain outside land, cars remain on land, and swimming/aircraft use the outer boundary. All dispatch paths explicitly distinguish aircraft from watercraft.

Source pads derive at runtime from validated locations in the saved artifact. Neither gameplay nor this expansion regenerates or writes the city. Inventory owns refill and collection; grenades own projectile admission and removal; simulation owns blast damage. The blast path must not damage a seated passenger twice.

## Synthesis decision

Two independent designs scored equally at 22/25. The independent judge chose the existing-catalog design because it has fewer changed interfaces and avoids artifact migration. Adopt the other candidate's checked dispatch coverage and lifecycle gates. Reject the broad registry move, plugin interface, and city/manifest migration without a demonstrated need. The second provider timed out; an available Codex agent supplied that candidate and another independently judged both.

## Tradeoffs

- Flat deterministic water physics, with cosmetic waves, instead of a buoyancy engine.
- Existing four weapon slots; jetpack equipment does not consume a weapon slot.
- Reusable knives; finite rounds, grenades, and flame/jetpack fuel.
- Bounded projectiles, cosmetic effects, and water AI. No spreading fire or dynamic-map persistence.

## Verification

Each domain ends with focused behavior tests. Final checks include full/delta equipment state, compatible full-slot ammo, grenade bounce/fuse and occupied blasts, fuel exhaustion/parachutes, rotated hull shore contacts, shared prediction, every model/supply on the saved map, real WebSocket actions, and renderer cleanup. Browser checks must inspect passenger labels, watercraft, jetpack exhaust, and parachute art. Screenshots and controlled movement checks are separate from passing type checks.

## Risks

Subjective handling and audible playback require playtesting. Transport timing checks must run without competing CPU-heavy browser/test processes. Corpse retention must also respect the destruction body's capacity under repeated deaths.
