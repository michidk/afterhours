# Debugging and repeatable scenarios

Development exposes a server-authoritative WebSocket command interface, a reusable script client, and a browser controller. No separate MCP service is required. Production rejects debug commands and camera-interest overrides unless `ALLOW_DEBUG=1` explicitly enables debug access for everyone. Keep that setting private to a test environment.

## Script interface

Start the development server, then run commands from the repository root. The debug script defaults to `http://localhost:5174`; set `DEBUG_URL` when using the standard development port 5173 or another server.

```powershell
$env:DEBUG_URL='http://localhost:5174'
bun run debug -- state
bun run debug -- time 6.5
bun run debug -- time 16.5 0.013333333333333334
bun run debug -- teleport 11 25
bun run debug -- spawn sport
bun run debug -- move forward 1
bun run debug -- day-cycle
```

`state` reports authoritative entities, the script player's identity/input, city seed, simulation time, and clock rate. `time HOUR RATE` changes the shared clock in hours per real second; omitted rate pauses it. Normal speed is `1/75`, a 30-minute day. `spawn` accepts `sedan`, `sport`, `van`, `scout`, `utility`, or `plane`. Teleport and spawn placement are validated by the server. `interact`, `drop`, and `reload` use normal gameplay messages. Movement is limited to ten seconds and releases controls afterward.

Each CLI invocation joins its own temporary player. For a scenario that must retain one player, import `AgentClient` from `scripts/agent-client.ts` in a TypeScript script:

```ts
import { AgentClient } from "../scripts/agent-client.ts";

const client = await AgentClient.connect("http://localhost:5174", "Scenario");
try {
  await client.command({ kind: "teleport", x: 11, z: 25 });
  await client.command({ kind: "spawn", model: "sedan" });
  await client.move({ up: true }, 1);
  const state = await client.command({ kind: "state" });
  console.log(state);
} finally {
  client.close();
}
```

Commands have correlated responses, bounded timeouts, schema validation, and server action limits; helpers serialize commands to respect those limits. Script inputs still pass through ordinary sequencing, simulation, collisions, and ownership checks. Clock changes affect every client. The day-cycle scenario saves and restores the original clock in `finally`.

## Browser interface and cameras

After joining a debug-enabled city, `window.afterhoursDebug` provides:

```js
const d = window.afterhoursDebug;
await d.state(); // authoritative state
d.inspect(); // received/predicted state, camera, lighting
await d.time(6.5, 0);
d.camera("free", { x: 0, y: 0, z: 32 }); // elevated view; point is focus
d.zoom(-200);
await d.settle(); // wait two rendered frames before inspecting/capturing
await d.move({ right: true }, 1); // moves the camera in this mode
d.camera("fly", { x: 0, y: 12, z: 25 }, 0, 0.08);
d.look(100, -20); // mouse-like look deltas
d.camera("follow");
await d.spawn("sport");
d.action("interact"); // ordinary gameplay action; follow mode required
await d.time(16.5, 1 / 75); // resume normal shared clock
```

F1 opens the development menu with camera selection, vehicle/tools, fixed-time lighting presets, resume, and a 30-second day-cycle button.

| Mode                    | Controls                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Player follow           | Normal gameplay controls                                                                                       |
| Elevated free camera    | WASD/arrows pan, E/Space raise and Q lowers focus, Shift faster, wheel zoom                                    |
| First-person fly camera | WASD/arrows move relative to view, E/Space rise, Q descends, Shift faster, no fog, right-drag look, wheel zoom |

Escape restores player follow and closes panels. Both debug cameras suppress gameplay movement, attacks, equipment changes, and interactions; the server receives idle player controls. The world continues simulating, so moving vehicles still coast and collisions remain possible. A debug-only camera position selects nearby snapshot interest without teleporting the player. Returning to follow restores normal input and player-centered interest. Blur/hidden tabs release held inputs. `stop()` releases scripted movement; a disconnected client loses its debug API.

Wheel zoom has no fixed distance or lens-zoom caps in either debug mode. The elevated view adjusts clipping and fog with distance, allowing close inspection and a view of the whole city. Fly mode changes lens magnification continuously within a valid perspective projection. Returning to player follow restores normal lens/clipping settings.

The zoom browser check verified free-camera distances of approximately 1061 m and 2.63 m, fly-camera fields of view beyond both former caps, unchanged player position, and restored follow settings. [Whole-city view](screenshots/debug-zoom-out.png).

## Day/night appearance and evidence

The sky has a moving sun/moon, a blue daytime gradient, peach dawn, rose dusk, and sparse night stars. Sun/moon lighting and shadow direction follow time. Cool ambient light keeps midnight streets readable, while occupied windows, storefronts, and street lamps become warm. Four reusable nearby point lights illuminate the scene; shared window materials and lamp pools keep the lighting budget bounded. Noon intensity preserves roof and road detail.

The script checks fixed times, pause, a complete accelerated cycle, and clock wrap: [authoritative report](day-night-test.json). The browser records a complete rendered cycle. Comparable captures use the same elevated camera at dawn 06:30, noon 12:00, dusk 18:30, and midnight 00:00; a second fixed fly-camera view checks the sky.

| Time     | Street view                       | Sky view                              |
| -------- | --------------------------------- | ------------------------------------- |
| Dawn     | [06:30](screenshots/dawn.png)     | [06:30](screenshots/sky-dawn.png)     |
| Noon     | [12:00](screenshots/noon.png)     | [12:00](screenshots/sky-noon.png)     |
| Dusk     | [18:30](screenshots/dusk.png)     | [18:30](screenshots/sky-dusk.png)     |
| Midnight | [00:00](screenshots/midnight.png) | [00:00](screenshots/sky-midnight.png) |

The camera browser scenario verified movement/zoom/look in both modes, unchanged player position, idle authoritative inputs, and restored walking after Escape. Regression tests cover camera coordinate accessors, unrestricted zoom and reversible lens changes, pitch bounds, lighting continuity and midnight wrap, debug command validation, authoritative execution, and disabled production access. Browser captures use SwiftShader and establish visual/functionality evidence only; they do not establish hardware performance.

## Debug windows

Press F1 on a debug-enabled server, then use the toolbar to open Vehicles, Day / night,
Camera, Networking, Server stats, or Object inspector. Drag a title bar to move a window;
its minus button collapses it and its close button hides it. Focus a title bar and use
arrow keys to move it with the keyboard. Reset layout restores the default positions.
Escape or F1 hides the tools. Layout lasts until the page reloads.

Server stats refresh once per second while that window is expanded. Tick CPU and wall
p95 cover the latest 600 ticks (up to 20 seconds); CPU is the simulation thread's work,
not host-wide CPU utilization. Backlog measures simulation time still owed, including
elapsed time since the last scheduler pass. Catch-up ticks, dropped time, and overloads
are cumulative since startup. RSS includes native physics allocations; JavaScript heap
usage and its limit are separate. Available memory is reported by Node for the process,
including supported container constraints. These are usage indicators, not OS pressure
stall measurements.

Enable the inspector checkbox and hover a person or vehicle to read its authoritative
entity fields, vehicle configuration, current input, AI personality and reaction, and
route state. AI state describes the actual decision system; it does not generate thoughts.
Move the pointer into a window to keep the selected object while reading. Inspection
suppresses left-click firing while active. Static scenery shows mesh and hit information;
batched scenery does not have individual AI or entity state. Removed entities are marked
unavailable. Server requests stop when both monitoring windows are collapsed or hidden.

The inspector and server diagnostics use the existing authorized debug connection.
Production still requires explicit `ALLOW_DEBUG=1`; enabling it grants these tools to
all connected players.
