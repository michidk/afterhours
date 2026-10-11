# AFTERHOURS

A living city. A stolen car. A story worth sharing.

A playable desktop-browser foundation: Babylon.js renders a procedural 3D city while a Node/TypeScript server owns the simulation. All players connect to one shared in-memory city. This is an early gameplay prototype, not yet a production MMO or a finished GTA-style game.

## Run

Requires Node.js 22+ and Bun (tested with Node 24 and Bun 1.2).

```sh
bun install
bun run dev
```

Open http://localhost:5173. Open a second tab to join the same city. Other devices on your network can use your computer's LAN address and port 5173. The server must remain running.

```sh
bun run test
bun run build
bun run start
```

`start` serves the production build and WebSocket endpoint together. Set `PORT` to change the port. Production disables the F1 tools; `ALLOW_DEBUG=1` explicitly enables them for everyone on that server. Development enables them by default. Deploy as one long-running Node process behind an HTTPS reverse proxy with WebSocket support. Do not use independent replicas: each process currently has its own city.

## Controls

- WASD / arrows: walk; in vehicles W/S throttle/reverse and A/D steer.
- Space: sprint on foot; handbrake in vehicles.
- F: enter a nearby unoccupied vehicle, exit a grounded vehicle, or collect a nearby weapon.
- J: punch, swing a bat, or shoot in the direction you face.
- E / Q: ascend / descend in aircraft. Planes need forward speed to climb.
- Enter: chat. H: help. Escape: close panels.
- F1: development garage with cars, helicopters, planes, weapons, healing, and day/night presets.

## Implemented

- Name and character-colour entry; a pre-bundle loading veil followed by engine/world readiness stages, inspired by Craftstead's loading handoff.
- Seeded building placement, varying heights and palettes, parks, storefront signs, palms, sidewalks, crossings, ramps, and named areas.
- Elevated following camera, shadows, day/night lighting, minimap, health, vehicle speed, and shared chat.
- Walking, sprinting, fists, bat and pistol pickups, damage, knockdowns, and recovery.
- Server-owned car acceleration, lateral tyre grip, handbrake sliding, simple collision impulses, and ramp airtime.
- Two-way lane traffic that stops for signals and nearby cars; sidewalk pedestrians that react to moving cars and crossing phases.
- Simple controllable helicopter and plane prototypes with server-owned altitude.
- Single shared city, exclusive vehicle ownership, input validation, message/payload limits, idle input release, disconnect cleanup, and production debug gating.

## Architecture

- `shared/world.ts`: deterministic city generation, entity/input types, signal phases, and district names.
- `server/simulation.ts`: fixed-step simulation and gameplay rules; no renderer dependency.
- `server/index.ts`: HTTP hosting, WebSocket protocol, session limits, validation, and snapshot delivery.
- `client/scene.ts`: Babylon meshes/materials, spatial batches of static geometry, entity interpolation, camera, and cosmetic particles.
- `client/main.ts`: entry flow, network connection, input, HUD, chat, and minimap.
- `tests/`: simulation invariants and an integration test that launches a production server and connects two WebSocket clients.

The server steps at 30 Hz and broadcasts at 15 Hz. Clients send booleans, never accepted transforms, damage values, or vehicle ownership. Rendering smooths received positions; it does not decide outcomes. World state resets on restart. The connection cap is 64, but that is a guardrail, **not a verified capacity claim**.

Babylon.js was chosen for its browser-first 3D engine, animation/material tooling, and CPU/GPU particle support. The simulation is deliberately independent, so richer server-side collision physics can be integrated without moving authority into the browser. See [Babylon's capabilities](https://www.babylonjs.com/specifications/) and [particle documentation](https://doc.babylonjs.com/features/featuresDeepDive/particles/).

## Next development work / known limits

- Driving uses a compact custom planar model with vertical ramp/aircraft motion; it is not a full rigid-body, suspension, or aerodynamic simulation. Cars use circular collision bounds.
- Traffic follows straight lanes and wraps at the island boundary. Intersection turning, route selection, lane recovery after crashes, richer pedestrian routes, and traffic deadlock recovery still need work.
- Buildings are generated on a fixed street grid. District geometry, interiors, road topology, garages, airport/runways, and authored landmarks need expansion.
- Aircraft, combat, characters, and visual effects are simple prototypes. Add better models, visible weapons, richer animations, audio, lighting pools, destruction, and hit feedback.
- No local movement prediction/reconciliation, lag compensation, spatial interest management, delta compression, persistence, accounts, moderation, or reconnect session restoration yet. Full snapshots and pairwise collision checks need profiling before a larger public server.
- Desktop keyboard controls only. Small screens can display the entry UI, but touch gameplay is not implemented.
- Modular engine imports keep the main bundle near 1.24 MB (305 KB gzip); further splitting remains useful. Fonts use Google Fonts with local fallbacks. Browser QA used software WebGL (SwiftShader), so real GPU and device performance still needs profiling.

The linked Pat Kerr vehicle page could not be read as an article through the available fetches (the direct response was an application shell). No code from that project was copied. The current grip model follows the requested longitudinal/lateral tyre behaviour and should be tuned against the reference interactively in a subsequent driving pass.
