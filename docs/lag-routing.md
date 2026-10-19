# Live movement routing investigation, 2026-10-19

The lag is not yet verified as fixed. The normal public DNS record still points
at the main node, 130.61.217.172. Changing internal split DNS does not change
public clients. Public DNS must point `afterhours.k8s.lohr.dev` at the game node,
178.162.254.45, to use the route tested below. The existing hostname, TLS
certificate and game origin remain valid on that node.

Concurrent WebSocket ping probes against the same game server found stalls on
the main-node ingress while direct service and game-node ingress stayed responsive.
One 180-second comparison reached 64 ms through the service, 166 ms through the
game-node public ingress, and 11,043 ms through main-node public ingress.
The normal hostname reached 18,992 ms, but that probe did not record its resolved
socket address, so it cannot establish which address the resolver selected.
These are diagnostic observations from a shared host, not capacity benchmarks
or proof of smooth rendered movement.

Infrastructure commits in `michidk/k8s`:

- `92a7822b` caps background Folding CPU at 250 millicores on main. CPU headroom
  improved, but subsequent movement still failed the acceptance limits.
- `7038c82e` routes internal split DNS directly to the game node's Tailscale
  address, 100.119.247.42. It also restores the ingress addon's empty resource
  policy. An experimental 50-millicore request did not eliminate stalls and
  consumed the scheduling headroom needed by a migration job.

The initial split-DNS CNAME introduced in `ecdfb9b2` did not recursively resolve
its external target. The corrected A record was checked against the live DNS
server. Repository verification passed before deployment. Public DNS write
credentials were unavailable in this session.

The test driver now records vehicle health, burning, wreck and driver fields.
These distinguish crashes or ownership loss from transport stalls without
changing authoritative gameplay or relaxing acceptance limits.

The full five-client test remains the acceptance gate: five walking clients,
five cars, then five planes, each measured for 180 seconds after acceleration.
See [movement testing](movement-testing.md). Runs overlapping infrastructure
rollouts are diagnostic only and cannot establish post-deployment success.

## Direct public game-node result

A complete sequential run used a process-local DNS lookup override to
178.162.254.45 for both HTTP map downloads and WebSockets, retaining the normal
hostname and TLS validation. `ss` confirmed sockets to that address. The game-node
ingress had completed its restart before this run. This was not a test of updated
public DNS. One short debug observer joined during cars to inspect obstructions.

| Phase | Passing clients | Worst snapshot age | Worst applied-input age | Worst correction |
| --- | ---: | ---: | ---: | ---: |
| People | 3/5 | 327 ms | 473 ms | 0.80 m |
| Cars | 4/5 | 161 ms | 326 ms | 0.33 m |
| Planes | 0/5 | 422 ms | 604 ms | 9.44 m |

Every phase measured 180 seconds. The command exited 1. One walker and car were
obstructed near planes e10609/e10612, left by the earlier failed plane setup.
Their IDs match that setup's ready records. One new plane remained on the ground;
another lost health and did not meet sustained-flight requirements. Other planes
flew but still failed correction and latency limits. Existing test vehicles make
this shared server unsuitable for claiming a clean repeatable flight test without
isolating or cleaning the test area. No failures were waived.

[Full report](lag-direct-route-validation.json) records all client results. Raw
traces are archived locally in `.codex/lag-evidence/routing-2026-10-19.tar.gz`.
Build and seven acceptance evaluator tests passed. No gameplay change was made.
The shared browser loaded character selection, but rendered movement was not
validated. DNS bypass alone is not a complete fix for the remaining corrections.
