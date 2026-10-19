# Reconciliation rewind and production scheduling waits

CI [39325012552](https://github.com/michidk/afterhours/actions/runs/39325012552)
recorded a sedan moving backwards 0.171673 m while accelerating. All 244 recorded
Prediction calls replayed with zero position error and reproduced that rewind.
The raw replay is retained in the isolated scout worktree at
`.codex/scout-replay-captures/sedan-ci-rewind.json`. The original scout failure
remains recorded separately; this sedan replay does not reproduce that incident.

At receipt of an acknowledgement ahead of the latest input, reconciliation cleared
15 pending inputs. Presentation consequently changed its extrapolation allowance
from two ticks to half a second. Reconciliation sampled the old and new histories
at different command positions and generated a -0.928438 m offset. The same browser
callback then filled seven catch-up inputs, restoring the two-tick cap. That
transient allowance change pulled the next displayed car position backwards.

The fix captures the bounded command position before replacing authority and
compares both histories at that same position. Rendering keeps its existing limits,
and authority, damage, ownership, and input pacing remain server-controlled. Simply
capping all extrapolation at two ticks was rejected because it broke the existing
car and plane held-slot tests.

The focused behavioral case in `tests/held-presentation.test.ts` reduces the real
capture to public Prediction calls on an empty city. It fails against the original
source with a 0.171710 m rewind and passes with the fix. The full original capture
also has no backward frame with the fix. This is proof for that recorded movement
failure, not production lag acceptance.

The scheduler diagnostic release `7d34079` deployed successfully on main through
infrastructure run
[39324045268](https://github.com/michidk/k8s/actions/runs/39324045268).
The subsequent public five-person/car/plane capture failed all 15 clients, retaining
load-generator failures too. It is stored under the root checkout's
`.codex/lag-check/results/public-scheduler-five/`, including client traces, health,
TCP, `scheduler-analysis.json`, and `thread-pause-bounds.json`.

The counters establish that some pump gaps include game-thread run-queue wait. For
one 395.495 ms gap, bracketing scheduler reads span 811 ms and accumulate 521.206 ms
of thread wait. Even if every millisecond outside the pump gap were waiting, at
least 105.701 ms of waiting lies inside it. Read start/end uncertainty is included
in that conservative window. Three captured gaps have positive lower bounds; this
does not attribute every stall or the entire duration of any gap.

Main runs Linux `6.17.0-1019-oracle`. The initial offline analyzer incorrectly
treated `kernel.sched_schedstats=0` as disabling per-task run-queue counters. In
Linux 6.17, [sched_info_on](https://github.com/torvalds/linux/blob/v6.17/include/linux/sched/stat.h)
checks `CONFIG_SCHED_INFO`, independently of that runtime flag.
[/proc/PID/schedstat](https://github.com/torvalds/linux/blob/v6.17/fs/proc/base.c)
exports `sched_info.run_delay`, updated by the
[scheduler switch path](https://github.com/torvalds/linux/blob/v6.17/kernel/sched/stats.h).
The production counters are nonzero and advance. The corrected analysis uses those
values; the flag is retained as metadata. No kernel setting was changed.

Infrastructure commit `87551948` raises Afterhours' CPU request from 450m to 600m.
Both validations before and after its first rebase passed `just verify`. The node
reports two allocatable cores; its observed reservations total 1.845 cores before
this change and 1.995 afterward. CPU remains unlimited. This is a scheduling change
to test, not a demonstrated lag fix. No workloads move and DNS stays unchanged.
Afterhours rolled out successfully in deployment run `39327342558`, and the live
pod reports 600m requested with CPU weight 67, increased from 54. The global
workflow subsequently failed on an unrelated CodeTend migration-hook timeout; it
did not undo the Afterhours rollout. The first five walking clients at 600m still
failed, so this reservation change has not removed the lag.

The candidate passed all 445 isolated tests, `bun run build`, and `bun run check`.
The regression was also run against the original source and failed as described
above. CI must validate the committed artifact and its browser gates before
promoting its image; these local checks do not establish production acceptance.
