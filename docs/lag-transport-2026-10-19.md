# Production transport diagnosis, 19 October 2026

The lag remains unresolved. The [public production run](https://github.com/michidk/afterhours/actions/runs/39305078996) failed all fifteen clients with the unchanged acceptance gates. Five cars sustained movement and five planes sustained flight, but their timing still failed. Four walking clients required corrections near four metres.

Release `dfc1926` runs on `main.lohr.dev`, deployed by infrastructure commit `34de73ca`. Its input transition fix and debug-only transport diagnostics passed all 436 local tests, check/build, and all CI jobs. The [clean-runner run](https://github.com/michidk/afterhours/actions/runs/39303214310) passed five people, five cars and five planes, each measured for sixty seconds. That local pass does not establish production success.

[The production report](lag-main-transport.json) retains all failures. Its maximum snapshot age was 782 ms, applied-input age 1.107 s, and correction 3.968 m. The largest load-generator timer delay was 42 ms. Simulation ran at 99.3–99.9% of wall time.

A separate observer sampled the cluster-service health endpoint four times a second, with at most four concurrent requests. [The census](lag-main-transport-census.json) and [47 paired samples](lag-main-transport-pairs.json) match client snapshot ages above 300 ms to nearby server observations. Each observation finished within 500 ms and its request midpoint was within 250 ms of the client sample. Every matched client had a server snapshot write no older than 45 ms, zero skipped snapshots and zero application-buffered bytes. These are accepted socket writes, not proof that the peer received or acknowledged those bytes. The healthy generator and fresh writes point to delivery stalls beyond the game process. They do not identify which network hop or proxy is responsible.

At server time `1792435568838`, two clients had delivered no input for 1129/1088 ms while the other three had delivered input within 118 ms. All five had snapshot writes within 38 ms. Server scheduling pauses also remain: the observer captured a 405 ms pump gap. Neither finding justifies treating all stalls as one cause.

Five short idle ping rounds observed maxima of 249 ms through main's tailnet address, 243 ms through main's public address, 171 ms through work2 ingress, and 172 ms through the cluster service. Local timer gaps stayed below 57 ms. These unloaded ping probes do not reproduce the loaded failure. Main's conntrack table was around 3324/131072 entries, with no observed listen overflow or softnet-drop increase, so those saturation hypotheses lack supporting evidence.

[The local report](lag-local-transport.json) retains the passing control. The repeated [service-route run](lag-service-transport.json) also failed every client. Walking input age reached 909 ms, car snapshot age 395 ms, one car correction 2.702 m, and plane input age 819 ms. All clients sustained movement and all planes sustained flight. The [service census](lag-service-transport-census.json) matched seven stale-snapshot samples to fresh server writes, with no skipped snapshots or application-buffered bytes. This disproves an ingress-only explanation for the remaining failures. Do not change DNS, move other workloads, relax the gates, or claim the lag is fixed based on these diagnostics.

## Socket captures

A single-car cluster-service probe captured TCP state with `ss -tionp`. The completed client logged 671 samples, maximum snapshot age 799 ms, applied-input age 911 ms, and timer delay 31 ms. Its socket accumulated 25 retransmitted segments and 19 out-of-order received packets. During one snapshot gap, the receive counter stopped while outbound input packets continued to receive TCP acknowledgements. This demonstrates impaired delivery on the direct overlay route but does not attribute every delay to packet loss.

A separate single-car public-route probe also completed and recorded a 766 ms snapshot gap with a 23 ms client timer delay. At that gap its client TCP receive counter stopped, but its retransmission counter did not increase. The client cannot observe retransmissions by the server or nginx. The public-route stall therefore remains unexplained by the available TCP counters. An earlier public probe used an invalid name longer than the protocol's eighteen-character maximum, never joined, and is excluded from performance evidence.

`scripts/capture-movement-transport.py` runs the existing five-client test and collects health and per-address TCP socket observations concurrently. It preserves the child exit code and keeps observer errors, start/end times, resolved addresses, and all three phase results. It creates a new output directory to avoid overwriting evidence. Health writers serialize complete JSON lines, because concurrent `print` calls in an earlier ad hoc observer occasionally joined lines.

```sh
python3 scripts/capture-movement-transport.py \
  --url https://afterhours.k8s.lohr.dev \
  --node node --seconds 60 --output /tmp/afterhours-transport-capture
```

Run from an installed checkout with Node 24, Python 3, and `ss`. The capture adds observer load and is diagnostic; client timer delays remain part of the unchanged acceptance report.

## Synchronized public capture

The first complete run of the capture script used deployed source `dfc1926` against public main, from the VibePod on work2. It ran from `1792437110255` to `1792437543079`, with sixty measured seconds in each phase, and exited 1. [All fifteen client results](lag-public-tcp-five.json) failed the unchanged gates. Maximum snapshot age was 520 ms, applied-input age 635 ms, and correction 2.502 m. Generator timer delays stayed below 115 ms. All clients sustained movement and all planes sustained flight. Simulation ran at approximately real time.

At `1792437267872`, three of five walking connections had receive gaps above 400 ms while two continued receiving. The client TCP captures showed no increase in retransmitted bytes or out-of-order receive counters during that interval. Nearby health samples still recorded fresh server writes for the stalled clients. This pattern is compatible with a shared proxy or server-side transport delay, but does not establish it. Accepted writes and empty application buffers do not reveal the game's kernel send queues.

A separate compression diagnostic alternated five Brotli and five identity rounds, three downloads of the same 1,802,129-byte bundle each round, alongside five WebSocket ping connections. Every download returned 200 with the full decoded payload and the expected content encoding. Neither setting eliminated latency spikes. Probe timer gaps reached 335 ms, so this experiment is inconclusive for attributing latency to nginx compression. No compression or network configuration was changed.

The next diagnostic must distinguish game-side kernel buffering from nginx and downstream buffering. Server snapshot-write timestamps alone cannot make that distinction.
