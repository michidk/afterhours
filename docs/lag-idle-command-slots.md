# Silent coasting and doubled replay

The protocol 9 public run [39331158289](https://github.com/michidk/afterhours/actions/runs/39331158289)
failed all five people, five cars and five planes. Its full report is retained in
[lag-reconcile-public-followup.json](lag-reconcile-public-followup.json). Generator
input delays stayed below 46 ms. Cars reached 1.19 s applied-input age and 1.90 m
correction. Three planes exceeded the correction limit, reaching 2.77 m, while
all five sustained flight. The reconciliation release therefore did not remove
production lag.

Two single-plane diagnostics, one with injected delay and spikes, captured 7,088
and 6,675 Prediction calls respectively. Both replayed with zero position and
correction error. Their maximum captured corrections were 0.00152 m and 0.0629 m.
Neither reproduced the large flight correction.

A subsequent five-plane diagnostic applied 80 ms one-way delay to approximate the
public runner's median 158 ms RTT. It recorded the second plane's prediction
calls. All five clients failed; generator delays remained below 143 ms. The
recording reproduced a 3.643093 m correction, and all 1,596 calls replayed with
zero position and correction error. This instrumented diagnostic is separate
from the unchanged public acceptance run.

Immediately before that correction, both authoritative snapshots acknowledged
command 2094, but the plane moved about 3.925 m between them. Its last reported
controls changed to idle after input silence. The client still had 24 pending
commands through sequence 2118. Replaying them from authority that had coasted
without consuming command slots counted the coasting movement again. This case
was not a collision with another plane and did not require an angle correction.

The fix acknowledges every silent coasting tick while retaining control release
after 500 ms. Late commands fill those slots without another physics step. The snapshot
reports the last silent coasting slot separately from ordinary held-control
acknowledgements. A resumed browser skips unsent slots through that coasting slot,
and the server removes abandoned slots in that sequence gap from its outstanding
count. This prevents a long silent period from trapping fresh controls behind
commands the browser never sent. Protocol 10 requires a refresh so client and
server use the same recovery semantics. Coasting acknowledges logical slots but
does not refresh the input timestamp. Late frames extrapolate timestamps only
through held-control slots, so idle time cannot hide stale input from the lag
gate. Server authority, damage, ownership and
the maximum work granted by a command burst are unchanged.

The focused wire regressions initially failed with 3.769782 m car and 3.492588 m
plane corrections. They now require corrections below 0.01 m, acknowledged
coasting slots, and immediate application of resumed controls. The real
GameNetwork recovery check also initially sent obsolete sequence 2 where 5 was
required; its extended case verifies recovery after 90 quiet ticks. Existing
burst and held-slot assertions remain intact. All 452 tests pass on Node 24,
including the unchanged full-speed, clock-regulation, 400 ms wakeup and multiplayer
reconnect cases. Ordinary held-control acknowledgements do not skip unsent input;
the separate `idleAck` marker limits sequence recovery to silent coasting.

This fixes an identified source of excess correction. The public report also
contains genuine server runtime gaps, including a 423 ms gap with only 98 ms of
overlapping GC. Those scheduling and delivery delays remain unresolved until the
unchanged production gates pass on the final deployed artifact.

Raw captures and replay tools are retained under the root checkout's
`.codex/lag-check/results/reconcile-release/` and `.codex/lag-check/` directories.
The five-plane diagnostic's client traces are copied into the artifact
directory's `five-plane-diagnostic-traces/` folder. Its recorder ran from the immutable
`afterhours-reconcile-release` worktree, not the concurrently edited root checkout.
