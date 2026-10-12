# Traffic gridlock cleanup

Driving and cleanup run on the authoritative CPU server. Cars still brake for signals/vehicles, follow routes, and try reversing out of a collision. `server/traffic.ts` adds a separate low-frequency lifecycle controller so persistent jams gradually lose obstructing AI cars.

The controller samples once per simulated second. A car is stalled when it stays within three metres of its progress anchor for 30 seconds and is currently moving below 1 m/s. Two or more stalled cars connected by gaps of at most 12 metres form a jam. The anchor survives short reverse/forward recovery wiggles; meaningful movement resets it. The 30-second grace exceeds the full 18-second signal cycle, protecting ordinary red-light queues that move during their green phase.

At most one car is removed globally every five seconds, starting in the densest part of a jam. Only unoccupied AI cars with active routes qualify. Player-controlled/stolen cars, driver/passenger seats, player-to-vehicle attachments, burning cars, and wrecks are protected. Cleanup stops when traffic makes progress or no eligible clustered cars remain. Removal updates entities, AI routes, input state, and spatial interest immediately, so ordinary snapshot deltas remove the car on every client.

Each removed car gets a replacement after at least ten seconds. Replacements are paced to one every five seconds, retain model/colour, and start aligned with a road lane and a fresh reachable route. Sites must be clear of static geometry, at least 12 metres from other ground entities, and at least 65 metres from every player. If no site is clear, the replacement remains queued for a later retry. AI wreck expiry uses the same safe delayed replacement path. Traffic can temporarily become thinner; cleanup does not increase the population or continually replace stolen cars.

`/health` and `await window.afterhoursDebug.state()` expose `traffic` diagnostics: `jamCount`, `jammedCars` (latest sample), cumulative `despawned`/`respawned`, and `pendingRespawns`. Tuning is collected in `TRAFFIC` in `server/traffic.ts`.

## Verification

`bun run test` includes nine traffic regressions covering connected jams, cooldowns, normal signal queues, two-car gridlock, progress resets, unrelated parked cars, short recovery wiggles, protected ownership/lifecycle states, clear replacement lanes, blocked-site retries, spatial snapshot interest, and AI wreck replacement.

`bun run test:traffic` runs an isolated simulation with six normally driven AI cars inside a barricaded street. It does not modify the city artifact or the running server. [Recorded report](traffic-test.json): in 100 simulated seconds, three jam cars were removed at approximately 30.87, 62.90, and 95.93 seconds. Two replacements appeared at approximately 41.20 and 72.93 seconds, over 270 metres from the observer; the third remained in its ten-second delay at the end. After each removal, the remaining cars advanced and reset their grace period. Active cars plus queued replacements stayed exactly six throughout.

This is local simulation evidence, not a WAN or client performance test. Cleanup is a fallback for persistent gridlock; it cannot guarantee congestion-free traffic when players deliberately block roads. Removal can be visible near a player. Replacement sites are kept away from players, though a distant debug camera can still see one appear.

The complete 68-test suite, formatting/boundary/type checks, and production build passed. A fresh 30-second run with 16 moving WebSocket clients measured CPU tick p95 26.19 ms, max 35.40 ms, no catch-up drops, and about 26 KB/s per player: [load report](load-test.json). This short local run includes the jam scanner, but a long-duration/WAN soak remains further scope.

## Personalities and accidents

The server assigns each citizen a stable personality. Calm drivers keep their normal pace after damage. Restless drivers temporarily raise their cruising speed, while still braking for corners, queues, and signals. Timid and aggressive drivers brake before attempting a safe exit. A timid driver runs from the crash; an aggressive driver pursues its identified cause with fists. If no culprit is known, the aggressive driver flees instead. Burning or wrecked cars do not create surviving drivers. A blocked exit retries for up to twelve seconds, then the driver resumes driving. Exited cars remain parked and stealable; exiting does not create replacement traffic.

For a vehicle strike, the vehicle is responsible. Between vehicles, the server compares their approach speeds at the contact point before resolving the impact. A tie leaves responsibility unknown. This is a local collision heuristic, not a traffic-law simulation. Direct melee, bullet, and flame hits retain the attacker as their source. Explosions without an identified source provoke flight. Witnesses within 22 metres and on the same level react only when buildings do not block their view. Aggressive citizens pursue for at most fifteen seconds and stop if the target disappears, is incapacitated, or gets more than 35 metres away.

Pedestrians cycle between their starting sidewalk, a stop near a building, and a stop near a park. They remain outside and use the connected sidewalk graph. They pause at each stop, with shorter pauses and a faster walk for restless people. Danger takes priority over crossing waits. After a reaction, they rejoin the sidewalk network and resume their destination.

Ambient choices are staggered and evaluated once every 60–150 seconds after an initial delay. Aggressive pedestrians have a 1.5% chance per choice to start a six-second fight with a nearby NPC. Other choices can produce a three-second run, with restless people more likely to run. These choices never randomly select a player as a fight target. Injury reactions and ambient choices have separate cooldowns. State remains server-only and resets with the simulation.

`bunx tsx --test tests/citizens.test.ts` covers evasion, witness visibility, retaliation, crash attribution, the four driver outcomes, blocked exits, routines, and rare ambient behavior.
