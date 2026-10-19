# Production kernel capture, 19 October 2026

The lag remains unresolved. Release `b0d4e45` passed all CI jobs in
[39311931317](https://github.com/michidk/afterhours/actions/runs/39311931317).
Infrastructure release `1416fc3b` passed `just verify` and deployed successfully
in [39313404021](https://github.com/michidk/k8s/actions/runs/39313404021).
The replacement pod `afterhours-84dfcf57cc-f5wxz` became ready on `main.lohr.dev`
with zero restarts. Its public health endpoint returned the new kernel fields.
DNS and workload placement were unchanged.

The [public report](lag-public-kernel-five.json) retains all fifteen clients and
the unchanged acceptance gates. Each phase measured sixty seconds after ten
seconds of acceleration. Thirteen clients failed; two planes passed. All clients
sustained movement and all planes sustained flight. Maximum snapshot age was
433 ms, applied-input age 622 ms, and correction 0.291 m. Generator timer delays
stayed below 136 ms. Simulation stayed near real time. This is one diagnostic
run, not evidence of a performance improvement over earlier runs.

Capture data is retained under
`/home/vibepod/workspaces/afterhours-kernel-transport/.codex/lag-check/results/public-kernel-five/`.
It includes `capture.json`, `five-client.json`, `health.jsonl`, `tcp.jsonl`,
`movement.log`, and `client-traces/`. All 1,313 health requests succeeded; 300
observations exceeded either 250 ms request duration or 100 ms kernel-read
duration and were excluded from precise timing correlation, not from the raw
capture or movement verdict.

The [census](lag-public-kernel-census.json) matches each failed timing sample to
the nearest usable server observation within 100 ms. Only six samples matched,
all for applied-input age. None of the stale-snapshot samples had an observation
meeting those constraints. Three car samples matched empty game TCP send queues;
three plane samples matched a 1,000-byte queue on one game connection. All six
had fresh application snapshot writes and no current retransmission timeout
retries. A nonempty queue can contain bytes in flight, and an empty game queue
only establishes acknowledgement by nginx. These samples do not establish a
kernel or proxy cause for the stale snapshots.

Server pump telemetry retained a 589 ms gap during the overall capture. Of the
eighteen measured samples with snapshot age above 300 ms, thirteen had a recorded
pump pause overlapping the interval since the client's last received snapshot.
Five did not. An overlap does not establish that the pause explains the entire
gap. Server scheduling and downstream delivery both remain under investigation;
the new evidence does not justify a DNS change, moving another workload, or
relaxing the acceptance thresholds.

A separate [local CPU profile](lag-kernel-local-profile.txt) ran the real server
loop with five socket clients for twenty seconds, using Node 24 and source
matching the deployed release. It is a diagnostic profile on the VibePod's x86
host, not a production latency result on main's ARM host. The script includes
client socket work in the profiled process and does not drive cars or planes.
It completed 607 ticks with no late ticks; profiled tick p95 was 22.5 ms.
Simulation stepping dominated active CPU time, while spatial query, clear and
insert together accounted for about 7.6% of total sampled wall time. This
identifies spatial-grid rebuilds as an optimization candidate, but does not
prove they cause production's long scheduling gaps.
