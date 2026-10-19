# Production transport diagnosis, 19 October 2026

The lag remains unresolved. The [public production run](https://github.com/michidk/afterhours/actions/runs/39305078996) failed all fifteen clients with the unchanged acceptance gates. Five cars sustained movement and five planes sustained flight, but their timing still failed. Four walking clients required corrections near four metres.

Release `dfc1926` runs on `main.lohr.dev`, deployed by infrastructure commit `34de73ca`. Its input transition fix and debug-only transport diagnostics passed all 436 local tests, check/build, and all CI jobs. The [clean-runner run](https://github.com/michidk/afterhours/actions/runs/39303214310) passed five people, five cars and five planes, each measured for sixty seconds. That local pass does not establish production success.

[The production report](lag-main-transport.json) retains all failures. Its maximum snapshot age was 782 ms, applied-input age 1.107 s, and correction 3.968 m. The largest load-generator timer delay was 42 ms. Simulation ran at 99.3–99.9% of wall time.

A separate observer sampled the cluster-service health endpoint four times a second, with at most four concurrent requests. [The census](lag-main-transport-census.json) and [47 paired samples](lag-main-transport-pairs.json) match client snapshot ages above 300 ms to nearby server observations. Each observation finished within 500 ms and its request midpoint was within 250 ms of the client sample. Every matched client had a server snapshot write no older than 45 ms, zero skipped snapshots and zero application-buffered bytes. These are accepted socket writes, not proof that the peer received or acknowledged those bytes. The healthy generator and fresh writes point to delivery stalls beyond the game process. They do not identify which network hop or proxy is responsible.

At server time `1792435568838`, two clients had delivered no input for 1129/1088 ms while the other three had delivered input within 118 ms. All five had snapshot writes within 38 ms. Server scheduling pauses also remain: the observer captured a 405 ms pump gap. Neither finding justifies treating all stalls as one cause.

Five short idle ping rounds observed maxima of 249 ms through main's tailnet address, 243 ms through main's public address, 171 ms through work2 ingress, and 172 ms through the cluster service. Local timer gaps stayed below 57 ms. These unloaded ping probes do not reproduce the loaded failure. Main's conntrack table was around 3324/131072 entries, with no observed listen overflow or softnet-drop increase, so those saturation hypotheses lack supporting evidence.

[The local report](lag-local-transport.json) retains the passing control. A new service-route five-client run is required to compare delivery under load while bypassing ingress. Do not change DNS, move other workloads, relax the gates, or claim the lag is fixed based on these diagnostics.
