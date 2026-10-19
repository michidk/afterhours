# Main-node production recheck

The lag remains unresolved. This public-hostname run tested five people, five cars,
then five planes against kernel-diagnostic release `b0d4e45` on `main.lohr.dev`.
Each phase measured 60 seconds after ten seconds of acceleration, with all existing
acceptance gates unchanged. All fifteen clients failed at least one timing gate.
The [complete report](lag-public-main-recheck-five.json) retains all clients.

Maximum snapshot age was 599.64 ms, applied-input age 735.18 ms, correction
0.299 m, and generator timer delay 173.31 ms. One car resynchronized its inputs.
All clients sustained movement and all five planes sustained flight. Simulation
rates remained near real time; that does not make delayed updates acceptable.

Raw health, TCP, client traces, and timing correlation are retained at
`.codex/lag-check/results/public-main-recheck-514069c/`. There were 1,383 health
observations. The timing correlation rejected 187 slow observations and one failed
request, retaining 1,195 observations, but paired only one failed client timing
sample within 100 ms. Therefore this run cannot establish a kernel or proxy cause
from those pairs. The raw evidence includes every observation.

The server's reported maximum tick wall time reached 467.68 ms while its reported
maximum tick thread CPU time reached 58.46 ms. These rolling maxima do not identify
the same tick, and CPU accounting excludes other threads. They motivate scheduler
and pause diagnostics rather than proving a particular source of waiting.
Several health requests also took multiple seconds before the server sampled its
response, despite much shorter kernel reads. These request durations include DNS,
connection setup, server scheduling, and transport; they are not simulation-pause
measurements.

Infrastructure commit `2996f239` pins the already published scheduler diagnostic
image `7d34079`. The exact configuration passed `just verify` before pushing to
main. It changes no gameplay, DNS, workload placement, or resource reservation.
Deployment runs through infrastructure CI. The earlier scout browser rewind remains
unresolved and recorded in `lag-scout-browser-failure.json`; passing local scout
repetitions do not erase it. Opt-in scheduler counters are being released to gain
production evidence despite that known movement failure, not as a gameplay fix or
as a claim that all browser gates passed.

Recorder commit `514069c` adds replayable browser movement traces. Its CI verification
and network jobs passed; browser and image jobs were still running when this report
was written. Inspect live CI and the pod image before claiming either release is
validated or deployed. Acceptance still requires the unchanged production tests to
pass and the browser rewind to be resolved.
