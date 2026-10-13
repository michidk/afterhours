# Collision prediction and reconciliation

The server owns movement outcomes, damage, knockdown, seats and inventory. Clients predict kinematics with the shared solver, then replace that state with the latest authoritative snapshot and replay the remaining inputs before the next input or render. Every snapshot still updates authority and the remote interpolation timeline; queued snapshots do not each trigger an obsolete replay. Controls are sent before reconciliation runs. Prediction runs at 30 Hz with 120 Hz contact substeps. Render extrapolation and correction offsets never modify the replay state.

## Input scheduling

The browser uses an elapsed-time accumulator for its 30 Hz input commands. Both timer wakeups and rendered frames pump the same clock, so overlapping callbacks cannot duplicate ticks. Short delays retain the fractional remainder and catch up with individually timestamped commands. A delay over 250 ms discards stale clock debt; hidden tabs reset the clock. The server still advances only one fixed physics tick at a time, regardless of packet bursts. It retains three queued commands: an 80 ms browser wakeup can produce three 30 Hz inputs. The former two-command cap discarded part of these ordinary batches, causing alternating one-tick corrections during steady driving and flight. Overflow still drops the oldest command, bounding application of the newest control to three ticks (100 ms) plus network transit.

Counting timer callbacks as ticks made prediction run slow whenever the browser delivered a nominal 33 ms callback after 50 or 80 ms. The server continued its held input during those gaps, causing recurring corrections. Scheduled command timestamps also keep fractional render extrapolation aligned with the accumulated ticks.

## Fixes and bounds

Remote entities normally stay on buffered interpolation, including nearby players.
Only bodies involved in a local predicted contact use provisional collision poses;
after contact ends they blend back over 500 ms. This preserves immediate impact
feedback without resetting every nearby player's pose on each snapshot. Riders
follow their displayed vehicle. Snapshots replace provisional physics state.

Prediction covers one second (30 input ticks), plus at most one render tick. The
previous seven-tick budget stopped accepting local turns and brakes at ordinary
latencies above 233 ms, even while snapshots arrived normally. The client now
replays the complete pending prefix up to 30 commands, retaining at most 60 for
recovery. Beyond one second it holds its bounded pose until acknowledgements
advance; if history overflows, incomplete suffixes are never replayed.

Collision candidates cover each body’s maximum closing distance, including any
existing impulse velocity. This reaches about 120 m for two vehicles at 52 m/s: they travel
107.5 m during the prediction and render horizon, with 12 m for contact footprints.
This remains inside the 220 m snapshot interest and 252 m streamed collision-map
requirement. Missing collision chunks still suspend prediction. Server authority
and damage rules are unchanged.

Server input remains one command per fixed tick. A three-command FIFO absorbs normal batching. On overflow it drops the oldest command, retaining the newest stop or turn. Previously the eight-frame queue rejected new commands when full, retaining up to 267 ms of old control at the target tick rate, and longer when the server was overloaded. An acknowledgement identifies the applied command; older discarded commands also leave client history. Overflow therefore permits a correction. It does not grant extra physics steps or claim to have simulated discarded commands. Duplicate or out-of-order sequence numbers remain rejected. A 250 ms input silence still releases held controls.

When a server pause leaves the displayed vehicle ahead of its reconciled position,
visual correction along its current velocity removes at most half its travel speed.
Between input ticks, the display also retains enough offset to prevent that easing
from moving backward. Sideways and stationary errors continue to settle normally;
collision constraints still apply after smoothing, and large corrections reset the
visual history. This changes presentation only: authority and replay apply immediately.
A deterministic 250 ms server pause checks recovery, continued travel and eventual
stop convergence, alongside the ordinary callback-jitter cases.

## Collision pair order

Authority and prediction use the same sweep broad phase. It sorts bodies along X, considers nearby candidates with a contact-correction margin, then orders pairs by stable entity IDs before resolving them. Reordering snapshot entities therefore cannot change pileup resolution. The server retains its spatial grid for AI and snapshot interest, but no longer rebuilds and queries it for every contact pass. Static contact checks are reused only while the body's pose and planar velocity are unchanged.

Protocol 7 rejects older clients whose collision solver or map manifest differs. Physics remains at 120 Hz and authority at 30 Hz; the optimization does not lower collision frequency or give the client additional simulation time.

## Server overload

The server prepares the debris physics world and terrain collider before listening.
It retains that terrain world when debris becomes idle, removing only temporary
colliders and actor proxies so later impacts do not rebuild it.
Creating them lazily on the first prop impact blocked a live simulation tick for
roughly 300–500 ms, delaying acknowledgements even with no network latency.

The stepped-walking investigation reproduced only 1.8 m of movement in three seconds while the development shell was CPU-throttled. The fixed-step runtime could perform four expensive catch-up ticks without letting socket events run. It now yields once its callback consumes one tick budget, while retaining the four-step limit for cheap catch-up. Spatial queries reuse cell-range candidates until insertion or clearing invalidates them; returned arrays remain independent.

Both managed previews now run immutable production Docker images outside the development shell's CPU quota. `PUBLIC_ORIGIN` permits the exact public origin behind container NAT without trusting forwarded headers from arbitrary peers. Prediction remains bounded and server authority is unchanged. Sustained overload still slows the simulation; yielding does not manufacture CPU capacity.

The [browser harness](movement-testing.md) checks held keyboard input, authoritative and rendered movement, release, and 150 ms delayed snapshots. It also records prediction, reconciliation, scene update/render, and engine frame-boundary timings. Full-scene software-rendered Chrome still fails the movement gate; passing socket and simulation tests does not establish browser playability or hardware GPU performance.

## Research and dependency decision

Sources checked on 2026-10-12:

- [Gabriel Gambetta: prediction and reconciliation](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html) describes sequence acknowledgements, resetting to authority, and replaying outstanding commands. His [entity interpolation](https://www.gabrielgambetta.com/entity-interpolation.html) article explains why remote interpolation shows a different time and why unknown remote controls prevent exact prediction.
- [Glenn Fiedler: fixed timesteps](https://gafferongames.com/post/fix_your_timestep/) explains retaining elapsed-time remainder in an accumulator and bounding catch-up after stalls. The input clock follows this approach without granting the client authority over server elapsed time.
- [Glenn Fiedler: state synchronization](https://gafferongames.com/post/state_synchronization/) distinguishes physics state from visual smoothing. Apply corrections directly to physics; smooth only rendered errors. Interacting extrapolated objects need consistent velocities and timing. Our private contact world follows this approach without transferring authority to the browser.
- [Colyseus 0.18 client prediction](https://docs.colyseus.io/netcode/client-prediction) includes reconcilers, composite simulation state, clock estimation, remote interpolation and dead reckoning. Its [server input guide](https://docs.colyseus.io/netcode/server-input) recommends consuming one command before a shared-world physics step and warns against draining a batch while simulating only the last command. This is why normal FIFO processing stays intact; dropping old commands is explicitly an overload recovery policy. Colyseus is the strongest evaluated option for a future networking migration. Adopting it requires migrating rooms, schemas, transport, input and state handling together; installing its SDK alone would not repair our current contact display. The registry reports `@colyseus/core` 0.18.18, MIT.
- [Geckos snapshot interpolation](https://github.com/geckosio/snapshot-interpolation) provides buffered interpolation and snapshot history. It could replace our remote timeline, but leaves shared collision simulation and reconciliation integration to the application. Its default three-frame buffer would also add delay. The registry reports 1.1.1, BSD-3-Clause.
- [Rapier JavaScript determinism](https://rapier.rs/docs/user_guides/javascript/determinism/) requires matching initial state, insertion order, version and deterministic initialization. Rapier 3D is already installed for debris and corpses. It provides collision solving and snapshots, but not our input acknowledgements or remote rendering policy. A vehicle migration remains a separate authority-and-prediction change; see [physics scope](physics.md).

No new dependency is required for these demonstrated timing faults. The current shared solver and codec remain in use. This is not a claim that hand-built networking is preferable for a new project.

## Verification and remaining limits

`tests/prediction.test.ts` checks a real predicted vehicle impact through `GameNetwork.renderEntities`, snapshot immutability, render/replay separation, immediate neighbour impulses, a fast approaching car initially beyond 24 m, and authoritative recovery after stalled acknowledgements. Delayed-snapshot scenarios run at 0, 50, 100 and 200 ms with deterministic jitter and three render samples per input. The 200 ms case exercises the capped replay window when snapshot cadence and jitter exceed the horizon. These scenarios delay snapshots, not an entire bidirectional WAN connection.

`tests/input-timing.test.ts` uses real WebSockets with manually stepped authority. It checks overflow recovery, stop latency in simulation ticks, stale sequences, binary acknowledgement delivery and that bursts cannot accelerate authority. The debug transport test waits for observed authoritative displacement within a bounded deadline instead of assuming 400 ms of wall time contains enough server ticks. Existing gameplay tests cover off-centre impulses, maximum-speed wall impacts, parked-car blocking, moving vehicle strikes and server-owned damage. Existing transport tests exercise jitter, delta recovery, reconnects and production debug rejection.

Unknown player/AI controls, authority-only damage and changing collision geometry can still cause corrections. Close neighbours are extrapolated from their latest velocities, so their corrections may be visible. This work does not add full rollback of the entire city or predict other players' future controls. Saturated server ticks and poor browser frame rates remain independent sources of latency. The public preview's health endpoint reported a tick p95 above the 33.33 ms target during investigation; that is an observation on a shared host, not a benchmark or attribution of the CPU cost.

Headless Chrome at 1280 by 900 verified the built application through the direct managed preview listener: 189 sampled walking poses stayed outside a parked sedan, delayed snapshots retained contact, and 193 driving samples included the second car responding to impact. Screenshots were inspected. These stages produced no browser exceptions or HTTP failures. Evidence is local at `/tmp/afterhours-collision-browser/evidence.json`. Earlier public-URL attempts joined successfully but also encountered gateway HTTP 502s and a dropped WebSocket; the successful contact checks do not establish public-route or real-WAN reliability.

A separate headless reconnect check at the same viewport restored the same player identity and resumed prediction without browser exceptions or HTTP failures. Its evidence is local at `/tmp/afterhours-collision-reconnect/evidence.json`. All 167 automated tests, formatting, architecture boundaries, TypeScript and the production build pass.

## Timing, aiming and diagnostics

Browser messages now carry a local monotonic `timestamp` in milliseconds, including discrete actions. The scripting AgentClient stamps its messages too. Server messages carry `time` in simulation seconds; snapshots additionally echo the applied command's `ackTimestamp`. These clocks are separate: input age subtracts the echoed browser timestamp from the browser clock, never from server time. Timestamps are diagnostic and do not authorize extra simulation time. Optional action timestamps and acknowledgement fields keep protocol 4 clients compatible; legacy tools may omit action timestamps, while input timestamps remain mandatory.

Ping runs once per second independently of player input. The F1 networking section is available only with server-authorized debug tools (`ALLOW_DEBUG=1` in production). Ping is full round-trip time; the combat clock continues to use half of it as a latency estimate. Ping variation is an exponential average of changes between consecutive RTT samples, not measured packet loss. Snapshot age means time since the last accepted snapshot, and gap means the last accepted arrival interval. Rates count events in the past second. Applied input age includes both directions, server queueing and snapshot cadence; it is not pure network latency. Prediction status identifies missing collision coverage or stalled acknowledgements. The outgoing buffer is WebSocket bytes waiting to send. Diagnostics use bounded history and update only while the panel is open.

Very short keyboard presses and clicks are retained for the next regular 30 Hz input sample, then released. Held keys continue sampling without relying on operating-system key repeat. Multiple presses within one sample are coalesced; input events do not grant extra physics ticks. Blur, hidden tabs, map opening and camera switches clear pending presses and aiming. Mouse aim is recomputed from the displayed character to the pointer's ground projection on every input sample, so a stationary pointer stays meaningful while the player or camera moves. Different discrete actions no longer suppress each other through a shared 100 ms cooldown; per-action and total message limits remain.

Reconciliation still restores and replays physics on every accepted snapshot, including tiny errors. Only visual offsets ease out. Following Fiedler's visual smoothing guidance linked above, exponential decay varies smoothly from 6/s for small offsets to 18/s at 1 m or 1 radian. These are initial presentation settings, covered by convergence tests rather than a claim of optimal perceptual tuning. Residual position offsets below the codec's 1 mm precision and yaw below its 0.00001 radian precision clear to zero. Unexplained large corrections still snap. The threshold is at least 3 m and expands with current speed and the snapshot arrival gap (capped at two seconds), so normal flight travel is not mistaken for a teleport. Accumulated visual offsets survive packet bursts. Correction speed is capped at the larger of 18 m/s and twice current body speed; this preserves normal small-error easing without a large recovery jump. Yaw takes the shortest wrapped arc, long background pauses clear stale visual offsets, and collision constraints remain in force. Ignoring authoritative position errors would instead corrupt replay and collision decisions.

The updated suite passes 183 tests plus formatting, boundaries, types and the production build. Real-socket regressions cover RTT, timestamp validation and echoing, all movement fields, aim yaw, applied sequence numbers, idle rates and independent actions. The two Docker browser cases pass held movement, release, panel values and mouse-facing yaw before/after sideways movement at 0 and 150 ms added incoming-message delay. These are local headless checks, not real-WAN or hardware-GPU measurements.

Public verification on 2026-10-12: both existing managed previews run gameplay commit `dd9aaef` and pass local/public HTTP doctor checks. Headless Chrome at 960 by 700 entered the canonical HTTPS preview, verified held keyboard movement and live F1 diagnostics, then closed the socket and confirmed the same player rejoined on an open connection with fresh ping, acknowledgements and prediction. No browser errors or failed gameplay requests occurred after gateway login. Evidence is in `test-results/network-public/`. The shared T3 browser was authenticated but its automation host disconnected during the smoke check, so this completed verification ran headless.

## Helicopter snapback regression (2026-10-12)

The old 250 ms cutoff returned no predicted render pose, so `GameNetwork` switched to an older authoritative position, then forward again when prediction resumed. Deterministic cruising reproduced a 3.75 m backwards jump for Sparrow and 2.75 m for Atlas. Reconciliation also compared physics poses without accounting for the fractional movement rendered between input ticks. It now compares both extrapolated poses at the same monotonic receipt timestamp; physics state remains authoritative and visual offsets remain separate. The acknowledged command supplies the render input after a backlog clears, so old throttle cannot replace an acknowledged brake.

`tests/flight-network.test.ts` exercises both models at 60 rendered frames/s and 30 simulation ticks/s, with changing 120–360 ms incoming delay and one-second stalls followed by ordered delivery bursts. Steady cruising permits at most 1 cm of numerical backward movement and less than 1.5 m forward movement per rendered frame. Separate checks cover a fresh recovery snapshot without queued older packets, turning/braking through a capped window, the acknowledged stop, and a correction arriving after a render stall. Existing offsets age up to receipt time before new corrections are added, so a preceding frozen frame cannot instantly consume a new correction. These isolate client behavior and do not claim real-WAN or hardware performance. Existing prediction tests retain collision-map gating, contact constraints, stale-history rejection, passenger ownership, and hard teleport resets.

The implementation follows the physics-versus-presentation separation in [Fiedler's state synchronization article](https://gafferongames.com/post/state_synchronization/) and acknowledged-input replay in [Gambetta's reconciliation article](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html), rechecked for this fix. Increasing the prediction horizon or adding a networking SDK would not fix the abrupt fallback path. Sustained server overload, browser stalls and missing collision chunks remain separate limits.

Verification of gameplay commit `8ce4352`: all 214 automated tests, formatting, architecture boundaries, TypeScript and the production build pass. The canonical Docker preview passes local/public HTTP doctor checks. In the shared T3 browser on the public HTTPS URL, the Sparrow took off, climbed, flew under held W input, and stopped after release. A second flight added ordered 120/1000/120 ms incoming-message delay and reached 22 pending inputs before recovery. Its 43 samples over 12.3 seconds showed a largest backward step of 1.1 cm; the baseline's 16 samples showed none. Inputs used DOM keyboard events, and the real renderer supplied the displayed positions. The browser was severely frame-limited, so these samples establish a public flight smoke check, not smooth hardware performance. Both the injected delay and held inputs were removed. Raw evidence is local at `test-results/flight-public/evidence.json`. The shared browser initially rejected the public WebSocket with `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`; reloading restored the connection.

## Slow-server playback and shared snapshot preparation

The previous remote playback clock could slow only to 90% of wall time. When server simulation ran slower, it repeatedly reached the 100 ms extrapolation limit and paused between packets. Playback now estimates simulation seconds per wall second over the retained delivery window, after at least 500 ms of samples. Packet-level clock correction remains bounded and extrapolation remains capped. A deterministic ten-second, 60 FPS test with server time at two-thirds of wall time failed on the previous clock and now checks continuous movement without packet jumps. Existing uneven-delivery, disconnect and flight tests remain in place.

CPU profiles found neighbour queries, allocation and per-client snapshot preparation consuming substantial server time. The moving-body grid disables its ineffective query cache, which hit on only 4,626 of 441,120 queries in a 120-tick saved-city sample. Static geometry keeps its cache. Rebuilt grids reuse empty cells and columns without changing candidate order or exposing shared result arrays. Each broadcast now prepares rounded entity fields once for all recipients; immutable serialized field values preserve independent delta histories even when nested arrays mutate. A real two-peer socket test checks seat changes, nested jetpack changes and explicit field removal.

Alternating local saved-city runs showed lower typical cost in an initial prototype, but the final comparison overlapped heavy workspace jobs and changing CPU contention. It does not establish a reliable speedup or a production tick-budget pass. Real 16-player socket load checks also exceeded the budget, with zero rejected messages; their local timing is similarly affected by concurrent work. Raw local evidence is `/tmp/afterhours-spatial-comparison-final.json` and `/tmp/afterhours-load-final.json`. Sustained overload and native browser performance still require measurement.
