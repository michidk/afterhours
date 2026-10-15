# Persistent traffic and horns

Traffic AI and physics run across the entire loaded island, regardless of player distance. Clients receive entities within 220 m and render them within 200 m. Prediction requires static collision coverage within 252 m and prefetches to 380 m; the initial loading screen prepares the spawn collision area before entry.

Living AI cars never despawn to clear congestion. They retain their identity, route, damage and position, including during prolonged gridlock. Existing steering, following distances, signal stops and reversing maneuvers continue to attempt recovery.

The server samples progress once a second. A grounded AI car that moves less than three metres from its progress anchor starts honking after eight seconds, when its speed is below 1 m/s. Subsequent horns are at least six seconds apart. Moving three metres resets the delay; short recovery wiggles do not. Waiting directly at a red signal resets the delay. Parked, player-driven, airborne, burning and destroyed cars do not honk. Horn events use two CC0 recordings through the existing spatial audio system, audible within 80 m with mute, cooldown and voice limits.

Destroyed wrecks retain their existing three-minute lifetime. Expired AI wrecks queue a replacement of the same model and colour after ten seconds. Replacement sites must have clear geometry and spacing from other bodies and players; unavailable sites retry later. This is separate from blocked, living traffic, which stays in the world.

`/health` and the opt-in debug interface expose `jamCount`, `jammedCars`, cumulative `honks` and `respawned`, and `pendingRespawns`. Connected groups of at least two cars with no progress for thirty seconds count as jams. Tuning lives in `server/traffic.ts`.

## Verification

Traffic tests cover delayed and repeated horns, retained identities/routes after ten simulated minutes, movement resets, red lights, recovery wiggles, player takeover, ineligible lifecycle states and safe wreck replacements. Streaming tests check startup collision coverage and global simulation; a real WebSocket test verifies that a car at 180 m reaches the client while one beyond 220 m does not.

`bun run test:traffic` drives six AI cars with ordinary contact physics inside an isolated barricaded street. [Recorded report](traffic-test.json): all six identities remained throughout 100 simulated seconds, with 39 horns and no replacements. The fixture changes only its in-memory world. It does not modify the saved city or a live server.

These checks cover behavior, not WAN or hardware performance. Persistent congestion is intentional; traffic can remain blocked indefinitely. Wider snapshots and visibility increase bandwidth and rendering work.

## Personalities and accidents

The server assigns each citizen a stable personality. Calm drivers keep their normal pace after damage. Restless drivers temporarily raise their cruising speed, while still braking for corners, queues, and signals. Timid and aggressive drivers brake before attempting a safe exit. A timid driver runs from the crash; an aggressive driver pursues its identified cause with fists. If no culprit is known, the aggressive driver flees instead. Burning or wrecked cars do not create surviving drivers. A blocked exit retries for up to twelve seconds, then the driver resumes driving. Exited cars stay parked with the parking brake on and remain stealable. Each one queues a replacement AI car, and the server removes it once no player is within the 220 m interest radius, unless someone has taken a seat. That replacement waits until the former driver finishes reacting and is outside every player’s interest radius, then retires the pedestrian and its route when the replacement spawns. A visible driver or an unavailable spawn site postpones the replacement without blocking unrelated wreck replacements. Repeated exits therefore reuse the population budget instead of permanently adding pedestrians.

For a vehicle strike, the vehicle is responsible. Between vehicles, the server compares their approach speeds at the contact point before resolving the impact. A tie leaves responsibility unknown. This is a local collision heuristic, not a traffic-law simulation. Direct melee, bullet, and flame hits retain the attacker as their source. Explosions without an identified source provoke flight. Witnesses within 22 metres and on the same level react only when buildings do not block their view. Aggressive citizens pursue for at most fifteen seconds and stop if the target disappears, is incapacitated, or gets more than 35 metres away.

Pedestrians cycle between their starting sidewalk, a stop near a building, and a stop near a park. They remain outside and use the connected sidewalk graph. They pause at each stop, with shorter pauses and a faster walk for restless people. Danger takes priority over crossing waits. After a reaction, they rejoin the sidewalk network and resume their destination.

Ambient choices are staggered and evaluated once every 60–150 seconds after an initial delay. Aggressive pedestrians have a 1.5% chance per choice to start a six-second fight with a nearby NPC. Other choices can produce a three-second run, with restless people more likely to run. These choices never randomly select a player as a fight target. Injury reactions and ambient choices have separate cooldowns. State remains server-only and resets with the simulation.

`bunx tsx --test tests/citizens.test.ts` covers evasion, witness visibility, retaliation, crash attribution, the four driver outcomes, blocked exits, routines, and rare ambient behavior.
