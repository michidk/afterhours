# Production movement lag reproduction

On 2026-10-18, independent scripted clients reproduced walking and driving
corrections on production without injected delay, jitter, or packet loss.
The probes use the real client networking, input clock, map streaming, and
prediction through `scripts/drive-client.ts`; they do not render the game.

Client revision: `1043106`. Production server revision: `f4cc921`.
This is a reproduction report, not a deployed fix or a browser FPS measurement.

## Results

Two public walking clients ran concurrently for 40 seconds. They recorded
maximum corrections of 1.34 m and 5.33 m. Both encountered a late snapshot
delivery gap; one reached a snapshot age of 1,337 ms. The map was ready.
Client scheduling gaps peaked at 142 ms, too short to explain that outage.
Over the enclosing health interval the server advanced 1,477 ticks in 49.23
simulation seconds, with no increase in late ticks or dropped simulation time.
The input-drop counter increased by 146.

A second comparison drove two cars on separate clear airport loops for 45
seconds, one through the public hostname and one through the service ClusterIP.
The public client recorded a 4.02 m maximum correction and 14 forward lurches;
the direct client recorded a 0.77 m maximum correction and no forward lurches.
After excluding the first five seconds, sampled correction maxima were 3.56 m
and 0.77 m respectively. The runs overlapped, but did not start simultaneously.

The walking comparison was repeated with public and direct clients. In the
same absolute-time window, excluding public startup:

| Maximum sampled value | Public route | Direct service |
| --- | ---: | ---: |
| Position correction | 6.45 m | 0.001 m |
| Snapshot age | 1,628 ms | 166 ms |
| Acknowledgement age | 1,995 ms | 311 ms |
| Pending inputs | 60 | 9 |
| RTT | 1,397 ms | 48 ms |

The public repeat ended prematurely at 36.75 seconds with Node v26.11.1
`InformationalError: socket idle timeout` from Undici's HTTP/2 stream. Its
preceding samples remain usable, but it has no final summary. The direct
repeat completed 60 seconds. That harness error is not evidence that browsers
disconnect in the same way.

## Interpretation and limits

The captured sequence is delayed snapshots/acknowledgements, growing pending
inputs, prediction waiting for acknowledgements, then metre-scale corrections
when authority catches up. The simultaneous direct connection was much more
stable. This implicates the public connection path, but does not identify a
specific proxy, network hop, transport implementation, or buffering mechanism.

These tests reproduce the symptom with two probes; they do not establish how
it scales with player count. Normal collision corrections can also occur.
Initial walking map-loading samples are excluded from the reported sampled
maxima. Full-run summaries include startup. Correction sizes measure prediction
reconciliation error, not necessarily a one-frame visual teleport: rendering
can smooth the correction. Lurch/freeze counters are harness frame heuristics,
not counts of seconds. No browser rendering performance conclusion follows.

## Repeat commands

Run two independent processes concurrently, with distinct names and outputs:

```sh
node --import tsx scripts/drive-client.ts \
  --url https://afterhours.k8s.lohr.dev --model none --seconds 40 \
  --pattern zigzag --name 'Lag probe A' --output /tmp/walk-a.jsonl
```

For the route comparison, use the same walking command with the service's
current ClusterIP (`http://10.152.183.129` during this run) from a host that can
reach it. This bypasses the public route, including TLS; it is not a perfectly
controlled single-hop comparison.

Driving used `--model sport --seconds 45 --x 292 --z 620 --radius 18 --speed 12`
on the public route and `--x 292 --z 700` on the direct route. Inspect the
current city before repeating: these coordinates were clear airport loops for
this city, and previous probes can leave parked cars behind.

Selected raw samples and unmodified run summaries are saved in
[lag-reproduction-evidence.json](lag-reproduction-evidence.json). Full JSONL
traces and process logs were retained in `/tmp/afterhours-repro/` on the test
host; those temporary files are not durable repository artifacts. No production
configuration was changed or service restarted for these tests.
