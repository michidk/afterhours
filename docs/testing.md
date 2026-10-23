# Testing

Each layer exists because something a player saw got past the one below it. CI runs all of them
(`.github/workflows/ci.yml`); run the same commands locally.

| Command                | What it runs                                                                    | What it catches                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test:rust`    | `cargo fmt --check`, clippy `-D warnings`, every Rust test (release)            | handling parity with the original, scene and session behaviour, collider orientation, ground heights, ack and held ticks, cache headers |
| `bun run test:parity`  | native and wasm physics hash of one scripted run (`scripts/check-parity.sh`)    | client prediction drifting from the server                                                                                              |
| `bun run test`         | JS unit tests (prediction, input clock, stamper, rendering helpers)             | prediction pose, input stamping, drawn-pose swap                                                                                        |
| `bun run test:feel`    | a real server and the real client stack, bot-driven (`tests/live/feel.test.ts`) | what the player sees: drawn position, smoothness, ground contact, corrections, server tick                                              |
| `bun run test:browser` | real Chromium renders the city and gameplay                                     | rendering failures (not latency; software GL is slow)                                                                                   |

## The feel suite

`test:feel` boots `afterhours-server` on a free port with the saved city, then runs
`scripts/drive-client.ts` (the browser's `GameNetwork`, prediction and input clock, with one-way
delay, jitter and spikes on its own socket) for six scenarios: walking, sprinting and driving a
sedan, each on a clean link and on a 74 ms link with 20 ms jitter and 150 ms spikes, along the
racetrack. `FEEL_SECONDS` sets the length of each (default 20). The bot calls the same
`renderEntities` the browser draws from, so its numbers are about the drawn body.

| Check                                        | Limit                                           | Why                                                                                                                        |
| -------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| drawn body vs predicted body, mean           | under one tick of travel, on both links         | the draw carries the body on by up to a tick (a healthy mean is half of it); the bug drew the server copy about 4 m behind |
| drawn body vs predicted body, worst          | one tick + 25 cm clean, 2 m on the spiky link   | a 150 ms spike makes the server hold the last controls, and the late inputs correct the prediction by up to a metre        |
| frames that stalled / lurched                | under 8% of frames each                         | stepping at 30 Hz stalled one frame in two and double-jumped the next                                                      |
| frames that moved backward                   | under 5%                                        | late input must not rewind the draw                                                                                        |
| drawn height over terrain (95th percentile)  | under 0.6 m                                     | wheels and feet on the ground                                                                                              |
| prediction corrections                       | at most 3 (15 on the spiky link), none over 1 m | the server agrees with what was predicted                                                                                  |
| inputs waiting for the server                | at most 20                                      | the input stream does not run away                                                                                         |
| player roster and positions reach the client | at least one each                               | the player list shows "Connecting…" until the roster arrives                                                               |
| server tick CPU (95th percentile)            | under 20 ms of the 33 ms budget                 | a slow tick delays everyone                                                                                                |

The limits are shares of frames and absolute metres so a loaded machine does not flip them;
`hitches` and the drawn-speed error are reported but not asserted, because they flag a 2 ms timer
wobble at walking pace. Observed on a host at load 15-35: stalls about 1% of frames, no backward
frames, no corrections, gap 0.02 m beyond the carry.

Mutation-checked: drawing the delayed server car fails with "drawn 3.99 m from the predicted
body"; removing the between-tick carry fails with "636/1236 frames stalled".

## Collisions with props

The feel suite also boots the test world on its own server and drives the sedan into a lamp, a tree
and a palm of its prop alley (`--strike`), on a clean and on the spiky link. It checks that the
server breaks the prop (a car at speed used to stop dead at it), that the client predicted the break
and showed it within 60 ms of the car reaching it (it showed 109-226 ms late before), that the
prediction led the server's confirmation, and that the hit corrected the car by under 1.5 m.
`--hitch 40` makes the bot block its main thread like a garbage-collection pause, to see late frames:
with it the drawn forward hops fell from 2.5% of frames to 0.3-0.6%.

## Real-city scenes

`cars_driven_at_the_real_buildings_never_end_up_inside_one` (`crates/server/tests/lab.rs`) drives a
sedan flat out at 16 rotated buildings of `data/city.json` and requires that no recorded position
lies inside a drawn footprint and that walls stop the cars. With the colliders mirrored it fails at
the first building. The scene lab can also walk (`drive` on foot), so on-foot problems have the same
JSON reproduction as driving ones (`docs/lab.md`).

The bot's report also carries `clientCpuMs`: what the client spends per frame on the prediction and
the draw list (about 0.4 ms mean, 0.9 ms p95) and per input (0.6 ms mean, 1.2 ms p95). The feel suite
holds the means to 3 and 4 ms, because a slow machine multiplies them (per-frame p95 is noisy on a loaded host). In a browser
with `?profile=1`, `window.afterhours.updateParts` splits the update stage into prediction, scene
update and the rest. The headless browser here renders in software (about 2 fps), so its frame times
describe the renderer, not a player's machine; use the Networking panel's Frame rate row there.

## When a player reports a problem

1. Reproduce it with a number: `scene-lab` or `handling-lab` for the world and the car, the bot for
   latency and drawing (`bun run bot:drive -- --url ... --model none|sedan --pattern track`).
2. Keep that reproduction as a test in the layer where it fails, and check it fails on the old code.
3. Prefer measuring what is drawn (`renderEntities`) over the predicted body or the server state:
   three "fixes" in a row passed on the prediction while the screen showed the server copy.

## Known gaps

No test runs a GPU-backed browser at a real frame rate or over the real public route (the preview
gateway and shared ingress stalled for seconds in `docs/lag-routing.md`), so a latency complaint that
passes here still needs the Networking panel from the player's session. Boats are drawn from the interpolated server copy; a piloted plane or
helicopter is drawn from the newest snapshot carried forward (`client/network/piloted.ts`) and is covered by
two feel tests (`--board --cycle N` reports enter/exit and turn latency; limits 200/190 ms clean, 330/320 ms
laggy). The enter/exit limit has not been mutation-checked against removing the urgent snapshot.
`docs/movement-testing.md` describes the older TypeScript-server harness; `test:network`,
`probe:drive` and the five-client acceptance there no longer exist except as `lag.yml`.
