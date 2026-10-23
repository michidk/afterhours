# Collision prediction and reconciliation

The server owns movement outcomes, damage, knockdown, seats and inventory. Clients predict kinematics with the shared solver, then replace that state with the latest authoritative snapshot and replay the remaining inputs before the next input or render. Every snapshot still updates authority and the remote interpolation timeline; queued snapshots do not each trigger an obsolete replay. Controls are sent before reconciliation runs. Prediction runs at 30 Hz with 120 Hz contact substeps. Render extrapolation and correction offsets never modify the replay state.

## Fast driving and shared collisions

The browser reads current controls for the fractional render step between 30 Hz commands. A turn can therefore appear on the next rendered frame instead of waiting for the next command. This changes only presentation; the server still consumes fixed-duration commands, and replay retains the exact controls that were sent.

Fast impacts used to disagree even on an otherwise perfect connection. The server broke a tree and retained 96% of the vehicle's velocity, while prediction stopped the same car against an unbreakable tree. Prediction now uses the same prop health and impact threshold for lethal single strikes, removes the collider from its private replay, and applies the same velocity loss. It resets that private state on each authoritative reconciliation and rebuilds it from pending inputs. It never changes the city's destruction overlay, health, pickups, or ownership. The reliable destruction update also carries each standing prop's accumulated damage, so the strike that finishes a dented prop is predicted like a lethal one instead of stopping the car and correcting it forward.

Prop collider tops, saved fixture placement, and debris spawn positions include terrain elevation. A car on raised ground is no longer mistaken for a car flying above a sea-level tree.

A predicted prop impact throws the prop at once with the same launch the server uses (`strikeVelocity`, `debrisSpin`): slightly faster than the car and up, so it clears the bumper instead of riding it. The browser flies it ballistically until the server's debris arrives, then follows the server. Debris the local car struck is drawn in the car's predicted time frame, extrapolated past the newest sample; other debris is interpolated on the same clock as remote cars, so another driver's strike appears when that car reaches the prop. Each new sample keeps the drawn pose where it was and stores the difference as an offset that decays at 3/s for small errors and up to 10/s for errors over a metre (Fiedler's two-rate smoothing); rotation errors decay the same way, and errors over 10 m snap. If the server does not confirm the impact within 700 ms, the thrown prop is withdrawn and the fixture stands again. At the 128-body debris limit, the server retires an older body's physics and retains its visible state until expiry, so capacity cannot make a new tree indestructible.

Player cars and AI cars keep the same server authority. Prediction advances private nearby bodies using their last reported driving controls and resolves provisional collisions; ordinary remote rendering uses buffered snapshots. Future steering by another player or an AI remains unknown until the next snapshot. A head-on collision can therefore still require a correction. Giving one driver authority over the other car would exchange that correction for conflicting ownership and cheat opportunities. It would not remove network delay.

This follows [Gabriel Gambetta's input replay and reconciliation](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html) and [Glenn Fiedler's separation of physics state from visual smoothing](https://gafferongames.com/post/state_synchronization/). Fiedler's [networked physics discussion](https://gafferongames.com/post/networked_physics_2004/) also explains why interacting bodies make prediction harder than motion against static geometry. [Epic's Unreal networked physics overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/networked-physics-overview) describes the same rewind, correct, replay, and visual interpolation sequence for Resimulation mode, and supports mixing it with Predictive Interpolation for other actors. These are design references, not claims that every game uses the same implementation.

## Input scheduling

The browser uses an elapsed-time accumulator for its 30 Hz input commands. Both timer wakeups and rendered frames pump the same clock, so overlapping callbacks cannot duplicate ticks. Short delays retain the fractional remainder and catch up with individually timestamped commands. A delay over 250 ms discards stale clock debt; hidden tabs reset the clock. The server still advances only one fixed physics tick at a time, regardless of packet bursts. Its per-client FIFO holds eight new commands, enough for a full 250 ms catch-up burst, plus late commands filling already simulated held slots. Counting held slots against the new-command budget caused valid batches to shed movement and over-advance acknowledgements. The total remains bounded at twenty-three commands; overflow beyond that allowance sheds the oldest command.

Each server tick applies exactly one queued command to the controlled body. If nothing is queued and the last command is younger than 500 ms, the tick runs on the last command's movement controls with actions stripped, and that slot is acknowledged in advance. The late command fills the slot on arrival without a second step; only its actions run. The body therefore keeps moving for everyone, and the driver predicted that tick with the same controls unless it changed them at exactly that moment, in which case the correction is one tick of control difference (centimetres) rather than a tick of travel. The client never predicts a slot the server has already acknowledged, so a browser stall cannot run those ticks twice either. A client whose clock never catches up would otherwise keep every tick on held controls, so after thirty consecutive held ticks the server skips one tick (no step, no acknowledgement) to let the commands arrive ahead of their slots again; `/health` counts these as `inputFrozen`. The browser's regulated clock normally ends such a run within half a second, before the fallback is reached. The runtime retains up to eight ticks of stall debt and repays it with complete world ticks. Each vehicle advances once per tick with the same 120 Hz contact ordering as prediction. Catch-up yields after four ticks or one tick budget of work; pauses beyond the bounded backlog can still require a correction. Silence beyond 500 ms releases controls; slots still owed are filled by the delayed commands whenever they arrive.

Every snapshot reports the net buffer after the tick: commands still queued minus slots already run on held controls, so it goes negative while the server is ahead of the client's commands. The browser input clock uses that to phase-lock its schedule: a negative buffer pulls the next command six milliseconds earlier, a buffer below `TUNING.inputBuffer` (two commands) two milliseconds earlier, and a buffer more than one deeper pushes it one millisecond later. The 30 Hz rate changes by at most a few percent and the rendered pose shifts by centimetres rather than a tick. Two spare commands ride out packets up to 67 ms late without any held slot; the driver never feels that depth because its own body is predicted, it only delays what other players see of the body. Retained server stall debt drains through whole-world catch-up ticks, keeping interacting vehicles on the same simulation clock.

The controlled body is drawn on a presentation clock that advances at the averaged command rate rather than at each command's own interval, so the input clock's pacing adjustments do not make the drawn speed surge and sag; see [movement testing](movement-testing.md#presentation-clock-2026-10-15). The rendered pose may now extrapolate up to two ticks past the last command's timestamp instead of one. It still sits one tick ahead of that timestamp in the normal case; the second tick only covers a wakeup that produced the command late, where the old cap held the pose and then lurched by the late amount (about 1 m at 52 m/s for a 20 ms late wakeup). Replay state is unchanged.

### Why: one-tick corrections scaled with speed (2026-10-13)

Before this change a dry queue re-applied the previous command, advancing the server one tick the client never simulated, and a full queue shed a command the client had already simulated. Both produced a one-tick position error, 1.7 m at 52 m/s and 15 cm on foot, which is why fast driving felt like drifting and being reset while walking seemed fine. Because every jitter event ratcheted the queue depth up by one, the FIFO sat at its cap and both faults recurred on every late or bunched packet. `bun run probe:drive` reproduced it deterministically: on a link with 40 ms base delay, 20 ms jitter and a 120 ms spike in three percent of packets, fifteen seconds at 52 m/s logged 40 held ticks, 36 shed commands and 29 corrections up to 3.5 m; a 3% server clock error alone produced a 1.7 m correction every second. After the change the same scenarios log zero shed commands, zero mispredicted held slots and zero corrections, and an observer client on a clean link sees the car advance every frame with no stall, jump or reversal.

Counting timer callbacks as ticks made prediction run slow whenever the browser delivered a nominal 33 ms callback after 50 or 80 ms. The server continued its held input during those gaps, causing recurring corrections. Scheduled command timestamps also keep fractional render extrapolation aligned with the accumulated ticks.

## Fixes and bounds

Remote entities normally stay on buffered interpolation, including nearby players.
Only bodies involved in a local predicted contact use provisional collision poses.
Contact detection uses the predicted world, avoiding false contacts between the
local current pose and a buffered remote pose. Entry and exit preserve the previous
displayed pose; after contact ends the target blends back over 500 ms. This preserves immediate impact
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

Server input remains one command per fixed world tick, including catch-up ticks. The eight-command FIFO absorbs a full browser catch-up burst; on overflow it drops the oldest command, retaining the newest stop or turn. An acknowledgement identifies the newest applied command; older discarded commands also leave client history. Overflow therefore permits a correction. It does not grant extra physics steps or claim to have simulated discarded commands. Duplicate or out-of-order sequence numbers remain rejected. A 500 ms input silence releases held controls. Coasting still consumes and acknowledges one command slot per world tick, so replay cannot add that movement again. The snapshot reports the last silent coasting slot separately from held-control acknowledgements. A resumed browser skips unsent slots through that coasting slot; the server retires any unsent slots in that gap before applying the fresh command. Coasting does not refresh the input timestamp; late commands extrapolate it only through held-control slots. The input-age diagnostic therefore continues exposing stale controls. Protocol 10 requires a browser refresh so the two sides agree on these recovery semantics. `/health` counts `inputSpeculated` (ticks run on held controls), `inputMispredicted` (held slots whose command changed controls), `catchUpTicks` (extra complete world ticks within a runtime callback) and `inputDrops`; a growing drop count means commands arrive beyond the bounded queue capacity, either in delayed bursts or faster than the server ticks.

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

Protocol 8 includes the last authoritative driving controls for cars and watercraft. Older clients receive an explicit refresh response before the socket closes. Physics remains at 120 Hz and authority at 30 Hz; the optimization does not lower collision frequency or give the client additional simulation time.

## Server tick cost (2026-10-13)

Production could not hold 30 Hz. Two samples of the public `/health` showed the simulation advancing 17.9 s in about 25 s of wall time with two players (72% of real time) and 26.9 s in 30.7 s with nobody connected (88%), at 26 ticks per second, with a tick p95 of 49 to 70 ms against the 33 ms budget. Every client then saw slow motion, stretched playback and constant corrections, and a second player made it worse. The cost is the simulation, not the players: with nobody connected the process still spent about 0.8 CPU cores.

Profiling the real server loop (`bun run bench:server`) put about 85% of the tick in the four 120 Hz physics substeps, each of which touches every AI body in the city, while snapshots and sockets were a few percent. Production ran about four times slower per tick than the development machine, so the worst cases were the ones to fix. Changes, each measured and covered by tests:

- **Level of detail for bodies nobody can reach** (`Simulation.distantAi`). An AI body farther than `contactRange` from every human takes one 30 Hz step per tick instead of four, with its timers advanced by the whole tick, and joins only the first contact pass. `contactRange` is the same function the client uses to decide which neighbours to predict, so a body a client could predict a contact with is always simulated at full rate. Distant pedestrians re-plan every fourth tick, staggered by id, with the real elapsed time and without repeating attacks. Over 2,400 ticks per variant, alternating in one process, the mean tick fell about three times (9.5 to 3.1 ms thread CPU), with players downtown or far from it. A distant body integrates once per tick and ends within a few centimetres of the full-rate result; `tests/server-lod.test.ts` pins both facts, and that a body within reach is bit-identical to the old path.
- **Route search.** Breadth-first search now uses typed arrays and cached neighbour ids instead of a hash map and a new array per visited node: the same routes (checked against the original algorithm on the generated city), 3.7 times faster for roads and 7 times for sidewalks, worst case 10.5 to 2.7 ms.
- **Static collision grid.** Breaking or restoring a prop rebuilt the grid of every collider (9,719 props in the saved city): median 12.8 ms, up to 40 ms, on the server and in every browser. The grid is now updated in place and keeps colliders in their original order, so queries match a fresh build exactly; the update costs well under a millisecond.
- **First debris event.** Rapier built the terrain acceleration structures on the first live step, 84 ms inside a tick. `prepare()` now runs a throwaway body against the terrain before the server listens; the first impact costs about 30 ms in total.
- The spatial index of moving bodies is rebuilt only on the substeps where AI decisions read it.

### Sleeping parked vehicles and 15 Hz distant bodies (2026-10-15)

The new destinations park vehicles all over the island: moored boats, airport planes, the town hall's cars and the racers on the grid. The level of detail covers only AI bodies, so every one of them ran full-rate physics, and the tick cost about 19% more than before (mean 5.3 ms against 4.4 ms on a desktop, `bun run bench:simulation`). A vehicle with no driver or AI, nothing burning, flooding or wrecked, no motion, and settled on ground gentler than half a grade or afloat now sleeps (`Simulation.asleep`): it skips integration and static contacts but stays an obstacle, so a hit that gives it velocity wakes it on the next substep. Moored boats keep their height on the swell, set once per tick. Distant AI bodies now move every other tick with a doubled step and doubled decision time, half of them on each tick, which is 15 Hz: the rate snapshots carry them at. Their pedestrians count only the ticks they move when spacing re-plans. Together the tick fell to a mean of 3.2 ms (p95 5.0 ms, from 7.9 ms).

On 2026-10-15 production also stalled for seconds at a time because its node ran at 95% CPU, almost all of it another workload; a single-threaded 30 Hz simulation cannot keep time on an oversubscribed node however cheap its ticks are.

Wall-clock timing on a shared machine is noisy, so the comparisons use alternating blocks and thread CPU time (`bun run bench:lod`). They show relative cost, not production capacity: measure `/health` after a rollout (`ticks` against wall time, `late`, `tickP95Ms`). Distant bodies beyond a human's view are simulated more coarsely by design; a debug camera that moves snapshot interest far from every human will show them.

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

Headless Chrome at 1280 by 900 verified the built application through the direct managed preview listener: 189 sampled walking poses stayed outside a parked sedan, delayed snapshots retained contact, and 193 driving samples included the second car responding to impact. Screenshots were inspected. These stages produced no browser exceptions or HTTP failures. Earlier public-URL attempts joined successfully but also encountered gateway HTTP 502s and a dropped WebSocket; the successful contact checks do not establish public-route or real-WAN reliability.

A separate headless reconnect check at the same viewport restored the same player identity and resumed prediction without browser exceptions or HTTP failures. All 167 automated tests, formatting, architecture boundaries, TypeScript and the production build pass.

## Timing, aiming and diagnostics

Browser messages now carry a local monotonic `timestamp` in milliseconds, including discrete actions. The scripting AgentClient stamps its messages too. Server messages carry `time` in simulation seconds; snapshots additionally echo the applied command's `ackTimestamp`. These clocks are separate: input age subtracts the echoed browser timestamp from the browser clock, never from server time. Timestamps are diagnostic and do not authorize extra simulation time. Optional action timestamps and acknowledgement fields keep protocol 4 clients compatible; legacy tools may omit action timestamps, while input timestamps remain mandatory.

Ping runs once per second independently of player input. The F1 networking section is available only with server-authorized debug tools (`ALLOW_DEBUG=1` in production). Ping is full round-trip time; the combat clock continues to use half of it as a latency estimate. Ping variation is an exponential average of changes between consecutive RTT samples, not measured packet loss. Snapshot age means time since the last accepted snapshot, and gap means the last accepted arrival interval. Rates count events in the past second. Applied input age includes both directions, server queueing and snapshot cadence; it is not pure network latency. Enter / exit vehicle is the time from pressing the interact key to the first drawn frame in the new seat; Turn response is the time from a steering press (from near-straight, above 3 m/s) to a visible heading change of about one degree. Both are measured on what is drawn, include the link and the physics, and show a dash until the first sample; a car's turn is bounded by the steering rate and suspension, so compare it with a plane's rather than expecting zero. Enter and exit make the server send a snapshot at once instead of waiting for the next even tick, and a plane or helicopter you pilot is drawn from the newest snapshot carried forward to the present rather than from the interpolation delay behind. Prediction status identifies missing collision coverage or stalled acknowledgements. The outgoing buffer is WebSocket bytes waiting to send. Diagnostics use bounded history and update only while the panel is open.

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

Alternating local saved-city runs showed lower typical cost in an initial prototype, but the final comparison overlapped heavy workspace jobs and changing CPU contention. It does not establish a reliable speedup or a production tick-budget pass. Real 16-player socket load checks also exceeded the budget, with zero rejected messages; their local timing is similarly affected by concurrent work. Sustained overload and native browser performance still require measurement.

## Collision-map fallback presentation

Missing collision coverage disables local physics and clears inputs that cannot be replayed safely. Rendering keeps the latest authoritative body and smooths the transition from the last displayed pose instead of replacing it with the raw snapshot. Returning to prediction preserves that displayed pose too. Forward-moving fallback poses do not rewind as authority catches up; stopped poses converge, and large authoritative teleports still reset presentation. Loaded collision constraints still apply to visual offsets. The regression covers map loss, recovery, input suppression, convergence and teleport resets through `GameNetwork.renderEntities`.

## Remote driving and connection recovery

Snapshots carry the last throttle, steering, handbrake and service-brake forces
applied to cars and watercraft. Private prediction neighbours apply those controls
with the shared solver and speed limits. This covers ongoing braking and turning,
including impulses passed through a pileup. A new remote input or AI decision is
unknown until the next snapshot; prediction still corrects to server authority.
Contact presentation follows target movement and settles its visual offset, so
stalled snapshots do not keep a vehicle advancing through cosmetic extrapolation.

Oversized or malformed WebSocket frames close the offending connection. Congested
sends leave snapshot bases, roster and destruction delivery markers unchanged,
so subsequent broadcasts retry persistent state. A full city can replace an
existing active session by token without admitting another player. Pending
connections have their own bound and must join within five seconds, even if they
send pings.

## Bounded client traffic and adaptive interpolation

The client allows at most 4 KiB of queued WebSocket traffic, including the next
message. It tracks each write's byte range and reconnects when the oldest
remaining bytes have waited 250 ms, matching the server's eight-command buffer
(about 267 ms at 30 Hz). New writes do not inherit the age of drained writes.
After a gap over 100 ms between sends, queued writes get a fresh age window so
the resumed browser can update its buffered-byte count.
A five-second response deadline starts with the connection attempt and is renewed
by welcome, snapshot or pong messages. If the browser misses heartbeat checks
for over two seconds, it grants a fresh response window so queued replies can
run after shader compilation or tab suspension. Recovery immediately clears provisional
prediction and pending debug requests; an unsent command is never predicted.
Callbacks from a superseded socket cannot affect its replacement. The restored
session starts a fresh sequence history. Snapshot progress has a separate deadline:
after 500 ms without an accepted state the client requests a full snapshot, and
after two seconds it reconnects even if pongs still arrive. A paused browser gets
the same resume grace before either deadline is enforced. The 250 ms heartbeat
grants that grace when its callback gap exceeds 500 ms; waiting until a gap
exceeded the two-second snapshot deadline incorrectly disconnected clients after
shorter stalls when the last snapshot was already old. The networking panel keeps
the last disconnect cause across reconnects, including WebSocket close codes.
During the server's
15-second reconnect grace, seats stay assigned and stale controls are replaced
with idle controls and a parking brake. Expiry removes the player and releases
the seat. Browser WebSocket close cannot retract
bytes already handed to the transport; session takeover clears the server's old
command queue.

Remote traffic retains a continuous playback clock and a 100 ms extrapolation
limit. The interpolation delay starts at 100 ms and grows to at most 250 ms using
the 95th percentile of excess delivery gaps in the last 30 snapshots, adjusted
for a slower simulation clock. Delay falls by at most 5 ms per second when delivery
stabilizes. The render clock slows to accumulate the extra buffer instead of
rewinding. First-time spikes and outages beyond this bound can still exhaust it.
`GameNetwork.stats().interpolationDelay` reports the current target in milliseconds.
The regressions cover recurring 256 ms delivery gaps at 52 m/s, continuous motion,
steady and slower simulation clocks, bounded outage behavior, and reset.

## Pileup prediction profile

CPU profiles in Node and Chromium identified collision-pair construction and
sorting as the largest cost in a dense prediction pileup. The sweep now groups
candidate neighbours by numeric ID rank and sorts each group. It retains the
same broad-phase bounds, every eligible pair, and the exact ID order of the
solver. No substeps, contact passes or reachable neighbours were removed.

[Recorded runs](prediction-profile.json) compare commit `38f9bce` with this change:
40 sport cars against a wall, six commands awaiting acknowledgement (about
200 ms plus input/snapshot phase), 30 Hz inputs,
60 Hz render calls, 60 warmup frames and 120 measured frames per run. Five
alternating standalone Chromium runs reduced median total prediction CPU time
from 2.97 s (range 2.85–3.84 s) to 1.75 s (range 1.47–2.28 s), about 41%.
Contact counts, pending command counts and motion checksums matched exactly.
The separate CPU profile attributed its largest share to pair construction and
sorting; contact geometry and garbage collection remain substantial costs.

The shared host had 12 logical CPUs and a load average of 23 at the start, with
unrelated builds active. This is a full prediction-path comparison, including
reconciliation, inputs and render extrapolation; it excludes Babylon rendering,
network transport, and real players' changing inputs. It does not establish
production FPS or smooth WAN behavior. The unbundled development modules were
identical on both sides except for pair generation. Node measurements had
wider overlapping ranges under contention and are not used for a speedup claim.

A separate headless Chromium check at 1280×900 used a real server WebSocket,
spawned 16 sport cars, entered a vehicle and delayed incoming messages by 200 ms.
Over six seconds it processed 144 inputs and 276 render calls, stayed connected
and predicting, and ended with four pending inputs, no resyncs and no outgoing
buffer. Prediction/render p95 was 33.6 ms on this loaded host, so the live path
still exceeded a 60 FPS frame budget. No browser exceptions or HTTP failures
occurred in the successful check. Earlier attempts hit a debug action rate limit
and an HMR reload; the public preview WebSocket also rejected authentication.
This check ran headless through the direct managed listener, without GPU gameplay.

Run `bun run bench:prediction` for five local prediction-path samples, or append
`--cpu-profile` to write a DevTools-readable profile to
`test-results/prediction.cpuprofile`. The browser workload can be imported from
`/scripts/prediction-workload.ts` on the development server; the lightweight
`/scripts/prediction-profile.html` page avoids including GPU rendering in CPU
measurements. Both are development tooling and are absent from the production
client bundle.

### Small collision worlds

For at most 64 eligible bodies, collision-pair generation now scans in ID order
directly. Larger worlds retain the spatial sweep. Both paths emit the same pairs
in the same order, including the correction margins and vertical cutoff. This
removes the sweep sort and per-body neighbour lists from small prediction worlds.

[Five alternating Chromium runs](prediction-small-world-profile.json) of the
same 40-car workload measured a median of 1.535 s before and 1.257 s after for
120 frames, an 18% reduction. Ranges were 1.456–1.774 s before and 1.226–1.278 s
after. Every run retained the same motion checksum, 4,680 contact observations,
and eight pending commands. A separate CPU profile identified pair construction
and sorting as the largest cost. The shared 12-core host also ran tests and builds.
The browser tool timed out after seven samples; the remaining three samples ran
in a subsequent call in the same page. No sample was discarded.

This measures reconciliation, input prediction and render extrapolation in the
T3 Chromium tab. It excludes Babylon rendering and transport. After-change p95
remained 34–37 ms in this dense scenario, so this is not a 60 FPS or WAN smoothness
claim. A 30-second public-server walking probe stayed connected, but did not
reproduce the reported snapping. The two-client driving probe also stayed
connected and kept simulation time current, but failed its speed gates after
cars encountered scenery; it is not a successful driving acceptance run.

## Delayed-batch recovery (2026-10-18)

The recovery queue now reserves space for commands filling held slots separately
from its eight new commands. A deterministic socket test previously dropped six
commands when six held slots and eight new commands arrived together. It now
retains the batch, fills each held slot once and simulates every new command once,
for both walking and driving. A second case covers twelve held slots.

Held movement now continues for up to 500 ms, with at most fifteen outstanding
held slots. The previous 250 ms cutoff briefly released controls during a replay
with 40 ms base one-way delay, up to 30 ms jitter and occasional 220 ms spikes.
That seeded fifteen-second replay went from one 1.724 m correction and one dropped
command to no corrections or drops. This is a deterministic regression result,
not a production latency improvement. Movement stays authoritative; attack is
never repeated by held input. Silent clients release controls after the bounded
window, and changing controls during an outage can still require reconciliation.

The production trace included outages longer than a second. This change does not
remove that underlying transport delay or promise smooth movement through it.

## Input lead (Rust server)

Each input is stamped with the server tick it should run on (`client/network/lead.ts`). The
snapshot's `lead` says how many ticks early the newest input arrived (the Networking panel's
"Server input buffer"); the stamper aims for about two and bumps its target when inputs arrive
late. The server runs one input per tick, so a send timer slightly faster than 30 Hz used to
stack extra inputs until a resync (a clean link sat at 9-10 commands, about 300 ms of input age
and ten pending replays). The stamper now skips a slot whenever its stream is already more than a
tick past the aim, and its target decays by a quarter tick per snapshot once the lead exceeds
three. `tests/input-lead.test.ts` simulates the loop over lan, 74 ms and stalling links at 30, 31
and 32.3 Hz sends (`tests/support/link.ts`); `scripts/drive-client.ts` measures the same live.

## Entity heights and steering

Clients draw an entity at its reported `y`, and the car renderer treats a car as airborne unless
`y` is the ground under its wheels (`carGrounded`), as the original game reported it. The physics
body centres sit above that, so the server subtracts `VEHICLE_REST` (1.26 m, tilt-adjusted) for
cars and `CHARACTER_FEET` (0.91 m) for people, and the client's local prediction applies the same
offsets to the wasm body. Without them every car hovered about 1.3 m up with drooping wheels and
people floated. `Entity.steering` is the front wheel angle in radians from the physics, and the
local car reads it from the predicted body so the wheels turn with the key, not a snapshot later.
`cars_and_people_are_reported_at_ground_height` and `the_front_wheels_turn_gradually_to_the_steering_lock`
in `crates/server/tests/scene.rs` pin both.

## Cars in the predicted world

The client's predicted world has terrain, water, buildings and parks. It also keeps the (up to
eight) cars within 40 m as real bodies, reset from every snapshot and coasting between them
(parked ones hold their brake), so driving into a parked or passing car stops the predicted body
where the server stops it. Before this, every touch of another car was a 1-2 m correction: the
`scripts/drive-client.ts` run that hits a parked car near spawn went from 2-3 corrections (up to
2.3 m) to none. `restore_entity` and `state_of` in the physics crate restore and read one body
without disturbing the rest. Shortcuts: props (lamps, trees) and other people are not predicted,
and a neighbour's future steering and throttle are unknown, so a head-on with a moving car can
still correct.

## The ack, held ticks and server cost

`ack` in a state message is the newest tick the state includes, input or not: when no input
arrived the server runs the held controls and still acks that tick. Acking only real inputs made
the client replay one tick too many after a held tick and one too few after the next, a +-1.2 m
seesaw at 18 m/s even on a clean link. A jump in the client's stamp stream skips server ticks
that run on held controls, so the client steps its prediction through them with the last input.
`scripts/drive-client.ts --pattern track` over a 150 ms round trip with 40 ms jitter and 250 ms
spikes went from 44-61 corrections a lap (about 20 over 1 m) to none.

The server tick must also fit its 33 ms budget. Two costs had grown past it on a busy server (tick
CPU p95 35 ms with 50 cars): `record_impacts` scanned every prop collider (thousands) for every
contact pair of every car on every substep, now a reverse map, and the tyre model kept every
parked car awake. Sleeping cars with the pedals up now skip suspension and tyre work. The Server
stats window shows tick CPU, late ticks and dropped time; `cargo run --release -p
afterhours-server --example tick-cost` measures the cost as cars accumulate (about 5 ms with 50).

## What is drawn

The mesh and the camera follow the entity of the thing you control. `withPredicted` swaps the
predicted body into the player and, when the player drives a car, into that car too; before, only
the player was swapped and a car at 18 m/s was drawn about 4 m behind the prediction (the server
copy, interpolated). The predicted body advances on 30 Hz input ticks, so `Prediction.render`
carries its last step forward by the time since that step, capped at one tick, instead of drawing a
stall and a double jump on a faster screen. A walker's predicted velocity comes from the same step
(the physics row has none).

Cars within 16 m of you are drawn the same way, not from the server copy: the prediction already
simulates them (restored from each snapshot and replayed through your unacknowledged inputs, so
they are time-aligned with your own body), and a collision is decided in that world. The server
copy is an interpolation delay behind, so a car passing at 10 m/s was drawn about three metres from
where the predicted body met it. Each such car carries its own correction easing and between-tick
step, and fades between the two over 0.4 s at the 16 m edge so nothing pops. Cars further out, and
other people, are still interpolated from snapshots.

The server also sends `roster` (who is in the city, on every join and leave) and `positions` (where
everyone is, about twice a second); the player list, nameplates and island map read them.

The drawn car also carries a velocity: the suspension springs (heave, pitch, roll) are driven by how
fast it changes between frames. The prediction only steps at 30 Hz, so the velocity is ramped from the
previous step's value to the new one across each tick; as a step it was 0 on one 60 fps frame and
double on the next, and the body rocked (frame-to-frame pitch jerk 8.6e-4 against 3.7e-5 ramped).

## Props and collisions

Trees, palms and lamps (`city.props`, about 7,400 in the city) are colliders on the server and, within
45 m of you, in the predicted world too (`Prediction.syncProps`). On each _live_ input step (not on
a replay, or one hit would count again at every snapshot) the server's strike rule runs: above
2 m/s a hit does `(speed - 2) * 14` damage, and at the prop's health (palm 65, tree 90, lamp 45) it
breaks, keeps 96% of the car's speed and flies off. A predicted break goes into `predictedImpacts`, so
the scene throws the debris at the impact instead of when the server's `broken` list arrives (a
round trip later: 109-226 ms measured). The server confirming it keeps the prop out; one it does not
confirm within 1.2 s stands again, and so does one the server's debris has expired. People and the
benches, signals and hydrants the original game had are not colliders here.

The server's strike detection used to ignore any contact with a positive gap. Rapier stops a fast
car on a speculative contact a few millimetres before it touches, so a car at speed registered an
impact of 0.1 m/s and stopped dead at every tree and lamp. `IMPACT_REACH` (5 cm) counts those
contacts; the approach speed is read from before the step. `a_fast_car_registers_the_speed_it_hits_a_prop_at`
(physics) and the strike tests in the feel suite pin it.

The carry between ticks is measured from the input's own scheduled slot, not from when `input()` ran,
and capped at two ticks. When a frame is late and the input clock steps several slots at once, the
drawn body still moves by exactly the elapsed time; with 40 ms stalls every 0.7 s the visible forward
hops fell from 2.5% of frames to 0.3-0.6%.
