# Island map and Shift sprint

M opens/closes the map; Escape and Close dismiss it. Drag pans; the wheel and +/- buttons zoom around the cursor/view centre. Find me centres on the live player; Island restores the entire island. Keyboard focus stays inside the map while open. Typing M in chat does not toggle it. N now mutes sound.

The server prepares `/city/atlas/<mapId>` from the artifact it loaded at startup. The compact atlas contains road endpoints/widths, parks, ramps and landmarks. It omits buildings, props, collision data and dynamic entities. The client validates its map identity and keeps it only in active memory; failed downloads can retry on reopening. Opening or zooming the map does not change 3D geometry interest. Player markers use existing snapshots, so other players appear only within ordinary network interest.

The map releases movement and attacks, suppresses interactions, and stops debug camera movement. The server continues simulation, including coasting vehicles. Closing clears held keys before restoring gameplay.

Left/right Shift sends a dedicated sprint flag through validated inputs and shared character movement. It reaches 8 m/s on foot; releasing it restores 4.5 m/s walking. Space retains legacy sprint and vehicle handbrake/ground brake. Shift does not activate vehicle brakes. Debug cameras accept Shift or Space for faster movement.

Verification on 2026-10-11:

- All 97 tests pass, including authoritative/predicted sprint agreement, both Shift keys and release, vehicle brake independence, cursor-anchored zoom/pan/resize, atlas contents, no-store and wrong-map rejection. Formatting, architecture checks, types and production build pass.
- Native browser: joined at localhost:5174, opened with M, downloaded one atlas, zoomed/recentred, restored Island, closed with Escape/button, reopened without another download, and typed M in chat without opening it. Holding W while browsing kept the player still. Geometry stayed at 16 nearby chunks, not the whole island.
- Actual browser Shift/W input produced server-reported 8 m/s sprint, followed by 4.5 m/s walking after release. The browser uses software WebGL; no hardware profiling was requested.
- [Full island overview screenshot](screenshots/city-map.png).
