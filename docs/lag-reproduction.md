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
| --------------------- | -----------: | -------------: |
| Position correction   |       6.45 m |        0.001 m |
| Snapshot age          |     1,628 ms |         166 ms |
| Acknowledgement age   |     1,995 ms |         311 ms |
| Pending inputs        |           60 |              9 |
| RTT                   |     1,397 ms |          48 ms |

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

## Deployed recovery fix and remaining route delay

Release `73411f2` was deployed by infrastructure commit `c04c1630`.
All 411 local tests passed, as did CI verification, real-WebSocket tests,
browser tests and image publication. The deployment workflow completed
successfully and the new Pod became ready.

Two concurrent public driving clients each completed 45 seconds with no counted
corrections, forward lurches or freezes. Snapshot ages still reached 333 ms and
298 ms after startup. Two concurrent public walking clients completed 40 seconds,
but still encountered snapshot ages of 680 ms and sampled corrections of 1.87 m
and 0.80 m after the first five seconds. These are short smoke checks under
uncontrolled network conditions, not a measured speedup or proof that all lag is
fixed.

A separate 60-second WebSocket ping comparison returned these maximum RTTs:
service 81 ms, ingress on work2 93 ms, ingress on main 455 ms, and the ordinary
hostname 361 ms. The main ingress route remained slower even without movement
prediction. The test reconnected unjoined sockets every 4.5 seconds to avoid
creating extra players. Its maxima are not the earlier mid-run observations.

The game is on work2. Connecting to `178.162.254.45:443` while retaining
`afterhours.k8s.lohr.dev` for Host and TLS server-name verification served the
same game successfully. A 40-second walking run through that direct ingress
had a maximum snapshot age of 85 ms and sampled correction of about 1 mm after
five seconds. It used the installed `ws` client with a DNS lookup override;
HTTP map requests still used normal DNS. A simultaneous ordinary-hostname
comparison using the same WebSocket library failed to join, so this is not a
matched movement comparison. The final HTTP health request also timed out.
Startup corrections and frame heuristics remain in the full summary.

Public DNS currently returns `130.61.217.172` for the game hostname. The local
resolver also returned main's tailnet address `100.80.38.88` earlier in these
tests. A proposed follow-up is a specific DNS record for
`afterhours.k8s.lohr.dev` pointing to work2 at `178.162.254.45`, with TTL 300,
and corresponding split-DNS routing. Read the authoritative zone before changing
it: the public lookup does not distinguish an explicit record from a wildcard.
The LumaServ credential is absent from this execution environment, so no DNS
records were changed. This route fix remains outstanding.

Compact results are in [lag-fix-validation.json](lag-fix-validation.json);
full temporary traces are in `/tmp/afterhours-postfix/`.
