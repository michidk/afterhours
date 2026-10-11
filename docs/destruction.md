# Temporary destruction

The server owns a temporary destruction overlay. The saved city JSON is immutable: destruction never writes it, regenerates it, or changes its map identity. Restarting restores the intact city.

Palms, trees, benches, streetlamps, signal poles, and hydrants have stable IDs derived from their kind and saved-map coordinates. Benches/signals/hydrants are deterministic fixtures derived from parks and road segments. Vehicle strikes, fists/weapons, and explosions damage fixtures; broken fixtures leave the standing collision grid and become debris.

Rapier 3D simulates debris with gravity, angular motion, CCD, friction, restitution, sleeping, and ground/building/fixture contacts. Nearby actors enter this debris world as kinematic collision proxies; driving retains the existing vehicle solver. Each fixture is one simplified rigid body, rather than a fracture simulation. Corpse bodies use capsules. The server limits active bodies to 128 and releases the physics world when empty.

| Object           | Lifetime                                    | Restoration                                                                |
| ---------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| Broken prop      | 30 seconds; fades over the final 3 seconds  | Returns to its original position/orientation once actors clear it          |
| Broken hydrant   | Same prop timer                             | Water sprays from the original pipe until restoration                      |
| Corpse           | 30 seconds; fades over the final 3 seconds  | Player respawns after 3 seconds; NPC recovers after 30 seconds             |
| Exploded vehicle | 180 seconds; fades over the final 3 seconds | Wreck is removed; AI replacement follows the existing clear-lane lifecycle |

Broken fixture membership is a reliable update sent when it changes and on join/reconnect. Spatial snapshots carry nearby debris poses, rotation, velocities and authoritative expiry times. The client interpolates positions/quaternions, fades meshes, and runs bounded cosmetic water particles. Chunk unloading disposes fixture models, lights and fountains; loading a broken fixture keeps it hidden. The same collision overlay removes broken obstacles from client prediction. Death bodies remain after player respawn without duplicating on repeated fatal damage.

Development automation can inspect `await window.afterhoursDebug.command({kind:"state"})`; its `destruction.nearby` lists fixture IDs. `await window.afterhoursDebug.command({kind:"destroyProp",id})` breaks a fixture within 60 m. This remains behind existing production debug opt-in. Renderer counts are in `window.afterhoursDebug.inspect().destruction`.

Completed checks before the user requested no further verification: the 102-test suite and production build passed; the additional late-join/roster transport and renderer interpolation/fade/disposal regressions passed separately. Browser observation showed hydrant debris, an active water fountain, and automatic restoration with all fountain particles disposed after the timer. The player list updated when another player joined and left. The last model cleanup/orientation adjustments were not followed by another full check at the user's request.

Physics dependency reference: [Rapier rigid bodies](https://rapier.rs/docs/user_guides/javascript/rigid_bodies/) and [colliders](https://www.rapier.rs/docs/user_guides/javascript/colliders/).
